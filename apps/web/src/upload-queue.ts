import type { ApplicationLimits, CreateUploadRequest, UploadTask, VideoDetail } from "@online-video/shared";
import { ApiClient, ApiError } from "./api/client";
import { generateLocalCover } from "./cover";
import type { LocalCover } from "./cover";
import { completeTask, uploadFile, validateTask, validateUploadSize, verifyFile } from "./upload";
import { TaskCompletionEffects } from "./space-enhancement-state";

export type LocalTaskState = "prepared" | "creating" | "createFailed" | "queued" | "uploading" | "paused" | "verifying" | "confirming" | "savingCover" | "completed" | "failed";
export interface PreparedVideo {
  clientId: string; file?: File | undefined; title: string; categoryId: string; tags: string[];
  fileName: string; sizeBytes: number; validationError?: string | undefined;
  cover?: LocalCover | undefined; coverState: "waiting" | "working" | "ready" | "failed"; coverError?: string | undefined;
  manualCoverTime?: number | undefined;
  state: LocalTaskState; createRequest?: CreateUploadRequest | undefined; task?: UploadTask | undefined; video?: VideoDetail | undefined; error?: unknown; notice?: string | undefined;
}
export const validVideoExtension = (name: string) => /\.(mp4|mov|webm|mkv|m4v)$/i.test(name);
export function validateVideoFile(file: File, limits: ApplicationLimits) {
  validateUploadSize(file.size, limits);
  if (!validVideoExtension(file.name)) throw new ApiError("VALIDATION_ERROR", "仅支持 MP4、MOV、WEBM、MKV、M4V 视频文件");
}

/** 应用级执行器：路由卸载不影响它，退出登录才停止本机传输。 */
export class UploadQueue {
  readonly completionEffects = new TaskCompletionEffects();
  private entries: PreparedVideo[] = [];
  private listeners = new Set<() => void>();
  private transfer: { id: string; controller: AbortController } | undefined;
  private previews: { id: string; controller: AbortController } | undefined;
  private creating = false;
  private stopped = false;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.entries;
  constructor(private client: ApiClient, private coverGenerator = generateLocalCover) {}
  private update(id: string, patch: Partial<PreparedVideo>) { this.entries = this.entries.map(entry => entry.clientId === id ? { ...entry, ...patch } : entry); this.listeners.forEach(listener => listener()); }
  private changed() { this.entries = [...this.entries]; this.listeners.forEach(listener => listener()); }
  private find(id: string) { return this.entries.find(entry => entry.clientId === id); }
  add(files: File[], limits: ApplicationLimits, categoryId: string) {
    const created = files.map(file => {
      let validationError: string | undefined;
      try { validateVideoFile(file, limits); } catch (error) { validationError = error instanceof Error ? error.message : "文件无效"; }
      return { clientId: crypto.randomUUID(), file, title: file.name.replace(/\.[^.]+$/, ""), categoryId, tags: [], fileName: file.name, sizeBytes: file.size, validationError, state: "prepared" as const, coverState: validationError ? "failed" as const : "waiting" as const };
    });
    this.entries.push(...created); this.changed(); void this.previewNext(); return created.map(entry => entry.clientId);
  }
  edit(id: string, patch: Pick<Partial<PreparedVideo>, "title" | "categoryId" | "tags">) { const entry = this.find(id); if (entry && !entry.createRequest && !entry.task) this.update(id, patch); }
  applyMetadata(id: string) { const source = this.find(id); if (!source) return; this.entries = this.entries.map(entry => !entry.createRequest && !entry.task ? { ...entry, categoryId: source.categoryId, tags: [...source.tags] } : entry); this.changed(); }
  remove(id: string) { const entry = this.find(id); if (!entry || entry.createRequest || entry.task) return; if (this.previews?.id === id) this.previews.controller.abort(); if (entry.cover) URL.revokeObjectURL(entry.cover.url); this.entries = this.entries.filter(value => value.clientId !== id); this.changed(); }
  /** 成功提交图片时才中止自动采集；取消弹窗不改变队列。调用者在返回 false 时释放图片。 */
  setCover(id: string, cover: LocalCover, manualCoverTime?: number) {
    const entry = this.find(id);
    if (this.stopped || !entry?.file || entry.validationError || entry.createRequest || entry.task) return false;
    if (cover.source === "manual" && (!Number.isFinite(manualCoverTime) || manualCoverTime! < 0)) return false;
    if (this.previews?.id === id) this.previews.controller.abort();
    this.update(id, { cover, coverState: "ready", coverError: undefined, manualCoverTime: cover.source === "manual" ? manualCoverTime : undefined });
    if (entry.cover && entry.cover.url !== cover.url) URL.revokeObjectURL(entry.cover.url);
    return true;
  }
  private async previewNext() {
    if (this.previews || this.stopped) return;
    const entry = this.entries.find(item => item.coverState === "waiting" && item.file); if (!entry?.file) return;
    const controller = new AbortController(); this.previews = { id: entry.clientId, controller }; this.update(entry.clientId, { coverState: "working" });
    try { const cover = await this.coverGenerator(entry.file, controller.signal); if (this.find(entry.clientId)?.coverState === "working" && !controller.signal.aborted && !this.stopped) this.update(entry.clientId, { cover, coverState: "ready", coverError: undefined }); else URL.revokeObjectURL(cover.url); }
    catch (error) { if (this.find(entry.clientId)?.coverState === "working" && !controller.signal.aborted && !this.stopped) this.update(entry.clientId, { coverState: "failed", coverError: error instanceof Error && error.name !== "AbortError" ? error.message : "封面采集超时或已停止，视频仍可上传" }); }
    finally { this.previews = undefined; if (!this.stopped) { const current = this.find(entry.clientId); if (current?.video && current.cover) void this.retryCover(entry.clientId); void this.previewNext(); void this.pump(); } }
  }
  async submit(ids: string[]) {
    if (this.creating || this.stopped) return;
    this.creating = true;
    try {
      for (const id of ids) {
        if (this.stopped) break;
        const entry = this.find(id); if (!entry || entry.task || entry.validationError || !entry.title.trim() || !entry.categoryId) continue;
        const body = entry.createRequest ?? { clientRequestId: entry.clientId, fileName: entry.fileName, sizeBytes: entry.sizeBytes, title: entry.title.trim(), categoryId: entry.categoryId, tags: [...entry.tags] };
        this.update(id, { createRequest: body, state: "creating", error: undefined });
        try { const task = await this.client.request<UploadTask>("/api/uploads", { method: "POST", body }); validateTask(task, entry.file); if (this.stopped) break; this.update(id, { task, state: "queued" }); void this.pump(); }
        catch (error) { if (!this.stopped) this.update(id, { state: "createFailed", error }); }
      }
    } finally { this.creating = false; }
  }
  private async saveCover(entry: PreparedVideo, signal: AbortSignal) {
    const current = this.find(entry.clientId); const video = current?.video; if (!video || !current.cover) return;
    this.update(entry.clientId, { state: "savingCover", error: undefined });
    try { const saved = await this.client.image<VideoDetail>(`/api/videos/${encodeURIComponent(video.id)}/cover`, current.cover.blob, signal); if (saved.id !== video.id || !saved.coverUrl || saved.coverStatus !== "saved") throw new ApiError("INVALID_RESPONSE", "后端尚未确认封面保存成功"); this.update(entry.clientId, { video: saved, task: { ...current.task!, coverUrl: saved.coverUrl, coverObjectKey: saved.coverObjectKey ?? null, coverStatus: "saved" }, state: "completed", error: undefined, notice: "视频已登记，封面已保存" }); }
    catch (error) { this.update(entry.clientId, { state: "completed", error, notice: "视频已登记并可播放，封面保存失败，可单独补封面" }); }
  }
  private async pump() {
    if (this.transfer || this.stopped) return;
    const entry = this.entries.find(item => item.state === "queued" && item.task);
    if (!entry?.task) { const coverPending = this.entries.find(item => item.state === "completed" && item.video && item.cover && item.video.coverStatus !== "saved" && !item.error); if (coverPending) void this.retryCover(coverPending.clientId); return; }
    const controller = new AbortController(); this.transfer = { id: entry.clientId, controller };
    this.update(entry.clientId, { state: "verifying", error: undefined, notice: "核对服务端已完成分片的 SHA-256…" });
    try {
      const task = entry.task;
      const previousStatus = task.status;
      let result: { upload: UploadTask; video: VideoDetail };
      const full = task.uploadedParts.length === Math.ceil(task.sizeBytes / task.partSizeBytes);
      if (task.status === "completed" && task.videoId) result = { upload: task, video: await this.client.request<VideoDetail>(`/api/videos/${encodeURIComponent(task.videoId)}`, { signal: controller.signal }) };
      else if (full && !entry.file) { this.update(entry.clientId, { state: "confirming", notice: "字节已传完，正在确认视频登记" }); result = await completeTask(this.client, task, controller.signal); }
      else {
        if (!entry.file) throw new ApiError("FILE_MISMATCH", "请重新选择原文件，经大小及已确认分片 SHA-256 校验后继续");
        result = await uploadFile(this.client, entry.file, task, controller.signal, value => this.update(entry.clientId, { task: value, state: value.status === "finalizing" ? "confirming" : "uploading", notice: value.status === "finalizing" ? "全部字节已上传，正在确认视频登记" : undefined }), part => this.update(entry.clientId, { notice: `已核对第 ${part} 个完成分片的 SHA-256` }));
      }
      this.completionEffects.confirm(previousStatus, result.upload, result.video);
      this.update(entry.clientId, { task: result.upload, video: result.video, state: "completed", notice: "视频已登记并可播放", error: undefined });
      // 预览仍在解析时稍后由 previewNext 再唤醒，不以占位图冒充封面。
      const current = this.find(entry.clientId)!;
      if (current.cover) await this.saveCover(current, controller.signal);
    } catch (error) { this.update(entry.clientId, { state: controller.signal.aborted ? "paused" : "failed", error: controller.signal.aborted ? undefined : error, notice: controller.signal.aborted ? "本机已暂停；服务端已确认分片保留" : undefined }); }
    finally { this.transfer = undefined; if (!this.stopped) void this.pump(); }
  }
  pause(id: string) { if (this.transfer?.id === id) this.transfer.controller.abort(); else if (this.find(id)?.state === "queued") this.update(id, { state: "paused" }); }
  retry(id: string) { const entry = this.find(id); if (!entry) return; if (entry.state === "createFailed") { void this.submit([id]); return; } this.update(id, { state: "queued", error: undefined }); void this.pump(); }
  async attach(task: UploadTask, file: File) {
    const id = this.entries.find(entry => entry.task?.id === task.id)?.clientId ?? `task-${task.id}`;
    validateTask(task, file);
    const controller = new AbortController(); await verifyFile(file, task, controller.signal);
    const entry = this.find(id);
    const patch: PreparedVideo = { clientId: id, file, fileName: task.fileName, sizeBytes: task.sizeBytes, title: task.title ?? task.fileName, categoryId: task.categoryId ?? "", tags: task.tags ?? [], task, state: task.status === "completed" ? "completed" : "paused", coverState: entry?.cover ? "ready" : "waiting", cover: entry?.cover, notice: task.uploadedParts.length ? "大小与全部已确认分片 SHA-256 已匹配，可继续上传" : "大小已匹配；此任务尚无已确认分片，无法与原文件的已有 SHA-256 比对" };
    if (entry) this.update(id, patch); else { this.entries.push(patch); this.changed(); }
    if (task.status === "completed" && task.videoId) { const video = await this.client.request<VideoDetail>(`/api/videos/${encodeURIComponent(task.videoId)}`); this.update(id, { video }); }
    void this.previewNext(); return id;
  }
  recover(task: UploadTask) { let entry = this.entries.find(value => value.task?.id === task.id); if (!entry) { entry = { clientId: `task-${task.id}`, task, fileName: task.fileName, sizeBytes: task.sizeBytes, title: task.title ?? task.fileName, categoryId: task.categoryId ?? "", tags: task.tags ?? [], state: "paused", coverState: "failed" }; this.entries.push(entry); this.changed(); } this.retry(entry.clientId); }
  async retryCover(id: string) { const entry = this.find(id); if (!entry?.cover || !entry.video || this.transfer) return; const controller = new AbortController(); this.transfer = { id, controller }; try { await this.saveCover(entry, controller.signal); } finally { this.transfer = undefined; void this.pump(); } }
  stop() { this.stopped = true; this.transfer?.controller.abort(); this.previews?.controller.abort(); this.entries.forEach(entry => { if (entry.cover) URL.revokeObjectURL(entry.cover.url); }); this.entries = []; this.changed(); }
}

import { isPartChecksum, PART_CHECKSUM_ALGORITHM, UPLOAD_STATUSES } from "@online-video/shared";
import type { CompleteUploadResponse, UploadedPart, UploadTask } from "@online-video/shared";
import { ApiClient, ApiError } from "./api/client";

export async function checksum(blob: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new ApiError("SERVICE_NOT_CONFIGURED", "当前浏览器无法安全计算分片校验；请使用 HTTPS 或本机 localhost");
  return Array.from(new Uint8Array(await crypto.subtle.digest(PART_CHECKSUM_ALGORITHM, await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function validateTask(task: UploadTask, file?: File) {
  if (!task || typeof task.id !== "string" || !task.id || !UPLOAD_STATUSES.includes(task.status)) throw new ApiError("INVALID_RESPONSE", "服务端上传任务标识或状态无效");
  if (!Number.isSafeInteger(task.sizeBytes) || task.sizeBytes <= 0 || !Number.isSafeInteger(task.partSizeBytes) || task.partSizeBytes <= 0 || task.partSizeBytes > 64 * 1048576 || !Array.isArray(task.uploadedParts)) throw new ApiError("INVALID_RESPONSE", "服务端上传任务尺寸无效或分片超过浏览器 64 MiB 安全内存边界");
  if (file && file.size !== task.sizeBytes) throw new ApiError("FILE_MISMATCH", "所选文件大小与服务端上传任务不同，请重新选择原文件");
  const seen = new Set<number>();
  for (const part of task.uploadedParts) {
    if (!part || typeof part !== "object") throw new ApiError("INVALID_RESPONSE", "服务端分片记录无效");
    const expected = Math.min(task.partSizeBytes, task.sizeBytes - (part.partNumber - 1) * task.partSizeBytes);
    if (!Number.isSafeInteger(part.partNumber) || part.partNumber <= 0 || expected <= 0 || part.sizeBytes !== expected || !isPartChecksum(part.checksum) || seen.has(part.partNumber)) throw new ApiError("INVALID_RESPONSE", "服务端已上传分片记录无效，请由后端检查任务");
    seen.add(part.partNumber);
  }
}
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException("Aborted", "AbortError"); };
export async function verifyFile(file: File, task: UploadTask, signal: AbortSignal, onVerified?: (partNumber: number) => void) {
  validateTask(task, file);
  for (const part of task.uploadedParts) {
    checkAbort(signal);
    const slice = file.slice((part.partNumber - 1) * task.partSizeBytes, (part.partNumber - 1) * task.partSizeBytes + part.sizeBytes);
    const digest = await checksum(slice); checkAbort(signal);
    if (slice.size !== part.sizeBytes || digest !== part.checksum) throw new ApiError("FILE_MISMATCH", `所选文件的第 ${part.partNumber} 片与服务端记录不同，不能续传`);
    onVerified?.(part.partNumber);
  }
}
export async function uploadFile(client: ApiClient, file: File, initialTask: UploadTask, signal: AbortSignal, onTask: (task: UploadTask) => void, onVerifying?: (partNumber: number) => void): Promise<CompleteUploadResponse["data"]> {
  const path = `/api/uploads/${encodeURIComponent(initialTask.id)}` as const;
  const task = await client.request<UploadTask>(path, { signal });
  if (task.id !== initialTask.id) throw new ApiError("INVALID_RESPONSE", "服务端返回了不同的上传任务");
  validateTask(task, file); onTask(task);
  const fullyUploaded = task.uploadedParts.length === Math.ceil(task.sizeBytes / task.partSizeBytes);
  if (task.status !== "uploading" && !fullyUploaded) throw new ApiError("UPLOAD_STATE_CONFLICT", "服务端任务尚未完成全部分片，不能重试完成，请核查任务状态");
  await verifyFile(file, task, signal, onVerifying);
  const completed = new Set(task.uploadedParts.map(part => part.partNumber));
  for (let partNumber = 1; partNumber <= Math.ceil(file.size / task.partSizeBytes); partNumber++) {
    checkAbort(signal); if (completed.has(partNumber)) continue;
    const start = (partNumber - 1) * task.partSizeBytes;
    const blob = file.slice(start, Math.min(start + task.partSizeBytes, file.size));
    const digest = await checksum(blob); checkAbort(signal);
    const part = await client.part<UploadedPart>(`${path}/parts/${partNumber}`, blob, digest, signal);
    if (part.partNumber !== partNumber || part.sizeBytes !== blob.size || part.checksum !== digest) throw new ApiError("INVALID_RESPONSE", "服务端分片确认与发送数据不一致，停止上传");
    task.uploadedParts.push(part); task.uploadedParts.sort((a, b) => a.partNumber - b.partNumber); onTask({ ...task, uploadedParts: [...task.uploadedParts] });
  }
  checkAbort(signal); onTask({ ...task, status: "finalizing" });
  const result = await completeTask(client, task, signal);
  onTask(result.upload); return result;
}

export async function completeTask(client: ApiClient, initialTask: UploadTask, signal?: AbortSignal): Promise<CompleteUploadResponse["data"]> {
  const path = `/api/uploads/${encodeURIComponent(initialTask.id)}` as const;
  const task = await client.request<UploadTask>(path, signal ? { signal } : {});
  validateTask(task);
  if (task.id !== initialTask.id || task.uploadedParts.length !== Math.ceil(task.sizeBytes / task.partSizeBytes)) throw new ApiError("UPLOAD_STATE_CONFLICT", "服务端尚未验证全部分片，不能提交完成");
  const result = await client.request<CompleteUploadResponse["data"]>(`${path}/complete`, { method: "POST", ...(signal ? { signal } : {}) });
  if (result.upload.id !== task.id || result.upload.status !== "completed" || result.upload.videoId !== result.video.id) throw new ApiError("INVALID_RESPONSE", "后端尚未确认完整视频登记，不能视为上传成功");
  return result;
}

export interface UploadHint { id: string; fileName: string; sizeBytes: number; createdAt: string }
export const uploadHintKey = (ownerId: string, mock: boolean) => `ov.${mock ? "mock" : "api"}.upload-hints.${ownerId}`;
export function readUploadHints(key: string): UploadHint[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(value) ? value.filter((hint): hint is UploadHint => !!hint && typeof hint === "object" && typeof hint.id === "string" && typeof hint.fileName === "string" && Number.isSafeInteger(hint.sizeBytes) && typeof hint.createdAt === "string") : []; } catch { return []; }
}
export function rememberUpload(key: string, task: UploadTask) {
  const existing = readUploadHints(key);
  if (!existing.some(hint => hint.id === task.id)) existing.unshift({ id: task.id, fileName: task.fileName, sizeBytes: task.sizeBytes, createdAt: task.createdAt });
  localStorage.setItem(key, JSON.stringify(existing));
}

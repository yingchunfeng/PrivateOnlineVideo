import { isVideoDuration, MAX_VIDEO_DURATION_SECONDS } from "@online-video/shared";
import type { VideoDetail } from "@online-video/shared";
import { ApiClient, ApiError } from "./api/client";

export { isVideoDuration, MAX_VIDEO_DURATION_SECONDS };
export const VIDEO_DURATION_SAVED = "video-duration-saved";
let probing = false;
const writes = new Map<string, Promise<VideoDetail>>();

/** 只采集当前选中的单个媒体；不读取整文件，也不在首页逐卡片创建播放器。 */
export async function readMediaDuration(source: Blob | string, signal?: AbortSignal, timeoutMs = 8000): Promise<number> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (probing) throw new Error("另一个视频正在采集时长，请稍后重试");
  if (typeof document === "undefined") throw new Error("当前环境不支持浏览器视频时长采集");
  probing = true;
  let video: HTMLVideoElement | undefined; let url: string | undefined;
  const local = typeof source !== "string";
  try {
    video = document.createElement("video"); url = local ? URL.createObjectURL(source) : source;
    video.preload = "metadata"; video.muted = true; video.playsInline = true;
    const node = video;
    return await new Promise<number>((resolve, reject) => {
      let finished = false;
      const finish = (value?: number, error?: Error) => {
        if (finished) return; finished = true; clearTimeout(timer);
        node.removeEventListener("loadedmetadata", loaded); node.removeEventListener("durationchange", loaded); node.removeEventListener("error", failed); signal?.removeEventListener("abort", aborted);
        error ? reject(error) : resolve(value!);
      };
      const loaded = () => { if (isVideoDuration(node.duration)) finish(node.duration); else if (node.readyState >= 1) finish(undefined, new Error("此媒体未提供有效的总时长，请重试或使用支持此格式的浏览器")); };
      const failed = () => finish(undefined, new Error("时长采集失败：网络不可用或浏览器不支持此媒体，可在详情页重试"));
      const aborted = () => finish(undefined, new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(() => finish(undefined, new Error("时长采集超时，视频已保留，可在详情页重试")), timeoutMs);
      node.addEventListener("loadedmetadata", loaded); node.addEventListener("durationchange", loaded); node.addEventListener("error", failed); signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      node.src = url!;
    });
  } finally {
    probing = false;
    if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    if (local && url) URL.revokeObjectURL(url);
  }
}

export function saveMediaDuration(client: ApiClient, video: VideoDetail, seconds: number, signal?: AbortSignal, timeoutMs = 8000): Promise<VideoDetail> {
  if (isVideoDuration(video.durationSeconds)) return Promise.resolve(video);
  if (!isVideoDuration(seconds)) return Promise.reject(new Error("媒体没有有效的总时长，不能保存占位值"));
  if (!video.objectKey) return Promise.reject(new Error("当前记录缺少可核对的播放媒体身份，无法从浏览器回填时长"));
  const identity = `${video.id}:${video.objectKey}`;
  const previous = writes.get(identity); if (previous) return previous;
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  const controller = new AbortController(); const aborted = () => controller.abort(new DOMException("Aborted", "AbortError"));
  signal?.addEventListener("abort", aborted, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("时长保存超时，原视频已保留，请重试")), timeoutMs);
  let cancel: () => void;
  const cancellation = new Promise<never>((_resolve, reject) => { cancel = () => reject(controller.signal.reason); controller.signal.addEventListener("abort", cancel, { once: true }); });
  const operation = Promise.race([client.request<VideoDetail>(`/api/videos/${encodeURIComponent(video.id)}/duration`, { method: "PUT", body: { durationSeconds: seconds, expectedObjectKey: video.objectKey }, signal: controller.signal }), cancellation]).then(saved => {
    controller.signal.throwIfAborted();
    if (saved.id !== video.id || saved.objectKey !== video.objectKey || !isVideoDuration(saved.durationSeconds)) throw new ApiError("INVALID_RESPONSE", "服务端尚未确认同一视频的时长已保存");
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(VIDEO_DURATION_SAVED, { detail: { videoId: saved.id, durationSeconds: saved.durationSeconds } }));
    return saved;
  }).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); controller.signal.removeEventListener("abort", cancel); writes.delete(identity); });
  writes.set(identity, operation); return operation;
}

/** 只识别 ISO BMFF（MP4/MOV）中的 iTunes covr JPEG/PNG，其他来源回退浏览器截帧。 */
export interface LocalCover { blob: Blob; source: "embedded" | "frame" | "manual"; url: string }
const MAX_EMBEDDED_BYTES = 4 * 1048576;
const MAX_IMAGE_BYTES = 1048576;
const CONTAINERS = new Set(["moov", "udta", "meta", "ilst", "covr"]);
const abortError = () => new DOMException("Aborted", "AbortError");
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };

/** 按 box 偏移读取，跳过 mdat；最多读 2048 个头部和一张 4 MiB 内图片。 */
export async function extractEmbeddedCover(file: Blob, signal?: AbortSignal): Promise<Blob | undefined> {
  let boxes = 0;
  const deadline = Date.now() + 2500;
  const read = async (start: number, length: number) => {
    checkAbort(signal);
    if (Date.now() > deadline) throw new Error("内嵌封面解析超时");
    const data = await file.slice(start, start + length).arrayBuffer();
    checkAbort(signal);
    return new DataView(data);
  };
  const visit = async (start: number, end: number, depth: number, inCover = false): Promise<Blob | undefined> => {
    if (depth > 6) return;
    for (let position = start; position + 8 <= end;) {
      if (++boxes > 2048) throw new Error("容器元数据超出封面解析范围");
      const head = await read(position, Math.min(16, end - position));
      let size = head.getUint32(0); let header = 8;
      const type = String.fromCharCode(...new Uint8Array(head.buffer, 4, 4));
      if (size === 1) {
        if (head.byteLength < 16) return;
        const high = head.getUint32(8); const low = head.getUint32(12);
        size = high * 4294967296 + low; header = 16;
      } else if (size === 0) size = end - position;
      if (!Number.isSafeInteger(size) || size < header || position + size > end) return;
      const content = position + header; const boxEnd = position + size;
      if (inCover && type === "data" && size - header > 8 && size - header - 8 <= MAX_EMBEDDED_BYTES) {
        const data = await read(content, 16);
        const kind = data.getUint32(0) & 0xffffff;
        const signature = new Uint8Array(data.buffer, 8);
        const jpeg = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
        const png = signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e && signature[3] === 0x47;
        if (kind === 13 && jpeg || kind === 14 && png) return file.slice(content + 8, boxEnd, jpeg ? "image/jpeg" : "image/png");
      }
      if (CONTAINERS.has(type)) {
        const result = await visit(content + (type === "meta" ? 4 : 0), boxEnd, depth + 1, type === "covr");
        if (result) return result;
      }
      position = boxEnd;
    }
  };
  return visit(0, file.size, 0);
}

function waitEvent(target: EventTarget, event: string, signal: AbortSignal, timeoutMs = 6500) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); target.removeEventListener(event, success); target.removeEventListener("error", failure); signal.removeEventListener("abort", aborted); error ? reject(error) : resolve(); };
    const success = () => finish(); const failure = () => finish(new Error("当前浏览器无法解码此视频，暂无封面")); const aborted = () => finish(abortError());
    const timer = setTimeout(() => finish(new Error("封面采集超时，视频仍可上传")), timeoutMs);
    target.addEventListener(event, success, { once: true }); target.addEventListener("error", failure, { once: true }); signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
async function canvasBlob(source: CanvasImageSource, width: number, height: number, signal: AbortSignal, maxEdge = 960) {
  checkAbort(signal);
  if (!width || !height || width * height > 100000000) throw new Error("封面图片尺寸无法识别");
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d"); if (!context) throw new Error("当前浏览器无法采集封面");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  for (const quality of [.86, .72, .55]) {
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      let settled = false;
      const finish = (blob: Blob | null, error?: unknown) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", aborted);
        error ? reject(error) : resolve(blob);
      };
      const aborted = () => finish(null, abortError());
      const timer = setTimeout(() => finish(null, new Error("封面图片生成超时，原封面已保留")), 4000);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      try { canvas.toBlob(blob => finish(blob), "image/jpeg", quality); } catch (error) { finish(null, error); }
    });
    checkAbort(signal);
    if (!blob || !blob.size) throw new Error("浏览器未能生成封面图片，原封面已保留");
    if (blob.size <= MAX_IMAGE_BYTES) return blob;
  }
  throw new Error("采集封面超过 1 MiB 限制");
}
/** 末尾定位到最后一个有效画面，避免在 duration 上读到空画面。 */
export function coverFrameTime(time: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("视频时长暂不可用，无法定位画面");
  if (!Number.isFinite(time)) throw new Error("请输入有效的时间秒数");
  return Math.min(Math.max(0, time), duration - Math.min(.001, duration / 2));
}
export function coverIntervalTimes(duration: number, interval: number) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const start = Math.max(0, Math.floor(interval)) * 10;
  return Array.from({ length: Math.max(0, Math.min(10, Math.ceil(duration - start))) }, (_, index) => start + index);
}
export async function loadCoverVideo(video: HTMLVideoElement, url: string, signal: AbortSignal) {
  checkAbort(signal);
  const loaded = waitEvent(video, "loadedmetadata", signal);
  video.src = url; await loaded;
  if (video.error) throw new Error("当前浏览器无法解码此视频，请检查文件或使用其他浏览器");
}
/** seeked 后仍检查 HAVE_CURRENT_DATA；已有画面无需等待不会再次触发的 seeked。 */
export async function seekCoverVideo(video: HTMLVideoElement, time: number, signal: AbortSignal) {
  checkAbort(signal); video.pause();
  const target = coverFrameTime(time, video.duration);
  if (video.error) throw new Error("当前浏览器无法解码此视频，请检查文件或使用其他浏览器");
  if (video.seeking) await waitEvent(video, "seeked", signal);
  if (Math.abs(video.currentTime - target) > .00001) {
    const sought = waitEvent(video, "seeked", signal); video.currentTime = target; await sought;
  }
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await waitEvent(video, "loadeddata", signal);
  checkAbort(signal);
  if (!video.videoWidth || !video.videoHeight) throw new Error("视频画面未能解码，原封面已保留");
  return target;
}
export async function captureVideoCover(video: HTMLVideoElement, time: number, signal: AbortSignal): Promise<LocalCover> {
  await seekCoverVideo(video, time, signal);
  const blob = await canvasBlob(video, video.videoWidth, video.videoHeight, signal);
  return { blob, source: "manual", url: URL.createObjectURL(blob) };
}
export async function captureCoverThumbnail(video: HTMLVideoElement, time: number, signal: AbortSignal) {
  await seekCoverVideo(video, time, signal);
  return canvasBlob(video, video.videoWidth, video.videoHeight, signal, 192);
}
export function releaseCoverVideo(video: HTMLVideoElement) { video.pause(); video.removeAttribute("src"); video.load(); }
async function normalizeImage(blob: Blob, signal: AbortSignal) {
  const url = URL.createObjectURL(blob); const image = new Image();
  try { const loaded = waitEvent(image, "load", signal, 4000); image.src = url; await loaded; return await canvasBlob(image, image.naturalWidth, image.naturalHeight, signal); }
  finally { image.src = ""; URL.revokeObjectURL(url); }
}
async function captureFrame(file: File, signal: AbortSignal) {
  const video = document.createElement("video"); const url = URL.createObjectURL(file);
  video.muted = true; video.playsInline = true; video.preload = "metadata";
  try {
    const loaded = waitEvent(video, "loadedmetadata", signal); video.src = url; await loaded;
    if (Number.isNaN(video.duration) || video.duration <= 0) throw new Error("视频时长无法识别，暂无封面");
    // 部分 WebM 的元数据时长为 Infinity，仍受超时控制尝试约 1 秒画面。
    const time = Number.isFinite(video.duration) && video.duration <= 2 ? video.duration / 2 : 1;
    const sought = waitEvent(video, "seeked", signal); video.currentTime = time; await sought;
    if (video.readyState < 2) await waitEvent(video, "loadeddata", signal, 3000);
    return await canvasBlob(video, video.videoWidth, video.videoHeight, signal);
  } finally { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}
export async function generateLocalCover(file: File, outerSignal?: AbortSignal): Promise<LocalCover> {
  const controller = new AbortController(); const forward = () => controller.abort(); outerSignal?.addEventListener("abort", forward, { once: true });
  if (outerSignal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), 14000);
  try {
    if (/\.(mp4|m4v|mov)$/i.test(file.name)) {
      try { const embedded = await extractEmbeddedCover(file, controller.signal); if (embedded) { const blob = await normalizeImage(embedded, controller.signal); return { blob, source: "embedded", url: URL.createObjectURL(blob) }; } }
      catch { checkAbort(controller.signal); /* 元数据或图片不能识别时，尝试真实视频画面。 */ }
    }
    const blob = await captureFrame(file, controller.signal); return { blob, source: "frame", url: URL.createObjectURL(blob) };
  } finally { clearTimeout(timer); outerSignal?.removeEventListener("abort", forward); }
}

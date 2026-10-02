import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Readable } from "node:stream";
import type { MetadataInspector, MediaMetadata } from "./types.js";
import { unknownMetadata } from "./types.js";
import { parseRange } from "../playback/range.js";

export interface ProbeOptions {
  executable: string;
  timeoutMs: number;
  maxReadBytes: number;
  maxConcurrent: number;
  /** 仅用于显式注入受信任的本地测试探针；不接受 HTTP 用户参数。 */
  prefixArgs?: string[];
}

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
export function parseProbe(value: unknown): MediaMetadata {
  if (!value || typeof value !== "object") throw new Error("invalid probe");
  const probe = value as { format?: { format_name?: unknown; duration?: unknown; tags?: { major_brand?: unknown } };
    streams?: { codec_type?: unknown; codec_name?: unknown; pix_fmt?: unknown; profile?: unknown; width?: unknown; height?: unknown; duration?: unknown }[] };
  if (!Array.isArray(probe.streams)) throw new Error("invalid streams");
  const videos = probe.streams.filter(stream => stream.codec_type === "video");
  const video = videos[0]; const audio = probe.streams.filter(stream => stream.codec_type === "audio");
  if (!video) return { ...unknownMetadata, status: "failed" };
  const codec = typeof video.codec_name === "string" ? video.codec_name : null;
  const audioCodecs = audio.map(stream => typeof stream.codec_name === "string" ? stream.codec_name : "unknown");
  const format = typeof probe.format?.format_name === "string" ? probe.format.format_name.split(",") : [];
  const brand = typeof probe.format?.tags?.major_brand === "string" ? probe.format.tags.major_brand.trim() : "";
  const mp4 = format.includes("mp4") && /^(isom|iso[2-9]|mp4[12]|avc1|M4V|MSNV|dash)$/.test(brand);
  const pixelFormat = typeof video.pix_fmt === "string" ? video.pix_fmt : null;
  const profile = typeof video.profile === "string" ? video.profile : null;
  const allowedProfiles = ["Baseline", "Constrained Baseline", "Main", "High"];
  const knownIncompatible = videos.length !== 1 || (codec !== null && codec !== "h264") ||
    audioCodecs.some(name => name !== "aac" && name !== "unknown") || (brand !== "" && !mp4) ||
    (pixelFormat !== null && pixelFormat !== "yuv420p") || (profile !== null && !allowedProfiles.includes(profile));
  const playable = !knownIncompatible && mp4 && codec === "h264" && pixelFormat === "yuv420p" &&
    profile !== null && allowedProfiles.includes(profile) && audioCodecs.every(name => name === "aac");
  const width = number(video.width); const height = number(video.height);
  return { status: playable ? "ready" : knownIncompatible ? "unsupported" : "processing", playable,
    codec: codec ? [codec, ...audioCodecs].join("/") : null,
    durationSeconds: number(probe.format?.duration) ?? number(video.duration),
    width: width !== null && Number.isInteger(width) && width > 0 ? width : null,
    height: height !== null && Number.isInteger(height) && height > 0 ? height : null };
}

/** FFprobe 只访问一次性鉴权的 loopback Range 服务，无 OSS URL/凭证、全量落盘或整文件缓冲。 */
export class FFprobeMetadataInspector implements MetadataInspector {
  private active = 0;
  constructor(readonly options: ProbeOptions) {
    if (!options.executable || ![options.timeoutMs, options.maxReadBytes, options.maxConcurrent].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("invalid FFprobe limits");
    }
  }
  async inspect(input: Parameters<MetadataInspector["inspect"]>[0]): Promise<MediaMetadata> {
    input.signal.throwIfAborted();
    if (this.active >= this.options.maxConcurrent) return { ...unknownMetadata };
    this.active++;
    const controller = new AbortController(); const abort = () => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    const streams = new Set<Readable>(); const token = randomUUID();
    let readBytes = 0;
    const server = createServer(async (request, response) => {
      if (request.url !== `/${token}` || !["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(404).end(); return; }
      const local = new AbortController(); const cancel = () => local.abort();
      controller.signal.addEventListener("abort", cancel, { once: true });
      response.once("close", cancel);
      let upstream: Readable | undefined;
      try {
        const meta = await input.storage.head({ object: input.object, signal: local.signal });
        const range = parseRange(typeof request.headers.range === "string" ? request.headers.range : undefined, meta.sizeBytes);
        const length = range ? range.end - range.start + 1 : meta.sizeBytes;
        response.setHeader("accept-ranges", "bytes"); response.setHeader("content-length", length);
        response.setHeader("content-type", "application/octet-stream"); response.statusCode = range ? 206 : 200;
        if (range) response.setHeader("content-range", `bytes ${range.start}-${range.end}/${meta.sizeBytes}`);
        if (request.method === "HEAD") { response.end(); return; }
        const read = await input.storage.openRead({ object: input.object, ...(range ? { range } : {}), signal: local.signal });
        upstream = read.stream; streams.add(upstream);
        for await (const chunk of upstream) {
          const bytes = Buffer.from(chunk as Uint8Array); readBytes += bytes.length;
          if (readBytes > this.options.maxReadBytes) { controller.abort(); throw new Error("probe byte limit"); }
          if (!response.write(bytes)) await once(response, "drain", { signal: local.signal });
        }
        response.end();
      } catch { response.destroy(); }
      finally { upstream?.destroy(); if (upstream) streams.delete(upstream); local.abort(); controller.signal.removeEventListener("abort", cancel); }
    });
    try {
      server.listen(0, "127.0.0.1"); await once(server, "listening", { signal: controller.signal });
      const address = server.address(); if (!address || typeof address === "string") throw new Error("probe bind failed");
      const args = [...(this.options.prefixArgs ?? []), "-v", "error", "-probesize", "8388608", "-analyzeduration", "10000000",
        "-max_alloc", "16777216", "-protocol_whitelist", "http,tcp", "-format_whitelist", "mov,matroska,webm,avi",
        "-enable_drefs", "0", "-use_absolute_path", "0", "-show_format", "-show_streams", "-of", "json", `http://127.0.0.1:${address.port}/${token}`];
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(this.options.executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal: controller.signal,
          env: { ...process.env, http_proxy: "", https_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "", all_proxy: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1" } });
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
        let text = "";
        child.stdout.on("data", (bytes: Buffer) => {
          text += bytes.toString("utf8"); if (Buffer.byteLength(text) > 64 * 1024) controller.abort();
        });
        child.stderr.resume();
        child.once("error", reject);
        child.once("close", code => { clearTimeout(timer); if (code === 0 && !controller.signal.aborted) resolve(text); else reject(new Error("probe failed")); });
      });
      return parseProbe(JSON.parse(output));
    } catch (error) {
      if (input.signal.aborted) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...unknownMetadata };
      return { ...unknownMetadata, status: "failed" };
    } finally {
      controller.abort(); input.signal.removeEventListener("abort", abort);
      for (const stream of streams) stream.destroy(); server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      this.active--;
    }
  }
}

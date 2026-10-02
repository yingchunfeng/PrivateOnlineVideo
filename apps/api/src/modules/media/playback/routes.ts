import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PlaybackRecord, StorageObjectRef, TransferReservation } from "../../../core/contracts/index.js";
import { HttpError } from "../../../core/errors.js";
import type { MediaContext } from "../context.js";
import { principal, requestSignal, text } from "../context.js";
import { usagePeriod } from "../metering/period.js";
import { parseRange } from "./range.js";

export const TRANSFER_BLOCK_BYTES = 64 * 1024;

export function registerPlaybackRoutes(app: FastifyInstance, context: MediaContext): void {
  const { dependencies: deps, options } = context;
  app.post<{ Params: { videoId: string } }>("/api/videos/:videoId/playback-sessions", async request => {
    const auth = await principal(context, request, true); const videoId = text(request.params.videoId);
    const record = await deps.videos.findOwned(auth.user.id, videoId);
    if (!record) throw new HttpError("NOT_FOUND");
    if (!record.video.playable || record.video.status !== "ready") throw new HttpError("UNSUPPORTED_MEDIA_TYPE");
    const period = usagePeriod(deps.now(), deps.config.usageTimezone);
    const usage = await deps.usage.read(auth.user.id, period, deps.config.transferPolicy);
    if (usage.limitMode === "unconfigured") throw new HttpError("SERVICE_NOT_CONFIGURED");
    if (usage.limitMode === "limited" && usage.transferredBytes >= usage.limitBytes) throw new HttpError("TRANSFER_LIMIT_EXCEEDED");
    const created = await deps.playback.create({ principal: auth, videoId, now: deps.now().toISOString(),
      expiresAt: new Date(deps.now().getTime() + options.playbackTtlMs).toISOString(), maxActiveSessions: deps.config.maxPlaybackSessions! });
    return { data: created.session };
  });
  app.post<{ Params: { sessionId: string } }>("/api/playback-sessions/:sessionId/heartbeat", async request => {
    const auth = await principal(context, request, true);
    const record = await deps.playback.heartbeat(auth, text(request.params.sessionId), deps.now().toISOString());
    return { data: record.session };
  });
  app.post<{ Params: { sessionId: string } }>("/api/playback-sessions/:sessionId/close", async request => {
    const auth = await principal(context, request, true);
    await deps.playback.close(auth, text(request.params.sessionId), deps.now().toISOString());
    return { data: { success: true } };
  });
  app.route<{ Params: { videoId: string }; Querystring: { playbackSessionId?: string } }>({
    method: ["GET", "HEAD"], url: "/api/videos/:videoId/stream", handler: async (request, reply) => {
      const auth = await principal(context, request); const videoId = text(request.params.videoId);
      const sessionId = text(request.query.playbackSessionId);
      const record = await deps.videos.findOwned(auth.user.id, videoId);
      if (!record || !record.video.playable || record.video.status !== "ready") throw new HttpError("NOT_FOUND");
      const playback = await deps.playback.findActive({ principal: auth, videoId, sessionId, now: deps.now().toISOString() });
      if (!playback) throw new HttpError("FORBIDDEN");
      return serveObject(context, request, reply, record.playbackObject, playback);
    }
  });
  app.route<{ Params: { videoId: string } }>({ method: ["GET", "HEAD"], url: "/api/videos/:videoId/thumbnail",
    handler: async (request, reply) => {
      const auth = await principal(context, request); const record = await deps.videos.findOwned(auth.user.id, text(request.params.videoId));
      if (!record?.thumbnailObject) throw new HttpError("NOT_FOUND");
      return serveObject(context, request, reply, record.thumbnailObject, null);
    }
  });
}

async function serveObject(context: MediaContext, request: FastifyRequest, reply: FastifyReply,
  object: StorageObjectRef, playback: PlaybackRecord | null): Promise<void> {
  const { dependencies: deps } = context; const auth = await principal(context, request);
  context.scope.key(object);
  const { controller, dispose } = requestSignal(request, reply);
  const abort = () => { if (!reply.raw.writableFinished) controller.abort(); };
  reply.raw.once("close", abort);
  let reservation: TransferReservation | undefined;
  let upstream: import("node:stream").Readable | undefined;
  let sentForReservation = 0;
  const reserve = async (bytes: number) => {
    const result = await deps.usage.reserve({ ownerId: auth.user.id, playbackSessionId: playback?.session.id ?? `thumbnail:${auth.loginSessionId}`,
      period: usagePeriod(deps.now(), deps.config.usageTimezone), requestedBytes: bytes, policy: deps.config.transferPolicy });
    if (!Number.isSafeInteger(result.grantedBytes) || result.grantedBytes <= 0 || result.grantedBytes > bytes) {
      throw new HttpError("TRANSFER_LIMIT_EXCEEDED");
    }
    reservation = result; sentForReservation = 0;
  };
  const settle = async () => {
    if (reservation) {
      const current = reservation;
      await deps.usage.settle({ ownerId: auth.user.id, reservationId: current.id, transferredBytes: sentForReservation });
      reservation = undefined; sentForReservation = 0;
    }
  };
  try {
    const metadata = await deps.storage.head({ object, signal: controller.signal });
    const range = parseRange(typeof request.headers.range === "string" ? request.headers.range : undefined, metadata.sizeBytes);
    const length = range ? range.end - range.start + 1 : metadata.sizeBytes;
    const type = playback ? "video/mp4" : metadata.contentType;
    if (!playback && !["image/jpeg", "image/png", "image/webp"].includes(type)) throw new HttpError("UNSUPPORTED_MEDIA_TYPE");
    reply.header("accept-ranges", "bytes").header("content-type", type).header("content-length", length)
      .header("x-content-type-options", "nosniff").header("cache-control", "no-store");
    if (range) reply.code(206).header("content-range", `bytes ${range.start}-${range.end}/${metadata.sizeBytes}`);
    if (request.method === "HEAD" || length === 0) { await reply.send(); return; }
    await reserve(Math.min(length, TRANSFER_BLOCK_BYTES));
    const read = await deps.storage.openRead({ object, ...(range ? { range } : {}), signal: controller.signal });
    upstream = read.stream;
    // 防止 head 与 get 之间对象变化：不转发错误对象长度/范围。
    if (read.metadata.sizeBytes !== metadata.sizeBytes || read.metadata.etag !== metadata.etag ||
      JSON.stringify(read.range) !== JSON.stringify(range)) throw new HttpError("STORAGE_UNAVAILABLE");
    controller.signal.throwIfAborted();
    for (const [key, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(key, value);
    reply.raw.statusCode = reply.statusCode; reply.hijack();
    let total = 0;
    for await (const chunk of upstream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (total + bytes.length > length) throw new HttpError("STORAGE_UNAVAILABLE");
      let offset = 0;
      while (offset < bytes.length) {
        controller.signal.throwIfAborted();
        await principal(context, request);
        if (playback && !await deps.playback.findActive({ principal: auth, sessionId: playback.session.id,
          videoId: playback.session.videoId, now: deps.now().toISOString() })) throw new HttpError("FORBIDDEN");
        if (!reservation) await reserve(Math.min(length - total, TRANSFER_BLOCK_BYTES));
        const count = Math.min(bytes.length - offset, reservation!.grantedBytes - sentForReservation);
        const segment = bytes.subarray(offset, offset + count);
        // 计量为交给 HTTP 输出队列的正文 byte；每请求最多一个 64KiB 在途块。
        await new Promise<void>((resolve, reject) => {
          const disconnected = () => reject(new Error("disconnected"));
          controller.signal.addEventListener("abort", disconnected, { once: true });
          if (controller.signal.aborted || reply.raw.destroyed) { controller.signal.removeEventListener("abort", disconnected); reject(new Error("disconnected")); return; }
          try {
            reply.raw.write(segment, error => {
              controller.signal.removeEventListener("abort", disconnected);
              if (error) reject(error); else resolve();
            });
            sentForReservation += count; total += count; offset += count;
          } catch (error) { controller.signal.removeEventListener("abort", disconnected); reject(error); }
        });
        if (sentForReservation === reservation!.grantedBytes) await settle();
      }
    }
    if (total !== length) throw new HttpError("STORAGE_UNAVAILABLE");
    await settle(); reply.raw.end();
  } catch (error) {
    if (error instanceof HttpError && error.code === "RANGE_NOT_SATISFIABLE") {
      const size = await deps.storage.head({ object, signal: controller.signal }); reply.header("content-range", `bytes */${size.sizeBytes}`);
    }
    if (reply.raw.headersSent || reply.sent) {
      request.log.warn({ code: error instanceof HttpError ? error.code : "STORAGE_UNAVAILABLE", requestId: request.id }, "media stream stopped");
      reply.raw.destroy();
    } else {
      reply.removeHeader("content-length"); reply.removeHeader("content-type");
      throw error instanceof HttpError ? error : new HttpError("STORAGE_UNAVAILABLE");
    }
  } finally {
    controller.abort(); upstream?.destroy(); dispose(); reply.raw.removeListener("close", abort);
    await settle();
  }
}

import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { HttpError } from "../../../core/errors.js";
import type { MediaContext } from "../context.js";
import { principal, requestSignal, text } from "../context.js";
import { UploadLocks } from "../upload/locks.js";
import { inspectCoverImage, MAX_COVER_BYTES } from "./image.js";
import { assertGuestRequest } from "../../../core/guest-access.js";

export function registerCoverRoutes(app: FastifyInstance, context: MediaContext): void {
  const { dependencies: deps } = context; const locks = new UploadLocks();
  app.addContentTypeParser("image/jpeg", { parseAs: "buffer", bodyLimit: MAX_COVER_BYTES }, (_request, body, done) => done(null, body));
  app.put<{ Params: { videoId: string } }>("/api/videos/:videoId/cover", { bodyLimit: MAX_COVER_BYTES }, async (request, reply) => {
    const auth = await principal(context, request, true); const videoId = text(request.params.videoId);
    if (!deps.config.library || !deps.storage.putImage || !deps.objects?.prepareCover || !deps.videos.saveCover) throw new HttpError("SERVICE_NOT_CONFIGURED");
    if (!Buffer.isBuffer(request.body) || request.headers["content-type"]?.split(";")[0]?.trim() !== "image/jpeg") throw new HttpError("UNSUPPORTED_MEDIA_TYPE");
    const bytes = request.body; const image = inspectCoverImage(bytes);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const { controller, dispose } = requestSignal(request, reply);
    try {
      return await locks.run(`${auth.user.id}:${videoId}`, async () => {
        controller.signal.throwIfAborted();
        const video = await deps.videos.findOwned(auth.user.id, videoId);
        if (!video) throw new HttpError("NOT_FOUND");
        const current = await principal(context, request, true);
        if (current.guest && !current.guest.permissions.includes("video_edit") && video.thumbnailObject) throw new HttpError("FORBIDDEN");
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(video.video.categoryId)) throw new HttpError("VALIDATION_ERROR");
        if (deps.config.storageDriver === "oss" && !deps.config.oss) throw new HttpError("SERVICE_NOT_CONFIGURED");
        const key = `${deps.config.library!.objectPrefix}${video.video.categoryId}/covers/${randomUUID()}.jpg`;
        const location = deps.config.storageDriver === "oss" ? { provider: "oss" as const, bucket: deps.config.oss!.bucket, region: deps.config.oss!.region, key, versionId: null }
          : { provider: "mock" as const, bucket: "", region: "", key, versionId: null };
        const prepared = await deps.objects!.prepareCover!({ ownerId: auth.user.id, videoId, checksum,
          sizeBytes: bytes.length, contentType: image.contentType, object: location });
        if (prepared.state === "registered") return { data: video.video };
        let objectCompleted = false;
        try {
          // 云对象已存在时只核验并关联，不覆盖、删除或再上传图片。
          let metadata; let recoveredObject = false;
          try { metadata = await deps.storage.head({ object: prepared.object, signal: controller.signal }); recoveredObject = true; }
          catch (error) {
            if (!(error instanceof HttpError) || error.code !== "NOT_FOUND") throw error;
            metadata = await deps.storage.putImage!({ object: prepared.object, bytes, contentType: image.contentType, signal: controller.signal });
          }
          objectCompleted = true;
          if (metadata.sizeBytes !== bytes.length || metadata.contentType.split(";")[0] !== image.contentType) throw new HttpError("FILE_MISMATCH");
          if (recoveredObject) {
            // 恢复读的是有界小图片，核对真实 SHA-256，不能只凭相同大小关联未知内容。
            const read = await deps.storage.openRead({ object: { ...prepared.object, versionId: metadata.versionId ?? null }, signal: controller.signal });
            const hash = createHash("sha256"); let size = 0;
            try {
              for await (const chunk of read.stream) {
                controller.signal.throwIfAborted(); size += Buffer.byteLength(chunk);
                if (size > bytes.length || size > MAX_COVER_BYTES) throw new HttpError("FILE_MISMATCH");
                hash.update(chunk);
              }
              if (size !== bytes.length || hash.digest("hex") !== checksum || read.metadata.etag !== metadata.etag) throw new HttpError("FILE_MISMATCH");
            } finally { read.stream.destroy(); }
          }
          await deps.objects!.recordOperation({ ownerId: auth.user.id, operationId: prepared.operationId, state: "object_completed" });
          const object = await deps.objects!.verify({ ownerId: auth.user.id, object: prepared.object, metadata });
          controller.signal.throwIfAborted();
          assertGuestRequest(request);
          const fresh = await principal(context, request, true);
          if (fresh.guest && !fresh.guest.permissions.includes("video_edit")) {
            const latest = await deps.videos.findOwned(auth.user.id, videoId);
            if (!latest) throw new HttpError("NOT_FOUND");
            if (latest.thumbnailObject) throw new HttpError("FORBIDDEN");
          }
          assertGuestRequest(request);
          const saved = await deps.videos.saveCover!({ ownerId: auth.user.id, videoId, thumbnailObject: object, operationId: prepared.operationId });
          return { data: saved.video };
        } catch (error) {
          const failure = objectCompleted && !(error instanceof HttpError && error.code === "FILE_MISMATCH")
            ? new HttpError("COVER_REGISTRATION_FAILED") : error instanceof HttpError ? error : new HttpError("STORAGE_UNAVAILABLE");
          try { await deps.objects!.recordOperation({ ownerId: auth.user.id, operationId: prepared.operationId, state: "failed", errorCode: failure.code }); }
          catch { request.log.error({ code: "COVER_RECOVERY_STATE_FAILED", videoId }, "cover recovery state could not be saved"); }
          throw failure;
        }
      });
    } finally { controller.abort(); dispose(); }
  });
}

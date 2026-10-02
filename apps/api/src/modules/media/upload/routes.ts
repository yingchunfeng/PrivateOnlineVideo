import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { FastifyInstance } from "fastify";
import { isPartChecksum } from "@online-video/shared";
import type { CreateUploadRequest, UploadTask } from "@online-video/shared";
import type { UploadRecord } from "../../../core/contracts/index.js";
import { HttpError } from "../../../core/errors.js";
import type { MediaContext } from "../context.js";
import { integer, principal, recordBody, requestSignal, text } from "../context.js";
import { UploadLocks } from "./locks.js";
import { makeVideo } from "./video.js";

export function publicUpload(record: UploadRecord): UploadTask {
  return { ...record.task, uploadedParts: [...record.parts].sort((a, b) => a.partNumber - b.partNumber)
    .map(({ partNumber, sizeBytes, checksum }) => ({ partNumber, sizeBytes, checksum })) };
}

export function registerUploadRoutes(app: FastifyInstance, context: MediaContext): void {
  const { dependencies: deps, options } = context; const locks = new UploadLocks();
  const active = new Map<string, number>();
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => { done(null, payload); });
  app.post("/api/uploads", async (request, reply) => {
    const auth = await principal(context, request, true); const body = recordBody(request.body);
    const input: CreateUploadRequest = { fileName: text(body.fileName), title: text(body.title), categoryId: text(body.categoryId),
      sizeBytes: integer(body.sizeBytes, 1, options.maxUploadBytes) };
    await deps.videos.assertCategoryOwned(auth.user.id, input.categoryId);
    const object = { key: `${options.objectPrefix}originals/${randomUUID()}` };
    const { controller, dispose } = requestSignal(request, reply);
    try {
      const multipart = await deps.storage.createMultipart({ object, contentType: "application/octet-stream", signal: controller.signal });
      controller.signal.throwIfAborted();
      const record = await deps.uploads.create({ ownerId: auth.user.id, request: input, object, storageUploadId: multipart.uploadId,
        partSizeBytes: options.partSizeBytes });
      return { data: publicUpload(record) };
    } finally { controller.abort(); dispose(); }
  });
  app.get<{ Params: { uploadId: string } }>("/api/uploads/:uploadId", async request => {
    const auth = await principal(context, request); const record = await deps.uploads.findOwned(auth.user.id, text(request.params.uploadId));
    if (!record) throw new HttpError("NOT_FOUND"); return { data: publicUpload(record) };
  });
  app.put<{ Params: { uploadId: string; partNumber: string } }>("/api/uploads/:uploadId/parts/:partNumber", {
    bodyLimit: options.partSizeBytes
  }, async (request, reply) => {
    const auth = await principal(context, request, true); const uploadId = text(request.params.uploadId);
    const checksum = request.headers["x-part-checksum"];
    if (!isPartChecksum(checksum) || !/^[1-9]\d*$/.test(request.params.partNumber)) throw new HttpError("VALIDATION_ERROR");
    const partNumber = integer(Number(request.params.partNumber), 1, 10_000);
    if (!(request.body instanceof Readable)) throw new HttpError("UNSUPPORTED_MEDIA_TYPE");
    const count = active.get(auth.user.id) ?? 0;
    if (count >= options.maxUploadConcurrency) throw new HttpError("RATE_LIMITED");
    active.set(auth.user.id, count + 1);
    const { controller, dispose } = requestSignal(request, reply);
    try {
      return await locks.run(uploadId, async () => {
        controller.signal.throwIfAborted();
        const record = await deps.uploads.findOwned(auth.user.id, uploadId);
        if (!record) throw new HttpError("NOT_FOUND");
        if (record.task.status !== "uploading") throw new HttpError("UPLOAD_STATE_CONFLICT");
        const expected = Math.min(record.task.partSizeBytes, record.task.sizeBytes - (partNumber - 1) * record.task.partSizeBytes);
        if (expected <= 0) throw new HttpError("VALIDATION_ERROR");
        const existing = record.parts.find(part => part.partNumber === partNumber);
        if (existing && (existing.checksum !== checksum || existing.sizeBytes !== expected)) throw new HttpError("FILE_MISMATCH");
        const declaredLength = request.headers["content-length"];
        if (declaredLength !== undefined && /^\d+$/.test(declaredLength) && Number(declaredLength) > options.partSizeBytes) throw new HttpError("PAYLOAD_TOO_LARGE");
        if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== expected)) throw new HttpError("FILE_MISMATCH");
        const hash = createHash("sha256"); let size = 0;
        const verify = new Transform({ highWaterMark: 64 * 1024, transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > expected || size > options.partSizeBytes) { callback(new HttpError("PAYLOAD_TOO_LARGE")); return; }
          hash.update(chunk); callback(null, chunk);
        }, flush(callback) {
          if (size !== expected || hash.digest("hex") !== checksum) callback(new HttpError("FILE_MISMATCH")); else callback();
        } });
        const abort = () => verify.destroy(new Error("aborted")); controller.signal.addEventListener("abort", abort, { once: true });
        const raw = request.body as Readable;
        const rawError = (error: Error) => verify.destroy(error); raw.once("error", rawError);
        raw.pipe(verify);
        try {
          let etag: string;
          if (existing) { for await (const _chunk of verify) { /* 仍重算重试原始字节，不能只相信头。 */ } etag = existing.etag; }
          else {
            const uploaded = await deps.storage.uploadPart({ object: record.object, uploadId: record.storageUploadId,
              partNumber, sizeBytes: expected, checksum, stream: verify, signal: controller.signal });
            etag = uploaded.etag;
          }
          // 适配器必须消费至 EOF；不能提前返回成功而跳过校验。
          if (!verify.readableEnded || size !== expected) throw new HttpError("FILE_MISMATCH");
          controller.signal.throwIfAborted();
          const saved = await deps.uploads.savePart(auth.user.id, uploadId, { partNumber, sizeBytes: expected, checksum, etag });
          const part = saved.parts.find(value => value.partNumber === partNumber)!;
          return { data: { partNumber: part.partNumber, sizeBytes: part.sizeBytes, checksum: part.checksum } };
        } finally {
          raw.unpipe(verify); raw.removeListener("error", rawError); controller.signal.removeEventListener("abort", abort); verify.destroy();
        }
      });
    } catch (error) { throw error instanceof HttpError ? error : new HttpError("STORAGE_UNAVAILABLE"); }
    finally {
      active.set(auth.user.id, (active.get(auth.user.id) ?? 1) - 1); controller.abort(); dispose();
    }
  });
  app.post<{ Params: { uploadId: string } }>("/api/uploads/:uploadId/complete", async (request, reply) => {
    const auth = await principal(context, request, true); const uploadId = text(request.params.uploadId);
    const { controller, dispose } = requestSignal(request, reply);
    try {
      return await locks.run(uploadId, async () => {
        controller.signal.throwIfAborted();
        let record = await deps.uploads.findOwned(auth.user.id, uploadId);
        if (!record) throw new HttpError("NOT_FOUND");
        if (record.task.status === "completed" && record.task.videoId) {
          const video = await deps.videos.findOwned(auth.user.id, record.task.videoId);
          if (!video) throw new HttpError("UPLOAD_STATE_CONFLICT");
          return { data: { upload: publicUpload(record), video: video.video } };
        }
        if (!["uploading", "failed", "finalizing"].includes(record.task.status)) throw new HttpError("UPLOAD_STATE_CONFLICT");
        const parts = [...record.parts].sort((a, b) => a.partNumber - b.partNumber);
        const total = Math.ceil(record.task.sizeBytes / record.task.partSizeBytes);
        if (parts.length !== total || parts.some((part, index) => part.partNumber !== index + 1 ||
          part.sizeBytes !== Math.min(record!.task.partSizeBytes, record!.task.sizeBytes - index * record!.task.partSizeBytes) || !isPartChecksum(part.checksum))) {
          throw new HttpError("UPLOAD_STATE_CONFLICT");
        }
        await deps.videos.assertCategoryOwned(auth.user.id, record.categoryId);
        record = await deps.uploads.transition(auth.user.id, uploadId, record.task.status, "finalizing");
        try {
          // failed 重试可接续“OSS 已完成、数据库登记失败”的场景，不重复覆盖对象。
          let metadata;
          try { metadata = await deps.storage.head({ object: record.object, signal: controller.signal }); }
          catch (error) {
            if (!(error instanceof HttpError) || error.code !== "NOT_FOUND") throw error;
            metadata = await deps.storage.completeMultipart({ object: record.object, uploadId: record.storageUploadId, parts, signal: controller.signal });
          }
          const verified = await deps.storage.head({ object: record.object, signal: controller.signal });
          if (metadata.sizeBytes !== record.task.sizeBytes || verified.sizeBytes !== record.task.sizeBytes || verified.etag !== metadata.etag) throw new HttpError("FILE_MISMATCH");
          const media = await options.metadata.inspect({ storage: deps.storage, object: record.object, signal: controller.signal });
          controller.signal.throwIfAborted();
          const video = await deps.videos.register(makeVideo({ ownerId: auth.user.id, title: record.title, categoryId: record.categoryId,
            object: record.object, sizeBytes: verified.sizeBytes, metadata: media, dependencies: deps }));
          const finished = await deps.uploads.transition(auth.user.id, uploadId, "finalizing", "completed", video.video.id);
          return { data: { upload: publicUpload(finished), video: video.video } };
        } catch (error) {
          await deps.uploads.transition(auth.user.id, uploadId, "finalizing", "failed");
          throw error instanceof HttpError ? error : new HttpError("STORAGE_UNAVAILABLE");
        }
      });
    } finally { controller.abort(); dispose(); }
  });
}

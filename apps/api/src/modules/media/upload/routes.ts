import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { FastifyInstance } from "fastify";
import { isPartChecksum, UPLOAD_STATUSES } from "@online-video/shared";
import type { CreateUploadRequest, UploadTask } from "@online-video/shared";
import type { UploadRecord } from "../../../core/contracts/index.js";
import { HttpError } from "../../../core/errors.js";
import { assertLibrarySelection } from "../../../core/library-config.js";
import type { MediaContext } from "../context.js";
import { assertOrganization, integer, organizationSelection, principal, recordBody, requestSignal, text } from "../context.js";
import { UploadLocks } from "./locks.js";
import { makeVideo } from "./video.js";
import { uploadFileType } from "./file.js";
import { unknownMetadata } from "../metadata/types.js";
import { assertGuestRequest, assertGuestUpload, bindGuestUpload, guestUploadPage } from "../../../core/guest-access.js";

async function assertUploadSelection(context: MediaContext, ownerId: string, record: UploadRecord): Promise<void> {
  // 公共任务已在创建时校验并保存快照，分类停用或标签改名不能阻断旧任务恢复。
  if (context.dependencies.config.library) {
    if (record.ownerId !== ownerId) throw new HttpError("NOT_FOUND");
    return;
  }
  await assertOrganization(context, ownerId, { categoryId: record.categoryId, groupIds: record.task.groupIds ?? [], tagIds: record.task.tagIds ?? [] });
}

export function publicUpload(record: UploadRecord): UploadTask {
  return { ...record.task, title: record.title, categoryId: record.categoryId, groupIds: record.task.groupIds ?? [], tagIds: record.task.tagIds ?? [],
    uploadedBytes: record.parts.reduce((total, part) => total + part.sizeBytes, 0),
    uploadedParts: [...record.parts].sort((a, b) => a.partNumber - b.partNumber)
    .map(({ partNumber, sizeBytes, checksum }) => ({ partNumber, sizeBytes, checksum })) };
}

export function registerUploadRoutes(app: FastifyInstance, context: MediaContext): void {
  const { dependencies: deps, options } = context; const locks = new UploadLocks();
  const active = new Map<string, number>();
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => { done(null, payload); });
  app.get<{ Querystring: { page?: string; pageSize?: string; status?: string } }>("/api/uploads", async request => {
    const auth = await principal(context, request);
    if (!deps.uploads.listOwned) throw new HttpError("SERVICE_NOT_CONFIGURED");
    const pageValue = (value: string | undefined, fallback: number, max: number) => {
      if (value === undefined) return fallback;
      if (!/^[1-9]\d*$/.test(value)) throw new HttpError("VALIDATION_ERROR");
      return integer(Number(value), 1, max);
    };
    const status = request.query.status;
    if (status !== undefined && !(UPLOAD_STATUSES as readonly string[]).includes(status)) throw new HttpError("VALIDATION_ERROR");
    const page = pageValue(request.query.page, 1, 1_000_000); const pageSize = pageValue(request.query.pageSize, 20, 100);
    const guestPage = guestUploadPage(request, page, pageSize, status);
    if (guestPage) {
      const records = await Promise.all(guestPage.ids.map(id => deps.uploads.findOwned(auth.user.id, id)));
      return { data: { page, pageSize, total: guestPage.total, items: records.filter(record => record !== null).map(publicUpload) } };
    }
    return { data: await deps.uploads.listOwned(auth.user.id, { page, pageSize, ...(status ? { status: status as UploadTask["status"] } : {}) }) };
  });
  app.post("/api/uploads", async (request, reply) => {
    const auth = await principal(context, request, true); const body = recordBody(request.body);
    const library = deps.config.library;
    const fileName = text(body.fileName); const title = text(body.title);
    const sizeBytes = integer(body.sizeBytes, 1, Number.MAX_SAFE_INTEGER);
    const clientRequestId = body.clientRequestId === undefined ? undefined : text(body.clientRequestId, 128);
    if (clientRequestId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(clientRequestId)) throw new HttpError("VALIDATION_ERROR");
    const requestTags = body.tags === undefined && library ? [] : body.tags;
    if (requestTags !== undefined && (!Array.isArray(requestTags) || requestTags.length > 100 ||
      requestTags.some(tag => typeof tag !== "string" || !tag.trim() || tag.length > 100) || new Set(requestTags).size !== requestTags.length)) throw new HttpError("VALIDATION_ERROR");
    const createTask = async () => {
      if (clientRequestId) {
        if (!deps.uploads.findByClientRequestId) throw new HttpError("SERVICE_NOT_CONFIGURED");
        const existing = await deps.uploads.findByClientRequestId(auth.user.id, clientRequestId,
          { fileName, title, sizeBytes, ...organizationSelection(body),
            ...(requestTags === undefined ? {} : { tags: requestTags as string[] }), clientRequestId });
        if (existing) { assertGuestUpload(request, existing.task.id); return { data: publicUpload(existing) }; }
      }
      integer(sizeBytes, 1, Math.min(options.getMaxUploadBytes?.() ?? options.maxUploadBytes, options.partSizeBytes * 10_000));
      const fileType = library ? uploadFileType(fileName) : null;
      const selected = library ? assertLibrarySelection(library, body) : null;
      if (selected && !deps.organizations?.normalizeSelection) throw new HttpError("SERVICE_NOT_CONFIGURED");
      const selection = selected ? await deps.organizations!.normalizeSelection!(auth.user.id, selected) : organizationSelection(body);
      const input: CreateUploadRequest = { fileName, title, ...selection, sizeBytes, ...(clientRequestId ? { clientRequestId } : {}) };
      await assertOrganization(context, auth.user.id, input);
      const key = library ? `${library.objectPrefix}${input.categoryId}/${randomUUID()}.${fileType!.extension}`
        : `${options.uploadObjectPrefix ?? `${options.objectPrefix}originals/`}${randomUUID()}`;
      const { controller, dispose } = requestSignal(request, reply);
      try {
        controller.signal.throwIfAborted();
        if (deps.objects && deps.uploads.attachMultipart) {
          if (deps.config.storageDriver === "oss" && !deps.config.oss) throw new HttpError("SERVICE_NOT_CONFIGURED");
          const location = deps.config.storageDriver === "oss" ? { provider: "oss" as const, bucket: deps.config.oss!.bucket, region: deps.config.oss!.region, key, versionId: null } :
            { provider: "mock" as const, bucket: "", region: "", key, versionId: null };
          const prepared = await deps.objects.prepare({ ownerId: auth.user.id, object: location, operation: "upload" });
          assertGuestRequest(request);
          const record = await deps.uploads.create({ ownerId: auth.user.id, request: input, object: prepared.object, storageUploadId: "",
            partSizeBytes: options.partSizeBytes, operationId: prepared.operationId });
          bindGuestUpload(request, record.task.id);
          // 首片才初始化云分片；创建失败不能让前端丢失已持久化任务的 ID。
          return { data: publicUpload(record) };
        }
        const object = { key };
        const multipart = await deps.storage.createMultipart({ object, contentType: fileType?.contentType ?? "application/octet-stream", signal: controller.signal });
        controller.signal.throwIfAborted();
        assertGuestRequest(request);
        const record = await deps.uploads.create({ ownerId: auth.user.id, request: input, object, storageUploadId: multipart.uploadId,
          partSizeBytes: options.partSizeBytes });
        bindGuestUpload(request, record.task.id);
        return { data: publicUpload(record) };
      } finally { controller.abort(); dispose(); }
    };
    return clientRequestId ? locks.run(`create:${auth.user.id}:${clientRequestId}`, createTask) : createTask();
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
        let record = await deps.uploads.findOwned(auth.user.id, uploadId);
        assertGuestRequest(request);
        if (!record) throw new HttpError("NOT_FOUND");
        if (record.task.status !== "uploading") throw new HttpError("UPLOAD_STATE_CONFLICT");
        const expected = Math.min(record.task.partSizeBytes, record.task.sizeBytes - (partNumber - 1) * record.task.partSizeBytes);
        if (expected <= 0) throw new HttpError("VALIDATION_ERROR");
        const existing = record.parts.find(part => part.partNumber === partNumber);
        if (existing && (existing.checksum !== checksum || existing.sizeBytes !== expected)) throw new HttpError("FILE_MISMATCH");
        const declaredLength = request.headers["content-length"];
        if (declaredLength !== undefined && /^\d+$/.test(declaredLength) && Number(declaredLength) > options.partSizeBytes) throw new HttpError("PAYLOAD_TOO_LARGE");
        if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== expected)) throw new HttpError("FILE_MISMATCH");
        if (!record.storageUploadId) {
          if (!deps.uploads.attachMultipart) throw new HttpError("UPLOAD_STATE_CONFLICT");
          await assertUploadSelection(context, auth.user.id, record);
          try {
            const multipart = await deps.storage.createMultipart({ object: record.object,
              contentType: deps.config.library ? uploadFileType(record.task.fileName).contentType : "application/octet-stream", signal: controller.signal });
            controller.signal.throwIfAborted();
            if (deps.objects && record.operationId) await deps.objects.recordOperation({ ownerId: auth.user.id,
              operationId: record.operationId, state: "multipart_started", storageUploadId: multipart.uploadId, uploadId });
            record = await deps.uploads.attachMultipart({ ownerId: auth.user.id, uploadId, storageUploadId: multipart.uploadId });
          } catch (error) {
            if (deps.objects && record.operationId) await deps.objects.recordOperation({ ownerId: auth.user.id,
              operationId: record.operationId, state: "failed", errorCode: error instanceof HttpError ? error.code : "STORAGE_UNAVAILABLE", uploadId });
            throw error;
          }
        }
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
          assertGuestRequest(request);
          const saved = await deps.uploads.savePart(auth.user.id, uploadId, { partNumber, sizeBytes: expected, checksum, etag });
          const part = saved.parts.find(value => value.partNumber === partNumber)!;
          return { data: { partNumber: part.partNumber, sizeBytes: part.sizeBytes, checksum: part.checksum } };
        } catch (error) {
          const failure = error instanceof HttpError ? error : new HttpError("STORAGE_UNAVAILABLE");
          // 暂停/断线保留可续传状态；实际存储或校验失败需能从持久任务历史查到。
          if (!controller.signal.aborted && deps.objects && record.operationId) {
            try { await deps.objects.recordOperation({ ownerId: auth.user.id, operationId: record.operationId,
              uploadId, state: "failed", errorCode: failure.code }); }
            catch { request.log.error({ code: "UPLOAD_RECOVERY_STATE_FAILED", uploadId }, "upload part failure state could not be saved"); }
          }
          throw failure;
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
        await assertUploadSelection(context, auth.user.id, record);
        assertGuestRequest(request);
        record = await deps.uploads.transition(auth.user.id, uploadId, record.task.status, "finalizing");
        let objectCompleted = false;
        try {
          // failed 重试可接续“OSS 已完成、数据库登记失败”的场景，不重复覆盖对象。
          let metadata;
          try { metadata = await deps.storage.head({ object: record.object, signal: controller.signal }); }
          catch (error) {
            if (!(error instanceof HttpError) || error.code !== "NOT_FOUND") throw error;
            metadata = await deps.storage.completeMultipart({ object: record.object, uploadId: record.storageUploadId, parts, signal: controller.signal });
          }
          if (metadata.sizeBytes !== record.task.sizeBytes) throw new HttpError("FILE_MISMATCH");
          objectCompleted = true;
          const verified = await deps.storage.head({ object: record.object, signal: controller.signal });
          if (metadata.sizeBytes !== record.task.sizeBytes || verified.sizeBytes !== record.task.sizeBytes || verified.etag !== metadata.etag) throw new HttpError("FILE_MISMATCH");
          if (deps.objects && record.operationId) await deps.objects.recordOperation({ ownerId: auth.user.id, operationId: record.operationId, state: "object_completed", uploadId });
          const object = deps.objects && record.object.kind === "registered"
            ? await deps.objects.verify({ ownerId: auth.user.id, object: record.object, metadata: verified }) : record.object;
          let media = { ...unknownMetadata };
          try { media = await options.metadata.inspect({ storage: deps.storage, object, signal: controller.signal }); }
          catch (error) {
            if (!deps.config.library || controller.signal.aborted) throw error;
            request.log.warn({ code: "METADATA_UNAVAILABLE", uploadId }, "optional video metadata unavailable");
          }
          const finalHead = await deps.storage.head({ object, signal: controller.signal });
          if (finalHead.sizeBytes !== verified.sizeBytes || finalHead.etag !== verified.etag || finalHead.versionId !== verified.versionId) throw new HttpError("FILE_MISMATCH");
          controller.signal.throwIfAborted();
          const videoInput = makeVideo({ ownerId: auth.user.id, title: record.title, categoryId: record.categoryId,
            groupIds: record.task.groupIds ?? [], tagIds: record.task.tagIds ?? [], tags: record.task.tags ?? [], fileName: record.task.fileName,
            object, sizeBytes: verified.sizeBytes, metadata: media, dependencies: deps });
          assertGuestRequest(request);
          if (deps.uploads.finishRegistration) {
            const result = await deps.uploads.finishRegistration({ ownerId: auth.user.id, uploadId, video: videoInput,
              ...(record.operationId ? { operationId: record.operationId } : {}) });
            return { data: { upload: publicUpload(result.upload), video: result.video.video } };
          }
          const video = await deps.videos.register(videoInput);
          const finished = await deps.uploads.transition(auth.user.id, uploadId, "finalizing", "completed", video.video.id);
          return { data: { upload: publicUpload(finished), video: video.video } };
        } catch (error) {
          const failure = deps.config.library && objectCompleted && !controller.signal.aborted &&
            !(error instanceof HttpError && error.code === "FILE_MISMATCH")
            ? new HttpError("UPLOAD_REGISTRATION_FAILED") : error instanceof HttpError ? error : new HttpError("STORAGE_UNAVAILABLE");
          try {
            if (deps.objects && record.operationId) await deps.objects.recordOperation({ ownerId: auth.user.id, operationId: record.operationId,
              state: "failed", errorCode: failure.code, uploadId });
          } catch { request.log.error({ code: "UPLOAD_RECOVERY_STATE_FAILED", uploadId }, "upload operation state could not be saved"); }
          try { await deps.uploads.transition(auth.user.id, uploadId, "finalizing", "failed"); }
          catch { request.log.error({ code: "UPLOAD_RECOVERY_STATE_FAILED", uploadId }, "upload failure state could not be saved"); }
          throw failure;
        }
      });
    } finally { controller.abort(); dispose(); }
  });
}

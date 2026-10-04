import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ImportPreview, ImportPreviewItem, VideoDetail } from "@online-video/shared";
import type { StorageListItem, StorageObjectRef, VideoRecord } from "../../../core/contracts/index.js";
import { HttpError } from "../../../core/errors.js";
import type { MediaContext } from "../context.js";
import { assertOrganization, organizationSelection, principal, recordBody, requestSignal, text } from "../context.js";
import { makeVideo } from "../upload/video.js";

interface PreviewRecord { ownerId: string; loginSessionId: string; expires: number; prefix: string; items: Map<string, StorageListItem>; dto: ImportPreview }
interface CursorRecord { ownerId: string; loginSessionId: string; expires: number; prefix: string; storageCursor: string }

export function registerImportRoutes(app: FastifyInstance, context: MediaContext): void {
  const { dependencies: deps, options } = context;
  const previews = new Map<string, PreviewRecord>();
  const cursors = new Map<string, CursorRecord>();
  const expire = () => {
    for (const [id, preview] of previews) if (preview.expires <= deps.now().getTime()) previews.delete(id);
    for (const [id, cursor] of cursors) if (cursor.expires <= deps.now().getTime()) cursors.delete(id);
  };
  app.post("/api/imports/preview", async (request, reply) => {
    const auth = await principal(context, request, true); const body = recordBody(request.body);
    const prefix = context.scope.subprefix(body.prefix === "" ? options.objectPrefix : text(body.prefix, 1024));
    expire(); if (previews.size >= options.maxPreviews) throw new HttpError("RATE_LIMITED");
    let storageCursor: string | undefined;
    if (body.cursor !== undefined) {
      const cursor = cursors.get(text(body.cursor));
      if (!cursor || cursor.ownerId !== auth.user.id || cursor.loginSessionId !== auth.loginSessionId || cursor.prefix !== prefix) throw new HttpError("NOT_FOUND");
      storageCursor = cursor.storageCursor;
    }
    const { controller, dispose } = requestSignal(request, reply);
    try {
      // 有界目录预览，最多一次列 100 条，不递归全 Bucket 扫描。
      const result = await deps.storage.list({ prefix, ...(storageCursor ? { cursor: storageCursor } : {}), limit: 100, signal: controller.signal });
      controller.signal.throwIfAborted();
      const items = new Map<string, StorageListItem>();
      const dtoItems: ImportPreviewItem[] = [];
      for (const entry of result.items) {
        context.scope.key(entry.object);
        if (!entry.object.key.startsWith(prefix)) throw new HttpError("FORBIDDEN");
        if (!Number.isSafeInteger(entry.metadata.sizeBytes) || entry.metadata.sizeBytes <= 0) continue;
        // 仅筛候选，最终兼容性须由内容分析决定。
        if (!entry.metadata.contentType.startsWith("video/") && !/\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(entry.fileName)) continue;
        // 列表不是版本核验证据；私有预览读取 HEAD 固定存在性/ETag/版本快照。
        const head = await deps.storage.head({ object: entry.object, signal: controller.signal });
        if (head.sizeBytes !== entry.metadata.sizeBytes || head.etag !== entry.metadata.etag) throw new HttpError("FILE_MISMATCH");
        const object = entry.object.kind === "registered" ? { ...entry.object, versionId: head.versionId ?? null } : entry.object;
        const id = randomUUID(); items.set(id, { ...entry, object, metadata: head });
        dtoItems.push({ id, fileName: entry.fileName, sizeBytes: head.sizeBytes, durationSeconds: null, codec: null });
      }
      const id = randomUUID(); const expires = deps.now().getTime() + options.previewTtlMs;
      let nextCursor: string | null = null;
      if (result.nextCursor) {
        if (cursors.size >= options.maxPreviews) throw new HttpError("RATE_LIMITED");
        nextCursor = randomUUID(); cursors.set(nextCursor, { ownerId: auth.user.id, loginSessionId: auth.loginSessionId, prefix, storageCursor: result.nextCursor, expires });
      }
      const dto: ImportPreview = { id, items: dtoItems, expiresAt: new Date(expires).toISOString(), nextCursor };
      previews.set(id, { ownerId: auth.user.id, loginSessionId: auth.loginSessionId, prefix, items, expires, dto });
      return { data: dto };
    } catch (error) { throw error instanceof HttpError ? error : new HttpError("STORAGE_UNAVAILABLE"); }
    finally { controller.abort(); dispose(); }
  });
  app.post("/api/imports/commit", async (request, reply) => {
    const auth = await principal(context, request, true); const body = recordBody(request.body);
    const previewId = text(body.previewId); const selection = organizationSelection(body);
    if (!Array.isArray(body.itemIds) || body.itemIds.length < 1 || body.itemIds.length > 100) throw new HttpError("VALIDATION_ERROR");
    const itemIds = body.itemIds.map(id => text(id));
    if (new Set(itemIds).size !== itemIds.length) throw new HttpError("VALIDATION_ERROR");
    const existingVideoId = body.existingVideoId === undefined ? undefined : text(body.existingVideoId);
    if (existingVideoId && itemIds.length !== 1) throw new HttpError("VALIDATION_ERROR");
    expire(); const preview = previews.get(previewId);
    if (!preview || preview.ownerId !== auth.user.id || preview.loginSessionId !== auth.loginSessionId) throw new HttpError("NOT_FOUND");
    const existingVideo = existingVideoId ? await deps.videos.findOwned(auth.user.id, existingVideoId) : undefined;
    if (existingVideoId && !existingVideo) throw new HttpError("NOT_FOUND");
    if (!existingVideoId) await assertOrganization(context, auth.user.id, selection);
    else if (!deps.videos.bindLegacy) throw new HttpError("SERVICE_NOT_CONFIGURED");
    const selected = itemIds.map(id => {
      const entry = preview.items.get(id); if (!entry) throw new HttpError("FORBIDDEN");
      context.scope.key(entry.object);
      if (!entry.object.key.startsWith(preview.prefix)) throw new HttpError("FORBIDDEN");
      return entry;
    });
    if (existingVideo && existingVideo.originalObject.key !== selected[0]!.object.key) throw new HttpError("FILE_MISMATCH");
    const { controller, dispose } = requestSignal(request, reply);
    const operations: { id: string; registered: boolean }[] = [];
    try {
      // 先复核所有选中对象，再写任何元数据；不存在、替换或越界均不产生部分登记。
      for (const entry of selected) {
        const head = await deps.storage.head({ object: entry.object, signal: controller.signal });
        if (head.etag !== entry.metadata.etag || head.sizeBytes !== entry.metadata.sizeBytes || (head.versionId ?? null) !== (entry.metadata.versionId ?? null)) throw new HttpError("FILE_MISMATCH");
      }
      const candidates: { video: VideoRecord; entry: StorageListItem; operation?: { id: string; registered: boolean } }[] = [];
      for (const entry of selected) {
        let object: StorageObjectRef = entry.object; let operation: { id: string; registered: boolean } | undefined;
        if (deps.objects) {
          if (object.kind !== "registered" && deps.config.storageDriver === "oss") throw new HttpError("SERVICE_NOT_CONFIGURED");
          const identity = object.kind === "registered" ? { provider: object.provider, bucket: object.bucket, region: object.region, key: object.key, versionId: object.versionId } :
            { provider: "mock" as const, bucket: "", region: "", key: object.key, versionId: null };
          const prepared = await deps.objects.prepare({ ownerId: auth.user.id, object: identity, operation: "import" });
          operation = { id: prepared.operationId, registered: false }; operations.push(operation);
          object = await deps.objects.verify({ ownerId: auth.user.id, object: prepared.object, metadata: entry.metadata });
        }
        const metadata = await options.metadata.inspect({ storage: deps.storage, object, signal: controller.signal });
        const checked = await deps.storage.head({ object, signal: controller.signal });
        if (checked.etag !== entry.metadata.etag || checked.sizeBytes !== entry.metadata.sizeBytes || (checked.versionId ?? null) !== (entry.metadata.versionId ?? null)) throw new HttpError("FILE_MISMATCH");
        controller.signal.throwIfAborted();
        candidates.push({ video: makeVideo({ ownerId: auth.user.id, title: entry.fileName, categoryId: selection.categoryId,
          groupIds: selection.groupIds ?? [], tagIds: selection.tagIds ?? [], object, sizeBytes: entry.metadata.sizeBytes, metadata, dependencies: deps }), entry,
          ...(operation ? { operation } : {}) });
      }
      // 全部分析完成后复核，避免最后一项在分析中被替换却先登记前面的项。
      for (const candidate of candidates) {
        const checked = await deps.storage.head({ object: candidate.video.originalObject, signal: controller.signal });
        if (checked.etag !== candidate.entry.metadata.etag || checked.sizeBytes !== candidate.entry.metadata.sizeBytes ||
          (checked.versionId ?? null) !== (candidate.entry.metadata.versionId ?? null)) throw new HttpError("FILE_MISMATCH");
      }
      if (!existingVideoId) await assertOrganization(context, auth.user.id, selection);
      const videos: VideoDetail[] = [];
      for (const candidate of candidates) {
        controller.signal.throwIfAborted();
        const video = existingVideoId
          ? await deps.videos.bindLegacy!({ ownerId: auth.user.id, videoId: existingVideoId, record: candidate.video })
          : await deps.videos.register(candidate.video);
        if (candidate.operation && deps.objects) {
          await deps.objects.recordOperation({ ownerId: auth.user.id, operationId: candidate.operation.id, state: "registered", videoId: video.video.id });
          candidate.operation.registered = true;
        }
        videos.push(video.video);
      }
      return { data: { videos } };
    } catch (error) {
      for (const operation of operations.filter(value => !value.registered)) {
        await deps.objects!.recordOperation({ ownerId: auth.user.id, operationId: operation.id, state: "failed", errorCode: error instanceof HttpError ? error.code : "STORAGE_UNAVAILABLE" });
      }
      throw error instanceof HttpError ? error : new HttpError("STORAGE_UNAVAILABLE");
    }
    finally { controller.abort(); dispose(); }
  });
}

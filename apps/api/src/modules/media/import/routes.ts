import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ImportPreview, ImportPreviewItem, VideoDetail } from "@online-video/shared";
import type { StorageListItem } from "../../../core/contracts/index.js";
import { HttpError } from "../../../core/errors.js";
import type { MediaContext } from "../context.js";
import { principal, recordBody, requestSignal, text } from "../context.js";
import { makeVideo } from "../upload/video.js";

interface PreviewRecord { ownerId: string; loginSessionId: string; expires: number; prefix: string; items: Map<string, StorageListItem>; dto: ImportPreview }

export function registerImportRoutes(app: FastifyInstance, context: MediaContext): void {
  const { dependencies: deps, options } = context;
  const previews = new Map<string, PreviewRecord>();
  const expire = () => { for (const [id, preview] of previews) if (preview.expires <= deps.now().getTime()) previews.delete(id); };
  app.post("/api/imports/preview", async (request, reply) => {
    const auth = await principal(context, request, true); const body = recordBody(request.body);
    const prefix = context.scope.subprefix(body.prefix === "" ? options.objectPrefix : text(body.prefix, 1024));
    expire(); if (previews.size >= options.maxPreviews) throw new HttpError("RATE_LIMITED");
    const { controller, dispose } = requestSignal(request, reply);
    try {
      // 有界目录预览，最多一次列 100 条，不递归全 Bucket 扫描。
      const result = await deps.storage.list({ prefix, limit: 100, signal: controller.signal });
      controller.signal.throwIfAborted();
      const items = new Map<string, StorageListItem>();
      const dtoItems: ImportPreviewItem[] = [];
      for (const entry of result.items) {
        context.scope.key(entry.object);
        if (!entry.object.key.startsWith(prefix)) throw new HttpError("FORBIDDEN");
        if (!Number.isSafeInteger(entry.metadata.sizeBytes) || entry.metadata.sizeBytes <= 0) continue;
        // 仅筛候选，最终兼容性须由内容分析决定。
        if (!entry.metadata.contentType.startsWith("video/") && !/\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(entry.fileName)) continue;
        const id = randomUUID(); items.set(id, entry);
        dtoItems.push({ id, fileName: entry.fileName, sizeBytes: entry.metadata.sizeBytes, durationSeconds: null, codec: null });
      }
      const id = randomUUID(); const expires = deps.now().getTime() + options.previewTtlMs;
      const dto: ImportPreview = { id, items: dtoItems, expiresAt: new Date(expires).toISOString() };
      previews.set(id, { ownerId: auth.user.id, loginSessionId: auth.loginSessionId, prefix, items, expires, dto });
      return { data: dto };
    } catch (error) { throw error instanceof HttpError ? error : new HttpError("STORAGE_UNAVAILABLE"); }
    finally { controller.abort(); dispose(); }
  });
  app.post("/api/imports/commit", async (request, reply) => {
    const auth = await principal(context, request, true); const body = recordBody(request.body);
    const previewId = text(body.previewId); const categoryId = text(body.categoryId);
    if (!Array.isArray(body.itemIds) || body.itemIds.length < 1 || body.itemIds.length > 100) throw new HttpError("VALIDATION_ERROR");
    const itemIds = body.itemIds.map(id => text(id));
    if (new Set(itemIds).size !== itemIds.length) throw new HttpError("VALIDATION_ERROR");
    expire(); const preview = previews.get(previewId);
    if (!preview || preview.ownerId !== auth.user.id || preview.loginSessionId !== auth.loginSessionId) throw new HttpError("NOT_FOUND");
    await deps.videos.assertCategoryOwned(auth.user.id, categoryId);
    const selected = itemIds.map(id => {
      const entry = preview.items.get(id); if (!entry) throw new HttpError("FORBIDDEN");
      context.scope.key(entry.object);
      if (!entry.object.key.startsWith(preview.prefix)) throw new HttpError("FORBIDDEN");
      return entry;
    });
    const { controller, dispose } = requestSignal(request, reply);
    try {
      // 先复核所有选中对象，再写任何元数据；不存在、替换或越界均不产生部分登记。
      for (const entry of selected) {
        const head = await deps.storage.head({ object: entry.object, signal: controller.signal });
        if (head.etag !== entry.metadata.etag || head.sizeBytes !== entry.metadata.sizeBytes) throw new HttpError("FILE_MISMATCH");
      }
      const videos: VideoDetail[] = [];
      for (const entry of selected) {
        const metadata = await options.metadata.inspect({ storage: deps.storage, object: entry.object, signal: controller.signal });
        const checked = await deps.storage.head({ object: entry.object, signal: controller.signal });
        if (checked.etag !== entry.metadata.etag || checked.sizeBytes !== entry.metadata.sizeBytes) throw new HttpError("FILE_MISMATCH");
        controller.signal.throwIfAborted();
        const video = await deps.videos.register(makeVideo({ ownerId: auth.user.id, title: entry.fileName, categoryId,
          object: entry.object, sizeBytes: entry.metadata.sizeBytes, metadata, dependencies: deps }));
        videos.push(video.video);
      }
      return { data: { videos } };
    } catch (error) { throw error instanceof HttpError ? error : new HttpError("STORAGE_UNAVAILABLE"); }
    finally { controller.abort(); dispose(); }
  });
}

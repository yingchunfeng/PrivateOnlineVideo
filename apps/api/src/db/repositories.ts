import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { isPartChecksum, isVideoDuration, UPLOAD_STATUSES, VIDEO_STATUSES } from "@online-video/shared";
import type { ApplicationUsage, LibraryConfig, VideoDetail, UploadTask, CreateUploadRequest } from "@online-video/shared";
import type { AuthPrincipal, VideoRecord, UploadRecord, PlaybackRecord, VideoRepository, UploadRepository, PlaybackRepository, UsageRepository } from "../core/contracts/index.js";
import { HttpError } from "../core/errors.js";
import type { AppDatabase } from "./database.js";
import * as s from "./schema.js";
import { createLibraryPersistence, createCatalogPersistence } from "./library.js";
import { publicUrlFor } from "../core/library-config.js";
import { accountReady, currentUser } from "../modules/auth/service.js";
import { authenticationUser } from "../modules/auth/login-mode.js";

function bytes(value: number, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new HttpError("VALIDATION_ERROR");
  return value;
}
function timestamp(value: string) {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new HttpError("VALIDATION_ERROR");
  return value;
}
function key(value: string) {
  if (!value || value.startsWith("/") || /[\\%?#\x00-\x1f]/.test(value) || value.split("/").some(v => v === "." || v === "..")) throw new HttpError("VALIDATION_ERROR");
  return value;
}
function requestEventId(ownerId: string, clientRequestId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(clientRequestId)) throw new HttpError("VALIDATION_ERROR");
  return `upload-request-${createHash("sha256").update(JSON.stringify([ownerId, clientRequestId])).digest("hex")}`;
}
function requestFingerprint(request: CreateUploadRequest) {
  return JSON.stringify({ fileName: request.fileName, title: request.title, sizeBytes: request.sizeBytes, categoryId: request.categoryId,
    ...(request.tags === undefined ? { groupIds: [...(request.groupIds ?? [])].sort(), tagIds: [...(request.tagIds ?? [])].sort() } : { tags: [...request.tags].sort() }) });
}
export function createRepositories(database: AppDatabase, now: () => Date = () => new Date(), config?: LibraryConfig) {
  const { orm: db, client } = database;
  const atomic = <T>(operation: () => T): T => client.transaction(operation).immediate();
  const library = createLibraryPersistence(database, now, config);
  const assertCategory = (ownerId: string, categoryId: string) => {
    library.assertSelection(ownerId, { categoryId });
  };
  const videoRow = (ownerId: string, id: string) => db.select().from(s.videos).where(and(eq(s.videos.id, id), eq(s.videos.ownerId, ownerId))).get();
  const videoRecord = (row: typeof s.videos.$inferSelect): VideoRecord => {
    const position = db.select().from(s.watchProgress).where(and(eq(s.watchProgress.ownerId, row.ownerId), eq(s.watchProgress.videoId, row.id))).get();
    const upload = config ? client.prepare("SELECT file_name FROM upload_tasks WHERE owner_id=? AND video_id=? ORDER BY created_at,id LIMIT 1").get(row.ownerId, row.id) as { file_name: string } | undefined : undefined;
    const coverOperation = config ? client.prepare("SELECT state FROM storage_operations WHERE owner_id=? AND video_id=? AND upload_id IS NULL AND operation_type='upload' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(row.ownerId, row.id) as { state: string } | undefined : undefined;
    return { ownerId: row.ownerId, originalObject: library.asset(row.ownerId, row.id, "original", row.originalKey), playbackObject: library.asset(row.ownerId, row.id, "playback", row.playbackKey),
      thumbnailObject: row.thumbnailKey ? library.asset(row.ownerId, row.id, "thumbnail", row.thumbnailKey) : null, video: {
        id: row.id, title: row.title, categoryId: row.categoryId, durationSeconds: isVideoDuration(row.durationSeconds) ? row.durationSeconds : null, sizeBytes: row.sizeBytes,
        groupIds: library.getLinks("video", "group", row.ownerId, row.id), tagIds: library.getLinks("video", "tag", row.ownerId, row.id),
        ...(config ? { tags: library.getTagNames("video", row.ownerId, row.id, row.categoryId), objectKey: row.originalKey, publicUrl: publicUrlFor(config, row.originalKey), fileName: upload?.file_name ?? row.originalKey.split("/").at(-1)!,
          coverObjectKey: row.thumbnailKey, coverUrl: row.thumbnailKey ? publicUrlFor(config, row.thumbnailKey) : null, coverStatus: coverOperation?.state === "failed" ? "failed" as const : coverOperation && !["registered"].includes(coverOperation.state) ? "saving" as const : row.thumbnailKey ? "saved" as const : "missing" as const } : {}),
        status: row.status as VideoDetail["status"], thumbnailUrl: row.thumbnailKey ? `/api/videos/${encodeURIComponent(row.id)}/thumbnail` : null,
        createdAt: row.createdAt, codec: row.codec, width: row.width, height: row.height, playable: row.playable,
        lastPositionSeconds: position?.positionSeconds ?? 0
      } };
  };
  const findUpload = (ownerId: string, id: string) => db.select().from(s.uploadTasks).where(and(eq(s.uploadTasks.id, id), eq(s.uploadTasks.ownerId, ownerId))).get();
  const uploadRecord = (row: typeof s.uploadTasks.$inferSelect): UploadRecord => {
    const parts = db.select().from(s.uploadParts).where(eq(s.uploadParts.uploadId, row.id)).orderBy(s.uploadParts.partNumber).all();
    const operation = client.prepare("SELECT id,storage_upload_id,error_code FROM storage_operations WHERE owner_id=? AND upload_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(row.ownerId, row.id) as { id: string; storage_upload_id: string | null; error_code: string | null } | undefined;
    const intent = client.prepare("SELECT action FROM audit_events WHERE owner_id=? AND id=?").get(row.ownerId, `upload-request-${row.id}`) as { action: string } | undefined;
    const snapshot = intent ? JSON.parse(intent.action) as { clientRequestId: string } : undefined;
    const video = row.videoId ? videoRow(row.ownerId, row.videoId) : undefined;
    const cover = video ? videoRecord(video).video : undefined;
    return { ...(operation ? { operationId: operation.id } : {}), ownerId: row.ownerId, title: row.title, categoryId: row.categoryId, object: library.uploadObject(row.ownerId, row.id, row.objectKey), storageUploadId: row.storageUploadId || operation?.storage_upload_id || "",
      parts: parts.map(({ partNumber, sizeBytes, checksum, etag }) => ({ partNumber, sizeBytes, checksum, etag })), task: {
        id: row.id, videoId: row.videoId, fileName: row.fileName, sizeBytes: row.sizeBytes, partSizeBytes: row.partSizeBytes,
        title: row.title, categoryId: row.categoryId, groupIds: library.getLinks("upload", "group", row.ownerId, row.id), tagIds: library.getLinks("upload", "tag", row.ownerId, row.id),
        ...(config ? { tags: library.getTagNames("upload", row.ownerId, row.id, row.categoryId), objectKey: row.objectKey, publicUrl: publicUrlFor(config, row.objectKey),
          uploadedBytes: parts.reduce((sum, part) => sum + part.sizeBytes, 0), errorCode: operation?.error_code ?? null,
          coverObjectKey: cover?.coverObjectKey ?? null, coverUrl: cover?.coverUrl ?? null, coverStatus: cover?.coverStatus ?? "missing" } : {}),
        ...(snapshot ? { clientRequestId: snapshot.clientRequestId } : {}),
        status: row.status as UploadTask["status"], createdAt: row.createdAt,
        uploadedParts: parts.map(({ partNumber, sizeBytes, checksum }) => ({ partNumber, sizeBytes, checksum }))
      } };
  };
  const requireLogin = (principal: AuthPrincipal, at: string) => {
    const login = db.select().from(s.loginSessions).where(and(eq(s.loginSessions.id, principal.loginSessionId),
      eq(s.loginSessions.ownerId, principal.user.id), isNull(s.loginSessions.revokedAt), gt(s.loginSessions.expiresAt, at))).get();
    const user = db.select().from(s.users).where(eq(s.users.id, principal.user.id)).get();
    if (!login || !user || !accountReady(authenticationUser(database, user)) || login.authVersion !== user.authVersion || principal.user.authVersion !== user.authVersion) throw new HttpError("SESSION_EXPIRED");
    return login;
  };
  const playbackRecord = (row: typeof s.playbackSessions.$inferSelect): PlaybackRecord => ({ ownerId: row.ownerId,
    loginSessionId: row.loginSessionId, lastSeenAt: row.lastSeenAt, closedAt: row.closedAt,
    session: row.mode === "oss" ? { id: row.id, videoId: row.videoId, mode: "oss", expiresAt: row.expiresAt, sourceUrl: "",
      sourceExpiresAt: row.sourceExpiresAt ?? row.createdAt, renewAfter: row.sourceExpiresAt ?? row.createdAt }
      : { id: row.id, videoId: row.videoId, mode: "proxy", expiresAt: row.expiresAt,
      sourceUrl: `/api/videos/${encodeURIComponent(row.videoId)}/stream?playbackSessionId=${encodeURIComponent(row.id)}` } });
  const activePlayback = (principal: AuthPrincipal, id: string, at: string) => {
    requireLogin(principal, at);
    return db.select().from(s.playbackSessions).where(and(eq(s.playbackSessions.id, id), eq(s.playbackSessions.ownerId, principal.user.id),
      eq(s.playbackSessions.loginSessionId, principal.loginSessionId), isNull(s.playbackSessions.closedAt), gt(s.playbackSessions.expiresAt, at))).get();
  };
  const activeCount = (ownerId: string, at: string): number => db.select({ count: sql<number>`count(*)` }).from(s.playbackSessions)
    .innerJoin(s.loginSessions, eq(s.loginSessions.id, s.playbackSessions.loginSessionId)).where(and(eq(s.playbackSessions.ownerId, ownerId),
      isNull(s.playbackSessions.closedAt), gt(s.playbackSessions.expiresAt, at), isNull(s.loginSessions.revokedAt), gt(s.loginSessions.expiresAt, at))).get()!.count;

  const videos: VideoRepository = {
    saveDurationIfMissing: async (ownerId, id, input) => atomic(() => {
      if (!isVideoDuration(input.durationSeconds) || typeof input.expectedObjectKey !== "string") throw new HttpError("VALIDATION_ERROR");
      const row = videoRow(ownerId, id); if (!row) throw new HttpError("NOT_FOUND");
      if (input.expectedObjectKey !== row.originalKey) throw new HttpError("FILE_MISMATCH");
      if (!isVideoDuration(row.durationSeconds)) {
        db.update(s.videos).set({ durationSeconds: input.durationSeconds }).where(and(eq(s.videos.id, id), eq(s.videos.ownerId, ownerId))).run();
      }
      return videoRecord(videoRow(ownerId, id)!);
    }),
    deleteOwnedRecord: async (ownerId, id) => atomic(() => {
      const row = videoRow(ownerId, id); if (!row) throw new HttpError("NOT_FOUND");
      const at = now().toISOString();
      const uploading = client.prepare("SELECT 1 FROM upload_tasks WHERE owner_id=? AND (video_id=? OR object_key=?) AND status<>'completed' LIMIT 1").get(ownerId, id, row.originalKey);
      const savingCover = client.prepare("SELECT 1 FROM storage_operations WHERE owner_id=? AND video_id=? AND upload_id IS NULL AND state NOT IN ('registered','failed') LIMIT 1").get(ownerId, id);
      const playing = client.prepare("SELECT 1 FROM playback_sessions p JOIN login_sessions l ON l.id=p.login_session_id AND l.owner_id=p.owner_id WHERE p.owner_id=? AND p.video_id=? AND p.closed_at IS NULL AND p.expires_at>? AND l.revoked_at IS NULL AND l.expires_at>? LIMIT 1").get(ownerId, id, at, at);
      if (uploading || savingCover || playing) throw new HttpError("VIDEO_RECORD_BUSY");
      const address = (objectKey: string) => { try { return config ? publicUrlFor(config, objectKey) : null; } catch { return null; } };
      const original = library.asset(ownerId, id, "original", row.originalKey);
      const playback = library.asset(ownerId, id, "playback", row.playbackKey);
      const thumbnail = row.thumbnailKey ? library.asset(ownerId, id, "thumbnail", row.thumbnailKey) : null;
      const objects = ([ ["original", original], ["playback", playback], ["thumbnail", thumbnail] ] as const)
        .flatMap(([role, object]) => object ? [{ role, objectKey: object.key, bucket: object.kind === "registered" && object.bucket ? object.bucket : null,
          publicUrl: address(object.key) }] : []);
      // 只清理站内关系；对象身份、任务及审计保留，绝不调用存储适配器。
      client.prepare("DELETE FROM source_authorizations WHERE owner_id=? AND video_id=?").run(ownerId, id);
      client.prepare("DELETE FROM playback_sessions WHERE owner_id=? AND video_id=?").run(ownerId, id);
      client.prepare("DELETE FROM watch_progress WHERE owner_id=? AND video_id=?").run(ownerId, id);
      client.prepare("DELETE FROM video_group_links WHERE owner_id=? AND video_id=?").run(ownerId, id);
      client.prepare("DELETE FROM video_tag_links WHERE owner_id=? AND video_id=?").run(ownerId, id);
      client.prepare("DELETE FROM video_assets WHERE owner_id=? AND video_id=?").run(ownerId, id);
      client.prepare("UPDATE upload_tasks SET video_id=NULL WHERE owner_id=? AND video_id=?").run(ownerId, id);
      client.prepare("UPDATE storage_operations SET video_id=NULL WHERE owner_id=? AND video_id=?").run(ownerId, id);
      client.prepare("DELETE FROM videos WHERE owner_id=? AND id=?").run(ownerId, id);
      client.prepare("INSERT INTO audit_events(id,owner_id,action,created_at) VALUES(?,?,?,?)").run(randomUUID(), ownerId,
        JSON.stringify({ action: "video_record_deleted", videoId: id, objects }), at);
      return { videoId: id, title: row.title, objects };
    }),
    saveCover: async input => atomic(() => {
      const row = videoRow(input.ownerId, input.videoId); if (!row) throw new HttpError("NOT_FOUND");
      library.assertObject(input.ownerId, input.thumbnailObject);
      if (input.operationId && !client.prepare("SELECT 1 FROM storage_operations WHERE owner_id=? AND id=? AND video_id=? AND storage_object_id=? AND upload_id IS NULL").get(input.ownerId, input.operationId, input.videoId, input.thumbnailObject.id)) throw new HttpError("UPLOAD_STATE_CONFLICT");
      library.attachAssets(input.ownerId, input.videoId, { originalObject: library.asset(input.ownerId, input.videoId, "original", row.originalKey), playbackObject: library.asset(input.ownerId, input.videoId, "playback", row.playbackKey), thumbnailObject: input.thumbnailObject });
      db.update(s.videos).set({ thumbnailKey: key(input.thumbnailObject.key) }).where(and(eq(s.videos.id, input.videoId), eq(s.videos.ownerId, input.ownerId))).run();
      if (input.operationId) client.prepare("UPDATE storage_operations SET state='registered',error_code=NULL,updated_at=? WHERE owner_id=? AND id=?").run(now().toISOString(), input.ownerId, input.operationId);
      return videoRecord(videoRow(input.ownerId, input.videoId)!);
    }),
    assertCategoryOwned: async (ownerId, categoryId) => assertCategory(ownerId, categoryId),
    assertOrganizationOwned: async (ownerId, selection) => library.assertSelection(ownerId, selection),
    findOwned: async (ownerId, id) => { const row = videoRow(ownerId, id); return row ? videoRecord(row) : null; },
    register: async input => atomic(() => {
      const v = config && input.video.tags !== undefined ? { ...input.video, ...library.normalizeSelection(input.ownerId, { categoryId: input.video.categoryId, tags: input.video.tags }) } : input.video;
      library.assertSelection(input.ownerId, { categoryId: v.categoryId, groupIds: v.groupIds ?? [], tagIds: v.tagIds ?? [] }); key(input.originalObject.key); key(input.playbackObject.key);
      library.assertObject(input.ownerId, input.originalObject); library.assertObject(input.ownerId, input.playbackObject);
      if (input.thumbnailObject) key(input.thumbnailObject.key);
      bytes(v.sizeBytes); timestamp(v.createdAt);
      if (!VIDEO_STATUSES.includes(v.status) || !v.id || !v.title.trim() || v.title.length > 256) throw new HttpError("VALIDATION_ERROR");
      const identity = input.originalObject.kind === "registered" ? client.prepare("SELECT video_id FROM video_assets WHERE owner_id=? AND storage_object_id=? AND asset_role='original'").get(input.ownerId, input.originalObject.id) as { video_id: string } | undefined : undefined;
      const existing = input.originalObject.kind === "registered" ? identity ? videoRow(input.ownerId, identity.video_id) : undefined
        : db.select().from(s.videos).where(and(eq(s.videos.ownerId, input.ownerId), eq(s.videos.originalKey, input.originalObject.key))).get();
      if (existing) return videoRecord(existing);
      db.insert(s.videos).values({ id: v.id, ownerId: input.ownerId, title: v.title, categoryId: v.categoryId,
        durationSeconds: isVideoDuration(v.durationSeconds) ? v.durationSeconds : null, sizeBytes: v.sizeBytes, status: v.status, createdAt: v.createdAt, codec: v.codec,
        width: v.width, height: v.height, playable: v.playable, originalKey: input.originalObject.key,
        playbackKey: input.playbackObject.key, thumbnailKey: input.thumbnailObject?.key ?? null }).run();
      library.attachAssets(input.ownerId, v.id, input);
      library.setLinks("video", "group", input.ownerId, v.id, v.groupIds ?? []); library.setLinks("video", "tag", input.ownerId, v.id, v.tagIds ?? []);
      return videoRecord(videoRow(input.ownerId, v.id)!);
    }),
    bindLegacy: async input => atomic(() => {
      const row = videoRow(input.ownerId, input.videoId);
      if (!row || input.record.ownerId !== input.ownerId) throw new HttpError("NOT_FOUND");
      const object = input.record.originalObject; const playbackObject = input.record.playbackObject;
      if (object.kind !== "registered" || playbackObject.kind !== "registered" || playbackObject.id !== object.id || object.key !== row.originalKey) throw new HttpError("FILE_MISMATCH");
      library.assertObject(input.ownerId, object); library.assertObject(input.ownerId, playbackObject);
      const existing = library.asset(input.ownerId, row.id, "original", row.originalKey);
      if (existing.kind === "registered") {
        if (existing.id !== object.id) throw new HttpError("FILE_MISMATCH");
        return videoRecord(row);
      }
      const alreadyBound = client.prepare("SELECT video_id FROM video_assets WHERE storage_object_id=? AND asset_role='original'").get(object.id) as { video_id: string } | undefined;
      if (alreadyBound && alreadyBound.video_id !== row.id) throw new HttpError("UPLOAD_STATE_CONFLICT");
      const media = input.record.video;
      bytes(media.sizeBytes); if (!VIDEO_STATUSES.includes(media.status)) throw new HttpError("VALIDATION_ERROR");
      const checked = client.prepare("SELECT size_bytes FROM storage_objects WHERE owner_id=? AND id=?").get(input.ownerId, object.id) as { size_bytes: number };
      if (checked.size_bytes !== media.sizeBytes) throw new HttpError("FILE_MISMATCH");
      library.attachAssets(input.ownerId, row.id, { originalObject: object, playbackObject, thumbnailObject: input.record.thumbnailObject });
      db.update(s.videos).set({ durationSeconds: isVideoDuration(row.durationSeconds) ? row.durationSeconds : isVideoDuration(media.durationSeconds) ? media.durationSeconds : null, sizeBytes: media.sizeBytes, status: media.status, codec: media.codec,
        width: media.width, height: media.height, playable: media.playable, playbackKey: playbackObject.key, thumbnailKey: input.record.thumbnailObject?.key ?? row.thumbnailKey })
        .where(and(eq(s.videos.id, row.id), eq(s.videos.ownerId, input.ownerId))).run();
      return videoRecord(videoRow(input.ownerId, row.id)!);
    }),
    updateMedia: async (ownerId, id, patch) => atomic(() => {
      const row = videoRow(ownerId, id); if (!row) throw new HttpError("NOT_FOUND");
      if (!VIDEO_STATUSES.includes(patch.status)) throw new HttpError("VALIDATION_ERROR");
      library.attachAssets(ownerId, id, { originalObject: library.asset(ownerId, id, "original", videoRow(ownerId, id)!.originalKey), ...patch });
      db.update(s.videos).set({ status: patch.status, durationSeconds: isVideoDuration(row.durationSeconds) ? row.durationSeconds : isVideoDuration(patch.durationSeconds) ? patch.durationSeconds : null, codec: patch.codec, width: patch.width,
        height: patch.height, playable: patch.playable, playbackKey: key(patch.playbackObject.key), thumbnailKey: patch.thumbnailObject ? key(patch.thumbnailObject.key) : null })
        .where(and(eq(s.videos.id, id), eq(s.videos.ownerId, ownerId))).run();
      return videoRecord(videoRow(ownerId, id)!);
    })
  };
  const uploads: UploadRepository = {
    findByClientRequestId: async (ownerId, clientRequestId, request) => {
      const intent = client.prepare("SELECT action FROM audit_events WHERE owner_id=? AND id=?").get(ownerId, requestEventId(ownerId, clientRequestId)) as { action: string } | undefined;
      if (!intent) return null;
      const snapshot = JSON.parse(intent.action) as { uploadId: string; fingerprint: string };
      if (request && snapshot.fingerprint !== requestFingerprint(request)) throw new HttpError("UPLOAD_STATE_CONFLICT");
      const row = findUpload(ownerId, snapshot.uploadId); if (!row) throw new HttpError("UPLOAD_STATE_CONFLICT"); return uploadRecord(row);
    },
    listOwned: async (ownerId, query) => {
      const page = query.page ?? 1; const pageSize = query.pageSize ?? 20;
      if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || (query.status !== undefined && !UPLOAD_STATUSES.includes(query.status))) throw new HttpError("VALIDATION_ERROR");
      const failedOperation = "(SELECT operation.state FROM storage_operations operation WHERE operation.owner_id=task.owner_id AND operation.upload_id=task.id ORDER BY operation.created_at DESC,operation.rowid DESC LIMIT 1)='failed'";
      const params = query.status && query.status !== "failed" ? [ownerId, query.status] : [ownerId];
      // 分片/云初始化失败仍保留 uploading 以续传，但必须能从服务端失败历史找到。
      // 已完成任务的封面失败独立展示，不混入视频上传失败筛选。
      const filter = query.status === "failed" ? ` AND (task.status='failed' OR (task.status<>'completed' AND ${failedOperation}))` : query.status ? " AND task.status=?" : "";
      const where = `task.owner_id=?${filter}`;
      const total = (client.prepare(`SELECT count(*) n FROM upload_tasks task WHERE ${where}`).get(...params) as { n: number }).n;
      const ids = client.prepare(`SELECT task.id FROM upload_tasks task WHERE ${where} ORDER BY task.created_at DESC,task.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as { id: string }[];
      return { page, pageSize, total, items: ids.map(row => uploadRecord(findUpload(ownerId, row.id)!).task) };
    },
    create: async input => atomic(() => {
      const eventId = input.request.clientRequestId ? requestEventId(input.ownerId, input.request.clientRequestId) : undefined;
      if (eventId) {
        const prior = client.prepare("SELECT action FROM audit_events WHERE owner_id=? AND id=?").get(input.ownerId, eventId) as { action: string } | undefined;
        if (prior) { const snapshot = JSON.parse(prior.action) as { uploadId: string; fingerprint: string }; if (snapshot.fingerprint !== requestFingerprint(input.request)) throw new HttpError("UPLOAD_STATE_CONFLICT"); return uploadRecord(findUpload(input.ownerId, snapshot.uploadId)!); }
      }
      const request = config && input.request.tags !== undefined ? { ...input.request, ...library.normalizeSelection(input.ownerId, input.request) } : input.request;
      library.assertSelection(input.ownerId, request); library.assertObject(input.ownerId, input.object, false); bytes(request.sizeBytes, 1); bytes(input.partSizeBytes, 1, 16 * 1024 * 1024);
      if (Math.ceil(request.sizeBytes / input.partSizeBytes) > 10_000) throw new HttpError("VALIDATION_ERROR");
      const id = eventId?.slice("upload-request-".length) ?? randomUUID(); db.insert(s.uploadTasks).values({ id, ownerId: input.ownerId, fileName: request.fileName,
        title: request.title, categoryId: request.categoryId, sizeBytes: request.sizeBytes, partSizeBytes: input.partSizeBytes,
        status: "uploading", objectKey: key(input.object.key), storageUploadId: input.storageUploadId, createdAt: now().toISOString() }).run();
      library.setLinks("upload", "group", input.ownerId, id, request.groupIds ?? []); library.setLinks("upload", "tag", input.ownerId, id, request.tagIds ?? []);
      if (eventId) client.prepare("INSERT INTO audit_events(id,owner_id,action,created_at) VALUES(?,?,?,?)").run(eventId, input.ownerId, JSON.stringify({ type: "upload.create.v1", uploadId: id, clientRequestId: input.request.clientRequestId, fingerprint: requestFingerprint(input.request) }), now().toISOString());
      if (input.object.kind === "registered") client.prepare("INSERT INTO upload_storage_objects(owner_id,upload_id,storage_object_id,created_at) VALUES(?,?,?,?)").run(input.ownerId, id, input.object.id, now().toISOString());
      if (input.operationId) {
        const operation = client.prepare("SELECT storage_object_id FROM storage_operations WHERE owner_id=? AND id=?").get(input.ownerId, input.operationId) as { storage_object_id: string } | undefined;
        if (input.object.kind !== "registered" || operation?.storage_object_id !== input.object.id) throw new HttpError("UPLOAD_STATE_CONFLICT");
        client.prepare("UPDATE storage_operations SET upload_id=?,storage_upload_id=?,state=?,updated_at=? WHERE owner_id=? AND id=?").run(id, input.storageUploadId || null, input.storageUploadId ? "multipart_started" : "prepared", now().toISOString(), input.ownerId, input.operationId);
      }
      return uploadRecord(findUpload(input.ownerId, id)!);
    }),
    attachMultipart: async input => atomic(() => {
      const row = findUpload(input.ownerId, input.uploadId); if (!row) throw new HttpError("NOT_FOUND");
      if (!input.storageUploadId || row.status !== "uploading" || (row.storageUploadId && row.storageUploadId !== input.storageUploadId)) throw new HttpError("UPLOAD_STATE_CONFLICT");
      db.update(s.uploadTasks).set({ storageUploadId: input.storageUploadId }).where(eq(s.uploadTasks.id, row.id)).run();
      client.prepare("UPDATE storage_operations SET storage_upload_id=?,state='multipart_started',error_code=NULL,updated_at=? WHERE owner_id=? AND upload_id=? AND state IN ('prepared','failed','multipart_started')").run(input.storageUploadId, now().toISOString(), input.ownerId, row.id);
      return uploadRecord(findUpload(input.ownerId, row.id)!);
    }),
    finishRegistration: async input => {
      // register 本身无异步 I/O；先实现同步嵌套事务，所有状态在同一 immediate 事务提交。
      return atomic(() => {
        const row = findUpload(input.ownerId, input.uploadId); if (!row) throw new HttpError("NOT_FOUND");
        if (row.status === "completed" && row.videoId) return { upload: uploadRecord(row), video: videoRecord(videoRow(input.ownerId, row.videoId)!) };
        if (row.status !== "finalizing" || input.video.ownerId !== input.ownerId || input.video.originalObject.key !== row.objectKey) throw new HttpError("UPLOAD_STATE_CONFLICT");
        const snapshot = uploadRecord(row); library.assertSelection(input.ownerId, { categoryId: row.categoryId, groupIds: snapshot.task.groupIds ?? [], tagIds: snapshot.task.tagIds ?? [] }, !!config);
        let videoCategoryId = row.categoryId;
        if (config) {
          const category = client.prepare("SELECT archived_at FROM categories WHERE owner_id=? AND id=?").get(input.ownerId, row.categoryId) as { archived_at: string | null };
          if (category.archived_at || config.categories.find(item => item.id === row.categoryId)?.enabled === false) {
            const defaultCategory = client.prepare("SELECT id FROM categories WHERE owner_id=? AND is_default=1 AND archived_at IS NULL").get(input.ownerId) as { id: string } | undefined;
            if (!defaultCategory || !config.categories.some(item => item.id === defaultCategory.id && item.enabled !== false)) throw new HttpError("ORGANIZATION_CONFLICT");
            videoCategoryId = defaultCategory.id;
          }
        }
        library.assertObject(input.ownerId, input.video.originalObject);
        if (snapshot.object.kind === "registered" && (input.video.originalObject.kind !== "registered" || snapshot.object.id !== input.video.originalObject.id)) throw new HttpError("UPLOAD_STATE_CONFLICT");
        const v = { ...input.video.video, categoryId: videoCategoryId, groupIds: snapshot.task.groupIds ?? [], tagIds: snapshot.task.tagIds ?? [] };
        const object = input.video.originalObject;
        const found = object.kind === "registered" ? client.prepare("SELECT video_id FROM video_assets WHERE owner_id=? AND storage_object_id=? AND asset_role='original'").get(input.ownerId, object.id) as { video_id: string } | undefined : undefined;
        let registered = found ? videoRow(input.ownerId, found.video_id) : undefined;
        if (!registered) {
          db.insert(s.videos).values({ id: v.id, ownerId: input.ownerId, title: row.title, categoryId: v.categoryId, durationSeconds: isVideoDuration(v.durationSeconds) ? v.durationSeconds : null,
            sizeBytes: v.sizeBytes, status: v.status, createdAt: v.createdAt, codec: v.codec, width: v.width, height: v.height, playable: v.playable,
            originalKey: object.key, playbackKey: input.video.playbackObject.key, thumbnailKey: input.video.thumbnailObject?.key ?? null }).run();
          library.attachAssets(input.ownerId, v.id, input.video); library.setLinks("video", "group", input.ownerId, v.id, v.groupIds); library.setLinks("video", "tag", input.ownerId, v.id, v.tagIds); registered = videoRow(input.ownerId, v.id)!;
        }
        db.update(s.uploadTasks).set({ status: "completed", videoId: registered.id }).where(eq(s.uploadTasks.id, row.id)).run();
        client.prepare("UPDATE storage_operations SET state='registered',video_id=?,updated_at=? WHERE owner_id=? AND upload_id=?").run(registered.id, now().toISOString(), input.ownerId, row.id);
        if (input.operationId && !client.prepare("SELECT 1 FROM storage_operations WHERE owner_id=? AND id=? AND upload_id=? AND state='registered'").get(input.ownerId, input.operationId, row.id)) throw new HttpError("UPLOAD_STATE_CONFLICT");
        return { upload: uploadRecord(findUpload(input.ownerId, row.id)!), video: videoRecord(registered) };
      });
    },
    findOwned: async (ownerId, id) => { const row = findUpload(ownerId, id); return row ? uploadRecord(row) : null; },
    savePart: async (ownerId, id, part) => atomic(() => {
      const row = findUpload(ownerId, id); if (!row) throw new HttpError("NOT_FOUND");
      if (row.status !== "uploading") throw new HttpError("UPLOAD_STATE_CONFLICT");
      bytes(part.partNumber, 1, 10_000);
      const expected = Math.min(row.partSizeBytes, row.sizeBytes - (part.partNumber - 1) * row.partSizeBytes);
      if (expected <= 0 || expected !== part.sizeBytes || !isPartChecksum(part.checksum) || !part.etag) throw new HttpError("FILE_MISMATCH");
      const existing = db.select().from(s.uploadParts).where(and(eq(s.uploadParts.uploadId, id), eq(s.uploadParts.partNumber, part.partNumber))).get();
      if (existing && (existing.checksum !== part.checksum || existing.sizeBytes !== part.sizeBytes)) throw new HttpError("FILE_MISMATCH");
      if (!existing) db.insert(s.uploadParts).values({ uploadId: id, ...part }).run();
      client.prepare("UPDATE storage_operations SET state='multipart_started',error_code=NULL,updated_at=? WHERE owner_id=? AND upload_id=? AND state='failed'").run(now().toISOString(), ownerId, id);
      return uploadRecord(row);
    }),
    transition: async (ownerId, id, expected, next, videoId) => atomic(() => {
      const row = findUpload(ownerId, id); if (!row) throw new HttpError("NOT_FOUND");
      const valid = (expected === "uploading" || expected === "failed") ? next === "finalizing"
        : expected === "finalizing" && ["finalizing", "completed", "failed"].includes(next);
      if (row.status !== expected || !UPLOAD_STATUSES.includes(next) || !valid) throw new HttpError("UPLOAD_STATE_CONFLICT");
      if (next === "completed") {
        const video = videoId ? videoRow(ownerId, videoId) : undefined;
        if (!video || video.originalKey !== row.objectKey) throw new HttpError("UPLOAD_STATE_CONFLICT");
      } else if (videoId) throw new HttpError("VALIDATION_ERROR");
      db.update(s.uploadTasks).set({ status: next, ...(videoId ? { videoId } : {}) }).where(and(eq(s.uploadTasks.id, id), eq(s.uploadTasks.ownerId, ownerId), eq(s.uploadTasks.status, expected))).run();
      return uploadRecord(findUpload(ownerId, id)!);
    })
  };
  const playback: PlaybackRepository = {
    create: async input => atomic(() => {
      timestamp(input.now); timestamp(input.expiresAt); bytes(input.maxActiveSessions, 1);
      const login = requireLogin(input.principal, input.now); const video = videoRow(input.principal.user.id, input.videoId);
      if (!video) throw new HttpError("NOT_FOUND");
      if (!video.playable || video.status !== "ready") throw new HttpError("UNSUPPORTED_MEDIA_TYPE");
      if (input.expiresAt <= input.now) throw new HttpError("VALIDATION_ERROR");
      if (activeCount(input.principal.user.id, input.now) >= input.maxActiveSessions) throw new HttpError("PLAYBACK_CONCURRENCY_LIMIT");
      const id = randomUUID(); db.insert(s.playbackSessions).values({ id, ownerId: input.principal.user.id, loginSessionId: login.id,
        videoId: input.videoId, createdAt: input.now, expiresAt: input.expiresAt < login.expiresAt ? input.expiresAt : login.expiresAt,
        lastSeenAt: input.now, ttlMs: Date.parse(input.expiresAt) - Date.parse(input.now), mode: input.mode ?? "proxy" }).run();
      return playbackRecord(db.select().from(s.playbackSessions).where(eq(s.playbackSessions.id, id)).get()!);
    }),
    authorize: async input => atomic(() => {
      requireLogin(input.principal, timestamp(input.now)); timestamp(input.sourceExpiresAt); bytes(input.maxAuthorizationsPerMinute, 1);
      if (input.sourceExpiresAt <= input.now || Date.parse(input.sourceExpiresAt) - Date.parse(input.now) > 3_600_000) throw new HttpError("VALIDATION_ERROR");
      if (!videoRow(input.principal.user.id, input.videoId)) throw new HttpError("NOT_FOUND");
      if (input.purpose !== "download") {
        const session = input.sessionId ? activePlayback(input.principal, input.sessionId, input.now) : undefined;
        if (!session || session.videoId !== input.videoId || session.mode !== "oss") throw new HttpError("FORBIDDEN");
        db.update(s.playbackSessions).set({ sourceExpiresAt: input.sourceExpiresAt }).where(eq(s.playbackSessions.id, session.id)).run();
      }
      const since = new Date(Date.parse(input.now) - 60_000).toISOString();
      const count = (client.prepare("SELECT count(*) n FROM source_authorizations WHERE owner_id=? AND created_at>? AND created_at<=?").get(input.principal.user.id, since, input.now) as { n: number }).n;
      if (count >= input.maxAuthorizationsPerMinute) throw new HttpError("RATE_LIMITED");
      client.prepare("INSERT INTO source_authorizations(id,owner_id,login_session_id,video_id,playback_session_id,purpose,source_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), input.principal.user.id, input.principal.loginSessionId, input.videoId, input.sessionId ?? null, input.purpose, input.sourceExpiresAt, input.now);
    }),
    findActive: async input => {
      try { const row = activePlayback(input.principal, input.sessionId, timestamp(input.now)); return row && (input.videoId === undefined || row.videoId === input.videoId) ? playbackRecord(row) : null; }
      catch (error) { if (error instanceof HttpError && error.code === "SESSION_EXPIRED") return null; throw error; }
    },
    heartbeat: async (principal, id, at) => atomic(() => {
      const row = activePlayback(principal, id, timestamp(at)); if (!row) throw new HttpError("FORBIDDEN");
      const login = requireLogin(principal, at); const extended = new Date(Date.parse(at) + row.ttlMs).toISOString();
      db.update(s.playbackSessions).set({ lastSeenAt: at, expiresAt: extended < login.expiresAt ? extended : login.expiresAt }).where(eq(s.playbackSessions.id, id)).run();
      return playbackRecord(db.select().from(s.playbackSessions).where(eq(s.playbackSessions.id, id)).get()!);
    }),
    close: async (principal, id, at) => atomic(() => {
      requireLogin(principal, timestamp(at)); const row = db.select().from(s.playbackSessions).where(and(eq(s.playbackSessions.id, id),
        eq(s.playbackSessions.ownerId, principal.user.id), eq(s.playbackSessions.loginSessionId, principal.loginSessionId))).get();
      if (!row) throw new HttpError("NOT_FOUND");
      if (!row.closedAt) db.update(s.playbackSessions).set({ closedAt: at }).where(eq(s.playbackSessions.id, id)).run();
    })
  };
  const usage: UsageRepository = {
    read: async (ownerId, period, policy, mode = "proxy") => {
      if (mode === "oss") {
        const counts = client.prepare("SELECT purpose,count(*) n FROM source_authorizations WHERE owner_id=? AND created_at>=? AND created_at<? GROUP BY purpose").all(ownerId, period.start, period.end) as { purpose: string; n: number }[];
        const count = (purpose: string) => counts.find(row => row.purpose === purpose)?.n ?? 0;
        return { source: "oss_direct", statisticsStatus: "not_synced", transferredBytes: null, cloudStatisticsAt: null, limitMode: "not_applicable", limitBytes: null,
          periodStart: period.start, periodEnd: period.end, timezone: period.timezone, activePlaybackSessions: activeCount(ownerId, now().toISOString()), authorizationCount: counts.reduce((total, row) => total + row.n, 0),
          playbackAuthorizationCount: count("playback"), renewalAuthorizationCount: count("renewal"), downloadAuthorizationCount: count("download") };
      }
      const counter = db.select().from(s.usageCounters).where(and(eq(s.usageCounters.ownerId, ownerId), eq(s.usageCounters.periodStart, period.start))).get();
      const base = { periodStart: period.start, periodEnd: period.end, timezone: period.timezone, transferredBytes: counter?.transferredBytes ?? 0,
        activePlaybackSessions: activeCount(ownerId, now().toISOString()), source: "application_proxy" as const };
      return (policy.kind === "limited" ? { ...base, limitMode: "limited", limitBytes: bytes(policy.limitBytes) } : { ...base, limitMode: policy.kind, limitBytes: null }) as ApplicationUsage;
    },
    reserve: async input => atomic(() => {
      if (input.policy.kind === "unconfigured") throw new HttpError("SERVICE_NOT_CONFIGURED");
      bytes(input.requestedBytes, 1); timestamp(input.period.start); timestamp(input.period.end);
      if (input.period.end <= input.period.start) throw new HttpError("VALIDATION_ERROR");
      const at = now().toISOString();
      if (input.playbackSessionId.startsWith("thumbnail:")) {
        const id = input.playbackSessionId.slice("thumbnail:".length);
        const login = db.select().from(s.loginSessions).where(and(eq(s.loginSessions.id, id), eq(s.loginSessions.ownerId, input.ownerId), isNull(s.loginSessions.revokedAt), gt(s.loginSessions.expiresAt, at))).get();
        if (!login) throw new HttpError("SESSION_EXPIRED");
      } else {
        const session = db.select().from(s.playbackSessions).where(and(eq(s.playbackSessions.id, input.playbackSessionId), eq(s.playbackSessions.ownerId, input.ownerId), isNull(s.playbackSessions.closedAt), gt(s.playbackSessions.expiresAt, at))).get();
        if (!session || session.mode !== "proxy") throw new HttpError("FORBIDDEN");
        const user = db.select().from(s.users).where(eq(s.users.id, input.ownerId)).get()!;
        requireLogin({ user: currentUser(authenticationUser(database, user)), loginSessionId: session.loginSessionId }, at);
      }
      db.insert(s.usageCounters).values({ ownerId: input.ownerId, periodStart: input.period.start, periodEnd: input.period.end, timezone: input.period.timezone }).onConflictDoNothing().run();
      const where = and(eq(s.usageCounters.ownerId, input.ownerId), eq(s.usageCounters.periodStart, input.period.start));
      const counter = db.select().from(s.usageCounters).where(where).get()!;
      if (counter.periodEnd !== input.period.end || counter.timezone !== input.period.timezone) throw new HttpError("VALIDATION_ERROR");
      const remaining = (input.policy.kind === "limited" ? bytes(input.policy.limitBytes) : Number.MAX_SAFE_INTEGER) - counter.transferredBytes - counter.reservedBytes;
      const grantedBytes = Math.min(input.requestedBytes, remaining); if (grantedBytes <= 0) throw new HttpError("TRANSFER_LIMIT_EXCEEDED");
      const id = randomUUID(); db.update(s.usageCounters).set({ reservedBytes: sql`${s.usageCounters.reservedBytes} + ${grantedBytes}` }).where(where).run();
      db.insert(s.transferReservations).values({ id, ownerId: input.ownerId, playbackSessionId: input.playbackSessionId, periodStart: input.period.start, grantedBytes, createdAt: at }).run();
      return { id, grantedBytes };
    }),
    settle: async input => atomic(() => {
      const row = db.select().from(s.transferReservations).where(and(eq(s.transferReservations.id, input.reservationId), eq(s.transferReservations.ownerId, input.ownerId))).get();
      if (!row) throw new HttpError("NOT_FOUND"); bytes(input.transferredBytes, 0, row.grantedBytes);
      if (row.transferredBytes !== null) { if (row.transferredBytes !== input.transferredBytes) throw new HttpError("VALIDATION_ERROR"); return; }
      const where = and(eq(s.usageCounters.ownerId, input.ownerId), eq(s.usageCounters.periodStart, row.periodStart));
      db.update(s.usageCounters).set({ reservedBytes: sql`${s.usageCounters.reservedBytes} - ${row.grantedBytes}`,
        transferredBytes: sql`${s.usageCounters.transferredBytes} + ${input.transferredBytes}` }).where(where).run();
      db.update(s.transferReservations).set({ transferredBytes: input.transferredBytes }).where(eq(s.transferReservations.id, row.id)).run();
    })
  };
  const catalog = createCatalogPersistence(database, library, videos.findOwned, now, config);
  return { videos, uploads, playback, usage, organizations: library.organizations, objects: library.objects, catalog, progress: catalog.progress };
}

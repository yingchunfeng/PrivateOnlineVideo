import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { isPartChecksum, UPLOAD_STATUSES, VIDEO_STATUSES } from "@online-video/shared";
import type { ApplicationUsage, VideoDetail, UploadTask } from "@online-video/shared";
import type { AuthPrincipal, VideoRecord, UploadRecord, PlaybackRecord, VideoRepository, UploadRepository, PlaybackRepository, UsageRepository } from "../core/contracts/index.js";
import { HttpError } from "../core/errors.js";
import type { AppDatabase } from "./database.js";
import * as s from "./schema.js";

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
export function createRepositories(database: AppDatabase, now: () => Date = () => new Date()) {
  const { orm: db, client } = database;
  const atomic = <T>(operation: () => T): T => client.transaction(operation).immediate();
  const assertCategory = (ownerId: string, categoryId: string) => {
    if (!db.select().from(s.categories).where(and(eq(s.categories.id, categoryId), eq(s.categories.ownerId, ownerId))).get()) throw new HttpError("NOT_FOUND");
  };
  const videoRow = (ownerId: string, id: string) => db.select().from(s.videos).where(and(eq(s.videos.id, id), eq(s.videos.ownerId, ownerId))).get();
  const videoRecord = (row: typeof s.videos.$inferSelect): VideoRecord => {
    const position = db.select().from(s.watchProgress).where(and(eq(s.watchProgress.ownerId, row.ownerId), eq(s.watchProgress.videoId, row.id))).get();
    return { ownerId: row.ownerId, originalObject: { key: row.originalKey }, playbackObject: { key: row.playbackKey },
      thumbnailObject: row.thumbnailKey ? { key: row.thumbnailKey } : null, video: {
        id: row.id, title: row.title, categoryId: row.categoryId, durationSeconds: row.durationSeconds, sizeBytes: row.sizeBytes,
        status: row.status as VideoDetail["status"], thumbnailUrl: row.thumbnailKey ? `/api/videos/${encodeURIComponent(row.id)}/thumbnail` : null,
        createdAt: row.createdAt, codec: row.codec, width: row.width, height: row.height, playable: row.playable,
        lastPositionSeconds: position?.positionSeconds ?? 0
      } };
  };
  const findUpload = (ownerId: string, id: string) => db.select().from(s.uploadTasks).where(and(eq(s.uploadTasks.id, id), eq(s.uploadTasks.ownerId, ownerId))).get();
  const uploadRecord = (row: typeof s.uploadTasks.$inferSelect): UploadRecord => {
    const parts = db.select().from(s.uploadParts).where(eq(s.uploadParts.uploadId, row.id)).orderBy(s.uploadParts.partNumber).all();
    return { ownerId: row.ownerId, title: row.title, categoryId: row.categoryId, object: { key: row.objectKey }, storageUploadId: row.storageUploadId,
      parts: parts.map(({ partNumber, sizeBytes, checksum, etag }) => ({ partNumber, sizeBytes, checksum, etag })), task: {
        id: row.id, videoId: row.videoId, fileName: row.fileName, sizeBytes: row.sizeBytes, partSizeBytes: row.partSizeBytes,
        status: row.status as UploadTask["status"], createdAt: row.createdAt,
        uploadedParts: parts.map(({ partNumber, sizeBytes, checksum }) => ({ partNumber, sizeBytes, checksum }))
      } };
  };
  const requireLogin = (principal: AuthPrincipal, at: string) => {
    const login = db.select().from(s.loginSessions).where(and(eq(s.loginSessions.id, principal.loginSessionId),
      eq(s.loginSessions.ownerId, principal.user.id), isNull(s.loginSessions.revokedAt), gt(s.loginSessions.expiresAt, at))).get();
    if (!login) throw new HttpError("SESSION_EXPIRED");
    return login;
  };
  const playbackRecord = (row: typeof s.playbackSessions.$inferSelect): PlaybackRecord => ({ ownerId: row.ownerId,
    loginSessionId: row.loginSessionId, lastSeenAt: row.lastSeenAt, closedAt: row.closedAt,
    session: { id: row.id, videoId: row.videoId, mode: "proxy", expiresAt: row.expiresAt,
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
    assertCategoryOwned: async (ownerId, categoryId) => assertCategory(ownerId, categoryId),
    findOwned: async (ownerId, id) => { const row = videoRow(ownerId, id); return row ? videoRecord(row) : null; },
    register: async input => atomic(() => {
      assertCategory(input.ownerId, input.video.categoryId); key(input.originalObject.key); key(input.playbackObject.key);
      if (input.thumbnailObject) key(input.thumbnailObject.key);
      const v = input.video; bytes(v.sizeBytes); timestamp(v.createdAt);
      if (!VIDEO_STATUSES.includes(v.status) || !v.id || !v.title.trim() || v.title.length > 256) throw new HttpError("VALIDATION_ERROR");
      const existing = db.select().from(s.videos).where(and(eq(s.videos.ownerId, input.ownerId), eq(s.videos.originalKey, input.originalObject.key))).get();
      if (existing) return videoRecord(existing);
      db.insert(s.videos).values({ id: v.id, ownerId: input.ownerId, title: v.title, categoryId: v.categoryId,
        durationSeconds: v.durationSeconds, sizeBytes: v.sizeBytes, status: v.status, createdAt: v.createdAt, codec: v.codec,
        width: v.width, height: v.height, playable: v.playable, originalKey: input.originalObject.key,
        playbackKey: input.playbackObject.key, thumbnailKey: input.thumbnailObject?.key ?? null }).run();
      return videoRecord(videoRow(input.ownerId, v.id)!);
    }),
    updateMedia: async (ownerId, id, patch) => atomic(() => {
      if (!videoRow(ownerId, id)) throw new HttpError("NOT_FOUND");
      if (!VIDEO_STATUSES.includes(patch.status)) throw new HttpError("VALIDATION_ERROR");
      db.update(s.videos).set({ status: patch.status, durationSeconds: patch.durationSeconds, codec: patch.codec, width: patch.width,
        height: patch.height, playable: patch.playable, playbackKey: key(patch.playbackObject.key), thumbnailKey: patch.thumbnailObject ? key(patch.thumbnailObject.key) : null })
        .where(and(eq(s.videos.id, id), eq(s.videos.ownerId, ownerId))).run();
      return videoRecord(videoRow(ownerId, id)!);
    })
  };
  const uploads: UploadRepository = {
    create: async input => atomic(() => {
      assertCategory(input.ownerId, input.request.categoryId); bytes(input.request.sizeBytes, 1); bytes(input.partSizeBytes, 1, 16 * 1024 * 1024);
      if (Math.ceil(input.request.sizeBytes / input.partSizeBytes) > 10_000 || !input.storageUploadId) throw new HttpError("VALIDATION_ERROR");
      const id = randomUUID(); db.insert(s.uploadTasks).values({ id, ownerId: input.ownerId, fileName: input.request.fileName,
        title: input.request.title, categoryId: input.request.categoryId, sizeBytes: input.request.sizeBytes, partSizeBytes: input.partSizeBytes,
        status: "uploading", objectKey: key(input.object.key), storageUploadId: input.storageUploadId, createdAt: now().toISOString() }).run();
      return uploadRecord(findUpload(input.ownerId, id)!);
    }),
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
        lastSeenAt: input.now, ttlMs: Date.parse(input.expiresAt) - Date.parse(input.now) }).run();
      return playbackRecord(db.select().from(s.playbackSessions).where(eq(s.playbackSessions.id, id)).get()!);
    }),
    findActive: async input => {
      try { const row = activePlayback(input.principal, input.sessionId, timestamp(input.now)); return row?.videoId === input.videoId ? playbackRecord(row) : null; }
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
    read: async (ownerId, period, policy) => {
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
        if (!session) throw new HttpError("FORBIDDEN");
        const user = db.select().from(s.users).where(eq(s.users.id, input.ownerId)).get()!;
        requireLogin({ user: { id: user.id, displayName: user.displayName, totpEnabled: user.totpEnabled }, loginSessionId: session.loginSessionId }, at);
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
  return { videos, uploads, playback, usage };
}

import { randomUUID } from "node:crypto";
import type { MediaDependencies, PlaybackRecord, UploadRecord, VideoRecord } from "../../src/core/contracts/index.js";
import type { AppConfig } from "../../src/core/config.js";
import { HttpError } from "../../src/core/errors.js";
import { MockStorageAdapter } from "../../src/modules/media/storage/mock.js";
import type { MediaOptions } from "../../src/modules/media/options.js";
import { unknownMetadata } from "../../src/modules/media/metadata/types.js";

export const headers = { cookie: "session=valid", "x-csrf-token": "csrf", origin: "http://127.0.0.1:5173" };
export const options: MediaOptions = { objectPrefix: "library/", partSizeBytes: 128 * 1024, maxUploadBytes: 16 * 1024 * 1024,
  maxUploadConcurrency: 2, playbackTtlMs: 120_000, requestsPerMinute: 1000, previewTtlMs: 60_000, maxPreviews: 16,
  metadata: { inspect: async () => ({ ...unknownMetadata, status: "ready", codec: "h264/aac", durationSeconds: 10,
    width: 1920, height: 1080, playable: true }) } };

/** 全部数据均为隔离测试内存，不初始化或写入任何 SQLite 文件。 */
export function fakeDependencies(config: AppConfig) {
  const storage = new MockStorageAdapter(); const videos = new Map<string, VideoRecord>();
  const uploads = new Map<string, UploadRecord>(); const sessions = new Map<string, PlaybackRecord>();
  const periods = new Map<string, { bytes: number; reserved: number }>();
  const reservations = new Map<string, { owner: string; periodKey: string; granted: number; settled: boolean }>();
  const clock = { time: new Date("2026-10-01T10:00:00Z") };
  const findUpload = (owner: string, id: string) => { const record = uploads.get(id); if (!record || record.ownerId !== owner) throw new HttpError("NOT_FOUND"); return record; };
  const category = async (owner: string, id: string) => { if (owner !== "owner" || id !== "category") throw new HttpError("NOT_FOUND"); };
  const dependencies: MediaDependencies = { kind: "test", config, storage, now: () => clock.time,
    auth: { requireUser: async (request, { mutation }) => {
      if (request.headers.cookie !== headers.cookie) throw new HttpError("AUTH_REQUIRED");
      if (mutation && (request.headers["x-csrf-token"] !== headers["x-csrf-token"] || request.headers.origin !== headers.origin)) throw new HttpError("CSRF_REJECTED");
      return { user: { id: "owner", displayName: "测试账户", totpEnabled: true }, loginSessionId: String(request.headers["x-test-session"] ?? "login") };
    } },
    videos: { assertCategoryOwned: category,
      findOwned: async (owner, id) => { const video = videos.get(id); return video?.ownerId === owner ? video : null; },
      register: async record => {
        await category(record.ownerId, record.video.categoryId);
        const existing = [...videos.values()].find(video => video.ownerId === record.ownerId && video.originalObject.key === record.originalObject.key);
        if (existing) return existing;
        videos.set(record.video.id, record); return record;
      },
      updateMedia: async (owner, id, patch) => {
        const record = videos.get(id); if (!record || record.ownerId !== owner) throw new HttpError("NOT_FOUND");
        record.video = { ...record.video, ...patch }; record.playbackObject = patch.playbackObject; record.thumbnailObject = patch.thumbnailObject; return record;
      }
    },
    uploads: {
      create: async input => {
        const id = randomUUID(); const record: UploadRecord = { ownerId: input.ownerId, title: input.request.title, categoryId: input.request.categoryId,
          object: input.object, storageUploadId: input.storageUploadId, parts: [], task: { id, videoId: null, fileName: input.request.fileName,
            sizeBytes: input.request.sizeBytes, partSizeBytes: input.partSizeBytes, status: "uploading", uploadedParts: [], createdAt: clock.time.toISOString() } };
        uploads.set(id, record); return record;
      },
      findOwned: async (owner, id) => { const record = uploads.get(id); return record?.ownerId === owner ? record : null; },
      savePart: async (owner, id, part) => {
        const record = findUpload(owner, id); const existing = record.parts.find(value => value.partNumber === part.partNumber);
        if (record.task.status !== "uploading") throw new HttpError("UPLOAD_STATE_CONFLICT");
        if (existing && (existing.checksum !== part.checksum || existing.sizeBytes !== part.sizeBytes)) throw new HttpError("FILE_MISMATCH");
        if (!existing) record.parts.push(part); return record;
      },
      transition: async (owner, id, expected, next, videoId) => {
        const record = findUpload(owner, id); if (record.task.status !== expected) throw new HttpError("UPLOAD_STATE_CONFLICT");
        record.task.status = next; if (videoId) record.task.videoId = videoId; return record;
      }
    },
    playback: {
      create: async input => {
        const active = [...sessions.values()].filter(record => record.ownerId === input.principal.user.id && !record.closedAt && record.session.expiresAt > input.now);
        if (active.length >= input.maxActiveSessions) throw new HttpError("PLAYBACK_CONCURRENCY_LIMIT");
        const id = randomUUID(); const record: PlaybackRecord = { ownerId: input.principal.user.id, loginSessionId: input.principal.loginSessionId,
          lastSeenAt: input.now, closedAt: null, session: { id, videoId: input.videoId, mode: "proxy", expiresAt: input.expiresAt,
            sourceUrl: `/api/videos/${input.videoId}/stream?playbackSessionId=${id}` } };
        sessions.set(id, record); return record;
      },
      findActive: async input => {
        const record = sessions.get(input.sessionId);
        return record && record.ownerId === input.principal.user.id && record.loginSessionId === input.principal.loginSessionId &&
          record.session.videoId === input.videoId && !record.closedAt && record.session.expiresAt > input.now ? record : null;
      },
      heartbeat: async (auth, id, now) => {
        const record = sessions.get(id);
        if (!record || record.ownerId !== auth.user.id || record.loginSessionId !== auth.loginSessionId || record.closedAt || record.session.expiresAt <= now) throw new HttpError("FORBIDDEN");
        record.lastSeenAt = now; record.session.expiresAt = new Date(new Date(now).getTime() + options.playbackTtlMs).toISOString(); return record;
      },
      close: async (auth, id, now) => {
        const record = sessions.get(id);
        if (!record || record.ownerId !== auth.user.id || record.loginSessionId !== auth.loginSessionId) throw new HttpError("FORBIDDEN");
        record.closedAt = now;
      }
    },
    usage: {
      read: async (owner, period, policy) => {
        const current = periods.get(`${owner}:${period.start}`)?.bytes ?? 0;
        const base = { periodStart: period.start, periodEnd: period.end, timezone: period.timezone, transferredBytes: current,
          activePlaybackSessions: [...sessions.values()].filter(record => record.ownerId === owner && !record.closedAt && record.session.expiresAt > clock.time.toISOString()).length,
          source: "application_proxy" as const };
        return policy.kind === "limited" ? { ...base, limitMode: "limited", limitBytes: policy.limitBytes } : { ...base, limitMode: policy.kind, limitBytes: null };
      },
      reserve: async input => {
        if (input.policy.kind === "unconfigured") throw new HttpError("SERVICE_NOT_CONFIGURED");
        const key = `${input.ownerId}:${input.period.start}`; let period = periods.get(key);
        if (!period) { period = { bytes: 0, reserved: 0 }; periods.set(key, period); }
        const grantedBytes = input.policy.kind === "limited" ? Math.min(input.requestedBytes, input.policy.limitBytes - period.bytes - period.reserved) : input.requestedBytes;
        if (grantedBytes <= 0) throw new HttpError("TRANSFER_LIMIT_EXCEEDED");
        const id = randomUUID(); period.reserved += grantedBytes;
        reservations.set(id, { owner: input.ownerId, periodKey: key, granted: grantedBytes, settled: false }); return { id, grantedBytes };
      },
      settle: async input => {
        const reservation = reservations.get(input.reservationId);
        if (!reservation || reservation.owner !== input.ownerId || input.transferredBytes < 0 || input.transferredBytes > reservation.granted) throw new Error("bad settle");
        if (!reservation.settled) {
          const period = periods.get(reservation.periodKey)!; period.reserved -= reservation.granted; period.bytes += input.transferredBytes; reservation.settled = true;
        }
      }
    }
  };
  const seedVideo = (id = "video", bytes = Buffer.from("0123456789"), ownerId = "owner") => {
    const key = `library/${id}.mp4`; storage.seed(key, bytes); const record: VideoRecord = { ownerId,
      originalObject: { key }, playbackObject: { key }, thumbnailObject: null,
      video: { id, title: "测试视频", categoryId: "category", durationSeconds: 10, sizeBytes: bytes.length, status: "ready", thumbnailUrl: null,
        createdAt: clock.time.toISOString(), codec: "h264/aac", width: 1920, height: 1080, playable: true, lastPositionSeconds: 0 } };
    videos.set(id, record); return record;
  };
  return { dependencies, storage, videos, uploads, sessions, periods, reservations, clock, seedVideo };
}

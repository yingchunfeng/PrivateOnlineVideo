import { PART_CHECKSUM_HEADER, PLAYBACK_MODE, isPartChecksum } from "@online-video/shared";
import type { ApplicationUsage, LoginRequest, PlaybackSession, UploadTask, VideoDetail } from "@online-video/shared";

// 此文件使用浏览器 lib 和 types: [] 编译，验证共享包公开入口不要求 Node 类型。
export const video: VideoDetail = {
  id: "mock-video", title: "测试视频", categoryId: "mock-category", durationSeconds: null,
  sizeBytes: 0, status: "processing", thumbnailUrl: null, createdAt: "2026-10-01T00:00:00.000Z",
  codec: null, width: null, height: null, playable: false, lastPositionSeconds: 0
};
export const upload: UploadTask = {
  id: "mock-upload", videoId: null, fileName: "sample.mp4", sizeBytes: 10,
  partSizeBytes: 5, status: "uploading", uploadedParts: [], createdAt: video.createdAt
};
export const playback: PlaybackSession = {
  id: "mock-playback", videoId: video.id, mode: PLAYBACK_MODE,
  sourceUrl: "/api/videos/mock-video/stream?playbackSessionId=mock-playback", expiresAt: video.createdAt
};
export const usage: ApplicationUsage = {
  periodStart: video.createdAt, periodEnd: "2026-10-02T00:00:00.000Z", timezone: "UTC",
  transferredBytes: 0, limitMode: "unconfigured", limitBytes: null,
  activePlaybackSessions: 0, source: "application_proxy"
};
export const login: LoginRequest = { password: "mock-password", totp: "000000" };
export const checksumHeaders = new Headers({ [PART_CHECKSUM_HEADER]: "a".repeat(64) });
export const validChecksum = isPartChecksum(checksumHeaders.get(PART_CHECKSUM_HEADER));
// @ts-expect-error 本轮没有 B 模式。
export const invalidMode: PlaybackSession["mode"] = "oss_direct";
// @ts-expect-error 限额未配置时必须使用 null，不允许伪装成明确限额。
export const invalidUsage: ApplicationUsage = { ...usage, limitMode: "unconfigured", limitBytes: 100 };

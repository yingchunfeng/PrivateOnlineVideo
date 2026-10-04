import type { DownloadAuthorization, PlaybackSession } from "@online-video/shared";
import { ApiError } from "./api/client";
import { validateMediaUrl, validateProxySource } from "./media-policy";

export const mediaPolicy = () => ({
  origin: import.meta.env.VITE_MEDIA_ORIGIN ?? "",
  prefix: import.meta.env.VITE_MEDIA_PREFIX ?? "",
  allowLocalHttp: import.meta.env.DEV && import.meta.env.VITE_ALLOW_LOCAL_MEDIA_HTTP === "true"
});
export function validatePlayback(session: PlaybackSession, videoId: string, sessionId?: string): PlaybackSession {
  if (!session || !session.id || session.videoId !== videoId || sessionId && session.id !== sessionId || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) throw new ApiError("INVALID_RESPONSE", "播放授权与当前视频、会话或有效期不匹配");
  if (session.mode === "proxy") validateProxySource(session.sourceUrl, videoId, session.id);
  else if (session.mode === "oss") {
    validateMediaUrl(session.sourceUrl, mediaPolicy());
    if (!Number.isFinite(Date.parse(session.sourceExpiresAt)) || !Number.isFinite(Date.parse(session.renewAfter)) || Date.parse(session.sourceExpiresAt) <= Date.now() || Date.parse(session.renewAfter) > Date.parse(session.sourceExpiresAt)) throw new ApiError("INVALID_RESPONSE", "媒体授权有效期无法确认");
  } else throw new ApiError("INVALID_RESPONSE", "无法识别播放传输模式");
  return session;
}
export function validateDownload(value: DownloadAuthorization, videoId: string): DownloadAuthorization {
  if (!value || value.videoId !== videoId || value.mode !== "oss" || Date.parse(value.sourceExpiresAt) <= Date.now() || !Number.isFinite(Date.parse(value.sourceExpiresAt)) || !value.fileName || /[\\/\r\n\x00]/.test(value.fileName)) throw new ApiError("INVALID_RESPONSE", "原片下载授权信息无效");
  validateMediaUrl(value.sourceUrl, mediaPolicy()); return value;
}

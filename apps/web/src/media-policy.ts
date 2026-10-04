import { ApiError, isSiteApiPath } from "./api/client";

export interface MediaPolicy { origin: string; prefix: string; allowLocalHttp?: boolean }
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const safePath = (path: string) => {
  try {
    const decoded = decodeURIComponent(path);
    return !/[\\\x00-\x1f\x7f?#]/.test(decoded) && !/%(?:2e|2f|5c|25)/i.test(decoded) && !/%(?:2f|5c)/i.test(path) && !decoded.split("/").some(part => part === "." || part === "..");
  } catch { return false; }
};

/** 仅校验媒体授权地址；此策略不会扩大站内 API 客户端的地址权限。 */
export function validateMediaUrl(value: string, policy: MediaPolicy): string {
  const invalid = () => new ApiError("INVALID_RESPONSE", "媒体授权地址不符合已配置的域名、协议或目录范围");
  try {
    if (!value || /[\\\s]/.test(value)) throw invalid();
    const allowed = new URL(policy.origin);
    if (allowed.username || allowed.password || allowed.search || allowed.hash || allowed.pathname !== "/" || (allowed.protocol !== "https:" && !(policy.allowLocalHttp && allowed.protocol === "http:" && loopbackHosts.has(allowed.hostname)))) throw invalid();
    if (!policy.prefix.startsWith("/") || !policy.prefix.endsWith("/") || policy.prefix === "/" || !safePath(policy.prefix) || policy.prefix.includes("//")) throw invalid();
    const url = new URL(value);
    const rawPath = value.slice(value.indexOf("://") + 3).replace(/^[^/]*(?=\/|$)/, "").split(/[?#]/)[0] || "/";
    if (url.origin !== allowed.origin || url.protocol !== allowed.protocol || url.username || url.password || url.hash || url.pathname !== rawPath || !safePath(url.pathname) || !decodeURIComponent(url.pathname).startsWith(decodeURIComponent(policy.prefix))) throw invalid();
    if (url.pathname === policy.prefix) throw invalid();
    return url.href;
  } catch { throw invalid(); }
}

export function validateProxySource(value: string, videoId: string, sessionId: string): void {
  if (!isSiteApiPath(value)) throw new ApiError("INVALID_RESPONSE", "播放入口不是受保护的站内代理地址");
  const url = new URL(value, "https://site.invalid");
  if (url.pathname !== `/api/videos/${encodeURIComponent(videoId)}/stream` || url.searchParams.get("playbackSessionId") !== sessionId || [...url.searchParams.keys()].some(key => key !== "playbackSessionId")) throw new ApiError("INVALID_RESPONSE", "代理播放入口与当前视频或会话不匹配");
}

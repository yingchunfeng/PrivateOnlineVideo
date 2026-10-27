import type { ApiPath, LibraryCategory, LibraryConfig } from "@online-video/shared";
import { ApiError } from "./api/client";

export const defaultLibraryCategory = (categories: LibraryCategory[]) => categories.find(category => category.enabled !== false)?.id ?? "";
export const libraryTags = (categories: LibraryCategory[], categoryId = "") => [...new Set(categories.filter(category => !categoryId || category.id === categoryId).flatMap(category => category.tags))];
export function parseTagFilter(value: string): string[] {
  try { const tags: unknown = JSON.parse(value || "[]"); return Array.isArray(tags) && tags.every(tag => typeof tag === "string") ? [...new Set(tags)] : []; }
  catch { return []; }
}
export function libraryVideoPath(page: number, q: string, categoryId: string, tags: string[]): ApiPath {
  const query = new URLSearchParams({ page: String(page), pageSize: "12" });
  if (q) query.set("q", q); if (categoryId) query.set("categoryId", categoryId); if (tags.length) query.set("tags", JSON.stringify(tags));
  return `/api/videos?${query}`;
}
export type PublicMediaPolicy = Pick<LibraryConfig, "mediaBaseUrl" | "objectPrefix">;
export function validatePublicMediaPolicy(value: PublicMediaPolicy): PublicMediaPolicy {
  try {
    const origin = new URL(value.mediaBaseUrl);
    if (origin.protocol !== "https:" || origin.origin !== value.mediaBaseUrl || origin.username || origin.password || origin.port || origin.search || origin.hash || typeof value.objectPrefix !== "string" || !value.objectPrefix || value.objectPrefix.length > 512 || !value.objectPrefix.endsWith("/") || value.objectPrefix.startsWith("/") || /[\\%?#*\x00-\x1f\x7f]/.test(value.objectPrefix) || value.objectPrefix.split("/").some(part => part === "." || part === "..")) throw new Error();
    return value;
  } catch { throw new ApiError("INVALID_RESPONSE", "服务端媒体域名或对象范围配置无效"); }
}
export function publicMediaUrl(value: string, policy: PublicMediaPolicy | undefined): string {
  try {
    if (!policy) throw new Error();
    validatePublicMediaPolicy(policy);
    const url = new URL(value); const path = decodeURIComponent(value.slice(policy.mediaBaseUrl.length)); const prefix = `/${policy.objectPrefix}`;
    if (!value.startsWith(`${policy.mediaBaseUrl}/`) || url.origin !== policy.mediaBaseUrl || url.username || url.password || url.search || url.hash || !path.startsWith(prefix) || path.length <= prefix.length || /[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some(part => part === "." || part === "..")) throw new Error();
    return url.href;
  } catch { throw new ApiError("INVALID_RESPONSE", "公开视频地址无效，请检查媒体域名和对象路径"); }
}

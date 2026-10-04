import type { ApiPath, LibraryCategory } from "@online-video/shared";
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
export function publicMediaUrl(value: string): string {
  try {
    const url = new URL(value); const path = decodeURIComponent(url.pathname);
    if (url.origin !== "https://oss.meetdawn.top" || url.username || url.password || url.search || url.hash || !path.startsWith("/onlineVideo/") || path.length <= "/onlineVideo/".length || /[\\\x00-\x1f]/.test(path) || path.split("/").some(part => part === "." || part === "..")) throw new Error();
    return url.href;
  } catch { throw new ApiError("INVALID_RESPONSE", "公开视频地址无效，请检查媒体域名和对象路径"); }
}

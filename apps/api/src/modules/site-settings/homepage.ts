import type { HomepageSettings } from "@online-video/shared";
import { orderHomepageVideos } from "@online-video/shared";
import type { AppDatabase } from "../../db/database.js";
import { HttpError } from "../../core/errors.js";

interface SettingsRow { category_random_enabled: number; video_order: string; version: number }

export function createHomepageSettings(database: AppDatabase, now: () => Date = () => new Date()) {
  const db = database.client;
  const available = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='homepage_settings'").get();
  const preferences = (ownerId: string) => {
    const persistenceAvailable = available();
    const row = persistenceAvailable ? db.prepare("SELECT category_random_enabled,video_order,version FROM homepage_settings WHERE owner_id=?").get(ownerId) as SettingsRow | undefined : undefined;
    let videoOrder: unknown;
    try { videoOrder = JSON.parse(row?.video_order ?? "[]"); } catch { throw new HttpError("SERVICE_NOT_CONFIGURED"); }
    if (!Array.isArray(videoOrder) || videoOrder.some(id => typeof id !== "string") || new Set(videoOrder).size !== videoOrder.length || row && (![0, 1].includes(row.category_random_enabled) || !Number.isSafeInteger(row.version) || row.version < 1)) throw new HttpError("SERVICE_NOT_CONFIGURED");
    return { version: row?.version ?? 0, categoryRandomEnabled: persistenceAvailable && (row?.category_random_enabled ?? 1) === 1, videoOrder: videoOrder as string[], persistenceAvailable };
  };
  const view = (ownerId: string): HomepageSettings => {
    const current = preferences(ownerId);
    const rows = db.prepare("SELECT id,title,category_id categoryId FROM videos WHERE owner_id=? ORDER BY created_at DESC,id DESC").all(ownerId) as HomepageSettings["videos"];
    const videos = orderHomepageVideos(rows, current.videoOrder, []);
    return { ...current, videos, videoOrder: videos.map(video => video.id) };
  };
  const save = (ownerId: string, input: unknown): HomepageSettings => {
    if (!available()) throw new HttpError("SERVICE_NOT_CONFIGURED");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError("VALIDATION_ERROR");
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(key => !["version", "categoryRandomEnabled", "videoOrder"].includes(key)) || !Number.isSafeInteger(body.version) || (body.version as number) < 0 || typeof body.categoryRandomEnabled !== "boolean" || !Array.isArray(body.videoOrder) || body.videoOrder.some(id => typeof id !== "string" || !id || id.length > 256) || new Set(body.videoOrder).size !== body.videoOrder.length) throw new HttpError("VALIDATION_ERROR");
    return db.transaction(() => {
      const current = view(ownerId); const ids = new Set(current.videoOrder);
      // 视频新增或删除也会使整表排序草稿过期，不能静默丢失并发新增的视频。
      if (body.version !== current.version || (body.videoOrder as string[]).length !== ids.size || (body.videoOrder as string[]).some(id => !ids.has(id))) throw new HttpError("CONFIG_VERSION_CONFLICT");
      db.prepare("INSERT INTO homepage_settings(owner_id,category_random_enabled,video_order,version,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET category_random_enabled=excluded.category_random_enabled,video_order=excluded.video_order,version=excluded.version,updated_at=excluded.updated_at")
        .run(ownerId, body.categoryRandomEnabled ? 1 : 0, JSON.stringify(body.videoOrder), current.version + 1, now().toISOString());
      return view(ownerId);
    }).immediate();
  };
  return { preferences, view, save };
}

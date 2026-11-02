import type { SiteSettings } from "@online-video/shared";
import type { AppDatabase } from "../../db/database.js";
import type { AppConfig } from "../../core/config.js";
import { HttpError } from "../../core/errors.js";

interface SettingsRow { default_theme: string; max_upload_bytes: number; version: number }

export function createSiteSettings(database: AppDatabase, config: AppConfig, now: () => Date = () => new Date()) {
  const available = () => !!config.media && !!database.client.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_settings'").get();
  const maximum = () => Math.min(Number.MAX_SAFE_INTEGER, (config.media?.partSizeBytes ?? 262144) * 10000);
  const validBytes = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum();
  const view = (): SiteSettings => {
    const persistenceAvailable = available();
    const row = persistenceAvailable ? database.client.prepare("SELECT default_theme,max_upload_bytes,version FROM site_settings WHERE id=1").get() as SettingsRow | undefined : undefined;
    if (row && ((row.default_theme !== "light" && row.default_theme !== "dark") || !validBytes(row.max_upload_bytes) || !Number.isSafeInteger(row.version) || row.version < 1)) throw new HttpError("SERVICE_NOT_CONFIGURED");
    return { version: row?.version ?? 0, defaultTheme: row?.default_theme === "dark" ? "dark" : "light",
      maxUploadBytes: row?.max_upload_bytes ?? config.media?.maxUploadBytes ?? 2147483648,
      maxConfigurableUploadBytes: maximum(), partSizeBytes: config.media?.partSizeBytes ?? 262144, persistenceAvailable };
  };
  const save = (input: unknown): SiteSettings => {
    if (!available()) throw new HttpError("SERVICE_NOT_CONFIGURED");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError("VALIDATION_ERROR");
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(key => !["version", "defaultTheme", "maxUploadBytes"].includes(key)) ||
      !Number.isSafeInteger(body.version) || (body.version as number) < 0 ||
      !("defaultTheme" in body || "maxUploadBytes" in body) ||
      ("defaultTheme" in body && body.defaultTheme !== "light" && body.defaultTheme !== "dark") ||
      ("maxUploadBytes" in body && !validBytes(body.maxUploadBytes))) throw new HttpError("VALIDATION_ERROR");
    const saved = database.client.transaction(() => {
      const current = view();
      if (body.version !== current.version) throw new HttpError("CONFIG_VERSION_CONFLICT");
      const next = { ...current, version: current.version + 1,
        defaultTheme: (body.defaultTheme ?? current.defaultTheme) as SiteSettings["defaultTheme"],
        maxUploadBytes: (body.maxUploadBytes ?? current.maxUploadBytes) as number };
      database.client.prepare("INSERT INTO site_settings(id,default_theme,max_upload_bytes,version,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET default_theme=excluded.default_theme,max_upload_bytes=excluded.max_upload_bytes,version=excluded.version,updated_at=excluded.updated_at")
        .run(next.defaultTheme, next.maxUploadBytes, next.version, now().toISOString());
      return next;
    }).immediate();
    // 只有事务提交后才切换进程内值，失败不会影响正在使用的配置。
    config.media!.maxUploadBytes = saved.maxUploadBytes;
    return saved;
  };
  return { view, save };
}

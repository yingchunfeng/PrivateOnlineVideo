import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/db/schema.js";
import type { AppDatabase } from "../src/db/database.js";
import { WORKSPACE_ROOT } from "../src/db/database.js";
import { readConfig } from "../src/core/config.js";
import { createSiteSettings } from "../src/modules/site-settings/service.js";

const at = "2026-11-02T10:00:00.000Z";
function config() {
  return readConfig({ NODE_ENV: "test", MAX_UPLOAD_BYTES: "2147483648", UPLOAD_PART_SIZE_BYTES: "262144", MAX_UPLOAD_CONCURRENCY: "1", MEDIA_REQUESTS_PER_MINUTE: "120" });
}
function database(path = ":memory:", create = true): AppDatabase {
  const client = new Database(path);
  if (create) client.exec("CREATE TABLE site_settings(id INTEGER PRIMARY KEY CHECK(id=1),default_theme TEXT NOT NULL,max_upload_bytes INTEGER NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL)");
  return { client, orm: drizzle(client, { schema }), path, close: () => client.close() };
}

test("站点设置：默认不写库，授权结构存在时原子持久化、重开保持，进程内上限同步", () => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `site-settings-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "isolated.db"); const db = database(path); const current = config();
  try {
    const manager = createSiteSettings(db, current, () => new Date(at));
    assert.deepEqual(manager.view(), { version: 0, defaultTheme: "light", maxUploadBytes: 2147483648, maxConfigurableUploadBytes: 2621440000, partSizeBytes: 262144, persistenceAvailable: true });
    assert.equal((db.client.prepare("SELECT count(*) count FROM site_settings").get() as { count: number }).count, 0);
    const saved = manager.save({ version: 0, defaultTheme: "dark", maxUploadBytes: 1073741824 });
    assert.equal(saved.version, 1); assert.equal(saved.defaultTheme, "dark"); assert.equal(current.media!.maxUploadBytes, 1073741824);
    assert.deepEqual(db.client.prepare("SELECT * FROM site_settings").get(), { id: 1, default_theme: "dark", max_upload_bytes: 1073741824, version: 1, updated_at: at });
  } finally { db.close(); }
  const reopened = database(path, false);
  try {
    const freshConfig = config(); const manager = createSiteSettings(reopened, freshConfig);
    assert.equal(manager.view().maxUploadBytes, 1073741824); assert.equal(manager.view().defaultTheme, "dark");
    const next = manager.save({ version: 1, defaultTheme: "light" });
    assert.equal(next.maxUploadBytes, 1073741824); assert.equal(next.version, 2); assert.equal(freshConfig.media!.maxUploadBytes, 1073741824);
  } finally { reopened.close(); }
});

test("站点设置：未迁移实例只读降级，不自动创建表；缺少媒体装配拒绝保存", () => {
  const db = database(":memory:", false);
  try {
    const manager = createSiteSettings(db, config());
    assert.equal(manager.view().persistenceAvailable, false);
    assert.throws(() => manager.save({ version: 0, defaultTheme: "dark" }), { code: "SERVICE_NOT_CONFIGURED" });
    assert.equal(db.client.prepare("SELECT name FROM sqlite_master WHERE name='site_settings'").get(), undefined);
    const withoutMedia = createSiteSettings(db, readConfig({ NODE_ENV: "test" }));
    assert.equal(withoutMedia.view().persistenceAvailable, false);
  } finally { db.close(); }
});

test("站点设置：严格校验字段、主题、版本和有限正整数字节；分片上界可保存", () => {
  const db = database(); const current = config(); const manager = createSiteSettings(db, current);
  try {
    for (const input of [null, [], {}, { version: 0 }, { version: "0", defaultTheme: "dark" }, { version: -1, defaultTheme: "dark" },
      { version: 0, defaultTheme: "auto" }, { version: 0, defaultTheme: null }, { version: 0, maxUploadBytes: 0 },
      { version: 0, maxUploadBytes: -1 }, { version: 0, maxUploadBytes: 1.5 }, { version: 0, maxUploadBytes: NaN },
      { version: 0, maxUploadBytes: Infinity }, { version: 0, maxUploadBytes: "1" },
      { version: 0, maxUploadBytes: Number.MAX_SAFE_INTEGER + 1 }, { version: 0, maxUploadBytes: 2621440001 },
      { version: 0, defaultTheme: "dark", unknown: true }]) assert.throws(() => manager.save(input), { code: "VALIDATION_ERROR" });
    assert.equal(current.media!.maxUploadBytes, 2147483648); assert.equal(manager.view().version, 0);
    assert.equal(manager.save({ version: 0, maxUploadBytes: 2621440000 }).maxUploadBytes, 2621440000);
    assert.equal(manager.save({ version: 1, maxUploadBytes: 1 }).maxUploadBytes, 1);
  } finally { db.close(); }
});

test("站点设置：跨实例版本冲突不覆盖；事务失败不切换配置", () => {
  const db = database(); const current = config(); const first = createSiteSettings(db, current); const second = createSiteSettings(db, current);
  try {
    first.save({ version: 0, defaultTheme: "dark", maxUploadBytes: 1073741824 });
    assert.throws(() => second.save({ version: 0, maxUploadBytes: 536870912 }), { code: "CONFIG_VERSION_CONFLICT" });
    assert.equal(second.view().maxUploadBytes, 1073741824);
    db.client.exec("CREATE TRIGGER isolated_failure BEFORE UPDATE ON site_settings BEGIN SELECT RAISE(ABORT,'isolated'); END");
    assert.throws(() => first.save({ version: 1, maxUploadBytes: 536870912 }));
    assert.equal(current.media!.maxUploadBytes, 1073741824); assert.equal(first.view().version, 1);
  } finally { db.close(); }
});

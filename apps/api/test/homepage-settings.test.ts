import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import * as schema from "../src/db/schema.js";
import { migrateDatabase, migrationManifest, openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { createHomepageSettings } from "../src/modules/site-settings/homepage.js";
import { createRepositories } from "../src/db/repositories.js";

const at = "2026-11-08T10:00:00.000Z";
function populate(db: ReturnType<typeof openDatabase>) {
  db.client.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES('owner','fixture','test-only-hash','test-only-cipher',?)").run(at);
  for (let index = 0; index < 15; index++) db.client.prepare("INSERT INTO categories(id,owner_id,name,name_key,sort_order,created_at) VALUES(?,'owner',?,?,?,?)").run(`cat-${index}`, `分类${index}`, `分类${index}`, index, at);
  for (let index = 0; index < 60; index++) db.client.prepare("INSERT INTO videos(id,owner_id,title,category_id,size_bytes,status,created_at,playable,original_key,playback_key) VALUES(?,'owner',?,?,1,'ready',?,1,?,?)")
    .run(`video-${index}`, `视频${index}`, `cat-${index % 15}`, at, `videos/${index}.webm`, `videos/${index}.webm`);
}

test("首页设置：默认只读读取不落库；保存重开持久化，所有视频手动排序", async () => {
  const directory = resolve(WORKSPACE_ROOT, `.local/tests/homepage-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "isolated.db"); new Database(path).close();
  const db = openDatabase(path, { initialize: true }); populate(db);
  const settings = createHomepageSettings(db); const initial = settings.view("owner");
  assert.equal(initial.categoryRandomEnabled, true); assert.equal(initial.version, 0); assert.equal(initial.videos.length, 60);
  assert.equal((db.client.prepare("SELECT count(*) n FROM homepage_settings").get() as { n: number }).n, 0);
  const order = [...initial.videoOrder].reverse();
  try {
    assert.equal(settings.save("owner", { version: 0, categoryRandomEnabled: false, videoOrder: order }).version, 1);
    const repos = createRepositories(db);
    const result = await repos.catalog.list("owner", { page: 1, pageSize: 100 }, "session-a");
    assert.deepEqual(result.items.map(video => video.id), order);
  } finally { db.close(); }
  const reopened = openDatabase(path);
  try {
    const next = createHomepageSettings(reopened).view("owner");
    assert.equal(next.categoryRandomEnabled, false); assert.deepEqual(next.videoOrder, order); assert.equal(next.version, 1);
  } finally { reopened.close(); }
});

test("首页设置：严格校验、并发冲突、视频新增/删除冲突和事务失败均不覆盖", () => {
  const db = openDatabase(":memory:", { initialize: true }); populate(db);
  try {
    const settings = createHomepageSettings(db); const initial = settings.view("owner");
    const body = { version: 0, categoryRandomEnabled: true, videoOrder: initial.videoOrder };
    for (const invalid of [null, [], {}, { ...body, version: -1 }, { ...body, categoryRandomEnabled: "true" }, { ...body, unknown: 1 }, { ...body, videoOrder: [1] }, { ...body, videoOrder: [initial.videoOrder[0], initial.videoOrder[0]] }]) assert.throws(() => settings.save("owner", invalid), { code: "VALIDATION_ERROR" });
    for (const videoOrder of [initial.videoOrder.slice(1), [...initial.videoOrder, "not-owned"], initial.videoOrder.map((id, index) => index ? id : "foreign-id")]) assert.throws(() => settings.save("owner", { ...body, videoOrder }), { code: "CONFIG_VERSION_CONFLICT" });
    settings.save("owner", body);
    assert.throws(() => settings.save("owner", body), { code: "CONFIG_VERSION_CONFLICT" });
    db.client.exec("CREATE TRIGGER fail_homepage BEFORE UPDATE ON homepage_settings BEGIN SELECT RAISE(ABORT,'test-only-failure'); END");
    assert.throws(() => settings.save("owner", { ...body, version: 1, categoryRandomEnabled: false }));
    assert.equal(settings.view("owner").categoryRandomEnabled, true); assert.equal(settings.view("owner").version, 1);
  } finally { db.close(); }
});

test("首页列表：真实SQL分页跨15个分类稳定覆盖，新会话重抽，筛选无随机前置", async () => {
  const db = openDatabase(":memory:", { initialize: true }); populate(db);
  try {
    const settings = createHomepageSettings(db); const initial = settings.view("owner");
    settings.save("owner", { version: 0, categoryRandomEnabled: true, videoOrder: initial.videoOrder });
    const repos = createRepositories(db); const list = (page: number, seed = "session-a") => repos.catalog.list("owner", { page, pageSize: 12 }, seed);
    const full = (await Promise.all([1, 2, 3, 4, 5].map(page => list(page)))).flatMap(page => page.items);
    assert.equal(new Set(full.map(video => video.id)).size, 60);
    assert.deepEqual(full.slice(0, 15).map(video => video.categoryId), Array.from({ length: 15 }, (_, i) => `cat-${i}`));
    assert.deepEqual((await list(1)).items, full.slice(0, 12));
    assert.notDeepEqual((await list(1, "session-b")).items.map(video => video.id), full.slice(0, 12).map(video => video.id));
    const filtered = await repos.catalog.list("owner", { categoryId: "cat-0", pageSize: 100 }, "session-b");
    assert.deepEqual(filtered.items.map(video => video.id), initial.videos.filter(video => video.categoryId === "cat-0").map(video => video.id));
  } finally { db.close(); }
});

test("v8兼容：缺少v9表不自动建表，保留旧排序并明确只读", async () => {
  const client = new Database(":memory:");
  client.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)");
  for (const migration of migrationManifest().slice(0, 8)) { client.exec(migration.sql); client.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migration.version, migration.checksum, at); }
  const db = { client, orm: drizzle(client, { schema }), path: ":memory:", close: () => client.close() }; populate(db);
  try {
    const settings = createHomepageSettings(db); const view = settings.view("owner");
    assert.equal(view.persistenceAvailable, false); assert.equal(view.categoryRandomEnabled, false);
    assert.throws(() => settings.save("owner", { version: 0, categoryRandomEnabled: true, videoOrder: view.videoOrder }), { code: "SERVICE_NOT_CONFIGURED" });
    assert.equal(client.prepare("SELECT 1 FROM sqlite_master WHERE name='homepage_settings'").get(), undefined);
    assert.deepEqual((await createRepositories(db).catalog.list("owner", { pageSize: 100 }, "seed")).items.map(video => video.id), view.videoOrder);
    migrateDatabase(client); assert.equal(settings.view("owner").persistenceAvailable, true);
  } finally { db.close(); }
});

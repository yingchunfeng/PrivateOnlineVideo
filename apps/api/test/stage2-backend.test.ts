import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { eq, getTableColumns, getTableName } from "drizzle-orm";
import { migrateDatabase, migrationManifest, openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { readConfig } from "../src/core/config.js";
import { buildApp } from "../src/app.js";
import * as schema from "../src/db/schema.js";
import type { AuthPrincipal, VideoRecord } from "../src/core/contracts/index.js";

const at = "2026-10-02T08:00:00.000Z";
function fixture(path = ":memory:") {
  if (path !== ":memory:") new Database(path).close();
  const db = openDatabase(path, { initialize: true });
  db.orm.insert(schema.users).values({ id: "owner", displayName: "隔离用户", passwordHash: "test-only", totpCipher: "test-only", createdAt: at }).run();
  db.orm.insert(schema.categories).values({ id: "default", ownerId: "owner", name: "未分类", nameKey: "未分类", isDefault: true, createdAt: at }).run();
  db.orm.insert(schema.loginSessions).values({ id: "login", ownerId: "owner", tokenHash: randomUUID(), createdAt: at, lastSeenAt: at, expiresAt: "2026-10-03T08:00:00.000Z" }).run();
  const principal: AuthPrincipal = { user: { id: "owner", displayName: "隔离用户", totpEnabled: true }, loginSessionId: "login" };
  const repos = createRepositories(db, () => new Date(at));
  const video: VideoRecord = { ownerId: "owner", originalObject: { key: "library/old.mp4" }, playbackObject: { key: "library/old.mp4" }, thumbnailObject: null,
    video: { id: "video", title: "原视频", categoryId: "default", durationSeconds: 100, sizeBytes: 8, status: "ready", thumbnailUrl: null, createdAt: at,
      codec: "h264/aac", width: 640, height: 360, playable: true, lastPositionSeconds: 0 } };
  return { db, repos, principal, video };
}
function comparable(db: Database.Database) {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  return tables.map(table => ({ table, columns: db.pragma(`table_info(${table})`), fks: db.pragma(`foreign_key_list(${table})`) }));
}

test("0002有序升级保存v1记录、重复升级幂等，未知ledger/名称碰撞全部回滚", () => {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON"); const first = migrationManifest()[0]!;
  db.exec(first.sql); db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)");
  db.prepare("INSERT INTO schema_migrations VALUES(1,?,?)").run(first.checksum, at);
  db.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES('owner','本人','hash','cipher',?)").run(at);
  db.prepare("INSERT INTO categories(id,owner_id,name,is_default,created_at) VALUES('default','owner','未分类',1,?)").run(at);
  const before = db.prepare("SELECT * FROM users").all();
  migrateDatabase(db); migrateDatabase(db);
  assert.deepEqual(db.prepare("SELECT * FROM users").all(), before);
  assert.deepEqual(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all(), [{ version: 1 }, { version: 2 }]);
  assert.equal((db.prepare("SELECT name_key FROM categories").get() as { name_key: string }).name_key, "未分类");
  db.prepare("UPDATE schema_migrations SET version=9 WHERE version=2").run(); assert.throws(() => migrateDatabase(db)); db.close();

  const collision = new Database(":memory:"); collision.pragma("foreign_keys=ON"); collision.exec(first.sql);
  collision.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)");
  collision.prepare("INSERT INTO schema_migrations VALUES(1,?,?)").run(first.checksum, at);
  collision.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES('owner','本人','hash','cipher',?)").run(at);
  for (const [id, label] of [["one", "Ａ"], ["two", "a"]]) collision.prepare("INSERT INTO categories(id,owner_id,name,created_at) VALUES(?,'owner',?,?)").run(id, label, at);
  assert.throws(() => migrateDatabase(collision));
  assert.equal((collision.prepare("SELECT max(version) n FROM schema_migrations").get() as { n: number }).n, 1);
  assert.equal((collision.pragma("table_info(categories)") as { name: string }[]).some(column => column.name === "archived_at"), false);
  assert.equal((collision.prepare("SELECT count(*) n FROM categories").get() as { n: number }).n, 2); collision.close();
});

test("SQL提案与0002相同；完整空库25表/列/外键与逐版本迁移一致", () => {
  const target = new Database(":memory:"); const empty = new Database(":memory:");
  try {
    target.pragma("foreign_keys=ON"); migrateDatabase(target);
    empty.exec(readFileSync(resolve(WORKSPACE_ROOT, "docs/sql/01_EMPTY_DATABASE_FULL.sql"), "utf8"));
    assert.deepEqual(comparable(target), comparable(empty));
    assert.equal(comparable(target).length, 25);
    const sql = readFileSync(resolve(WORKSPACE_ROOT, "docs/sql/STAGE2_PENDING.sql"), "utf8").replace(/\r\n/g, "\n");
    assert.equal(createHash("sha256").update(sql).digest("hex"), migrationManifest()[1]!.checksum);
    assert.deepEqual(target.pragma("foreign_key_check"), []); assert.equal(target.pragma("integrity_check", { simple: true }), "ok");
    for (const table of Object.values(schema)) {
      const columns = target.pragma(`table_info(${getTableName(table)})`) as { name: string; type: string }[];
      assert.deepEqual(Object.values(getTableColumns(table)).map(column => ({ name: column.name, type: column.getSQLType().toUpperCase() })).sort((a,b) => a.name.localeCompare(b.name)),
        columns.map(column => ({ name: column.name, type: column.type })).sort((a,b) => a.name.localeCompare(b.name)));
    }
  } finally { target.close(); empty.close(); }
});

test("组织规范化唯一、归档恢复/默认保护，AND筛选/软解绑/失败事务不丢旧数据", async () => {
  const f = fixture();
  try {
    const groups = f.repos.organizations;
    const first = groups.create("library_groups", "owner", { name: "  ＴＲＩＰ  ", description: "旅行", sortOrder: 1 });
    const second = groups.create("library_groups", "owner", { name: "家人" }); const tag = groups.create("tags", "owner", { name: "杭州" });
    assert.throws(() => groups.create("library_groups", "owner", { name: "trip" }));
    assert.throws(() => groups.update("categories", "owner", "default", { archived: true }));
    assert.throws(() => groups.update("library_groups", "other", first.id, { name: "x" }));
    await f.repos.videos.register({ ...f.video, video: { ...f.video.video, groupIds: [first.id, second.id], tagIds: [tag.id] } });
    assert.equal((await f.repos.catalog.list("owner", { groupIds: `${first.id},${second.id}`, tagIds: tag.id, q: "原", pageSize: 1 })).total, 1);
    assert.equal((await f.repos.catalog.list("owner", { groupIds: `${first.id},absent` })).total, 0);
    await assert.rejects(f.repos.catalog.list("owner", { groupIds: `${first.id},${first.id}` }));
    groups.update("tags", "owner", tag.id, { archived: true });
    await f.repos.catalog.update("owner", "video", { title: "保留历史标签" });
    await assert.rejects(f.repos.catalog.update("owner", "video", { title: "不得落库", tagIds: [tag.id] }));
    assert.equal((await f.repos.videos.findOwned("owner", "video"))!.video.title, "保留历史标签");
    assert.deepEqual((await f.repos.videos.findOwned("owner", "video"))!.video.tagIds, [tag.id]);
    groups.update("tags", "owner", tag.id, { archived: false }); await f.repos.catalog.update("owner", "video", { groupIds: [], tagIds: [] });
    assert.equal((f.db.client.prepare("SELECT count(*) n FROM video_group_links WHERE removed_at IS NOT NULL").get() as { n: number }).n, 2);
    assert.equal(groups.list("library_groups", "owner").length, 2);
  } finally { f.db.close(); }
});

test("完整存储身份唯一、防跨owner/改版本；上传组织登记回滚、幂等和重启保留", async () => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `stage2-${randomUUID()}`); mkdirSync(directory, { recursive: true }); const path = resolve(directory, "isolated.db");
  const f = fixture(path); let id = "";
  try {
    const group = f.repos.organizations.create("library_groups", "owner", { name: "上传分组" });
    const prepared = await f.repos.objects.prepare({ ownerId: "owner", object: { provider: "oss", bucket: "xzlbucket", region: "cn-hangzhou", key: "onlineVideo/originals/test.mp4", versionId: null }, operation: "upload" });
    await assert.rejects(f.repos.objects.prepare({ ownerId: "other", object: { provider: "oss", bucket: "xzlbucket", region: "cn-hangzhou", key: prepared.object.key, versionId: null }, operation: "upload" }));
    const upload = await f.repos.uploads.create({ ownerId: "owner", request: { fileName: "test.mp4", sizeBytes: 8, title: "上传快照", categoryId: "default", groupIds: [group.id] }, object: prepared.object, storageUploadId: "", partSizeBytes: 4, operationId: prepared.operationId });
    id = upload.task.id; assert.equal(upload.storageUploadId, ""); await f.repos.uploads.attachMultipart!({ ownerId: "owner", uploadId: id, storageUploadId: "test-multipart" });
    await f.repos.uploads.transition("owner", id, "uploading", "finalizing");
    const verified = await f.repos.objects.verify({ ownerId: "owner", object: prepared.object, metadata: { sizeBytes: 8, etag: "etag", contentType: "video/mp4", versionId: null } });
    assert.throws(() => f.db.client.prepare("UPDATE storage_objects SET version_id='new' WHERE id=?").run(verified.id));
    const record = { ...f.video, originalObject: verified, playbackObject: verified, video: { ...f.video.video, id: "uploaded", title: "client title ignored" } };
    f.repos.organizations.update("library_groups", "owner", group.id, { archived: true });
    await assert.rejects(f.repos.uploads.finishRegistration!({ ownerId: "owner", uploadId: id, video: record, operationId: prepared.operationId }));
    assert.equal(await f.repos.videos.findOwned("owner", "uploaded"), null); assert.equal((await f.repos.uploads.findOwned("owner", id))!.task.status, "finalizing");
    f.repos.organizations.update("library_groups", "owner", group.id, { archived: false });
    const result = await f.repos.uploads.finishRegistration!({ ownerId: "owner", uploadId: id, video: record, operationId: prepared.operationId });
    const repeat = await f.repos.uploads.finishRegistration!({ ownerId: "owner", uploadId: id, video: record });
    assert.equal(result.video.video.title, "上传快照"); assert.deepEqual(result.video.video.groupIds, [group.id]); assert.equal(repeat.video.video.id, "uploaded");
    assert.equal((f.db.client.prepare("SELECT state FROM storage_operations WHERE id=?").get(prepared.operationId) as { state: string }).state, "registered");
    assert.equal((f.db.client.prepare("SELECT count(*) n FROM videos").get() as { n: number }).n, 1);
  } finally { f.db.close(); }
  const reopened = openDatabase(path);
  try { assert.equal((await createRepositories(reopened).uploads.findOwned("owner", id))!.task.status, "completed"); } finally { reopened.close(); }
});

test("直连签发审计/撤销原子拒绝、未知字节独立于proxy；进度越界拒绝", async () => {
  const f = fixture();
  try {
    await f.repos.videos.register(f.video);
    const session = await f.repos.playback.create({ principal: f.principal, videoId: "video", now: at, expiresAt: "2026-10-02T08:02:00.000Z", maxActiveSessions: 3, mode: "oss" });
    const input = { principal: f.principal, sessionId: session.session.id, videoId: "video", purpose: "playback" as const, sourceExpiresAt: "2026-10-02T08:59:30.000Z", now: at, maxAuthorizationsPerMinute: 2 };
    await f.repos.playback.authorize!(input); await f.repos.playback.authorize!({ ...input, purpose: "renewal" }); await assert.rejects(f.repos.playback.authorize!({ ...input, purpose: "download" }));
    const usage = await f.repos.usage.read("owner", { start: "2026-10-02T00:00:00.000Z", end: "2026-10-03T00:00:00.000Z", timezone: "UTC" }, { kind: "unconfigured" }, "oss");
    assert.equal(usage.source, "oss_direct"); assert.equal(usage.transferredBytes, null); if (usage.source === "oss_direct") assert.equal(usage.authorizationCount, 2);
    await f.repos.progress.save("owner", "video", 25.5); await assert.rejects(f.repos.progress.save("owner", "video", 101)); assert.equal((await f.repos.progress.read("owner", "video")).positionSeconds, 25.5);
    f.db.orm.update(schema.loginSessions).set({ revokedAt: at }).where(eq(schema.loginSessions.id, "login")).run(); await assert.rejects(f.repos.playback.authorize!({ ...input, purpose: "renewal" }));
    assert.equal((f.db.client.prepare("SELECT count(*) n FROM source_authorizations").get() as { n: number }).n, 2);
  } finally { f.db.close(); }
});

test("显式legacy位置绑定只接受核验且同key对象，保留id/标题/组织/进度并幂等", async () => {
  const f = fixture();
  try {
    const group = f.repos.organizations.create("library_groups", "owner", { name: "历史分组" });
    await f.repos.videos.register({ ...f.video, video: { ...f.video.video, groupIds: [group.id] } });
    await f.repos.progress.save("owner", "video", 20);
    const prepared = await f.repos.objects.prepare({ ownerId: "owner", object: { provider: "oss", bucket: "xzlbucket", region: "cn-hangzhou", key: f.video.originalObject.key, versionId: null }, operation: "import" });
    await assert.rejects(f.repos.videos.bindLegacy!({ ownerId: "owner", videoId: "video", record: { ...f.video, originalObject: prepared.object, playbackObject: prepared.object } }));
    const verified = await f.repos.objects.verify({ ownerId: "owner", object: prepared.object, metadata: { sizeBytes: 8, contentType: "video/mp4", etag: "verified" } });
    const candidate = { ...f.video, originalObject: verified, playbackObject: verified, video: { ...f.video.video, id: "discarded", title: "不得覆盖", categoryId: "irrelevant" } };
    await assert.rejects(f.repos.videos.bindLegacy!({ ownerId: "owner", videoId: "video", record: { ...candidate, originalObject: { ...verified, key: "library/other.mp4" } } }));
    await assert.rejects(f.repos.videos.bindLegacy!({ ownerId: "other", videoId: "video", record: candidate }));
    const bound = await f.repos.videos.bindLegacy!({ ownerId: "owner", videoId: "video", record: candidate });
    assert.equal(bound.video.id, "video"); assert.equal(bound.video.title, "原视频"); assert.equal(bound.video.categoryId, "default");
    assert.equal(bound.video.lastPositionSeconds, 20); assert.deepEqual(bound.video.groupIds, [group.id]); assert.equal(bound.originalObject.kind, "registered");
    await f.repos.videos.bindLegacy!({ ownerId: "owner", videoId: "video", record: candidate });
    assert.equal((f.db.client.prepare("SELECT count(*) n FROM videos").get() as { n: number }).n, 1);
    assert.equal((await f.repos.videos.findOwned("owner", "video"))!.video.title, "原视频");
  } finally { f.db.close(); }
});

test("业务HTTP校验鉴权、参数及组织分页；配置显式限额与安全来源", async () => {
  const f = fixture(); const config = readConfig({});
  const auth = { requireUser: async (_request: unknown, _options: unknown) => f.principal };
  const app = await buildApp({ config, logger: false, backend: { config, auth, database: f.db, now: () => new Date(at) } });
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/groups", payload: { name: "test", bucket: "evil" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/videos?page=1x" })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/categories/default", payload: { archived: true } })).statusCode, 409);
    assert.equal((await app.inject({ method: "GET", url: "/api/categories?includeArchived=true" })).json().data[0].isDefault, true);
    assert.throws(() => readConfig({ STORAGE_DRIVER: "oss", PLAYBACK_MODE: "oss" }));
    assert.throws(() => readConfig({ NODE_ENV: "production", STORAGE_DRIVER: "mock" }));
  } finally { await app.close(); f.db.close(); }
});

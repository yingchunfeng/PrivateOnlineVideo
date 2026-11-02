import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { MAX_VIDEO_DURATION_SECONDS, PART_CHECKSUM_HEADER } from "@online-video/shared";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/core/config.js";
import { validateLibraryConfig } from "../src/core/library-config.js";
import { runtimeModules } from "../src/core/runtime.js";
import { migrateDatabase, migrationManifest, openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { AuthService, initializeAccount } from "../src/modules/auth/service.js";
import { totp } from "../src/modules/auth/crypto.js";
import { readAuthSettings } from "../src/modules/auth/settings.js";
import type { MockStorageAdapter } from "../src/modules/media/storage/mock.js";
import { createSiteSettings } from "../src/modules/site-settings/service.js";

const at = new Date("2026-11-02T10:00:00.000Z");
const configForTest = () => ({ ...readConfig({ NODE_ENV: "test", MAX_UPLOAD_BYTES: "1048576", UPLOAD_PART_SIZE_BYTES: "262144",
  MAX_UPLOAD_CONCURRENCY: "2", MEDIA_REQUESTS_PER_MINUTE: "1000" }),
  library: validateLibraryConfig({ mediaBaseUrl: "https://isolated-media.invalid", objectPrefix: "onlineVideo/",
    categories: [{ id: "default", name: "未分类", tags: ["测试"] }] }) });

test("既有v6实例不自动升级；只读默认可运行，授权测试迁移后才启用站点设置持久化", () => {
  const directory = resolve(WORKSPACE_ROOT, `.local/acceptance/ui-batch2-v6-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "isolated-v6.db"); const source = new Database(path);
  try {
    source.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)");
    for (const migration of migrationManifest().slice(0, 6)) {
      source.exec(migration.sql); source.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migration.version, migration.checksum, at.toISOString());
    }
    source.prepare("INSERT INTO audit_events(id,action,created_at) VALUES('preserved','keep',?)").run(at.toISOString());
  } finally { source.close(); }
  const database = openDatabase(path);
  try {
    const settings = createSiteSettings(database, configForTest());
    assert.equal(settings.view().persistenceAvailable, false);
    assert.throws(() => settings.save({ version: 0, defaultTheme: "dark" }));
    assert.equal((database.client.prepare("SELECT max(version) n FROM schema_migrations").get() as { n: number }).n, 6);
    assert.equal(database.client.prepare("SELECT 1 FROM sqlite_master WHERE name='site_settings'").get(), undefined);
    migrateDatabase(database.client);
    assert.equal(settings.save({ version: 0, defaultTheme: "dark" }).defaultTheme, "dark");
    assert.deepEqual(database.client.prepare("SELECT action FROM audit_events WHERE id='preserved'").get(), { action: "keep" });
    assert.equal(database.client.pragma("integrity_check", { simple: true }), "ok");
  } finally { database.close(); }
});

async function fixture(path = ":memory:") {
  if (path !== ":memory:") new Database(path).close();
  const database = openDatabase(path, { initialize: true });
  const key = randomBytes(32); const credentials = await initializeAccount(database, key, "第二批隔离验收");
  const owner = database.client.prepare("SELECT id FROM users").get() as { id: string };
  database.client.prepare("UPDATE categories SET id='default' WHERE owner_id=?").run(owner.id);
  const config = configForTest(); const now = () => at;
  const auth = new AuthService(database, key, readAuthSettings("test", { AUTH_MAX_FAILURES: "100" }), now);
  const modules = await runtimeModules(config, auth, database, now);
  const app = await buildApp({ config, auth, ...modules, logger: false });
  const storage = modules.media!.dependencies.storage as MockStorageAdapter;
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "http://127.0.0.1:5173" },
    payload: { password: credentials.password, totp: totp(credentials.totpSecret).generate({ timestamp: at.getTime() }) } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { origin: "http://127.0.0.1:5173", cookie: String(login.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": login.json().data.csrfToken as string };
  const request = (url: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET", payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const register = async (file = "sample.mp4") => {
    const response = await request("/api/videos/register-public", "POST", { publicUrl: `${config.library.mediaBaseUrl}/onlineVideo/default/${file}`, title: file, categoryId: "default", tags: ["测试"] });
    assert.equal(response.statusCode, 200, response.body); return response.json().data as { id: string; objectKey: string; durationSeconds: number | null };
  };
  return { database, key, credentials, owner, config, auth, app, storage, headers, request, register,
    repositories: createRepositories(database, now, config.library), close: async () => { await app.close(); database.close(); } };
}

test("站点配置真实HTTP鉴权/CSRF/版本与上传动态边界；降低上限不破坏旧任务幂等及完成", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.alloc(262144, 1);
    const input = { fileName: "sample.mp4", title: "旧任务", categoryId: "default", tags: [], sizeBytes: bytes.length, clientRequestId: "batch2-existing-task" };
    const created = await f.request("/api/uploads", "POST", input); assert.equal(created.statusCode, 200, created.body);
    const upload = created.json().data;
    const changed = await f.request("/api/settings/site", "PATCH", { version: 0, defaultTheme: "dark", maxUploadBytes: 131072 });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal((await f.request("/api/settings/limits")).json().data.maxUploadBytes, 131072);
    assert.equal((await f.request("/api/settings/site", "PATCH", { version: 0, maxUploadBytes: 1 })).statusCode, 409);
    assert.equal((await f.request("/api/uploads", "POST", { ...input, clientRequestId: "batch2-new-too-large" })).statusCode, 400);
    assert.equal((await f.request("/api/uploads", "POST", input)).json().data.id, upload.id);
    const boundary = await f.request("/api/uploads", "POST", { ...input, sizeBytes: 131072, clientRequestId: "batch2-exact-boundary" });
    assert.equal(boundary.statusCode, 200, boundary.body);
    const part = await f.app.inject({ method: "PUT", url: `/api/uploads/${upload.id}/parts/1`, headers: { ...f.headers,
      "content-type": "application/octet-stream", [PART_CHECKSUM_HEADER]: createHash("sha256").update(bytes).digest("hex") }, payload: bytes });
    assert.equal(part.statusCode, 200, part.body);
    const completed = await f.request(`/api/uploads/${upload.id}/complete`, "POST"); assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().data.video.sizeBytes, bytes.length);
    assert.equal((await f.app.inject({ url: "/api/settings/site" })).statusCode, 401);
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/settings/site", headers: { cookie: f.headers.cookie, origin: f.headers.origin }, payload: { version: 1, defaultTheme: "light" } })).statusCode, 403);
    const newAuth = new AuthService(f.database, f.key, f.auth.settings, () => new Date(at.getTime() + 60000));
    const modules = await runtimeModules(f.config, newAuth, f.database, () => new Date(at.getTime() + 60000));
    const next = await buildApp({ config: f.config, auth: newAuth, ...modules, logger: false });
    try {
      const login = await next.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.headers.origin }, payload: { password: f.credentials.password,
        totp: totp(f.credentials.totpSecret).generate({ timestamp: at.getTime() + 60000 }) } });
      assert.equal(login.statusCode, 200, login.body); assert.equal(login.json().data.defaultTheme, "dark");
    } finally { await next.close(); }
  } finally { await f.close(); }
});

test("时长补填校验权限/媒体/数值，重复幂等、失败不抹可信值，列表和文件SQLite重启保持", async () => {
  const directory = resolve(WORKSPACE_ROOT, `.local/acceptance/ui-batch2-api-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "isolated.db"); const f = await fixture(path); let id = "";
  try {
    const video = await f.register(); id = video.id;
    for (const value of [0, -1, "12", MAX_VIDEO_DURATION_SECONDS + 1, null]) {
      assert.equal((await f.request(`/api/videos/${id}/duration`, "PUT", { durationSeconds: value, expectedObjectKey: video.objectKey })).statusCode, 400);
    }
    for (const value of [NaN, Infinity, -Infinity]) await assert.rejects(f.repositories.videos.saveDurationIfMissing!(f.owner.id, id, { durationSeconds: value, expectedObjectKey: video.objectKey }));
    assert.equal((await f.request(`/api/videos/${id}/duration`, "PUT", { durationSeconds: 3661.5, expectedObjectKey: "onlineVideo/wrong.mp4" })).statusCode, 409);
    const saved = await f.request(`/api/videos/${id}/duration`, "PUT", { durationSeconds: 3661.5, expectedObjectKey: video.objectKey });
    assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().data.durationSeconds, 3661.5);
    assert.equal((await f.request(`/api/videos/${id}/duration`, "PUT", { durationSeconds: 1, expectedObjectKey: video.objectKey })).json().data.durationSeconds, 3661.5);
    await assert.rejects(f.repositories.videos.saveDurationIfMissing!("another-owner", id, { durationSeconds: 12, expectedObjectKey: video.objectKey }));
    assert.equal((await f.app.inject({ method: "PUT", url: `/api/videos/${id}/duration`, headers: { cookie: f.headers.cookie, origin: f.headers.origin }, payload: { durationSeconds: 1, expectedObjectKey: video.objectKey } })).statusCode, 403);
    assert.equal((await f.request(`/api/videos/${id}/duration`, "PUT", { durationSeconds: 12, expectedObjectKey: video.objectKey, title: "不可改" })).statusCode, 400);
    const record = (await f.repositories.videos.findOwned(f.owner.id, id))!;
    await f.repositories.videos.updateMedia(f.owner.id, id, { ...record.video, durationSeconds: null, playbackObject: record.playbackObject, thumbnailObject: record.thumbnailObject });
    assert.equal((await f.request("/api/videos")).json().data.items[0].durationSeconds, 3661.5);
    assert.equal((f.database.client.prepare("SELECT duration_seconds FROM videos WHERE id=?").get(id) as { duration_seconds: number }).duration_seconds, 3661.5);
    assert.equal((await f.request("/api/settings/site", "PATCH", { version: 0, defaultTheme: "dark", maxUploadBytes: 131072 })).statusCode, 200);
  } finally { await f.close(); }
  const reopened = openDatabase(path);
  try {
    const config = configForTest(); const auth = new AuthService(reopened, f.key, f.auth.settings, () => at);
    const restarted = await buildApp({ config, auth, ...await runtimeModules(config, auth, reopened, () => at), logger: false });
    try {
      const response = await restarted.inject({ url: `/api/videos/${id}`, headers: f.headers });
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().data.durationSeconds, 3661.5);
      assert.equal((await restarted.inject({ url: "/api/settings/limits", headers: f.headers })).json().data.maxUploadBytes, 131072);
      assert.equal((await restarted.inject({ url: "/api/settings/site", headers: f.headers })).json().data.defaultTheme, "dark");
    } finally { await restarted.close(); }
  } finally { reopened.close(); }
});

test("仅删除视频记录事务清理关联，保留存储对象/完成任务/审计与真实路径，不读取或删除云对象", async () => {
  const f = await fixture();
  try {
    const video = await f.register();
    const object = await f.repositories.objects.prepare({ ownerId: f.owner.id, operation: "upload", object: { provider: "mock", bucket: "", region: "", key: video.objectKey, versionId: null } });
    await f.repositories.objects.verify({ ownerId: f.owner.id, object: object.object, metadata: { sizeBytes: 8, etag: "isolated", contentType: "video/mp4" } });
    f.database.client.prepare("INSERT INTO video_assets(owner_id,video_id,asset_role,storage_object_id,created_at) VALUES(?,?,?,?,?)").run(f.owner.id, video.id, "original", object.object.id, at.toISOString());
    f.database.client.prepare("UPDATE storage_operations SET video_id=?,state='registered' WHERE id=?").run(video.id, object.operationId);
    const task = await f.repositories.uploads.create({ ownerId: f.owner.id, object: { key: video.objectKey }, storageUploadId: "isolated", partSizeBytes: 262144,
      request: { fileName: "sample.mp4", title: "保留任务", categoryId: "default", sizeBytes: 8 } });
    f.database.client.prepare("UPDATE upload_tasks SET status='completed',video_id=? WHERE id=?").run(video.id, task.task.id);
    await f.repositories.progress.save(f.owner.id, video.id, 2);
    const before = f.database.client.prepare("SELECT * FROM storage_objects").all();
    const reads = f.storage.reads.length; f.storage.seed(video.objectKey, Buffer.from("keep-oss"));
    assert.equal((await f.request(`/api/videos/${video.id}`, "DELETE", { confirm: false })).statusCode, 400);
    await assert.rejects(f.repositories.videos.deleteOwnedRecord!("another-owner", video.id));
    const deleted = await f.request(`/api/videos/${video.id}`, "DELETE", { confirm: true }); assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(deleted.json().data.objects[0].objectKey, video.objectKey);
    assert.equal(deleted.json().data.objects[0].publicUrl, `${f.config.library.mediaBaseUrl}/${video.objectKey}`);
    assert.equal((await f.request(`/api/videos/${video.id}`)).statusCode, 404);
    for (const table of ["watch_progress", "video_assets", "video_group_links", "video_tag_links", "source_authorizations", "playback_sessions"]) {
      assert.equal((f.database.client.prepare(`SELECT count(*) n FROM ${table} WHERE owner_id=? AND video_id=?`).get(f.owner.id, video.id) as { n: number }).n, 0);
    }
    assert.equal((await f.repositories.uploads.findOwned(f.owner.id, task.task.id))!.task.videoId, null);
    assert.deepEqual(f.database.client.prepare("SELECT * FROM storage_objects").all(), before);
    assert.equal((f.database.client.prepare("SELECT video_id FROM storage_operations WHERE id=?").get(object.operationId) as { video_id: string | null }).video_id, null);
    assert.equal(f.storage.objects.get(video.objectKey)!.bytes.toString(), "keep-oss"); assert.equal(f.storage.reads.length, reads);
    assert.equal(f.database.client.pragma("integrity_check", { simple: true }), "ok"); assert.deepEqual(f.database.client.pragma("foreign_key_check"), []);
    assert.equal((await f.request(`/api/videos/${video.id}`, "DELETE", { confirm: true })).statusCode, 404);
  } finally { await f.close(); }
});

test("在途上传/封面/有效站内播放拒删；数据库中途失败回滚全部关系", async () => {
  const f = await fixture();
  try {
    const video = await f.register();
    const object = await f.repositories.objects.prepare({ ownerId: f.owner.id, operation: "upload", object: { provider: "mock", bucket: "", region: "", key: "onlineVideo/default/cover.jpg", versionId: null } });
    f.database.client.prepare("UPDATE storage_operations SET video_id=? WHERE id=?").run(video.id, object.operationId);
    assert.equal((await f.request(`/api/videos/${video.id}`, "DELETE", { confirm: true })).json().error.code, "VIDEO_RECORD_BUSY");
    f.database.client.prepare("UPDATE storage_operations SET state='failed' WHERE id=?").run(object.operationId);
    const task = await f.repositories.uploads.create({ ownerId: f.owner.id, object: { key: video.objectKey }, storageUploadId: "isolated", partSizeBytes: 262144,
      request: { fileName: "sample.mp4", title: "在途", categoryId: "default", sizeBytes: 8 } });
    assert.equal((await f.request(`/api/videos/${video.id}`, "DELETE", { confirm: true })).json().error.code, "VIDEO_RECORD_BUSY");
    f.database.client.prepare("UPDATE upload_tasks SET status='completed' WHERE id=?").run(task.task.id);
    const login = f.database.client.prepare("SELECT id FROM login_sessions LIMIT 1").get() as { id: string };
    f.database.client.prepare("INSERT INTO playback_sessions(id,owner_id,login_session_id,video_id,created_at,expires_at,last_seen_at,ttl_ms) VALUES('playing',?,?,?,?,?,?,60000)")
      .run(f.owner.id, login.id, video.id, at.toISOString(), new Date(at.getTime() + 60000).toISOString(), at.toISOString());
    assert.equal((await f.request(`/api/videos/${video.id}`, "DELETE", { confirm: true })).json().error.code, "VIDEO_RECORD_BUSY");
    f.database.client.prepare("UPDATE playback_sessions SET closed_at=? WHERE id='playing'").run(at.toISOString());
    await f.repositories.progress.save(f.owner.id, video.id, 2);
    f.database.client.exec("CREATE TRIGGER isolated_reject_delete BEFORE DELETE ON videos BEGIN SELECT RAISE(ABORT,'isolated failure'); END;");
    const failed = await f.request(`/api/videos/${video.id}`, "DELETE", { confirm: true }); assert.equal(failed.statusCode, 500);
    assert.equal((await f.repositories.progress.read(f.owner.id, video.id)).positionSeconds, 2);
    assert.ok(await f.repositories.videos.findOwned(f.owner.id, video.id));
    assert.ok(f.database.client.prepare("SELECT 1 FROM playback_sessions WHERE id='playing'").get());
    assert.deepEqual(f.database.client.pragma("foreign_key_check"), []);
  } finally { await f.close(); }
});

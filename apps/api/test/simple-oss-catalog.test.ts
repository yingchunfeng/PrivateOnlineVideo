import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/core/config.js";
import { runtimeModules } from "../src/core/runtime.js";
import { assertLibrarySelection, objectKeyFromPublicUrl, publicUrlFor, validateLibraryConfig } from "../src/core/library-config.js";
import { openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { AuthService } from "../src/modules/auth/service.js";
import { readAuthSettings } from "../src/modules/auth/settings.js";
import type { AuthPrincipal, VideoRecord } from "../src/core/contracts/index.js";

const at = "2026-10-03T08:00:00.000Z";
const library = validateLibraryConfig({ mediaBaseUrl: "https://oss.meetdawn.top", objectPrefix: "onlineVideo/", categories: [
  { id: "default", name: "未分类", tags: ["旅行", "城市,夜景"] }, { id: "empty", name: "空分类", tags: [] },
  { id: "disabled", name: "停用分类", tags: [], enabled: false }
] });
function fixture(path = ":memory:") {
  if (path !== ":memory:") new Database(path).close();
  const database = openDatabase(path, { initialize: true });
  database.client.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES('owner','隔离账号','test-only','test-only',?)").run(at);
  database.client.prepare("INSERT INTO categories(id,owner_id,name,name_key,is_default,created_at) VALUES('default','owner','未分类','未分类',1,?)").run(at);
  const principal: AuthPrincipal = { user: { id: "owner", displayName: "隔离账号", totpEnabled: true }, loginSessionId: "login" };
  const config = { ...readConfig({ NODE_ENV: "test" }), library };
  const repositories = createRepositories(database, () => new Date(at), library);
  return { database, config, principal, repositories };
}

test("配置分类顺序/空分类/停用状态、ID和标签校验；公共地址只登记同域授权路径", () => {
  assert.deepEqual(library.categories.map(category => category.id), ["default", "empty", "disabled"]);
  assert.deepEqual(assertLibrarySelection(library, { categoryId: "default", tags: ["城市,夜景"] }), { categoryId: "default", tags: ["城市,夜景"] });
  assert.throws(() => assertLibrarySelection(library, { categoryId: "disabled" }));
  assert.throws(() => assertLibrarySelection(library, { categoryId: "default", tags: ["未配置"] }));
  assert.throws(() => assertLibrarySelection(library, { categoryId: "default", tags: null }));
  for (const categories of [[library.categories[0], library.categories[0]], [{ id: "../bad", name: "x", tags: [] }], [{ id: "ok", name: "x", tags: ["旅行", "旅行"] }]]) {
    assert.throws(() => validateLibraryConfig({ ...library, categories }));
  }
  const key = "onlineVideo/96257570ce7bc1f46e749df9ab2598f7.mp4";
  assert.equal(objectKeyFromPublicUrl(library, publicUrlFor(library, key)), key);
  assert.equal(objectKeyFromPublicUrl(library, "https://oss.meetdawn.top/onlineVideo/default/%E6%97%85%E8%A1%8C.mp4"), "onlineVideo/default/旅行.mp4");
  for (const url of ["https://evil.test/onlineVideo/test.mp4", "https://oss.meetdawn.top/outside/test.mp4", `${publicUrlFor(library, key)}?signature=secret`,
    "https://oss.meetdawn.top/onlineVideo/../outside.mp4", "https://oss.meetdawn.top/onlineVideo/%2e%2e/outside.mp4", "https://oss.meetdawn.top/onlineVideo/%5cbad.mp4"]) {
    assert.throws(() => objectKeyFromPublicUrl(library, url));
  }
});

test("真实SQLite+HTTP公开地址登记、逗号标签筛选、标签文本搜索、分页和信息编辑", async () => {
  const f = fixture();
  const auth = { requireUser: async (_request: unknown, _options: unknown) => f.principal };
  const app = await buildApp({ config: f.config, logger: false, backend: { config: f.config, auth, database: f.database, now: () => new Date(at) } });
  try {
    const before = f.database.client.prepare("SELECT count(*) n FROM categories").get();
    const displayed = (await app.inject({ method: "GET", url: "/api/library" })).json().data;
    assert.deepEqual(displayed, library);
    assert.deepEqual(f.database.client.prepare("SELECT count(*) n FROM categories").get(), before, "读取配置不可自动同步数据库");
    const request = { publicUrl: "https://oss.meetdawn.top/onlineVideo/96257570ce7bc1f46e749df9ab2598f7.mp4", title: "公开基线", categoryId: "default", tags: ["城市,夜景", "旅行"] };
    const registered = await app.inject({ method: "POST", url: "/api/videos/register-public", payload: request });
    assert.equal(registered.statusCode, 200); const video = registered.json().data;
    assert.equal(video.publicUrl, request.publicUrl); assert.equal(video.fileName, "96257570ce7bc1f46e749df9ab2598f7.mp4");
    assert.equal(video.objectKey, request.publicUrl.slice(library.mediaBaseUrl.length + 1));
    assert.equal((await app.inject({ method: "POST", url: "/api/videos/register-public", payload: request })).json().data.id, video.id);
    assert.equal((await app.inject({ method: "GET", url: `/api/videos?tags=${encodeURIComponent(JSON.stringify(["城市,夜景"]))}&pageSize=1&q=${encodeURIComponent("夜景")}` })).json().data.total, 1);
    assert.equal((await app.inject({ method: "GET", url: "/api/videos?categoryId=empty" })).json().data.total, 0);
    assert.equal((await app.inject({ method: "GET", url: "/api/videos?page=2&pageSize=1" })).json().data.items.length, 0);
    assert.equal((await app.inject({ method: "GET", url: "/api/videos?tags=travel,night" })).statusCode, 400);
    const edited = await app.inject({ method: "PATCH", url: `/api/videos/${video.id}`, payload: { title: "修改标题", tags: ["旅行"] } });
    assert.equal(edited.statusCode, 200); assert.deepEqual(edited.json().data.tags, ["旅行"]); assert.equal(edited.json().data.objectKey, video.objectKey);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/videos/${video.id}`, payload: { title: "不应写入", tags: ["未知"] } })).statusCode, 400);
    assert.equal((await f.repositories.videos.findOwned("owner", video.id))!.video.title, "修改标题");
    assert.equal((await app.inject({ method: "POST", url: "/api/videos/register-public", payload: { ...request, categoryId: "empty", tags: [] } })).statusCode, 200);
    assert.equal(f.database.client.pragma("integrity_check", { simple: true }), "ok");
  } finally { await app.close(); f.database.close(); }
});

test("配置新增分类仅在授权登记写入；历史分类名、路径、分组关联与观看位置不变", async () => {
  const f = fixture();
  try {
    const old = createRepositories(f.database, () => new Date(at));
    const group = old.organizations.create("library_groups", "owner", { name: "历史分组" });
    const record: VideoRecord = { ownerId: "owner", originalObject: { key: "onlineVideo/private-old.mp4" }, playbackObject: { key: "onlineVideo/private-old.mp4" }, thumbnailObject: null,
      video: { id: "old-video", title: "历史私有视频", categoryId: "default", groupIds: [group.id], durationSeconds: 30, sizeBytes: 10, status: "unsupported", thumbnailUrl: null,
        createdAt: at, codec: null, width: null, height: null, playable: false, lastPositionSeconds: 0 } };
    await old.videos.register(record); await old.progress.save("owner", "old-video", 12);
    await f.repositories.catalog.update("owner", "old-video", { title: "保留历史", tags: ["旅行"] });
    const video = (await f.repositories.videos.findOwned("owner", "old-video"))!.video;
    assert.deepEqual(video.groupIds, [group.id]); assert.equal(video.objectKey, record.originalObject.key); assert.equal(video.lastPositionSeconds, 12);
    assert.equal(video.playable, false); assert.equal(video.publicUrl, "https://oss.meetdawn.top/onlineVideo/private-old.mp4");
    const renamed = createRepositories(f.database, () => new Date(at), { ...library, categories: library.categories.map(category => category.id === "default" ? { ...category, name: "新的展示名称" } : category) });
    assert.equal((await renamed.videos.findOwned("owner", "old-video"))!.video.objectKey, record.originalObject.key);
    assert.equal((f.database.client.prepare("SELECT name FROM categories WHERE id='default'").get() as { name: string }).name, "未分类");
    await f.repositories.organizations.normalizeSelection("owner", { categoryId: "empty", tags: [] });
    assert.ok(f.database.client.prepare("SELECT id FROM categories WHERE id='empty'").get());
  } finally { f.database.close(); }
});

test("公开信息和标签在SQLite重开后保留，账号记录不变", async () => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `simple-catalog-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "isolated.db"); const f = fixture(path); let videoId = "";
  const account = f.database.client.prepare("SELECT * FROM users").all();
  try {
    const selection = await f.repositories.organizations.normalizeSelection("owner", { categoryId: "default", tags: ["城市,夜景"] });
    const record = await f.repositories.videos.register({ ownerId: "owner", originalObject: { key: "onlineVideo/default/preserved.mp4" }, playbackObject: { key: "onlineVideo/default/preserved.mp4" }, thumbnailObject: null,
      video: { id: randomUUID(), title: "重启保留", ...selection, durationSeconds: null, sizeBytes: 0, status: "processing", thumbnailUrl: null,
        createdAt: at, codec: null, width: null, height: null, playable: false, lastPositionSeconds: 0 } });
    videoId = record.video.id;
  } finally { f.database.close(); }
  const reopened = openDatabase(path);
  try {
    const record = await createRepositories(reopened, () => new Date(at), library).videos.findOwned("owner", videoId);
    assert.deepEqual(record!.video.tags, ["城市,夜景"]); assert.equal(record!.video.publicUrl, "https://oss.meetdawn.top/onlineVideo/default/preserved.mp4");
    assert.deepEqual(reopened.client.prepare("SELECT * FROM users").all(), account);
    assert.deepEqual(reopened.client.prepare("SELECT version FROM schema_migrations ORDER BY version").all(), [{ version: 1 }, { version: 2 }]);
  } finally { reopened.close(); }
});

test("历史标签大小写规范化复用ID，返回配置名称且不改写历史标签记录", async () => {
  const f = fixture();
  try {
    const legacy = createRepositories(f.database, () => new Date(at));
    const tag = legacy.organizations.create("tags", "owner", { name: "TRAVEL" });
    const configured = { ...library, categories: [{ id: "default", name: "未分类", tags: ["travel"] }] };
    const repos = createRepositories(f.database, () => new Date(at), configured);
    const selected = await repos.organizations.normalizeSelection("owner", { categoryId: "default", tags: ["travel"] });
    assert.deepEqual(selected.tagIds, [tag.id]);
    const task = await repos.uploads.create({ ownerId: "owner", request: { title: "规范化", fileName: "sample.mp4", sizeBytes: 5, ...selected },
      object: { key: "onlineVideo/default/sample.mp4" }, storageUploadId: "isolated-upload", partSizeBytes: 5 });
    assert.deepEqual(task.task.tags, ["travel"]);
    assertLibrarySelection(configured, { categoryId: task.categoryId, tags: task.task.tags });
    assert.equal((f.database.client.prepare("SELECT name FROM tags WHERE id=?").get(tag.id) as { name: string }).name, "TRAVEL");
  } finally { f.database.close(); }
});

test("默认公共runtime使用隔离凭据装配，不要求STS、签名、播放限额或FFprobe", async () => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `simple-runtime-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const credentialFile = resolve(directory, "test-only-oss.json");
  writeFileSync(credentialFile, JSON.stringify({ accessKeyId: "isolated-test-ak", accessKeySecret: "isolated-test-secret" }), "utf8");
  const config = readConfig({ NODE_ENV: "test", STORAGE_DRIVER: "oss", MAX_UPLOAD_BYTES: "1048576", UPLOAD_PART_SIZE_BYTES: "102400", MAX_UPLOAD_CONCURRENCY: "1", MEDIA_REQUESTS_PER_MINUTE: "120",
    OSS_BUCKET: "isolated-bucket", OSS_REGION: "cn-hangzhou", OSS_NETWORK: "public", OSS_ALLOW_PUBLIC_NETWORK: "true", OSS_ENDPOINT: "https://oss-cn-hangzhou.aliyuncs.com", OSS_CREDENTIAL_FILE: credentialFile });
  config.library = library;
  assert.equal(config.libraryMode, "public"); assert.equal(config.maxPlaybackSessions, null); assert.equal(config.oss!.roleArn, undefined); assert.equal(config.media!.ffprobePath, null);
  const f = fixture(); const auth = new AuthService(f.database, randomBytes(32), readAuthSettings("test", {}));
  const modules = await runtimeModules(config, auth, f.database, () => new Date(at));
  const app = await buildApp({ config, logger: false, auth, ...modules });
  try {
    assert.equal(modules.media!.dependencies.sources, undefined);
    assert.equal((await app.inject({ method: "POST", url: "/api/videos/missing/playback-sessions", payload: {} })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/videos/missing/stream" })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/imports/preview", payload: {} })).statusCode, 404);
  } finally { await app.close(); f.database.close(); }
});

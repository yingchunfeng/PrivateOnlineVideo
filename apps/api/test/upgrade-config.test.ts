import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { LibraryConfiguration, SaveLibraryConfigurationRequest } from "@online-video/shared";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/core/config.js";
import { loadLibraryConfig, validateLibraryConfig } from "../src/core/library-config.js";
import { createLibraryConfiguration, recoverLibraryConfiguration } from "../src/core/library-configuration.js";
import { openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";

const at = "2026-10-03T14:00:00.000Z";
function fixture() {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `upgrade-config-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const databasePath = resolve(directory, "isolated.db"); new Database(databasePath).close();
  const database = openDatabase(databasePath, { initialize: true });
  database.client.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES('owner','隔离账号','unchanged-password','unchanged-secret',?)").run(at);
  database.client.prepare("INSERT INTO categories(id,owner_id,name,name_key,is_default,created_at) VALUES('default','owner','未分类','未分类',1,?)").run(at);
  database.client.prepare("INSERT INTO categories(id,owner_id,name,name_key,is_default,created_at) VALUES('sql-only','owner','历史SQL分类','历史sql分类',0,?)").run(at);
  const config = validateLibraryConfig({ mediaBaseUrl: "https://oss.meetdawn.top", objectPrefix: "onlineVideo/", categories: [{ id: "default", name: "未分类", tags: ["旅行"] }] });
  const path = resolve(directory, "library.json"); writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  const repositories = createRepositories(database, () => new Date(at), config);
  const manager = createLibraryConfiguration(database, config, path, () => new Date(at));
  return { directory, database, databasePath, config, path, repositories, manager };
}
function editable(view: LibraryConfiguration): SaveLibraryConfigurationRequest {
  return { version: view.version, categories: view.categories.map(({ id, name, enabled, tagIds }) => ({ id, name, enabled, tagIds })), tags: view.tags.map(({ id, name, enabled }) => ({ id, name, enabled })) };
}
async function register(f: ReturnType<typeof fixture>, categoryId = "default", tags = ["旅行"]) {
  const selected = await f.repositories.organizations.normalizeSelection("owner", { categoryId, tags });
  const object = { kind: "legacy" as const, key: `onlineVideo/${randomUUID()}.mp4` };
  return f.repositories.videos.register({ ownerId: "owner", originalObject: object, playbackObject: object, thumbnailObject: null, video: { id: randomUUID(), title: "保留的旧视频", ...selected, sizeBytes: 4, durationSeconds: null, status: "ready", thumbnailUrl: null, createdAt: at, codec: null, width: null, height: null, playable: true, lastPositionSeconds: 0 } });
}

test("隔离配置CRUD：JSON/SQLite热更新、空分类顺序、稳定标签ID与历史搜索，重开保留", async () => {
  const f = fixture();
  try {
    const pendingTagId = f.manager.view("owner").tags[0]!.id;
    const old = await register(f); const oldTagId = old.video.tagIds![0]!;
    assert.equal(oldTagId, pendingTagId, "未落库的JSON标签从查询到首次上传保持同一ID");
    f.database.client.prepare("UPDATE tags SET updated_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(oldTagId);
    const originalTag = f.database.client.prepare("SELECT * FROM tags WHERE id=?").get(oldTagId);
    const sqlOnly = f.database.client.prepare("SELECT * FROM categories WHERE id='sql-only'").get();
    const before = f.manager.view("owner"); assert.equal(before.tags[0]!.id, oldTagId);
    const desired = editable(before); desired.categories.unshift({ name: "空分类", enabled: true, tagIds: [oldTagId] });
    let saved = f.manager.save("owner", desired); const emptyId = saved.categories[0]!.id;
    assert.deepEqual(f.database.client.prepare("SELECT * FROM tags WHERE id=?").get(oldTagId), originalTag, "仅新增分类不得重写历史标签时间");
    assert.equal(f.config.categories[0]!.id, emptyId); assert.equal(f.config.categories[0]!.tags[0], "旅行");
    assert.deepEqual(f.database.client.prepare("SELECT * FROM categories WHERE id='sql-only'").get(), sqlOnly);
    const renamed = editable(saved); renamed.tags[0]!.name = "出行";
    assert.throws(() => f.manager.save("owner", renamed), { code: "CONFIG_IMPACT_CONFIRMATION_REQUIRED" });
    saved = f.manager.save("owner", { ...renamed, confirmImpact: true });
    assert.equal(saved.tags[0]!.id, oldTagId);
    assert.deepEqual((await f.repositories.videos.findOwned("owner", old.video.id))!.video.tags, ["出行"]);
    assert.equal((await f.repositories.catalog.list("owner", { q: "出行" })).total, 1);
    assert.equal((await f.repositories.videos.findOwned("owner", old.video.id))!.originalObject.key, old.originalObject.key);
    const reordered = editable(saved); reordered.categories.reverse(); reordered.categories.find(item => item.id === emptyId)!.name = "改名空分类";
    saved = f.manager.save("owner", reordered); assert.equal(f.config.categories[1]!.id, emptyId);
    const disabled = editable(saved); disabled.tags[0]!.enabled = false; disabled.categories.find(item => item.id === emptyId)!.enabled = false;
    saved = f.manager.save("owner", { ...disabled, confirmImpact: true });
    assert.equal(saved.categories.find(item => item.id === emptyId)!.enabled, false);
    assert.deepEqual((await f.repositories.videos.findOwned("owner", old.video.id))!.video.tagIds, [oldTagId]);
    assert.equal((await f.repositories.catalog.list("owner", { tags: JSON.stringify(["出行"]) })).total, 1);
    assert.equal((await f.repositories.catalog.update("owner", old.video.id, { title: "仍可编辑", tags: ["出行"] })).title, "仍可编辑");
    await assert.rejects(f.repositories.organizations.normalizeSelection("owner", { categoryId: emptyId, tags: [] }), { code: "ORGANIZATION_CONFLICT" });
    assert.equal(readdirSync(f.directory).filter(name => name.includes(".backup.")).length, 4);
    assert.equal(readFileSync(f.path)[0] === 0xef, false);
    f.database.close();
    const reopened = openDatabase(f.databasePath); const loaded = loadLibraryConfig(f.path);
    try { assert.equal(loaded.categories[1]!.id, emptyId); assert.equal(loaded.tagDefinitions![0]!.id, oldTagId); assert.equal(reopened.client.prepare("SELECT password_hash FROM users").get() && (reopened.client.prepare("SELECT password_hash FROM users").get() as { password_hash: string }).password_hash, "unchanged-password"); }
    finally { reopened.close(); }
  } finally { if (f.database.client.open) f.database.close(); }
});

test("隔离HTTP配置成功立即联动library，旧管理接口同源；非法/冲突/删除默认分类不写盘", async () => {
  const f = fixture(); const config = { ...readConfig({ NODE_ENV: "test" }), library: f.config, libraryConfigPath: f.path };
  const auth = { requireUser: async () => ({ user: { id: "owner", displayName: "隔离", totpEnabled: true }, loginSessionId: "isolated-login" }) };
  const app = await buildApp({ config, logger: false, backend: { config, auth, database: f.database } });
  try {
    const initial = (await app.inject({ method: "GET", url: "/api/library/configuration" })).json().data as LibraryConfiguration;
    const created = await app.inject({ method: "POST", url: "/api/categories", payload: { name: "立即显示", version: initial.version, sortOrder: 0 } });
    assert.equal(created.statusCode, 200); const id = created.json().data.id;
    assert.equal((await app.inject({ method: "GET", url: "/api/library" })).json().data.categories[0].id, id);
    const current = (await app.inject({ method: "GET", url: "/api/library/configuration" })).json().data as LibraryConfiguration;
    const bytes = readFileSync(f.path, "utf8");
    assert.equal((await app.inject({ method: "PUT", url: "/api/library/configuration", payload: editable(initial) })).json().error.code, "CONFIG_VERSION_CONFLICT");
    assert.equal((await app.inject({ method: "PUT", url: "/api/library/configuration", payload: { ...editable(current), mediaBaseUrl: "https://other.test" } })).statusCode, 400);
    const desired = editable(current); desired.categories.find(item => item.id === "default")!.enabled = false;
    assert.equal((await app.inject({ method: "PUT", url: "/api/library/configuration", payload: desired })).statusCode, 409);
    assert.equal(readFileSync(f.path, "utf8"), bytes);
    desired.categories.find(item => item.id === "default")!.enabled = true; desired.categories.find(item => item.id === id)!.enabled = false;
    assert.equal((await app.inject({ method: "PUT", url: "/api/library/configuration", payload: desired })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/categories" })).json().data.some((item: { id: string }) => item.id === id), false);
  } finally { await app.close(); f.database.close(); }
});

test("隔离独立分类与标签CRUD：新增即能选择，分类筛选、标签改名与删除立即生效", async () => {
  const f = fixture(); const config = { ...readConfig({ NODE_ENV: "test" }), library: f.config, libraryConfigPath: f.path };
  const auth = { requireUser: async () => ({ user: { id: "owner", displayName: "隔离", totpEnabled: true }, loginSessionId: "isolated-login" }) };
  const app = await buildApp({ config, logger: false, backend: { config, auth, database: f.database } });
  try {
    const desired = editable(f.manager.view("owner")); desired.categories.push({ name: "学习", enabled: true, tagIds: [] }, { name: "已删除", enabled: false, tagIds: [] });
    let saved = f.manager.save("owner", desired); const learningId = saved.categories.find(category => category.name === "学习")!.id;
    assert.deepEqual(f.config.categories.find(category => category.id === learningId)!.tags, ["旅行"], "新增分类默认可以选择已有有效标签");
    const narrowed = editable(saved); narrowed.categories.find(category => category.id === learningId)!.tagIds = [];
    saved = f.manager.save("owner", { ...narrowed, confirmImpact: true });
    const createTag = await app.inject({ method: "POST", url: "/api/tags", payload: { name: "笔记", version: saved.version } });
    assert.equal(createTag.statusCode, 200); const newTagId = createTag.json().data.id as string;
    const library = (await app.inject({ method: "GET", url: "/api/library" })).json().data;
    assert.deepEqual(library.categories.find((category: { id: string }) => category.id === "default").tags, ["旅行", "笔记"], "未分类直接可选新增标签");
    assert.deepEqual(library.categories.find((category: { id: string }) => category.id === learningId).tags, ["笔记"], "保留旧范围调整，并把新标签自动加入启用分类");
    assert.equal(library.categories.find((category: { name: string }) => category.name === "已删除").tags.includes("笔记"), false);
    const defaultVideo = await register(f, "default", ["笔记"]); const learningVideo = await register(f, learningId, ["笔记"]);
    assert.equal((await f.repositories.catalog.list("owner", {})).total, 2, "默认查询为全部视频");
    assert.equal((await f.repositories.catalog.list("owner", { categoryId: learningId })).items[0]!.id, learningVideo.video.id);
    saved = f.manager.view("owner"); const renamed = editable(saved); renamed.tags.find(tag => tag.id === newTagId)!.name = "学习笔记";
    saved = f.manager.save("owner", { ...renamed, confirmImpact: true });
    assert.deepEqual((await f.repositories.videos.findOwned("owner", defaultVideo.video.id))!.video.tags, ["学习笔记"]);
    const deleted = editable(saved); deleted.tags.find(tag => tag.id === newTagId)!.enabled = false;
    saved = f.manager.save("owner", { ...deleted, confirmImpact: true });
    const afterDelete = (await app.inject({ method: "GET", url: "/api/library" })).json().data;
    assert.equal(afterDelete.categories.some((category: { tags: string[] }) => category.tags.includes("学习笔记")), false, "删除标签立即退出可选范围");
    assert.deepEqual((await f.repositories.videos.findOwned("owner", learningVideo.video.id))!.video.tags, ["学习笔记"], "视频已有标签保留");
    await assert.rejects(f.repositories.organizations.normalizeSelection("owner", { categoryId: "default", tags: ["学习笔记"] }), { code: "VALIDATION_ERROR" });
    const restored = editable(saved); restored.tags.find(tag => tag.id === newTagId)!.enabled = true; f.manager.save("owner", restored);
    assert.deepEqual((await f.repositories.organizations.normalizeSelection("owner", { categoryId: "default", tags: ["学习笔记"] })).tags, ["学习笔记"]);
  } finally { await app.close(); f.database.close(); }
});

test("隔离历史双来源差异：JSON未分类/SQL未分的，无关新增不覆盖旧行，显式编辑才更新对应列", async () => {
  const f = fixture();
  try {
    const video = await register(f); const tagId = video.video.tagIds![0]!;
    f.database.client.prepare("UPDATE categories SET name='未分的',name_key='未分的',sort_order=88 WHERE id='default'").run();
    f.database.client.prepare("UPDATE tags SET name='旅行历史',name_key='旅行历史',updated_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(tagId);
    const categoryBefore = f.database.client.prepare("SELECT * FROM categories WHERE id='default'").get();
    const tagBefore = f.database.client.prepare("SELECT * FROM tags WHERE id=?").get(tagId);
    const desired = editable(f.manager.view("owner")); desired.categories.push({ name: "仅新增", enabled: true, tagIds: [] });
    let saved = f.manager.save("owner", desired);
    assert.deepEqual(f.database.client.prepare("SELECT * FROM categories WHERE id='default'").get(), categoryBefore);
    assert.deepEqual(f.database.client.prepare("SELECT * FROM tags WHERE id=?").get(tagId), tagBefore);
    const renamed = editable(saved); renamed.categories.find(item => item.id === "default")!.name = "显式类别改名"; renamed.tags.find(item => item.id === tagId)!.name = "显式标签改名";
    saved = f.manager.save("owner", { ...renamed, confirmImpact: true });
    const category = f.database.client.prepare("SELECT * FROM categories WHERE id='default'").get() as { name: string; name_key: string; sort_order: number };
    const tag = f.database.client.prepare("SELECT * FROM tags WHERE id=?").get(tagId) as { name: string; name_key: string; updated_at: string };
    assert.equal(category.name, "显式类别改名"); assert.equal(category.name_key, "显式类别改名"); assert.equal(category.sort_order, 88, "仅改名不得隐式修正历史排序");
    assert.equal(tag.name, "显式标签改名"); assert.equal(tag.name_key, "显式标签改名"); assert.equal(tag.updated_at, at);
    const reordered = editable(saved); reordered.categories.reverse(); f.manager.save("owner", reordered);
    assert.equal((f.database.client.prepare("SELECT sort_order FROM categories WHERE id='default'").get() as { sort_order: number }).sort_order, 1);
    assert.equal((await f.repositories.videos.findOwned("owner", video.video.id))!.video.tagIds![0], tagId);
  } finally { f.database.close(); }
});

test("隔离保存失败补偿与中断恢复：pending独立持久、SQL提交失败恢复旧文件、未知文件拒绝恢复", () => {
  const f = fixture();
  try {
    const oldRaw = readFileSync(f.path, "utf8"); const desired = editable(f.manager.view("owner")); desired.categories.push({ name: "失败分类", enabled: true, tagIds: [] });
    f.database.client.exec("CREATE TRIGGER isolated_fail_configuration_commit BEFORE UPDATE OF action ON audit_events WHEN NEW.action LIKE '%\"state\":\"committed\"%' BEGIN SELECT RAISE(ABORT,'isolated commit failure'); END");
    assert.throws(() => f.manager.save("owner", desired), { code: "CONFIG_SAVE_FAILED" });
    assert.equal(readFileSync(f.path, "utf8"), oldRaw); assert.equal(f.database.client.prepare("SELECT 1 FROM categories WHERE name='失败分类'").get(), undefined);
    assert.equal(f.manager.view("owner").version, desired.version);
    const newRaw = JSON.stringify({ ...f.config, categories: [...f.config.categories, { id: "crash", name: "中断分类", tags: [] }] });
    const journalId = randomUUID(); const journal = { path: f.path, state: "pending", oldRaw, newRaw };
    f.database.client.prepare("INSERT INTO audit_events(id,owner_id,action,created_at) VALUES(?,'owner',?,?)").run(journalId, "library.configuration.v1:" + JSON.stringify(journal), at);
    writeFileSync(f.path, newRaw, "utf8"); recoverLibraryConfiguration(f.database, f.path);
    assert.equal(readFileSync(f.path, "utf8"), oldRaw); assert.equal(f.database.client.prepare("SELECT 1 FROM categories WHERE id='crash'").get(), undefined);
    const unknownId = randomUUID(); f.database.client.prepare("INSERT INTO audit_events(id,owner_id,action,created_at) VALUES(?,'owner',?,?)").run(unknownId, "library.configuration.v1:" + JSON.stringify(journal), at);
    writeFileSync(f.path, JSON.stringify({ ...f.config, categories: [] }), "utf8");
    assert.throws(() => recoverLibraryConfiguration(f.database, f.path), { code: "CONFIG_RECOVERY_REQUIRED" });
    assert.throws(() => f.manager.view("owner"), { code: "CONFIG_RECOVERY_REQUIRED" });
  } finally { f.database.close(); }
});

test("隔离分类删除确认后两个视频归未分类，仅改变categoryId，恢复分类不自动搬回", async () => {
  const f = fixture();
  try {
    const desired = editable(f.manager.view("owner")); desired.categories.push({ name: "待删除分类", enabled: true, tagIds: [desired.tags[0]!.id!] });
    const saved = f.manager.save("owner", desired); const categoryId = saved.categories[1]!.id;
    const first = await register(f, categoryId); const second = await register(f, categoryId);
    const intent = await f.repositories.objects.prepareCover!({ ownerId: "owner", videoId: first.video.id, checksum: "d".repeat(64), sizeBytes: 100, contentType: "image/jpeg", object: { provider: "mock", bucket: "", region: "", key: `onlineVideo/${categoryId}/covers/${randomUUID()}.jpg`, versionId: null } });
    const cover = await f.repositories.objects.verify({ ownerId: "owner", object: intent.object, metadata: { sizeBytes: 100, contentType: "image/jpeg", etag: "isolated-cover-etag" } });
    await f.repositories.videos.saveCover!({ ownerId: "owner", videoId: first.video.id, thumbnailObject: cover, operationId: intent.operationId });
    const videosBefore = f.database.client.prepare("SELECT * FROM videos WHERE category_id=? ORDER BY id").all(categoryId) as { id: string; category_id: string }[];
    const tagsBefore = f.database.client.prepare("SELECT * FROM video_tag_links ORDER BY video_id,tag_id").all();
    const assetsBefore = f.database.client.prepare("SELECT * FROM video_assets ORDER BY video_id,asset_role").all();
    const bytesBefore = readFileSync(f.path, "utf8"); const disabled = editable(f.manager.view("owner")); disabled.categories[1]!.enabled = false;
    assert.throws(() => f.manager.save("owner", disabled), { code: "CONFIG_IMPACT_CONFIRMATION_REQUIRED" });
    assert.equal(readFileSync(f.path, "utf8"), bytesBefore); assert.deepEqual(f.database.client.prepare("SELECT * FROM videos WHERE category_id=? ORDER BY id").all(categoryId), videosBefore);
    const deleted = f.manager.save("owner", { ...disabled, confirmImpact: true });
    assert.equal(deleted.categories.find(item => item.id === categoryId)!.videoCount, 0); assert.equal(deleted.categories.find(item => item.id === "default")!.videoCount, 2);
    assert.deepEqual(f.database.client.prepare("SELECT * FROM videos WHERE id IN (?,?) ORDER BY id").all(first.video.id, second.video.id), videosBefore.map(row => ({ ...row, category_id: "default" })));
    assert.deepEqual(f.database.client.prepare("SELECT * FROM video_tag_links ORDER BY video_id,tag_id").all(), tagsBefore);
    assert.deepEqual(f.database.client.prepare("SELECT * FROM video_assets ORDER BY video_id,asset_role").all(), assetsBefore);
    assert.equal((await f.repositories.videos.findOwned("owner", first.video.id))!.video.coverObjectKey, intent.object.key);
    assert.equal((await f.repositories.catalog.list("owner", { categoryId: "default", tags: JSON.stringify(["旅行"]) })).total, 2);
    const restored = editable(deleted); restored.categories[1]!.enabled = true; f.manager.save("owner", restored);
    assert.equal((await f.repositories.videos.findOwned("owner", second.video.id))!.video.categoryId, "default");
    assert.equal((await f.repositories.catalog.list("owner", { categoryId })).total, 0);
  } finally { f.database.close(); }
});

test("隔离分类删除提交失败：软停用、视频归类与JSON同一提交失败时一起恢复", async () => {
  const f = fixture();
  try {
    const desired = editable(f.manager.view("owner")); desired.categories.push({ name: "回滚分类", enabled: true, tagIds: [desired.tags[0]!.id!] });
    const saved = f.manager.save("owner", desired); const categoryId = saved.categories[1]!.id; await register(f, categoryId); await register(f, categoryId);
    const before = { raw: readFileSync(f.path, "utf8"), categories: f.database.client.prepare("SELECT * FROM categories ORDER BY id").all(), videos: f.database.client.prepare("SELECT * FROM videos ORDER BY id").all(), tags: f.database.client.prepare("SELECT * FROM video_tag_links ORDER BY video_id,tag_id").all() };
    f.database.client.exec("CREATE TRIGGER isolated_fail_category_deletion BEFORE UPDATE OF action ON audit_events WHEN NEW.action LIKE '%\"state\":\"committed\"%' BEGIN SELECT RAISE(ABORT,'isolated deletion failure'); END");
    const disabled = editable(saved); disabled.categories[1]!.enabled = false;
    assert.throws(() => f.manager.save("owner", { ...disabled, confirmImpact: true }), { code: "CONFIG_SAVE_FAILED" });
    assert.equal(readFileSync(f.path, "utf8"), before.raw); assert.deepEqual(f.database.client.prepare("SELECT * FROM categories ORDER BY id").all(), before.categories);
    assert.deepEqual(f.database.client.prepare("SELECT * FROM videos ORDER BY id").all(), before.videos); assert.deepEqual(f.database.client.prepare("SELECT * FROM video_tag_links ORDER BY video_id,tag_id").all(), before.tags);
    assert.equal(f.config.categories[1]!.enabled, true);
  } finally { f.database.close(); }
});

test("隔离任务创建幂等/分页/重开及停用后原快照完成，无新增结构迁移", async () => {
  const f = fixture();
  try {
    const desired = editable(f.manager.view("owner")); desired.categories.push({ name: "任务分类", enabled: true, tagIds: [desired.tags[0]!.id!] });
    const saved = f.manager.save("owner", desired); const categoryId = saved.categories[1]!.id;
    const request = { fileName: "original.mp4", title: "幂等任务", sizeBytes: 4, categoryId, tags: ["旅行"], clientRequestId: randomUUID() };
    const created = await f.repositories.uploads.create({ ownerId: "owner", request, object: { key: "onlineVideo/isolated-task.mp4" }, storageUploadId: "isolated-multipart", partSizeBytes: 2 });
    const repeated = await f.repositories.uploads.create({ ownerId: "owner", request, object: { key: "onlineVideo/ignored.mp4" }, storageUploadId: "ignored", partSizeBytes: 2 });
    assert.equal(repeated.task.id, created.task.id); assert.equal(repeated.object.key, created.object.key);
    await assert.rejects(f.repositories.uploads.findByClientRequestId!("owner", request.clientRequestId, { ...request, title: "冲突" }), { code: "UPLOAD_STATE_CONFLICT" });
    await f.repositories.uploads.savePart("owner", created.task.id, { partNumber: 1, sizeBytes: 2, checksum: "a".repeat(64), etag: "isolated-etag" });
    const disabled = editable(saved); disabled.categories[1]!.enabled = false; disabled.tags[0]!.enabled = false;
    f.manager.save("owner", { ...disabled, confirmImpact: true });
    assert.equal((await f.repositories.uploads.findByClientRequestId!("owner", request.clientRequestId, request))!.object.key, created.object.key);
    const page = await f.repositories.uploads.listOwned!("owner", { page: 1, pageSize: 1, status: "uploading" }); assert.equal(page.total, 1); assert.equal(page.items[0]!.uploadedBytes, 2);
    await f.repositories.uploads.savePart("owner", created.task.id, { partNumber: 2, sizeBytes: 2, checksum: "c".repeat(64), etag: "isolated-second-etag" });
    await f.repositories.uploads.transition("owner", created.task.id, "uploading", "finalizing");
    const finished = await f.repositories.uploads.finishRegistration!({ ownerId: "owner", uploadId: created.task.id, video: { ownerId: "owner", originalObject: created.object, playbackObject: created.object, thumbnailObject: null, video: { id: randomUUID(), title: request.title, categoryId, tags: request.tags, sizeBytes: 4, durationSeconds: null, status: "ready", thumbnailUrl: null, createdAt: at, codec: null, width: null, height: null, playable: true, lastPositionSeconds: 0 } } });
    assert.equal(finished.upload.task.status, "completed"); assert.equal(finished.video.video.categoryId, "default"); assert.equal(finished.upload.task.categoryId, categoryId);
    assert.equal(finished.video.originalObject.key, created.object.key); assert.deepEqual(finished.video.video.tagIds, created.task.tagIds);
    assert.equal((await f.repositories.catalog.list("owner", { q: "旅行" })).total, 1);
    f.database.close(); const reopened = openDatabase(f.databasePath);
    try { const repos = createRepositories(reopened, () => new Date(at), loadLibraryConfig(f.path)); const original = await repos.uploads.findByClientRequestId!("owner", request.clientRequestId, request); assert.equal(original!.task.videoId, finished.video.video.id); assert.equal(original!.parts[0]!.checksum, "a".repeat(64)); assert.equal((reopened.client.prepare("SELECT count(*) n FROM schema_migrations").get() as { n: number }).n, 2); }
    finally { reopened.close(); }
  } finally { if (f.database.client.open) f.database.close(); }
});

test("隔离失败任务历史包含云初始化/分片失败且保持可续传状态，完成后的封面失败独立", async () => {
  const f = fixture();
  try {
    const prepared = await f.repositories.objects.prepare({ ownerId: "owner", operation: "upload", object: { provider: "mock", bucket: "", region: "", key: `onlineVideo/${randomUUID()}.mp4`, versionId: null } });
    const upload = await f.repositories.uploads.create({ ownerId: "owner", request: { fileName: "failed-part.mp4", title: "失败续传任务", sizeBytes: 4, categoryId: "default", tags: ["旅行"] }, object: prepared.object, storageUploadId: "isolated-multipart", partSizeBytes: 4, operationId: prepared.operationId });
    await f.repositories.objects.recordOperation({ ownerId: "owner", operationId: prepared.operationId, state: "failed", uploadId: upload.task.id, errorCode: "STORAGE_UNAVAILABLE" });
    const failed = await f.repositories.uploads.listOwned!("owner", { status: "failed", page: 1, pageSize: 1 });
    assert.equal(failed.total, 1); assert.equal(failed.items[0]!.status, "uploading"); assert.equal(failed.items[0]!.errorCode, "STORAGE_UNAVAILABLE");
    assert.equal((await f.repositories.uploads.listOwned!("other", { status: "failed" })).total, 0);
    await f.repositories.uploads.savePart("owner", upload.task.id, { partNumber: 1, sizeBytes: 4, checksum: "e".repeat(64), etag: "isolated-recovered-etag" });
    assert.equal((await f.repositories.uploads.listOwned!("owner", { status: "failed" })).total, 0);
    assert.equal((await f.repositories.uploads.findOwned("owner", upload.task.id))!.task.errorCode, null);
    await f.repositories.uploads.transition("owner", upload.task.id, "uploading", "finalizing");
    const verified = await f.repositories.objects.verify({ ownerId: "owner", object: prepared.object, metadata: { sizeBytes: 4, contentType: "video/mp4", etag: "isolated-video-etag" } });
    const finished = await f.repositories.uploads.finishRegistration!({ ownerId: "owner", uploadId: upload.task.id, video: { ownerId: "owner", originalObject: verified, playbackObject: verified, thumbnailObject: null, video: { id: randomUUID(), title: upload.title, categoryId: "default", tags: ["旅行"], sizeBytes: 4, durationSeconds: null, status: "ready", thumbnailUrl: null, createdAt: at, codec: null, width: null, height: null, playable: true, lastPositionSeconds: 0 } } });
    const cover = await f.repositories.objects.prepareCover!({ ownerId: "owner", videoId: finished.video.video.id, checksum: "f".repeat(64), sizeBytes: 100, contentType: "image/jpeg", object: { provider: "mock", bucket: "", region: "", key: `onlineVideo/covers/${randomUUID()}.jpg`, versionId: null } });
    await f.repositories.objects.recordOperation({ ownerId: "owner", operationId: cover.operationId, state: "failed", errorCode: "STORAGE_UNAVAILABLE" });
    assert.equal((await f.repositories.uploads.listOwned!("owner", { status: "failed" })).total, 0);
    const completed = await f.repositories.uploads.listOwned!("owner", { status: "completed" }); assert.equal(completed.total, 1); assert.equal(completed.items[0]!.coverStatus, "failed");
  } finally { f.database.close(); }
});

test("隔离封面意图与资产关联：图片对象完成后失败重试复用objectKey，视频数据与旧资产保留", async () => {
  const f = fixture();
  try {
    const video = await register(f); const input = { ownerId: "owner", videoId: video.video.id, checksum: "b".repeat(64), sizeBytes: 100, contentType: "image/jpeg" as const, object: { provider: "mock" as const, bucket: "", region: "", key: `onlineVideo/covers/${randomUUID()}.jpg`, versionId: null } };
    const first = await f.repositories.objects.prepareCover!(input);
    await f.repositories.objects.recordOperation({ ownerId: "owner", operationId: first.operationId, state: "failed", errorCode: "COVER_REGISTRATION_FAILED", videoId: video.video.id });
    const repeated = await f.repositories.objects.prepareCover!({ ...input, object: { ...input.object, key: "onlineVideo/covers/ignored.jpg" } });
    assert.equal(repeated.object.id, first.object.id); assert.equal(repeated.operationId, first.operationId); assert.equal(repeated.state, "failed");
    const verified = await f.repositories.objects.verify({ ownerId: "owner", object: first.object, metadata: { sizeBytes: 100, contentType: "image/jpeg", etag: "isolated-image-etag" } });
    const covered = await f.repositories.videos.saveCover!({ ownerId: "owner", videoId: video.video.id, thumbnailObject: verified, operationId: first.operationId });
    assert.equal(covered.video.coverObjectKey, input.object.key); assert.equal(covered.video.coverUrl, `https://oss.meetdawn.top/${input.object.key}`); assert.equal(covered.video.coverStatus, "saved");
    assert.equal(covered.originalObject.key, video.originalObject.key); assert.equal(covered.video.title, video.video.title);
    assert.equal((f.database.client.prepare("SELECT count(*) n FROM video_assets WHERE asset_role='thumbnail'").get() as { n: number }).n, 1);
    await assert.rejects(f.repositories.objects.prepareCover!({ ...input, sizeBytes: 101 }), { code: "FILE_MISMATCH" });
    await assert.rejects(f.repositories.objects.prepareCover!({ ...input, ownerId: "other" }), { code: "NOT_FOUND" });
  } finally { f.database.close(); }
});

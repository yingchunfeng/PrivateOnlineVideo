import assert from "node:assert/strict";
import test from "node:test";
import type { VideoDetail } from "@online-video/shared";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/core/config.js";
import { validateLibraryConfig } from "../src/core/library-config.js";
import { openDatabase } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";

const at = "2026-10-03T14:30:00.000Z";
function fixture() {
  const database = openDatabase(":memory:", { initialize: true });
  database.client.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES('owner','隔离账号','test-only','test-only',?)").run(at);
  database.client.prepare("INSERT INTO categories(id,owner_id,name,name_key,is_default,created_at) VALUES('default','owner','未分类','未分类',1,?)").run(at);
  const library = validateLibraryConfig({ mediaBaseUrl: "https://oss.meetdawn.top", objectPrefix: "onlineVideo/", categories: [
    { id: "default", name: "未分类", tags: ["旅行", "共同", "新增"] },
    { id: "work", name: "工作", tags: ["共同", "会议"] },
    { id: "disabled", name: "停用分类", tags: [], enabled: false }
  ] });
  const repositories = createRepositories(database, () => new Date(at), library);
  return { database, library, repositories };
}
async function register(f: ReturnType<typeof fixture>) {
  const assets = await Promise.all(["video.mp4", "cover.jpg"].map(async fileName => {
    const prepared = await f.repositories.objects.prepare({ ownerId: "owner", operation: "upload", object: {
      provider: "mock", bucket: "", region: "", key: `onlineVideo/default/${fileName}`, versionId: null
    } });
    return f.repositories.objects.verify({ ownerId: "owner", object: prepared.object, metadata: {
      sizeBytes: 16, etag: `test-${fileName}`, contentType: fileName.endsWith("mp4") ? "video/mp4" : "image/jpeg", versionId: null
    } });
  }));
  return f.repositories.videos.register({ ownerId: "owner", originalObject: assets[0]!, playbackObject: assets[0]!, thumbnailObject: assets[1]!, video: {
    id: "video", title: "原视频", categoryId: "default", tags: ["旅行", "共同"], durationSeconds: 30, sizeBytes: 16, status: "ready",
    thumbnailUrl: null, createdAt: at, codec: "h264", width: 640, height: 360, playable: true, lastPositionSeconds: 0
  } });
}

test("HTTP编辑分类和标签立即改变筛选，视频/封面对象身份与观看位置保持，非法选择和跨账号请求不写入", async () => {
  const f = fixture(); let ownerId = "owner";
  const config = { ...readConfig({ NODE_ENV: "test" }), library: f.library };
  const auth = { requireUser: async () => ({ user: { id: ownerId, displayName: "隔离账号", totpEnabled: true }, loginSessionId: "isolated-login" }) };
  const app = await buildApp({ config, logger: false, backend: { config, auth, database: f.database, now: () => new Date(at) } });
  try {
    await register(f); await f.repositories.progress.save("owner", "video", 12);
    const before = (await f.repositories.videos.findOwned("owner", "video"))!;
    const objectRows = f.database.client.prepare("SELECT * FROM storage_objects ORDER BY id").all();
    const assetRows = f.database.client.prepare("SELECT * FROM video_assets ORDER BY asset_role").all();
    const operationRows = f.database.client.prepare("SELECT * FROM storage_operations ORDER BY id").all();
    const edited = await app.inject({ method: "PATCH", url: "/api/videos/video", payload: { title: "工作视频", categoryId: "work", tags: ["共同", "会议"] } });
    assert.equal(edited.statusCode, 200); const video = edited.json().data as VideoDetail;
    assert.equal(video.categoryId, "work"); assert.deepEqual(video.tags?.sort(), ["会议", "共同"].sort());
    for (const field of ["objectKey", "publicUrl", "coverObjectKey", "coverUrl", "fileName", "lastPositionSeconds", "createdAt"] as const) assert.equal(video[field], before.video[field], field);
    assert.equal((await app.inject({ method: "GET", url: "/api/videos?categoryId=default" })).json().data.total, 0);
    assert.equal((await app.inject({ method: "GET", url: `/api/videos?categoryId=work&tags=${encodeURIComponent(JSON.stringify(["会议", "共同"]))}` })).json().data.total, 1);
    for (const payload of [{ title: "不得落库", categoryId: "work", tags: ["旅行"] }, { title: "不得落库", categoryId: "disabled", tags: [] }, { title: "不得落库", categoryId: "missing", tags: [] }]) {
      assert.notEqual((await app.inject({ method: "PATCH", url: "/api/videos/video", payload })).statusCode, 200);
    }
    assert.equal((await f.repositories.videos.findOwned("owner", "video"))!.video.title, "工作视频");
    ownerId = "intruder";
    assert.equal((await app.inject({ method: "PATCH", url: "/api/videos/video", payload: { categoryId: "default", tags: [] } })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/videos?categoryId=work" })).json().data.total, 0);
    const after = (await f.repositories.videos.findOwned("owner", "video"))!;
    assert.deepEqual(after.originalObject, before.originalObject); assert.deepEqual(after.playbackObject, before.playbackObject); assert.deepEqual(after.thumbnailObject, before.thumbnailObject);
    assert.deepEqual(f.database.client.prepare("SELECT * FROM storage_objects ORDER BY id").all(), objectRows);
    assert.deepEqual(f.database.client.prepare("SELECT * FROM video_assets ORDER BY asset_role").all(), assetRows);
    assert.deepEqual(f.database.client.prepare("SELECT * FROM storage_operations ORDER BY id").all(), operationRows);
    assert.equal(f.database.client.pragma("integrity_check", { simple: true }), "ok");
  } finally { await app.close(); f.database.close(); }
});

test("同分类保留部分历史标签并新增有效标签，取消后不能重新添加停用历史标签，历史分类仍可解除标签后转到新分类", async () => {
  const f = fixture();
  try {
    await register(f);
    const oldTag = f.database.client.prepare("SELECT * FROM tags WHERE name='旅行'").get() as { id: string };
    f.database.client.prepare("UPDATE tags SET archived_at=? WHERE id=?").run(at, oldTag.id);
    f.library.categories[0]!.tags = ["共同", "新增"];
    const retained = await f.repositories.catalog.update("owner", "video", { tags: ["旅行", "新增"] });
    assert.deepEqual(retained.tags?.sort(), ["旅行", "新增"].sort()); assert.ok(retained.tagIds?.includes(oldTag.id));
    assert.equal((f.database.client.prepare("SELECT archived_at FROM tags WHERE id=?").get(oldTag.id) as { archived_at: string }).archived_at, at);
    await assert.rejects(f.repositories.catalog.update("owner", "video", { title: "不得落库", tags: ["旅行", "未知"] }), { code: "VALIDATION_ERROR" });
    assert.equal((await f.repositories.videos.findOwned("owner", "video"))!.video.title, "原视频");
    const cleared = await f.repositories.catalog.update("owner", "video", { tags: ["新增"] });
    assert.deepEqual(cleared.tags, ["新增"]);
    await assert.rejects(f.repositories.catalog.update("owner", "video", { tags: ["旅行", "新增"] }), { code: "VALIDATION_ERROR" });
    f.library.categories = f.library.categories.filter(category => category.id !== "default");
    const historical = await f.repositories.catalog.update("owner", "video", { title: "历史分类视频", tags: [] });
    assert.equal(historical.categoryId, "default"); assert.deepEqual(historical.tags, []);
    const restored = await f.repositories.catalog.update("owner", "video", { categoryId: "work", tags: ["会议"] });
    assert.equal(restored.categoryId, "work"); assert.deepEqual(restored.tags, ["会议"]);
    assert.equal(restored.publicUrl, "https://oss.meetdawn.top/onlineVideo/default/video.mp4");
  } finally { f.database.close(); }
});

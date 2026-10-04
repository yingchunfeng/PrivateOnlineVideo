import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { encode } from "jpeg-js";
import OSS from "ali-oss";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/core/config.js";
import { HttpError } from "../src/core/errors.js";
import { openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { createMediaModule } from "../src/modules/media/index.js";
import { MockStorageAdapter } from "../src/modules/media/storage/mock.js";
import { OssStorageAdapter } from "../src/modules/media/storage/oss.js";
import type { OssClient, OssOptions } from "../src/modules/media/storage/oss.js";
import type { RegisteredStorageObjectRef } from "../src/core/contracts/index.js";
import { inspectCoverImage } from "../src/modules/media/cover/image.js";
import { fakeDependencies, headers, options } from "./media/fakes.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function image(red = 100, width = 16, height = 12): Buffer {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = red; pixels[i + 1] = 50; pixels[i + 2] = 90; pixels[i + 3] = 255; }
  return encode({ width, height, data: pixels }, 80).data;
}
async function fixture() {
  const directory = await mkdtemp(join(WORKSPACE_ROOT, ".local", "isolated-upgrade-media-")); const file = join(directory, "media.db");
  const config = readConfig({ NODE_ENV: "test", MAX_PLAYBACK_SESSIONS: "1", TRANSFER_LIMIT_BYTES: "unlimited" });
  config.library = { mediaBaseUrl: "https://oss.meetdawn.top", objectPrefix: "onlineVideo/", categories: [
    { id: "category", name: "隔离分类", tags: ["旅行"] }, { id: "default-category", name: "未分类", tags: [] }
  ] };
  const fake = fakeDependencies(config); const storage = new MockStorageAdapter("onlineVideo/");
  new Database(file).close();
  let database = openDatabase(file, { initialize: true });
  database.client.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES(?,?,?,?,?)").run("owner", "隔离账户", "test", "test", fake.clock.time.toISOString());
  database.client.prepare("INSERT INTO categories(id,owner_id,name,name_key,is_default,created_at) VALUES(?,?,?, ?,1,?)").run("default-category", "owner", "未分类", "未分类", fake.clock.time.toISOString());
  let repositories = createRepositories(database, () => fake.clock.time, config.library);
  const dependencies = () => ({ ...fake.dependencies, ...repositories, storage });
  const build = () => buildApp({ config, logger: false,
    media: { register: createMediaModule({ ...options, objectPrefix: "onlineVideo/" }), dependencies: dependencies() } });
  let app = await build();
  return {
    config, storage, get app() { return app; }, get database() { return database; }, get repositories() { return repositories; },
    count(table: string) { return (database.client.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n; },
    async restart() { await app.close(); database.close(); database = openDatabase(file); repositories = createRepositories(database, () => fake.clock.time, config.library); app = await build(); },
    async close() { await app.close(); database.close(); }
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const input = { fileName: "same.mp4", title: "独立视频", categoryId: "category", tags: ["旅行"], sizeBytes: 5, clientRequestId: "stable-client-0001" };
const create = (f: Fixture, extra = {}) => f.app.inject({ method: "POST", url: "/api/uploads", headers, payload: { ...input, ...extra } });
const put = (f: Fixture, id: string, content = Buffer.from("hello")) => f.app.inject({ method: "PUT", url: `/api/uploads/${id}/parts/1`,
  headers: { ...headers, "content-type": "application/octet-stream", "x-part-checksum": sha(content) }, payload: content });
const complete = (f: Fixture, id: string) => f.app.inject({ method: "POST", url: `/api/uploads/${id}/complete`, headers, payload: {} });
const cover = (f: Fixture, id: string, bytes = image()) => f.app.inject({ method: "PUT", url: `/api/videos/${id}/cover`,
  headers: { ...headers, "content-type": "image/jpeg" }, payload: bytes });
async function videoFixture(f: Fixture) {
  const response = await create(f); assert.equal(response.statusCode, 200, response.body); const task = response.json().data;
  assert.equal((await put(f, task.id)).statusCode, 200); const result = await complete(f, task.id); assert.equal(result.statusCode, 200, result.body);
  return { task, video: result.json().data.video };
}

test("任务分页、响应丢失后并发幂等与SQLite重开唯一恢复；仅隔离SQLite/Mock", async t => {
  const f = await fixture(); t.after(() => f.close());
  const [first, duplicate] = await Promise.all([create(f), create(f)]);
  assert.equal(first.statusCode, 200, first.body); assert.equal(duplicate.statusCode, 200, duplicate.body);
  const task = first.json().data; assert.equal(duplicate.json().data.id, task.id); assert.equal(f.count("upload_tasks"), 1);
  assert.equal(f.count("storage_objects"), 1); assert.equal(f.storage.uploads.size, 0);
  for (const tags of ["旅行", 42, {}, [null], ["旅行", "旅行"]]) {
    const invalid = await create(f, { tags }); assert.equal(invalid.statusCode, 400, invalid.body);
  }
  assert.equal((await create(f, { title: "不能静默覆盖" })).statusCode, 409);
  await f.restart(); const resumed = await create(f); assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json().data.id, task.id); assert.equal(resumed.json().data.objectKey, task.objectKey);
  assert.equal(f.count("upload_tasks"), 1);
  assert.equal((await create(f, { clientRequestId: "stable-client-0002", tags: [] })).statusCode, 200);
  const noTags = { fileName: "same.mp4", title: "独立视频", categoryId: "category", sizeBytes: 5, clientRequestId: "stable-client-0002" };
  const retryNoTags = await f.app.inject({ method: "POST", url: "/api/uploads", headers, payload: noTags }); assert.equal(retryNoTags.statusCode, 200, retryNoTags.body);
  const page = await f.app.inject({ url: "/api/uploads?page=1&pageSize=1&status=uploading", headers });
  assert.equal(page.statusCode, 200, page.body); assert.equal(page.json().data.total, 2); assert.equal(page.json().data.items.length, 1);
  for (const query of ["page=0", "pageSize=101", "status=forged", "page=1.5"]) assert.equal((await f.app.inject({ url: `/api/uploads?${query}`, headers })).statusCode, 400);
  assert.equal((await f.app.inject({ url: "/api/uploads" })).statusCode, 401);
});

test("分类业务删除后原任务按旧路径续传，登记视频归默认未分类且标签保留；仅隔离SQLite/Mock", async t => {
  const f = await fixture(); t.after(() => f.close()); const made = await create(f); const task = made.json().data;
  f.config.library!.categories[0]!.enabled = false;
  f.database.client.prepare("UPDATE categories SET archived_at=? WHERE id='category'").run(new Date().toISOString());
  f.database.client.prepare("UPDATE tags SET archived_at=?").run(new Date().toISOString());
  const duplicate = await create(f); assert.equal(duplicate.statusCode, 200, duplicate.body); assert.equal(duplicate.json().data.id, task.id);
  assert.equal((await create(f, { clientRequestId: "stable-client-blocked" })).statusCode, 409);
  assert.equal((await put(f, task.id)).statusCode, 200);
  const result = await complete(f, task.id); assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().data.video.categoryId, "default-category"); assert.deepEqual(result.json().data.video.tags, ["旅行"]);
  assert.equal(result.json().data.upload.categoryId, "category"); assert.equal(result.json().data.upload.objectKey, task.objectKey);
  assert.equal(result.json().data.video.objectKey, task.objectKey); assert.match(result.json().data.video.objectKey, /^onlineVideo\/category\//);
  assert.deepEqual(result.json().data.video.tagIds, task.tagIds); assert.deepEqual(result.json().data.upload.tagIds, task.tagIds);
  const repeat = await complete(f, task.id); assert.equal(repeat.json().data.video.id, result.json().data.video.id); assert.equal(f.count("videos"), 1);
  assert.equal((await f.app.inject({ url: "/api/uploads?status=completed", headers })).json().data.total, 1);
});

test("真实分片路由失败进入持久历史，原任务/对象/已确认分片续传成功后清错；仅隔离SQLite/Mock", async t => {
  const f = await fixture(); t.after(() => f.close());
  const firstBytes = Buffer.alloc(options.partSizeBytes, 50); const secondBytes = Buffer.from("hello");
  const made = await create(f, { sizeBytes: firstBytes.length + secondBytes.length }); assert.equal(made.statusCode, 200, made.body);
  const task = made.json().data; assert.equal((await put(f, task.id, firstBytes)).statusCode, 200);
  const initial = (await f.repositories.uploads.findOwned("owner", task.id))!; const multipartId = initial.storageUploadId;
  const putSecond = (bytes = secondBytes) => f.app.inject({ method: "PUT", url: `/api/uploads/${task.id}/parts/2`,
    headers: { ...headers, "content-type": "application/octet-stream", "x-part-checksum": sha(secondBytes) }, payload: bytes });
  const storagePut = f.storage.uploadPart.bind(f.storage);
  f.storage.uploadPart = async input => {
    for await (const _chunk of input.stream) { /* 受控消费真实路由校验流，不保存失败分片。 */ }
    throw new HttpError("STORAGE_PERMISSION_DENIED");
  };
  const failed = await putSecond(); assert.equal(failed.statusCode, 503, failed.body); assert.equal(failed.json().error.code, "STORAGE_PERMISSION_DENIED");
  const history = (await f.app.inject({ url: "/api/uploads?status=failed", headers })).json().data;
  assert.equal(history.total, 1); assert.equal(history.items[0].id, task.id); assert.equal(history.items[0].status, "uploading");
  assert.equal(history.items[0].errorCode, "STORAGE_PERMISSION_DENIED");
  assert.equal((await f.repositories.uploads.listOwned!("other", { status: "failed" })).total, 0);
  let record = (await f.repositories.uploads.findOwned("owner", task.id))!;
  assert.equal(record.storageUploadId, multipartId); assert.equal(record.object.key, task.objectKey);
  assert.deepEqual(record.parts.map(part => part.checksum), [sha(firstBytes)]); assert.equal(f.storage.uploads.size, 1);
  f.storage.uploadPart = storagePut;
  const mismatch = await putSecond(Buffer.from("other")); assert.equal(mismatch.statusCode, 409, mismatch.body); assert.equal(mismatch.json().error.code, "FILE_MISMATCH");
  assert.equal((await f.app.inject({ url: "/api/uploads?status=failed", headers })).json().data.items[0].errorCode, "FILE_MISMATCH");
  await f.restart(); const resumed = await putSecond(); assert.equal(resumed.statusCode, 200, resumed.body);
  record = (await f.repositories.uploads.findOwned("owner", task.id))!;
  assert.equal(record.task.errorCode, null); assert.equal(record.storageUploadId, multipartId); assert.equal(record.object.key, task.objectKey);
  assert.deepEqual(record.parts.map(part => part.checksum), [sha(firstBytes), sha(secondBytes)]);
  assert.equal((await f.app.inject({ url: "/api/uploads?status=failed", headers })).json().data.total, 0);
  assert.equal(f.storage.uploads.size, 1); assert.equal(f.count("upload_tasks"), 1); assert.equal(f.count("storage_objects"), 1);
  assert.equal((await complete(f, task.id)).statusCode, 200);
});

test("真实HTTP客户端暂停取消上游，不把可续传任务写成失败；仅隔离SQLite/Mock", async t => {
  const f = await fixture(); t.after(() => f.close()); const made = await create(f); const task = made.json().data;
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let cancel!: () => void; const cancelled = new Promise<void>(resolve => { cancel = resolve; });
  const storagePut = f.storage.uploadPart.bind(f.storage);
  f.storage.uploadPart = async input => {
    for await (const _chunk of input.stream) { /* 完整收到分片后等待存储响应，暂停仍要取消。 */ }
    enter();
    return new Promise((_, reject) => {
      const abort = () => { cancel(); reject(new Error("isolated paused request")); };
      if (input.signal.aborted) abort(); else input.signal.addEventListener("abort", abort, { once: true });
    });
  };
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 }); const bytes = Buffer.from("hello");
  const client = httpRequest(`${address}/api/uploads/${task.id}/parts/1`, { method: "PUT", headers: {
    ...headers, "content-type": "application/octet-stream", "content-length": bytes.length, "x-part-checksum": sha(bytes)
  } });
  client.on("error", () => { /* 用户取消的客户端错误已预期。 */ }); client.end(bytes);
  await entered; client.destroy(); await cancelled;
  await new Promise<void>(resolve => setImmediate(resolve));
  const record = (await f.repositories.uploads.findOwned("owner", task.id))!;
  assert.equal(record.task.status, "uploading"); assert.equal(record.task.errorCode, null); assert.equal(record.parts.length, 0);
  assert.equal((await f.repositories.uploads.listOwned!("owner", { status: "failed" })).total, 0);
  assert.ok(record.storageUploadId); assert.equal(record.object.key, task.objectKey);
  f.storage.uploadPart = storagePut; assert.equal((await put(f, task.id)).statusCode, 200);
  const resumed = (await f.repositories.uploads.findOwned("owner", task.id))!;
  assert.equal(resumed.storageUploadId, record.storageUploadId); assert.equal(resumed.parts.length, 1);
});

test("真实JPEG解码、尺寸和请求限制拒绝占位/伪装/损坏封面；仅隔离SQLite/Mock", async t => {
  const f = await fixture(); t.after(() => f.close()); const { video } = await videoFixture(f);
  assert.deepEqual(inspectCoverImage(image()), { width: 16, height: 12, contentType: "image/jpeg" });
  assert.throws(() => inspectCoverImage(image(100, 961, 1)), (error: unknown) => error instanceof HttpError && error.code === "VALIDATION_ERROR");
  const damaged = Buffer.concat([image().subarray(0, -80), Buffer.from([0xff, 0xd9])]);
  assert.throws(() => inspectCoverImage(damaged));
  for (const bytes of [Buffer.from("封面占位"), damaged, image(100, 961, 1)]) {
    const response = await cover(f, video.id, bytes); assert.ok([400, 415].includes(response.statusCode), response.body);
  }
  assert.equal((await cover(f, video.id, Buffer.alloc(1024 * 1024 + 1))).statusCode, 413);
  assert.equal((await cover(f, "other-video")).statusCode, 404);
  assert.equal((await f.app.inject({ method: "PUT", url: `/api/videos/${video.id}/cover`, headers: { ...headers, "content-type": "image/png" }, payload: image() })).statusCode, 415);
  assert.equal((await f.app.inject({ method: "PUT", url: `/api/videos/${video.id}/cover`, headers: { "content-type": "image/jpeg" }, payload: image() })).statusCode, 401);
  assert.equal(f.storage.objects.size, 1); assert.equal(f.count("storage_objects"), 1);
});

test("封面持久化、同图幂等、换封面保留旧对象与原视频；仅隔离SQLite/Mock", async t => {
  const f = await fixture(); t.after(() => f.close()); const { video, task } = await videoFixture(f);
  const first = await cover(f, video.id); assert.equal(first.statusCode, 200, first.body); const saved = first.json().data;
  assert.match(saved.coverObjectKey, /^onlineVideo\/category\/covers\/[a-f0-9-]{36}\.jpg$/);
  assert.equal(saved.coverUrl, `https://oss.meetdawn.top/${saved.coverObjectKey}`); assert.equal(saved.coverStatus, "saved");
  assert.equal(saved.id, video.id); assert.equal(saved.objectKey, video.objectKey); assert.equal(saved.categoryId, video.categoryId);
  assert.equal((await cover(f, video.id)).json().data.coverObjectKey, saved.coverObjectKey); assert.equal(f.storage.objects.size, 2);
  const second = await cover(f, video.id, image(170)); assert.equal(second.statusCode, 200, second.body);
  assert.notEqual(second.json().data.coverObjectKey, saved.coverObjectKey); assert.equal(f.storage.objects.has(saved.coverObjectKey), true);
  assert.equal(f.count("videos"), 1); assert.equal(f.count("storage_objects"), 3);
  await f.restart(); const detail = await f.app.inject({ url: `/api/uploads/${task.id}`, headers });
  assert.equal(detail.json().data.coverObjectKey, second.json().data.coverObjectKey); assert.equal(detail.json().data.coverStatus, "saved");
  assert.equal((await complete(f, task.id)).json().data.video.coverUrl, second.json().data.coverUrl);
});

test("视频已完成封面登记失败，SQLite重开同图片仅关联原key且不重传视频；仅隔离SQLite/Mock", async t => {
  const f = await fixture(); t.after(() => f.close()); const { video, task } = await videoFixture(f);
  let puts = 0; const putImage = f.storage.putImage.bind(f.storage); f.storage.putImage = async input => { puts++; return putImage(input); };
  f.repositories.videos.saveCover = async () => { throw new Error("isolated registration failure"); };
  const failed = await cover(f, video.id); assert.equal(failed.statusCode, 503, failed.body); assert.equal(failed.json().error.code, "COVER_REGISTRATION_FAILED");
  assert.equal(failed.body.includes("isolated registration failure"), false);
  const snapshot = (await f.app.inject({ url: `/api/uploads/${task.id}`, headers })).json().data;
  assert.equal(snapshot.status, "completed"); assert.equal(snapshot.coverStatus, "failed");
  assert.equal(f.storage.objects.size, 2); const oldKey = [...f.storage.objects.keys()].find(key => key.includes("/covers/"))!;
  const storedBytes = f.storage.objects.get(oldKey)!.bytes; const changedAt = storedBytes.length - 3; const originalByte = storedBytes[changedAt]!;
  // 模拟同大小、相同 HEAD 元信息的对象内容变化，恢复必须校验实际 SHA-256。
  storedBytes[changedAt] = originalByte ^ 1;
  const mismatch = await cover(f, video.id); assert.equal(mismatch.statusCode, 409, mismatch.body); assert.equal(mismatch.json().error.code, "FILE_MISMATCH");
  assert.equal((await f.repositories.videos.findOwned("owner", video.id))!.video.coverObjectKey, null);
  storedBytes[changedAt] = originalByte;
  await f.restart(); const recovered = await cover(f, video.id); assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().data.coverObjectKey, oldKey); assert.equal(puts, 1); assert.equal(f.count("videos"), 1); assert.equal(f.count("storage_objects"), 2);
  assert.equal((await complete(f, task.id)).json().data.video.id, video.id); assert.equal(f.storage.objects.size, 2);
});

test("封面OSS权限不足保留视频完成结果及恢复意图；仅隔离SQLite/Mock", async t => {
  const f = await fixture(); t.after(() => f.close()); const { video, task } = await videoFixture(f);
  const putImage = f.storage.putImage.bind(f.storage); f.storage.putImage = async () => { throw new HttpError("STORAGE_PERMISSION_DENIED"); };
  const failed = await cover(f, video.id); assert.equal(failed.statusCode, 503); assert.equal(failed.json().error.code, "STORAGE_PERMISSION_DENIED");
  assert.equal((await complete(f, task.id)).json().data.video.id, video.id); assert.equal(f.storage.objects.size, 1);
  f.storage.putImage = putImage; const retry = await cover(f, video.id); assert.equal(retry.statusCode, 200, retry.body); assert.equal(f.count("storage_objects"), 2);
});

test("真ali-oss SDK的JPEG PUT仅连loopback，新对象public-read/禁止覆盖与403无扩权；非实云验收", async t => {
  const bytes = image(); let uploaded = false;
  const server = createServer(async (request, response) => {
    assert.match(String(request.headers.authorization), /^OSS4-HMAC-SHA256/);
    assert.equal(request.headers["x-oss-security-token"], undefined);
    if (request.method === "PUT") {
      assert.equal(request.headers["x-oss-object-acl"], "public-read"); assert.equal(request.headers["x-oss-forbid-overwrite"], "true");
      assert.equal(request.headers["content-type"], "image/jpeg"); const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk)); assert.deepEqual(Buffer.concat(chunks), bytes);
      uploaded = true; response.setHeader("etag", '"cover-etag"'); response.end(); return;
    }
    assert.equal(request.method, "HEAD"); assert.equal(uploaded, true);
    response.setHeader("content-length", bytes.length); response.setHeader("content-type", "image/jpeg"); response.setHeader("etag", '"cover-etag"'); response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const options: OssOptions = { bucket: "test-bucket", region: "cn-hangzhou", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", objectPrefix: "onlineVideo/", network: "public", allowPublicNetwork: true, publicUploads: true };
  const object: RegisteredStorageObjectRef = { kind: "registered", id: "cover-test", provider: "oss", bucket: "test-bucket", region: "cn-hangzhou", key: "onlineVideo/category/covers/isolated-new.jpg", versionId: null, verificationStatus: "pending" };
  const adapter = new OssStorageAdapter(options, input => new OSS({ ...input, endpoint: `http://127.0.0.1:${address.port}` }) as unknown as OssClient,
    async () => ({ accessKeyId: "fake-key", accessKeySecret: "fake-secret" }));
  const result = await adapter.putImage({ object, bytes, contentType: "image/jpeg", signal: new AbortController().signal }); assert.equal(result.sizeBytes, bytes.length);
  await assert.rejects(adapter.putImage({ object: { ...object, verificationStatus: "verified" as const }, bytes, contentType: "image/jpeg", signal: new AbortController().signal }), (error: unknown) => error instanceof HttpError && error.code === "UPLOAD_STATE_CONFLICT");
  const denied = new OssStorageAdapter(options, () => ({ put: async () => { throw Object.assign(new Error("AccessKeySecret=fake-secret"), { status: 403 }); }, cancel: () => {} }) as unknown as OssClient,
    async () => ({ accessKeyId: "fake-key", accessKeySecret: "fake-secret" }));
  await assert.rejects(denied.putImage({ object, bytes, contentType: "image/jpeg", signal: new AbortController().signal }), (error: unknown) => error instanceof HttpError && error.code === "STORAGE_PERMISSION_DENIED" && !error.message.includes("fake-secret"));
});

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { fixture } from "./playback.test.js";
import { headers, options } from "./fakes.js";
import { HttpError } from "../../src/core/errors.js";
import { buildApp } from "../../src/app.js";
import { createMediaModule } from "../../src/modules/media/index.js";

const checksum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function createUpload(f: Awaited<ReturnType<typeof fixture>>, sizeBytes: number, categoryId = "category") {
  const response = await f.app.inject({ method: "POST", url: "/api/uploads", headers,
    payload: { fileName: "same.mp4", sizeBytes, title: "手机视频", categoryId } });
  assert.equal(response.statusCode, 200, response.body); return response.json().data as { id: string; partSizeBytes: number };
}
async function put(f: Awaited<ReturnType<typeof fixture>>, id: string, number: number, bytes: Buffer, hash = checksum(bytes)) {
  return f.app.inject({ method: "PUT", url: `/api/uploads/${id}/parts/${number}`,
    headers: { ...headers, "content-type": "application/octet-stream", "x-part-checksum": hash }, payload: bytes });
}
const complete = (f: Awaited<ReturnType<typeof fixture>>, id: string) => f.app.inject({ method: "POST", url: `/api/uploads/${id}/complete`, headers, payload: {} });

test("新媒体注册实例恢复持久化 finalizing：OSS 完成前/完成后均可重试，登记幂等且分片保留", async t => {
  const f = await fixture(); const before = await createUpload(f, 5); const after = await createUpload(f, 5); const bytes = Buffer.from("hello");
  assert.equal((await put(f, before.id, 1, bytes)).statusCode, 200); assert.equal((await put(f, after.id, 1, bytes)).statusCode, 200);
  const record = f.uploads.get(after.id)!;
  await f.storage.completeMultipart({ object: record.object, uploadId: record.storageUploadId, parts: record.parts, signal: new AbortController().signal });
  f.uploads.get(before.id)!.task.status = "finalizing"; record.task.status = "finalizing";
  await f.app.close();
  const restarted = await buildApp({ config: f.dependencies.config, logger: false, media: { register: createMediaModule(options), dependencies: f.dependencies } });
  t.after(() => restarted.close()); const next = { ...f, app: restarted };
  for (const id of [before.id, after.id]) {
    const completed = await complete(next, id); assert.equal(completed.statusCode, 200, completed.body);
    const repeated = await complete(next, id); assert.equal(repeated.json().data.video.id, completed.json().data.video.id);
    assert.equal(f.uploads.get(id)!.parts.length, 1); assert.equal(f.storage.uploads.get(f.uploads.get(id)!.storageUploadId)!.parts.size, 1);
  }
  assert.equal(f.videos.size, 3);
});

test("分片真流式校验/重复幂等/续传状态/缺片/换文件/归属/CSRF与唯一对象路径", async t => {
  const f = await fixture(); t.after(() => f.app.close()); const size = options.partSizeBytes + 9;
  const upload = await createUpload(f, size); const another = await createUpload(f, size);
  assert.equal(upload.partSizeBytes, options.partSizeBytes);
  assert.notEqual(f.uploads.get(upload.id)!.object.key, f.uploads.get(another.id)!.object.key);
  const first = Buffer.alloc(options.partSizeBytes, 1); const last = Buffer.alloc(9, 2);
  assert.equal((await complete(f, upload.id)).statusCode, 409);
  const denied = await f.app.inject({ method: "PUT", url: `/api/uploads/${upload.id}/parts/1`,
    headers: { "content-type": "application/octet-stream", "x-part-checksum": checksum(first) }, payload: first });
  assert.equal(denied.statusCode, 401);
  const csrf = await f.app.inject({ method: "PUT", url: `/api/uploads/${upload.id}/parts/1`,
    headers: { cookie: headers.cookie, "content-type": "application/octet-stream", "x-part-checksum": checksum(first) }, payload: first });
  assert.equal(csrf.statusCode, 403);
  assert.equal((await put(f, upload.id, 1, first, "A".repeat(64))).statusCode, 400);
  const mismatch = await put(f, upload.id, 1, first, "0".repeat(64));
  assert.equal(mismatch.statusCode, 409); assert.equal(mismatch.json().error.code, "FILE_MISMATCH"); assert.equal(f.uploads.get(upload.id)!.parts.length, 0);
  assert.equal((await put(f, upload.id, 3, last)).statusCode, 400);
  assert.equal((await put(f, upload.id, 1, first)).statusCode, 200);
  assert.equal((await put(f, upload.id, 1, first)).statusCode, 200);
  assert.equal(f.uploads.get(upload.id)!.parts.length, 1);
  assert.equal((await put(f, upload.id, 1, Buffer.alloc(first.length, 3))).statusCode, 409);
  // 同 checksum 头但篡改字节也必须重算并拒绝。
  assert.equal((await put(f, upload.id, 1, Buffer.alloc(first.length, 3), checksum(first))).statusCode, 409);
  const restored = await f.app.inject({ url: `/api/uploads/${upload.id}`, headers });
  assert.equal(restored.json().data.uploadedParts[0].checksum, checksum(first)); assert.ok(!restored.body.includes("etag")); assert.ok(!restored.body.includes("library/"));
  assert.equal((await complete(f, upload.id)).statusCode, 409);
  assert.equal((await put(f, upload.id, 2, last)).statusCode, 200);
  const done = await complete(f, upload.id); assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().data.upload.status, "completed"); assert.equal(done.json().data.video.status, "ready");
  assert.equal(done.json().data.video.sizeBytes, size); assert.ok(!done.body.includes("storageUploadId"));
  const again = await complete(f, upload.id); assert.equal(again.statusCode, 200); assert.equal(again.json().data.video.id, done.json().data.video.id);
  assert.equal((await put(f, upload.id, 2, last)).statusCode, 409);
  f.uploads.get(another.id)!.ownerId = "other";
  assert.equal((await f.app.inject({ url: `/api/uploads/${another.id}`, headers })).statusCode, 404);
  const before = f.storage.uploads.size;
  const category = await f.app.inject({ method: "POST", url: "/api/uploads", headers,
    payload: { fileName: "v", sizeBytes: 1, title: "v", categoryId: "forged" } });
  assert.equal(category.statusCode, 404); assert.equal(f.storage.uploads.size, before);
});

test("分片尺寸/类型/存储失败不登记；完成存储失败保留分片，数据库失败可重试已完成对象", async t => {
  const f = await fixture(); t.after(() => f.app.close()); const upload = await createUpload(f, 5); const bytes = Buffer.from("hello");
  assert.equal((await put(f, upload.id, 1, Buffer.from("x"))).statusCode, 409);
  assert.equal((await put(f, upload.id, 1, Buffer.alloc(options.partSizeBytes + 1))).statusCode, 413);
  const wrongType = await f.app.inject({ method: "PUT", url: `/api/uploads/${upload.id}/parts/1`,
    headers: { ...headers, "x-part-checksum": checksum(bytes) }, payload: { data: "hello" } });
  assert.equal(wrongType.statusCode, 415);
  const uploadPart = f.storage.uploadPart.bind(f.storage);
  f.storage.uploadPart = async () => { throw new HttpError("STORAGE_UNAVAILABLE"); };
  assert.equal((await put(f, upload.id, 1, bytes)).statusCode, 503); assert.equal(f.uploads.get(upload.id)!.parts.length, 0);
  f.storage.uploadPart = uploadPart; assert.equal((await put(f, upload.id, 1, bytes)).statusCode, 200);
  const completeMultipart = f.storage.completeMultipart.bind(f.storage);
  f.storage.completeMultipart = async () => { throw new HttpError("STORAGE_UNAVAILABLE"); };
  assert.equal((await complete(f, upload.id)).statusCode, 503); assert.equal(f.uploads.get(upload.id)!.task.status, "failed"); assert.equal(f.uploads.get(upload.id)!.parts.length, 1);
  f.storage.completeMultipart = completeMultipart;
  const register = f.dependencies.videos.register;
  f.dependencies.videos.register = async () => { throw new Error("fake db failure"); };
  assert.equal((await complete(f, upload.id)).statusCode, 503); assert.ok(f.storage.objects.has(f.uploads.get(upload.id)!.object.key));
  f.dependencies.videos.register = register;
  // 模拟进程在 finalizing 中断后重建模块的持久化状态：对象已完成，任务仍待登记。
  f.uploads.get(upload.id)!.task.status = "finalizing";
  const done = await complete(f, upload.id); assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().data.upload.status, "completed");
});

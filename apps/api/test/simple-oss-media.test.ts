import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OSS from "ali-oss";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/core/config.js";
import { HttpError } from "../src/core/errors.js";
import { openDatabase } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { createMediaModule } from "../src/modules/media/index.js";
import { MockStorageAdapter } from "../src/modules/media/storage/mock.js";
import { OssStorageAdapter, createDirectOssStorageAdapter } from "../src/modules/media/storage/oss.js";
import type { OssClient, OssOptions } from "../src/modules/media/storage/oss.js";
import type { RegisteredStorageObjectRef } from "../src/core/contracts/index.js";
import type { MetadataInspector } from "../src/modules/media/metadata/types.js";
import { unknownMetadata } from "../src/modules/media/metadata/types.js";
import { fakeDependencies, headers, options } from "./media/fakes.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function publicFixture(metadata: MetadataInspector = { inspect: async () => ({ ...unknownMetadata }) }) {
  const config = readConfig({ NODE_ENV: "test", MAX_PLAYBACK_SESSIONS: "1", TRANSFER_LIMIT_BYTES: "unlimited" });
  config.library = { mediaBaseUrl: "https://oss.meetdawn.top", objectPrefix: "onlineVideo/", categories: [
    { id: "category", name: "已配置分类", tags: ["旅行", "家庭"] }, { id: "disabled", name: "停用分类", tags: [], enabled: false }
  ] };
  const fake = fakeDependencies(config); const storage = new MockStorageAdapter("onlineVideo/");
  const database = openDatabase(":memory:", { initialize: true });
  database.client.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES(?,?,?,?,?)").run("owner", "隔离媒体账户", "test", "test", fake.clock.time.toISOString());
  const repositories = createRepositories(database, () => fake.clock.time, config.library);
  const dependencies = { ...fake.dependencies, ...repositories, storage };
  const registration = { register: createMediaModule({ ...options, objectPrefix: "onlineVideo/", metadata }), dependencies };
  const app = await buildApp({ config, logger: false, media: registration });
  const count = (table: "videos" | "upload_tasks") => (database.client.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  return { ...fake, app, storage, dependencies, database, registration, count, close: async () => { await app.close(); database.close(); } };
}
const findUpload = async (f: Awaited<ReturnType<typeof publicFixture>>, id: string) => (await f.dependencies.uploads.findOwned("owner", id))!;
async function createUpload(f: Awaited<ReturnType<typeof publicFixture>>, extra = {}) {
  return f.app.inject({ method: "POST", url: "/api/uploads", headers,
    payload: { fileName: "手机片段.MP4", title: "家庭旅行", sizeBytes: 5, categoryId: "category", tags: ["旅行"], ...extra } });
}
const put = (f: Awaited<ReturnType<typeof publicFixture>>, id: string) => f.app.inject({ method: "PUT", url: `/api/uploads/${id}/parts/1`,
  headers: { ...headers, "content-type": "application/octet-stream", "x-part-checksum": hash(Buffer.from("hello")) }, payload: Buffer.from("hello") });
const complete = (f: Awaited<ReturnType<typeof publicFixture>>, id: string) => f.app.inject({ method: "POST", url: `/api/uploads/${id}/complete`, headers, payload: {} });

test("简化公共上传校验分类/标签/合法后缀，唯一分类目录及Content-Type；仅隔离Mock", async t => {
  const f = await publicFixture(); t.after(f.close);
  for (const [extra, expected] of [[{ categoryId: "forged" }, 404], [{ categoryId: "disabled" }, 409], [{ tags: ["无配置标签"] }, 400],
    [{ tags: ["旅行", "旅行"] }, 400], [{ fileName: "../bad.mp4" }, 400], [{ fileName: "no-extension" }, 415], [{ fileName: "not-video.html" }, 415]] as const) {
    const response = await createUpload(f, extra); assert.equal(response.statusCode, expected, response.body);
  }
  assert.equal(f.storage.uploads.size, 0); assert.equal(f.count("upload_tasks"), 0);
  const first = await createUpload(f); const second = await createUpload(f); assert.equal(first.statusCode, 200, first.body);
  const id = first.json().data.id; const record = await findUpload(f, id);
  assert.match(record.object.key, /^onlineVideo\/category\/[a-f0-9-]{36}\.mp4$/);
  assert.notEqual(record.object.key, (await findUpload(f, second.json().data.id)).object.key);
  assert.deepEqual(first.json().data.tags, ["旅行"]);
  assert.equal((await put(f, id)).statusCode, 200);
  assert.equal(f.storage.uploads.get((await findUpload(f, id)).storageUploadId)!.contentType, "video/mp4");
  const response = await complete(f, id); assert.equal(response.statusCode, 200, response.body);
  const video = response.json().data.video; assert.equal(video.publicUrl, `https://oss.meetdawn.top/${record.object.key}`);
  assert.equal(video.objectKey, record.object.key); assert.equal(video.fileName, "手机片段.MP4"); assert.deepEqual(video.tags, ["旅行"]);
  assert.equal(new URL(video.publicUrl).search, ""); assert.equal(response.json().data.upload.status, "completed");
  assert.equal((await complete(f, id)).json().data.video.id, video.id);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/playback-sessions", headers, payload: { videoId: video.id } })).statusCode, 404);
  assert.equal((await f.app.inject({ url: `/api/videos/${video.id}/stream`, headers })).statusCode, 404);
});

test("公共上传FFprobe异常或unsupported均不阻断对象登记和公共播放地址；仅隔离Mock", async t => {
  for (const metadata of [{ inspect: async () => { throw new Error("ffprobe unavailable"); } },
    { inspect: async () => ({ ...unknownMetadata, status: "unsupported" as const, codec: "hevc/aac", playable: false }) },
    { inspect: async () => ({ ...unknownMetadata, status: "failed" as const }) }]) {
    const f = await publicFixture(metadata); t.after(f.close); const upload = await createUpload(f); const id = upload.json().data.id;
    assert.equal((await put(f, id)).statusCode, 200);
    const response = await complete(f, id); assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.upload.status, "completed"); assert.equal(response.json().data.video.playable, false);
    assert.ok(response.json().data.video.publicUrl.startsWith("https://oss.meetdawn.top/onlineVideo/category/"));
  }
});

test("公共上传区分云失败与云已完成登记失败，失败分片和对象保留、重试不再次完成对象；仅隔离Mock", async t => {
  const f = await publicFixture(); t.after(f.close); const upload = await createUpload(f); const id = upload.json().data.id;
  assert.equal((await put(f, id)).statusCode, 200); const record = await findUpload(f, id);
  const finish = f.storage.completeMultipart.bind(f.storage); let completions = 0;
  f.storage.completeMultipart = async () => { throw new HttpError("STORAGE_PERMISSION_DENIED"); };
  const permission = await complete(f, id); assert.equal(permission.statusCode, 503); assert.equal(permission.json().error.code, "STORAGE_PERMISSION_DENIED");
  assert.equal(f.storage.objects.size, 0); assert.equal(record.parts.length, 1);
  f.storage.completeMultipart = async input => { completions++; return finish(input); };
  const register = f.dependencies.uploads.finishRegistration!;
  f.dependencies.uploads.finishRegistration = async () => { throw new Error("database registration failed; secret should not be exposed"); };
  const failed = await complete(f, id); assert.equal(failed.statusCode, 503); assert.equal(failed.json().error.code, "UPLOAD_REGISTRATION_FAILED");
  assert.equal(failed.body.includes("secret should"), false); assert.equal((await findUpload(f, id)).task.status, "failed"); assert.equal(record.parts.length, 1);
  assert.ok(f.storage.objects.has(record.object.key)); assert.equal(completions, 1); assert.equal(f.count("videos"), 0);
  f.dependencies.uploads.finishRegistration = register;
  const recovered = await complete(f, id); assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().data.upload.status, "completed"); assert.equal(completions, 1); assert.equal(f.count("videos"), 1);
});

test("对象完成后HEAD暂失败仍提示登记待恢复；新媒体实例读SQLite上传快照并完成，仅隔离Mock", async t => {
  const f = await publicFixture(); t.after(f.close); const upload = await createUpload(f); const id = upload.json().data.id;
  assert.equal((await put(f, id)).statusCode, 200);
  const finish = f.storage.completeMultipart.bind(f.storage); const head = f.storage.head.bind(f.storage);
  let objectCompleted = false; let failVerification = true; let completions = 0;
  f.storage.completeMultipart = async input => { completions++; const result = await finish(input); objectCompleted = true; return result; };
  f.storage.head = async input => { if (objectCompleted && failVerification) throw new HttpError("STORAGE_UNAVAILABLE"); return head(input); };
  const response = await complete(f, id); assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, "UPLOAD_REGISTRATION_FAILED");
  assert.equal((await findUpload(f, id)).task.status, "failed"); assert.equal(f.count("videos"), 0);
  failVerification = false; await f.app.close();
  const restarted = await buildApp({ config: f.dependencies.config, logger: false, media: f.registration }); t.after(() => restarted.close());
  const snapshot = await restarted.inject({ url: `/api/uploads/${id}`, headers }); assert.deepEqual(snapshot.json().data.tags, ["旅行"]);
  const recovered = await restarted.inject({ method: "POST", url: `/api/uploads/${id}/complete`, headers, payload: {} });
  assert.equal(recovered.statusCode, 200, recovered.body); assert.deepEqual(recovered.json().data.video.tags, ["旅行"]);
  assert.equal(completions, 1); assert.equal(f.count("videos"), 1);
});

test("登记失败遇恢复日志和状态写入失败保留finalizing原始任务，重试完成且不虚报成功；仅隔离Mock", async t => {
  const f = await publicFixture(); t.after(f.close); const upload = await createUpload(f); const id = upload.json().data.id;
  assert.equal((await put(f, id)).statusCode, 200);
  const finish = f.dependencies.uploads.finishRegistration!; const transition = f.dependencies.uploads.transition;
  const recordOperation = f.dependencies.objects!.recordOperation;
  f.dependencies.uploads.finishRegistration = async () => { throw new Error("temporary db failure"); };
  f.dependencies.uploads.transition = async (...input) => { if (input[3] === "failed") throw new Error("temporary db failure"); return transition(...input); };
  f.dependencies.objects!.recordOperation = async input => { if (input.state === "failed") throw new Error("temporary db failure"); return recordOperation(input); };
  const response = await complete(f, id); assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, "UPLOAD_REGISTRATION_FAILED");
  assert.equal((await findUpload(f, id)).task.status, "finalizing"); assert.equal(f.count("videos"), 0);
  f.dependencies.uploads.finishRegistration = finish; f.dependencies.uploads.transition = transition; f.dependencies.objects!.recordOperation = recordOperation;
  const recovered = await complete(f, id); assert.equal(recovered.statusCode, 200, recovered.body); assert.equal(f.count("videos"), 1);
});

const ossOptions: OssOptions = { bucket: "test-bucket", region: "cn-hangzhou", endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
  objectPrefix: "onlineVideo/", network: "public", allowPublicNetwork: true, publicUploads: true };
const object: RegisteredStorageObjectRef = { kind: "registered", id: "isolated-object", provider: "oss", bucket: "test-bucket", region: "cn-hangzhou",
  key: "onlineVideo/category/isolated-unique.mp4", versionId: null, verificationStatus: "pending" };

test("真实ali-oss SDK仅连接loopback：长期AK无STS，init/complete新对象public-read且禁止覆盖；非实云验收", async t => {
  let initialized = false; let completed = false; let bytes = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers["x-oss-security-token"], undefined); assert.match(String(request.headers.authorization), /^OSS4-HMAC-SHA256/);
    const url = new URL(request.url!, "http://127.0.0.1");
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      assert.equal(request.headers["content-type"], "video/mp4"); assert.equal(request.headers["x-oss-object-acl"], "public-read");
      assert.equal(request.headers["x-oss-forbid-overwrite"], "true"); initialized = true;
      response.setHeader("content-type", "application/xml"); response.end('<InitiateMultipartUploadResult><Bucket>test-bucket</Bucket><Key>onlineVideo/category/isolated-unique.mp4</Key><UploadId>isolated-upload</UploadId></InitiateMultipartUploadResult>'); return;
    }
    if (request.method === "PUT") {
      assert.equal(initialized, true); for await (const chunk of request) bytes += Buffer.byteLength(chunk);
      response.setHeader("etag", '"part-etag"'); response.end(); return;
    }
    if (request.method === "POST") {
      assert.equal(request.headers["x-oss-object-acl"], "public-read"); assert.equal(request.headers["x-oss-forbid-overwrite"], "true");
      for await (const _chunk of request) { /* 消费SDK完成清单，仅本地协议验证。 */ } completed = true;
      response.setHeader("content-type", "application/xml"); response.end('<CompleteMultipartUploadResult><Bucket>test-bucket</Bucket><Key>onlineVideo/category/isolated-unique.mp4</Key><ETag>object-etag</ETag></CompleteMultipartUploadResult>'); return;
    }
    assert.equal(request.method, "HEAD"); assert.equal(completed, true);
    response.setHeader("content-length", bytes); response.setHeader("content-type", "video/mp4"); response.setHeader("etag", '"object-etag"'); response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const adapter = new OssStorageAdapter(ossOptions, input => new OSS({ ...input, endpoint: `http://127.0.0.1:${address.port}` }) as unknown as OssClient,
    async () => ({ accessKeyId: "fake-server-key", accessKeySecret: "fake-server-secret" }));
  const signal = new AbortController().signal; const initializedUpload = await adapter.createMultipart({ object, contentType: "video/mp4", signal });
  const content = Buffer.from("hello"); const uploadedPart = await adapter.uploadPart({ object, uploadId: initializedUpload.uploadId, partNumber: 1,
    sizeBytes: content.length, checksum: hash(content), stream: Readable.from([content]), signal });
  const result = await adapter.completeMultipart({ object, uploadId: initializedUpload.uploadId,
    parts: [{ partNumber: 1, sizeBytes: content.length, checksum: hash(content), etag: uploadedPart.etag }], signal });
  assert.equal(result.sizeBytes, 5); assert.equal(result.contentType, "video/mp4");
});

test("OSS 403公共权限错误不泄露原始SDK信息，不自动修改权限；仅注入协议替身", async () => {
  const client = { initMultipartUpload: async () => { throw Object.assign(new Error("AccessKeySecret=fake-secret"), { status: 403, code: "AccessDenied" }); }, cancel: () => {} } as unknown as OssClient;
  const adapter = new OssStorageAdapter(ossOptions, () => client, async () => ({ accessKeyId: "fake-key", accessKeySecret: "fake-secret" }));
  await assert.rejects(adapter.createMultipart({ object, contentType: "video/mp4", signal: new AbortController().signal }),
    (error: unknown) => error instanceof HttpError && error.code === "STORAGE_PERMISSION_DENIED" && !error.message.includes("fake-secret"));
});

test("公共OSS工厂只读取服务端AK文件、无需角色或STS，坏凭据安全失败；不访问实云", async () => {
  const directory = await mkdtemp(join(tmpdir(), "simple-oss-fake-credentials-")); const credentialFile = join(directory, "fake.json");
  await writeFile(credentialFile, JSON.stringify({ accessKeyId: "fake-server-key", accessKeySecret: "fake-server-secret" }), "utf8");
  const adapter = await createDirectOssStorageAdapter({ ...ossOptions, credentialFile });
  const credentials = await adapter.credentials("upload", new AbortController().signal);
  assert.equal(credentials.accessKeyId, "fake-server-key"); assert.equal(credentials.stsToken, undefined);
  const invalidFile = join(directory, "invalid.json"); await writeFile(invalidFile, JSON.stringify({ accessKeySecret: "never-expose-secret" }), "utf8");
  await assert.rejects(createDirectOssStorageAdapter({ ...ossOptions, credentialFile: invalidFile }),
    (error: unknown) => error instanceof HttpError && error.code === "SERVICE_NOT_CONFIGURED" && !error.message.includes("never-expose"));
  await assert.rejects(createDirectOssStorageAdapter({ ...ossOptions, credentialFile, publicUploads: false }));
});

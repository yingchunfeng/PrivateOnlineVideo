import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import Fastify from "fastify";
import OSS from "ali-oss";
import type { SaveOssSettingsRequest } from "@online-video/shared";
import { ERROR_DEFINITIONS } from "@online-video/shared";
import { openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/core/config.js";
import { registerErrorHandlers } from "../src/core/errors.js";
import { createMediaModule } from "../src/modules/media/index.js";
import { storageDiagnostic } from "../src/modules/media/storage/diagnostics.js";
import { OssStorageAdapter } from "../src/modules/media/storage/oss.js";
import type { OssClient } from "../src/modules/media/storage/oss.js";
import { InstallationSettingsService } from "../src/modules/installation-settings/service.js";
import { registerInstallationSettingsModule } from "../src/modules/installation-settings/routes.js";
import { fakeDependencies, headers, options } from "./media/fakes.js";

const input: SaveOssSettingsRequest = { version: 0, accessKeyId: "isolated-key-id", accessKeySecret: "isolated-secret", bucket: "isolated-bucket",
  region: "cn-hangzhou", network: "public", allowPublicNetwork: true, mediaBaseUrl: "https://media.example.com", objectPrefix: "onlineVideo/" };
const roleArn = "acs:ram::123456789:role/isolated-role";

test("OSS列表目录标记不作为视频且不影响分页；仍拒绝越界目录", async () => {
  let objects = [{ name: "onlineVideo/", size: 0, etag: "directory" }, { name: "onlineVideo/sub/", size: 0, etag: "directory" }, { name: "onlineVideo/video.mp4", size: 12, etag: "video" }];
  const storage = new OssStorageAdapter({ bucket: input.bucket, region: input.region, endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    objectPrefix: input.objectPrefix, network: "public", allowPublicNetwork: true, publicUploads: true, diagnosticErrors: true },
  () => ({ cancel() {}, async listV2() { return { objects, isTruncated: true, nextContinuationToken: "next-page" }; } }) as unknown as OssClient,
  async () => ({ accessKeyId: "isolated", accessKeySecret: "isolated" }));
  const request = { prefix: input.objectPrefix, limit: 3, signal: new AbortController().signal };
  const listed = await storage.list(request);
  assert.deepEqual(listed.items.map(item => item.fileName), ["video.mp4"]); assert.equal(listed.nextCursor, "next-page");
  objects = [{ name: "onlineVideo/", size: 0, etag: "directory" }];
  const empty = await storage.list({ ...request, limit: 1 }); assert.deepEqual(empty.items, []); assert.equal(empty.nextCursor, "next-page");
  for (const name of ["other/", "onlineVideo/../private/", "onlineVideo/%2e%2e/"]) {
    objects = [{ name, size: 0, etag: "unsafe-directory" }];
    await assert.rejects(storage.list(request), { code: "OSS_RESPONSE_INVALID" });
  }
});

test("真实SDK工厂的配置只读检查兼容根目录占位对象，直接AK与ARN均通过且不云写入", async t => {
  let roleRequests = 0; let lists = 0;
  t.mock.method(OSS.STS.prototype, "assumeRole", async () => { roleRequests++; return { credentials: { AccessKeyId: "temporary-key", AccessKeySecret: "temporary-secret", SecurityToken: "temporary-token", Expiration: new Date(Date.now() + 3600_000).toISOString() } }; });
  t.mock.method(OSS.prototype, "listV2", async (query: { prefix: string; "max-keys": number }) => {
    lists++; assert.equal(query.prefix, "onlineVideo/"); assert.equal(query["max-keys"], 1);
    return { objects: [{ name: "onlineVideo/", size: 0, etag: "directory" }], isTruncated: true, nextContinuationToken: "next-page", res: { status: 200, headers: {} } };
  });
  for (const arn of [undefined, roleArn]) {
    const database = openDatabase(":memory:", { initialize: true });
    try {
      const service = new InstallationSettingsService(database, randomBytes(32), { isReady: () => false });
      service.saveOss({ ...input, ...(arn ? { roleArn: arn } : {}) });
      const result = await service.testOss(1, "isolated-owner");
      assert.equal(result.writePermissionVerified, false); assert.equal(service.hasTestedOss(), true);
    } finally { database.close(); }
  }
  assert.equal(lists, 2); assert.equal(roleRequests, 1);
});

test("网络、凭据、地域、列表权限与STS权限分类安全，不返回原始秘密或签名URL", () => {
  const cases = [
    [{ code: "ENOTFOUND" }, "oss", "OSS_NETWORK_ERROR"],
    [{ cause: { code: "ECONNRESET" } }, "oss", "OSS_NETWORK_ERROR"],
    [{ name: "TimeoutError" }, "oss", "OSS_REQUEST_TIMEOUT"],
    [{ code: "InvalidAccessKeyId", status: 403 }, "oss", "OSS_INVALID_CREDENTIALS"],
    [{ code: "SignatureDoesNotMatch", status: 403 }, "oss", "OSS_INVALID_CREDENTIALS"],
    [{ code: "RequestTimeTooSkewed", status: 403 }, "oss", "OSS_CLOCK_SKEW"],
    [{ code: "NoSuchBucket", status: 404 }, "oss", "OSS_BUCKET_NOT_FOUND"],
    [{ code: "PermanentRedirect", status: 301 }, "oss", "OSS_ENDPOINT_MISMATCH"],
    [{ code: "AccessDenied", status: 403 }, "oss", "OSS_LIST_PERMISSION_DENIED"],
    [{ code: "NoPermission", statusCode: 403 }, "sts", "OSS_STS_PERMISSION_DENIED"],
    [{ code: "InvalidParameter.DurationSeconds" }, "sts", "OSS_STS_CONFIGURATION_ERROR"],
    [{ code: "unknown-provider-error" }, "oss", "STORAGE_UNAVAILABLE"]
  ] as const;
  for (const [metadata, stage, code] of cases) {
    const error = storageDiagnostic({ ...metadata, message: "SECRET SHOULD NOT APPEAR", url: "https://invalid/?Signature=SECRET" }, stage, "list");
    assert.equal(error.code, code); assert.equal(error.message, ERROR_DEFINITIONS[code].message); assert.equal(JSON.stringify(error).includes("SECRET"), false);
  }
});

test("OSS对象不存在保留NOT_FOUND，不混淆Bucket、分片任务或STS错误", () => {
  for (const metadata of [{ code: "NoSuchKey", status: 404 }, { name: "NoSuchKeyError" }, { cause: { code: "NoSuchKey" } }]) {
    const error = storageDiagnostic({ ...metadata, message: "SECRET SHOULD NOT APPEAR" }, "oss");
    assert.equal(error.code, "NOT_FOUND"); assert.equal(JSON.stringify(error).includes("SECRET"), false);
  }
  assert.equal(storageDiagnostic({ code: "NoSuchBucket", status: 404 }, "oss").code, "OSS_BUCKET_NOT_FOUND");
  assert.equal(storageDiagnostic({ code: "NoSuchUpload", status: 404 }, "oss").code, "STORAGE_UNAVAILABLE");
  assert.equal(storageDiagnostic({ status: 404 }, "oss").code, "STORAGE_UNAVAILABLE");
  assert.equal(storageDiagnostic({ code: "NoSuchKey", status: 404 }, "sts").code, "STORAGE_UNAVAILABLE");
});

test("新部署真实存储工厂遇NoSuchKey可合并上传并恢复失败任务；仅内存库和SDK替身", async t => {
  for (const arn of [undefined, roleArn]) await t.test(arn ? "ARN凭据" : "直接AK", async t => {
    const content = Buffer.from("isolated-upload"); const checksum = createHash("sha256").update(content).digest("hex");
    const completed = new Set<string>(); let merges = 0; let missingHeads = 0; let roleRequests = 0;
    t.mock.method(OSS.STS.prototype, "assumeRole", async () => {
      roleRequests++; return { credentials: { AccessKeyId: "temporary-key", AccessKeySecret: "temporary-secret",
        SecurityToken: "temporary-token", Expiration: new Date(Date.now() + 3600_000).toISOString() } };
    });
    t.mock.method(OSS.prototype, "initMultipartUpload", async () => ({ uploadId: "isolated-upload-id" }));
    t.mock.method(OSS.prototype, "uploadPart", async (_key: string, _uploadId: string, _partNumber: number, stream: Readable) => {
      const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), content); return { etag: "isolated-part-etag" };
    });
    t.mock.method(OSS.prototype, "head", async (key: string) => {
      if (!completed.has(key)) {
        missingHeads++; throw Object.assign(new Error("Object not exists"), { name: "NoSuchKeyError", code: "NoSuchKey", status: 404 });
      }
      return { res: { headers: { "content-length": content.length, etag: "isolated-object-etag", "content-type": "video/mp4" } } };
    });
    t.mock.method(OSS.prototype, "completeMultipartUpload", async (key: string, _uploadId: string, parts: { number: number; etag: string }[]) => {
      assert.deepEqual(parts, [{ number: 1, etag: "isolated-part-etag" }]);
      assert.equal(completed.has(key), false); completed.add(key); merges++; return { res: { headers: {} } };
    });
    const config = readConfig({ NODE_ENV: "test", STORAGE_DRIVER: "oss", OSS_BUCKET: input.bucket, OSS_REGION: input.region,
      OSS_ENDPOINT: "https://oss-cn-hangzhou.aliyuncs.com", OSS_NETWORK: "public", OSS_ALLOW_PUBLIC_NETWORK: "true",
      OSS_CREDENTIAL_FILE: resolve(WORKSPACE_ROOT, ".local/isolated-not-read.json"), MAX_UPLOAD_BYTES: "1048576", UPLOAD_PART_SIZE_BYTES: "131072",
      MAX_UPLOAD_CONCURRENCY: "2", MEDIA_REQUESTS_PER_MINUTE: "120" });
    config.library = { mediaBaseUrl: input.mediaBaseUrl, objectPrefix: input.objectPrefix, categories: [{ id: "category", name: "隔离分类", tags: [] }] };
    const fake = fakeDependencies(config); const database = openDatabase(":memory:", { initialize: true });
    t.after(() => database.close());
    database.client.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES(?,?,?,?,?)")
      .run("owner", "isolated", "test", "test", fake.clock.time.toISOString());
    const service = new InstallationSettingsService(database, randomBytes(32), { isReady: () => false });
    service.saveOss({ ...input, ...(arn ? { roleArn: arn } : {}) });
    const repositories = createRepositories(database, () => fake.clock.time, config.library);
    const dependencies = { ...fake.dependencies, ...repositories, storage: service.createStorage() };
    const app = await buildApp({ config, logger: false, media: {
      register: createMediaModule({ ...options, objectPrefix: input.objectPrefix }), dependencies } });
    try {
      for (const state of ["uploading", "failed", "finalizing"] as const) {
        const created = await app.inject({ method: "POST", url: "/api/uploads", headers,
          payload: { fileName: "sample.mp4", title: "isolated", categoryId: "category", sizeBytes: content.length } });
        assert.equal(created.statusCode, 200, created.body); const id = created.json().data.id;
        const part = await app.inject({ method: "PUT", url: `/api/uploads/${id}/parts/1`,
          headers: { ...headers, "content-type": "application/octet-stream", "x-part-checksum": checksum }, payload: content });
        assert.equal(part.statusCode, 200, part.body);
        if (state !== "uploading") await repositories.uploads.transition("owner", id, "uploading", "finalizing");
        if (state === "failed") await repositories.uploads.transition("owner", id, "finalizing", "failed");
        const response = await app.inject({ method: "POST", url: `/api/uploads/${id}/complete`, headers, payload: {} });
        assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().data.upload.status, "completed");
        const again = await app.inject({ method: "POST", url: `/api/uploads/${id}/complete`, headers, payload: {} });
        assert.equal(again.statusCode, 200, again.body); assert.equal(again.json().data.video.id, response.json().data.video.id);
        assert.equal((await repositories.uploads.findOwned("owner", id))!.parts.length, 1);
      }
      assert.equal(merges, 3); assert.equal(missingHeads, 3); assert.equal(roleRequests, arn ? 2 : 0);
      assert.equal((database.client.prepare("SELECT count(*) n FROM videos").get() as { n: number }).n, 3);
    } finally { await app.close(); }
  });
});

test("新部署版本对象登记失败后可重试：角色与读取会话均需版本权限，不重复上传；仅内存库和SDK替身", async t => {
  const content = Buffer.from("isolated-versioned-upload"); const checksum = createHash("sha256").update(content).digest("hex");
  const versionId = "isolated-version-id"; const key = randomBytes(32);
  let roleAllowsVersionRead = false; let readActions: string[] = [];
  let completedKey: string | undefined; let merges = 0; let uploads = 0; let versionHeads = 0; let versionReads = 0; let roleRequests = 0;
  t.mock.method(OSS.STS.prototype, "assumeRole", async (_arn: string, policy: string, _duration: number, sessionName: string) => {
    roleRequests++;
    if (sessionName === "onlineVideo-read") readActions = JSON.parse(policy).Statement[0].Action;
    return { credentials: { AccessKeyId: "temporary-key", AccessKeySecret: "temporary-secret", SecurityToken: "temporary-token",
      Expiration: new Date(Date.now() + 3600_000).toISOString() } };
  });
  const requireVersionRead = () => {
    if (!roleAllowsVersionRead || !readActions.includes("oss:GetObjectVersion")) {
      throw Object.assign(new Error("isolated version read denied"), { status: 403, code: "AccessDenied" });
    }
  };
  t.mock.method(OSS.prototype, "initMultipartUpload", async () => ({ uploadId: "isolated-upload-id" }));
  t.mock.method(OSS.prototype, "uploadPart", async (_key: string, _uploadId: string, _partNumber: number, stream: Readable) => {
    uploads++; const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), content); return { etag: "isolated-part-etag" };
  });
  const objectHeaders = { "content-length": content.length, etag: "isolated-object-etag", "content-type": "video/mp4", "x-oss-version-id": versionId };
  t.mock.method(OSS.prototype, "head", async (objectKey: string, headOptions?: { versionId?: string }) => {
    if (objectKey !== completedKey) throw Object.assign(new Error("Object not exists"), { code: "NoSuchKey", status: 404 });
    if (headOptions?.versionId) {
      versionHeads++; assert.equal(headOptions.versionId, versionId); requireVersionRead();
    }
    return { res: { headers: objectHeaders } };
  });
  t.mock.method(OSS.prototype, "getStream", async (objectKey: string, readOptions: { subres?: { versionId: string } }) => {
    versionReads++; assert.equal(objectKey, completedKey); assert.equal(readOptions.subres?.versionId, versionId); requireVersionRead();
    return { stream: Readable.from([content]), res: { headers: objectHeaders } };
  });
  t.mock.method(OSS.prototype, "completeMultipartUpload", async (objectKey: string, _uploadId: string, parts: { number: number; etag: string }[]) => {
    assert.equal(completedKey, undefined); assert.deepEqual(parts, [{ number: 1, etag: "isolated-part-etag" }]);
    completedKey = objectKey; merges++; return { res: { headers: {} } };
  });
  const config = readConfig({ NODE_ENV: "test", STORAGE_DRIVER: "oss", OSS_BUCKET: input.bucket, OSS_REGION: input.region,
    OSS_ENDPOINT: "https://oss-cn-hangzhou.aliyuncs.com", OSS_NETWORK: "public", OSS_ALLOW_PUBLIC_NETWORK: "true",
    OSS_CREDENTIAL_FILE: resolve(WORKSPACE_ROOT, ".local/isolated-not-read.json"), MAX_UPLOAD_BYTES: "1048576", UPLOAD_PART_SIZE_BYTES: "131072",
    MAX_UPLOAD_CONCURRENCY: "2", MEDIA_REQUESTS_PER_MINUTE: "120" });
  config.library = { mediaBaseUrl: input.mediaBaseUrl, objectPrefix: input.objectPrefix, categories: [{ id: "category", name: "隔离分类", tags: [] }] };
  const fake = fakeDependencies(config); const database = openDatabase(":memory:", { initialize: true });
  t.after(() => database.close());
  database.client.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES(?,?,?,?,?)")
    .run("owner", "isolated", "test", "test", fake.clock.time.toISOString());
  const service = new InstallationSettingsService(database, key, { isReady: () => false }); service.saveOss({ ...input, roleArn });
  const repositories = createRepositories(database, () => fake.clock.time, config.library);
  const dependencies = { ...fake.dependencies, ...repositories, storage: service.createStorage() };
  const registration = createMediaModule({ ...options, objectPrefix: input.objectPrefix, metadata: { inspect: async ({ storage, object, signal }) => {
    const result = await storage.openRead({ object, signal }); const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), content);
    return options.metadata.inspect({ storage, object, signal });
  } } });
  const app = await buildApp({ config, logger: false, media: { register: registration, dependencies } });
  t.after(() => app.close());
  const created = await app.inject({ method: "POST", url: "/api/uploads", headers,
    payload: { fileName: "versioned.mp4", title: "isolated", categoryId: "category", sizeBytes: content.length } });
  assert.equal(created.statusCode, 200, created.body); const id = created.json().data.id;
  const part = await app.inject({ method: "PUT", url: `/api/uploads/${id}/parts/1`,
    headers: { ...headers, "content-type": "application/octet-stream", "x-part-checksum": checksum }, payload: content });
  assert.equal(part.statusCode, 200, part.body);
  const complete = () => app.inject({ method: "POST", url: `/api/uploads/${id}/complete`, headers, payload: {} });
  const failed = await complete();
  assert.equal(failed.statusCode, 503, failed.body); assert.equal(failed.json().error.code, "UPLOAD_REGISTRATION_FAILED");
  const saved = (await repositories.uploads.findOwned("owner", id))!;
  assert.equal(saved.task.status, "failed"); assert.equal(saved.object.kind, "registered");
  if (saved.object.kind !== "registered") assert.fail("expected registered object");
  assert.equal(saved.object.versionId, versionId); assert.equal(saved.object.verificationStatus, "verified"); assert.equal(saved.parts.length, 1);
  assert.equal((database.client.prepare("SELECT count(*) n FROM videos").get() as { n: number }).n, 0);
  // 恢复角色权限并创建新的凭据缓存，模拟更新 API 后继续同一数据库中的失败任务。
  roleAllowsVersionRead = true;
  dependencies.storage = new InstallationSettingsService(database, key, { isReady: () => false }).createStorage();
  const recovered = await complete();
  assert.equal(recovered.statusCode, 200, recovered.body); assert.equal(recovered.json().data.upload.status, "completed");
  const again = await complete(); assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().data.video.id, recovered.json().data.video.id);
  assert.equal((await repositories.uploads.findOwned("owner", id))!.parts.length, 1);
  assert.equal((database.client.prepare("SELECT count(*) n FROM videos").get() as { n: number }).n, 1);
  assert.equal(merges, 1); assert.equal(uploads, 1); assert.equal(roleRequests, 3); assert.equal(versionReads, 1); assert.ok(versionHeads >= 4);
});

test("配置测试HTTP保留SDK安全分类，STS失败不回退AK；失败不标记检查通过", async t => {
  let listRequests = 0;
  t.mock.method(OSS.STS.prototype, "assumeRole", async () => { throw { code: "NoPermission", statusCode: 403, message: "SECRET ROLE DETAIL" }; });
  t.mock.method(OSS.prototype, "listV2", async () => { listRequests++; throw { code: "ENOTFOUND", message: "SECRET REQUEST URL" }; });
  for (const stage of ["oss", "sts"] as const) {
    const database = openDatabase(":memory:", { initialize: true }); const app = Fastify({ logger: false });
    try {
      const service = new InstallationSettingsService(database, randomBytes(32), { isReady: () => false }); service.saveOss({ ...input, ...(stage === "sts" ? { roleArn } : {}) });
      registerErrorHandlers(app); registerInstallationSettingsModule(app, service, async () => ({ ownerId: "isolated-owner", setup: true }));
      const response = await app.inject({ method: "POST", url: "/api/installation/oss/test", payload: { version: 1 } });
      assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, stage === "sts" ? "OSS_STS_PERMISSION_DENIED" : "OSS_NETWORK_ERROR");
      assert.equal(response.body.includes("SECRET"), false); assert.equal(response.body.includes(input.accessKeySecret!), false); assert.equal(service.hasTestedOss(), false);
    } finally { await app.close(); database.close(); }
  }
  assert.equal(listRequests, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { StsCredentialCache, sessionPolicy } from "../src/modules/media/storage/sts.js";
import { HttpError } from "../src/core/errors.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import OSS from "ali-oss";
import { OssPresignedSourceProvider } from "../src/modules/media/storage/signing.js";
import { OssStorageAdapter } from "../src/modules/media/storage/oss.js";
import type { OssClient } from "../src/modules/media/storage/oss.js";
import type { RegisteredStorageObjectRef, StsCredentialProvider } from "../src/core/contracts/index.js";
import { startLocalOss } from "./integration/local-oss-server.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/core/config.js";
import { createMediaModule } from "../src/modules/media/index.js";
import { fakeDependencies, headers, options as mediaOptions } from "./media/fakes.js";
import { createHash, randomUUID } from "node:crypto";
import { runAcceptance, validateAcceptanceManifest } from "../src/modules/media/acceptance/run.js";
import type { AcceptanceManifest } from "../src/modules/media/acceptance/run.js";
import { openDatabase } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

test("STS 会话最小权限：只读用途包含版本读取，上传和导入不扩权", () => {
  for (const prefix of ["onlineVideo/", "onlineVideo/nested/"]) {
    const resource = [`acs:oss:*:*:xzlbucket/${prefix}*`];
    assert.deepEqual(JSON.parse(sessionPolicy("xzlbucket", prefix, "read")), { Version: "1", Statement: [
      { Effect: "Allow", Action: ["oss:GetObject", "oss:GetObjectVersion"], Resource: resource }
    ] });
    assert.deepEqual(JSON.parse(sessionPolicy("xzlbucket", prefix, "upload")), { Version: "1", Statement: [
      { Effect: "Allow", Action: ["oss:GetObject", "oss:PutObject"], Resource: resource }
    ] });
    assert.deepEqual(JSON.parse(sessionPolicy("xzlbucket", prefix, "import")), { Version: "1", Statement: [
      { Effect: "Allow", Action: ["oss:GetObject"], Resource: resource },
      { Effect: "Allow", Action: ["oss:ListObjects"], Resource: ["acs:oss:*:*:xzlbucket"],
        Condition: { StringLike: { "oss:Prefix": [`${prefix}*`] } } }
    ] });
  }
});

test("STS 用途隔离、并发合并、Expiration 提前刷新与失败关闭；无真实密钥/网络", async () => {
  let now = Date.parse("2026-10-02T10:00:00Z"); let calls = 0; let fail = false;
  const purposes: string[] = [];
  const cache = new StsCredentialCache({ roleArn: "acs:ram::123456789:role/test", bucket: "xzlbucket", objectPrefix: "onlineVideo/",
    durationSeconds: 3600, refreshBeforeSeconds: 300 }, async input => {
      calls++; purposes.push(input.sessionName);
      await new Promise(resolve => setTimeout(resolve, 10));
      if (fail) throw new Error("do not expose secret/provider error");
      return { AccessKeyId: `fake-${calls}`, AccessKeySecret: "fake-secret", SecurityToken: "fake-token",
        Expiration: new Date(now + 3600_000).toISOString() };
    }, () => new Date(now));
  const batch = await Promise.all(Array.from({ length: 10 }, () => cache.get("read")));
  assert.equal(calls, 1); assert.ok(batch.every(value => value.expiration === batch[0]!.expiration));
  await cache.get("upload"); await cache.get("import"); assert.equal(calls, 3);
  assert.deepEqual(purposes, ["onlineVideo-read", "onlineVideo-upload", "onlineVideo-import"]);
  assert.ok(!sessionPolicy("xzlbucket", "onlineVideo/", "read").includes("PutObject"));
  assert.ok(!sessionPolicy("xzlbucket", "onlineVideo/", "upload").includes("ListObjects"));
  now += 3301_000; await cache.get("read"); assert.equal(calls, 4);
  now += 3301_000; fail = true;
  await assert.rejects(cache.get("read"), (error: unknown) => error instanceof HttpError && error.code === "STORAGE_UNAVAILABLE");
  fail = false; await cache.get("read"); assert.equal(calls, 6);
});

test("STS 等待者取消不影响另一等待者；拒绝已过期和无Token凭据", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const options = { roleArn: "acs:ram::123456789:role/test", bucket: "xzlbucket", objectPrefix: "onlineVideo/",
    durationSeconds: 3600, refreshBeforeSeconds: 300 };
  const cache = new StsCredentialCache(options, async () => { await pending; return { AccessKeyId: "fake-key",
    AccessKeySecret: "fake-secret", SecurityToken: "fake-token", Expiration: new Date(Date.now() + 3600_000).toISOString() }; });
  const controller = new AbortController();
  const cancelled = cache.get("read", controller.signal); const survivor = cache.get("read");
  controller.abort(); await assert.rejects(cancelled); release(); assert.equal((await survivor).stsToken, "fake-token");
  for (const output of [{ AccessKeyId: "fake", AccessKeySecret: "fake", SecurityToken: "", Expiration: new Date(Date.now() + 3600_000).toISOString() },
    { AccessKeyId: "fake", AccessKeySecret: "fake", SecurityToken: "fake", Expiration: new Date(Date.now() - 1).toISOString() }]) {
    await assert.rejects(new StsCredentialCache(options, async () => output).get("read"));
  }
});

test("ali-oss STS SDK 仅连接本地协议服务，读取策略限定普通及版本读取", async t => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++; let body = ""; for await (const chunk of request) body += String(chunk);
    const form = new URLSearchParams(body);
    assert.equal(form.get("Action"), "AssumeRole"); assert.equal(form.get("DurationSeconds"), "3600");
    assert.equal(form.get("RoleSessionName"), "onlineVideo-read"); assert.ok(form.get("Signature"));
    const policy = JSON.parse(form.get("Policy")!);
    assert.deepEqual(policy.Statement[0].Action, ["oss:GetObject", "oss:GetObjectVersion"]);
    assert.deepEqual(policy.Statement[0].Resource, ["acs:oss:*:*:xzlbucket/onlineVideo/*"]);
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ Credentials: {
      AccessKeyId: "fake-local-sts", AccessKeySecret: "fake-secret", SecurityToken: "fake-token",
      Expiration: new Date(Date.now() + 3600_000).toISOString()
    } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const sdkOptions = { accessKeyId: "fake-longterm", accessKeySecret: "fake-secret", endpoint: `http://127.0.0.1:${address.port}` };
  const sdk = new OSS.STS(sdkOptions);
  const cache = new StsCredentialCache({ roleArn: "acs:ram::123456789:role/test", bucket: "xzlbucket", objectPrefix: "onlineVideo/",
    durationSeconds: 3600, refreshBeforeSeconds: 300 }, async input =>
      (await sdk.assumeRole(input.roleArn, input.policy, input.durationSeconds, input.sessionName)).credentials);
  assert.equal((await cache.get("read")).accessKeyId, "fake-local-sts");
  await cache.get("read"); assert.equal(requests, 1);
});

test("AssumeRole 同步失败后下次请求可以恢复，不留下拒绝的 pending", async () => {
  let attempts = 0;
  const cache = new StsCredentialCache({ roleArn: "acs:ram::123456789:role/test", bucket: "xzlbucket", objectPrefix: "onlineVideo/",
    durationSeconds: 3600, refreshBeforeSeconds: 300 }, () => {
      attempts++; if (attempts === 1) throw new Error("synchronous failure");
      return Promise.resolve({ AccessKeyId: "fake", AccessKeySecret: "fake", SecurityToken: "fake",
        Expiration: new Date(Date.now() + 3600_000).toISOString() });
    });
  await assert.rejects(cache.get("read")); assert.equal((await cache.get("read")).accessKeyId, "fake"); assert.equal(attempts, 2);
});

test("STS/V4固定CNAME直连、Range/到期/下载；完整身份与已验证状态限定，上传端点不改变签名域名", async t => {
  const identity = { accessKeyId: "fake-local-sts", accessKeySecret: "fake-secret", stsToken: "fake-token" };
  const server = await startLocalOss({ bucket: "xzlbucket", region: "cn-hangzhou", prefix: "onlineVideo/", ...identity });
  t.after(() => server.close());
  const object: RegisteredStorageObjectRef = { kind: "registered", id: "object-1", provider: "oss", bucket: "xzlbucket",
    region: "cn-hangzhou", key: "onlineVideo/片段.mp4", versionId: null, verificationStatus: "verified" };
  server.objects.set(object.key, { bytes: Buffer.from("0123456789"), etag: '"fixed"', contentType: "video/mp4" });
  const requested: string[] = [];
  const expiration = new Date(Date.now() + 3600_000).toISOString();
  const credentials: StsCredentialProvider = { get: async input => { requested.push(input.purpose); return { ...identity, expiration }; } };
  const options = { bucket: "xzlbucket", region: "cn-hangzhou" as const, endpoint: server.endpoint, objectPrefix: "onlineVideo/",
    ttlSeconds: 3600, safetySeconds: 30, renewBeforeSeconds: 300, kind: "test" as const };
  const provider = new OssPresignedSourceProvider(options, credentials, input => {
    assert.equal(input.region, "oss-cn-hangzhou"); assert.equal(input.cname, true); return new OSS(input);
  });
  const source = await provider.sign({ object, purpose: "playback", signal: new AbortController().signal });
  assert.equal(new URL(source.sourceUrl).origin, server.endpoint);
  assert.equal(new URL(source.sourceUrl).searchParams.has("response-content-type"), false);
  assert.equal(new URL(source.sourceUrl).searchParams.get("response-content-disposition"), "inline");
  assert.equal(Date.parse(source.sourceExpiresAt) - Date.parse(source.renewAfter), 300_000);
  assert.ok(Date.parse(source.sourceExpiresAt) <= Date.parse(expiration) - 30_000);
  const anonymous = await fetch(`${server.endpoint}/${encodeURIComponent(object.key).replace(/%2F/g, "/")}`); assert.equal(anonymous.status, 403);
  const range = await fetch(source.sourceUrl, { headers: { range: "bytes=2-4" } }); assert.equal(range.status, 206);
  assert.equal(await range.text(), "234"); assert.equal(range.headers.get("content-range"), "bytes 2-4/10");
  const download = await provider.sign({ object, purpose: "download", fileName: '手机/视频\r\n.mp4', signal: new AbortController().signal });
  const response = await fetch(download.sourceUrl); assert.equal(response.status, 200); assert.equal(await response.text(), "0123456789");
  assert.ok(response.headers.get("content-disposition")?.startsWith("attachment;"));
  assert.ok(!decodeURIComponent(new URL(download.sourceUrl).searchParams.get("response-content-disposition")!).includes("\r"));
  assert.deepEqual(requested, ["read", "read"]);
  for (const bad of [{ key: object.key }, { ...object, bucket: "other-bucket" }, { ...object, verificationStatus: "pending" as const }]) {
    await assert.rejects(provider.sign({ object: bad, purpose: "playback", signal: new AbortController().signal }));
  }
  assert.throws(() => new OssPresignedSourceProvider({ ...options, kind: "production" }, credentials, input => new OSS(input)));
  const short = new OssPresignedSourceProvider(options, { get: async () => ({ ...identity, expiration: new Date(Date.now() + 90_000).toISOString() }) }, input => new OSS(input));
  const shortSource = await short.sign({ object, purpose: "playback", signal: new AbortController().signal });
  assert.ok(Date.parse(shortSource.renewAfter) > Date.now() + 10_000); assert.ok(Date.parse(shortSource.renewAfter) < Date.parse(shortSource.sourceExpiresAt));
});

test("存储使用完整Bucket/region/版本，不随默认Bucket误读，上传STS与读取/导入隔离", async () => {
  const object: RegisteredStorageObjectRef = { kind: "registered", id: "object-1", provider: "oss", bucket: "xzlbucket", region: "cn-hangzhou",
    key: "onlineVideo/originals/test", versionId: null, verificationStatus: "pending" };
  const purposes: string[] = []; let optionsRegion = "";
  const client = { head: async () => ({ res: { headers: { "content-length": 1, etag: "x" } } }),
    initMultipartUpload: async () => ({ uploadId: "test-upload" }), listV2: async () => ({ objects: [] }), cancel: () => {} } as unknown as OssClient;
  const storage = new OssStorageAdapter({ bucket: "xzlbucket", region: "cn-hangzhou", objectPrefix: "onlineVideo/",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com", network: "public", allowPublicNetwork: true }, input => { optionsRegion = input.region; return client; },
    async purpose => { purposes.push(purpose); return { accessKeyId: "fake", accessKeySecret: "fake", stsToken: "fake" }; });
  const signal = new AbortController().signal;
  await storage.createMultipart({ object, contentType: "video/mp4", signal }); await storage.head({ object, signal });
  await storage.list({ prefix: "onlineVideo/", limit: 1, signal });
  assert.equal(optionsRegion, "oss-cn-hangzhou"); assert.deepEqual(purposes, ["upload", "read", "import"]);
  await assert.rejects(storage.head({ object: { ...object, bucket: "other-bucket" }, signal }));
  await assert.rejects(storage.head({ object: { key: object.key }, signal }));
  await assert.rejects(storage.head({ object: { ...object, versionId: "known-version" }, signal }));
});

test("真SDK播放签名遵守GetObject响应覆盖白名单，octet-stream原元数据可Range且保留inline", async t => {
  const object: RegisteredStorageObjectRef = { kind: "registered", id: "allowed-object", provider: "oss", bucket: "xzlbucket", region: "cn-hangzhou",
    key: "onlineVideo/existing-compatible", versionId: null, verificationStatus: "verified" };
  let unsupportedQueries = 0;
  const allowed = new Set(["response-content-language", "response-expires", "response-cache-control", "response-content-disposition", "response-content-encoding"]);
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    for (const key of url.searchParams.keys()) if (key.startsWith("response-") && !allowed.has(key)) {
      unsupportedQueries++; response.statusCode = 400; response.setHeader("content-type", "application/xml"); response.end("<Error><Code>InvalidRequest</Code></Error>"); return;
    }
    assert.equal(url.searchParams.get("x-oss-signature-version"), "OSS4-HMAC-SHA256");
    assert.equal(url.searchParams.get("response-content-disposition"), "inline"); assert.equal(request.headers.range, "bytes=0-0");
    response.statusCode = 206; response.setHeader("content-type", "application/octet-stream"); response.setHeader("content-disposition", "inline");
    response.setHeader("content-range", "bytes 0-0/1"); response.end("m");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const provider = new OssPresignedSourceProvider({ bucket: "xzlbucket", region: "cn-hangzhou", objectPrefix: "onlineVideo/",
    endpoint: `http://127.0.0.1:${address.port}`, ttlSeconds: 3600, safetySeconds: 30, renewBeforeSeconds: 300, kind: "test" },
    { get: async () => ({ accessKeyId: "fake", accessKeySecret: "fake", stsToken: "fake", expiration: new Date(Date.now() + 3600_000).toISOString() }) }, input => new OSS(input));
  const source = await provider.sign({ object, purpose: "playback", signal: new AbortController().signal });
  const response = await fetch(source.sourceUrl, { headers: { range: "bytes=0-0" } });
  assert.equal(response.status, 206); assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("content-disposition"), "inline"); assert.equal(await response.text(), "m"); assert.equal(unsupportedQueries, 0);
});

test("真SDK完成新唯一对象固定private ACL，403不回退/扩权，既有public对象与Bucket不改", async t => {
  const publicKey = "onlineVideo/existing-public.mp4";
  const original = { bytes: Buffer.from("public-original"), acl: "public-read" };
  const stored = new Map<string, { bytes: Buffer; acl: string }>([[publicKey, original]]);
  const calls: { method: string; key: string; acl: string | undefined; aclApi: boolean }[] = [];
  let uploaded = Buffer.alloc(0); let rejectComplete = true;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1"); const key = decodeURIComponent(url.pathname.slice(1));
    calls.push({ method: request.method!, key, acl: request.headers["x-oss-object-acl"] as string | undefined, aclApi: url.searchParams.has("acl") });
    const authorized = String(request.headers.authorization ?? "").startsWith("OSS4-HMAC-SHA256") && request.headers["x-oss-security-token"] === "fake-token";
    if (!authorized) {
      const object = stored.get(key);
      if (request.method === "GET" && object?.acl === "public-read") response.end(object.bytes);
      else { response.statusCode = 403; response.end(); }
      return;
    }
    assert.ok(key.startsWith("onlineVideo/"));
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      response.setHeader("content-type", "application/xml"); response.end(`<InitiateMultipartUploadResult><Bucket>xzlbucket</Bucket><Key>${key}</Key><UploadId>new-only-upload</UploadId></InitiateMultipartUploadResult>`); return;
    }
    if (request.method === "PUT") {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); uploaded = Buffer.concat(chunks);
      response.setHeader("etag", '"part"'); response.end(); return;
    }
    if (request.method === "POST") {
      assert.notEqual(key, publicKey); assert.equal(request.headers["x-oss-object-acl"], "private"); assert.equal(request.headers["x-oss-forbid-overwrite"], "true");
      for await (const _chunk of request) { /* 消费完成请求的小XML */ }
      if (rejectComplete) { response.statusCode = 403; response.setHeader("content-type", "application/xml"); response.end("<Error><Code>AccessDenied</Code><Message>Local denied</Message></Error>"); return; }
      assert.ok(!stored.has(key)); stored.set(key, { bytes: uploaded, acl: "private" });
      response.setHeader("content-type", "application/xml"); response.end(`<CompleteMultipartUploadResult><Bucket>xzlbucket</Bucket><Key>${key}</Key><ETag>new</ETag></CompleteMultipartUploadResult>`); return;
    }
    assert.equal(request.method, "HEAD"); const object = stored.get(key)!;
    response.setHeader("content-length", object.bytes.length); response.setHeader("etag", '"new"'); response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); const endpoint = `http://127.0.0.1:${address.port}`;
  const adapter = new OssStorageAdapter({ bucket: "xzlbucket", region: "cn-hangzhou", objectPrefix: "onlineVideo/",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com", network: "public", allowPublicNetwork: true },
    input => new OSS({ ...input, endpoint, cname: true }) as unknown as OssClient,
    async () => ({ accessKeyId: "fake-sts", accessKeySecret: "fake-secret", stsToken: "fake-token" }));
  const object: RegisteredStorageObjectRef = { kind: "registered", id: "new-object", provider: "oss", bucket: "xzlbucket", region: "cn-hangzhou",
    key: `onlineVideo/acceptance/local/code-acl/${randomUUID()}`, versionId: null, verificationStatus: "pending" };
  const signal = new AbortController().signal; const multipart = await adapter.createMultipart({ object, contentType: "video/mp4", signal });
  const bytes = Buffer.from("private-new"); const checksum = createHash("sha256").update(bytes).digest("hex");
  const part = await adapter.uploadPart({ object, uploadId: multipart.uploadId, partNumber: 1, sizeBytes: bytes.length, checksum, stream: Readable.from([bytes]), signal });
  const complete = () => adapter.completeMultipart({ object, uploadId: multipart.uploadId, parts: [{ partNumber: 1, sizeBytes: bytes.length, checksum, etag: part.etag }], signal });
  await assert.rejects(complete(), (error: unknown) => error instanceof HttpError && error.code === "STORAGE_UNAVAILABLE");
  assert.equal(stored.size, 1); assert.equal(calls.filter(call => call.method === "POST" && call.acl).length, 1);
  rejectComplete = false; assert.equal((await complete()).sizeBytes, bytes.length);
  assert.equal((await fetch(`${endpoint}/${publicKey}`)).status, 200); assert.equal(await (await fetch(`${endpoint}/${publicKey}`)).text(), "public-original");
  assert.equal((await fetch(`${endpoint}/${object.key}`)).status, 403); assert.deepEqual(stored.get(publicKey), original);
  assert.equal(stored.get(object.key)!.acl, "private"); assert.ok(calls.filter(call => call.method === "POST" && call.acl).every(call => call.acl === "private"));
  const before = calls.length;
  await assert.rejects(adapter.completeMultipart({ object: { ...object, verificationStatus: "verified" as const }, uploadId: multipart.uploadId, parts: [], signal }));
  assert.equal(calls.length, before, "已核验对象不能收到本次新对象ACL完成请求");
  assert.ok(calls.every(call => call.key !== "" && !call.aclApi), "没有Bucket/对象ACL修改API");
});

test("组织快照在云前持久化、初始化/登记失败可恢复、归档重新校验、只原子登记一条视频", async t => {
  const config = readConfig({ NODE_ENV: "test", MAX_PLAYBACK_SESSIONS: "3", TRANSFER_LIMIT_BYTES: "unlimited" });
  const f = fakeDependencies(config); const objects = new Map<string, RegisteredStorageObjectRef>();
  let archived = false; const events: string[] = []; let finishCalls = 0; let failRegistration = true;
  f.dependencies.organizations = { assertOwned: async (_owner, selection) => {
    if (selection.categoryId !== "category" || selection.groupIds?.some(id => id !== "group") || selection.tagIds?.some(id => id !== "tag")) throw new HttpError("NOT_FOUND");
    if (archived && selection.groupIds?.length) throw new HttpError("ORGANIZATION_CONFLICT");
  } };
  f.dependencies.objects = {
    prepare: async input => {
      events.push("prepare"); const object: RegisteredStorageObjectRef = { ...input.object, kind: "registered", id: randomUUID(), verificationStatus: "pending" };
      objects.set(object.id, object); return { object, operationId: randomUUID() };
    },
    verify: async input => { events.push("verify"); const object = { ...input.object, verificationStatus: "verified" as const }; objects.set(object.id, object); return object; },
    recordOperation: async input => { events.push(input.state); }
  };
  const originalCreate = f.dependencies.uploads.create;
  f.dependencies.uploads.create = async input => {
    events.push("create"); assert.equal(input.storageUploadId, "");
    const record = await originalCreate(input); record.task.groupIds = input.request.groupIds ?? []; record.task.tagIds = input.request.tagIds ?? [];
    record.operationId = input.operationId!; return record;
  };
  f.dependencies.uploads.attachMultipart = async input => {
    events.push("attach"); const record = f.uploads.get(input.uploadId)!; record.storageUploadId = input.storageUploadId; return record;
  };
  f.dependencies.uploads.finishRegistration = async input => {
    finishCalls++; events.push("finish"); if (failRegistration) throw new Error("isolated DB failure");
    const record = f.uploads.get(input.uploadId)!; const video = await f.dependencies.videos.register(input.video);
    record.task.status = "completed"; record.task.videoId = video.video.id; return { upload: record, video };
  };
  const app = await buildApp({ config, logger: false, media: { register: createMediaModule(mediaOptions), dependencies: f.dependencies } });
  t.after(() => app.close());
  const create = async (groupIds: string[], tagIds: string[]) => app.inject({ method: "POST", url: "/api/uploads", headers,
    payload: { fileName: "same.mp4", title: "原片", sizeBytes: 5, categoryId: "category", groupIds, tagIds } });
  assert.equal((await create(["bad"], [])).statusCode, 404); assert.equal(events.length, 0);
  assert.equal((await create(["group", "group"], [])).statusCode, 400);
  const task = (await create(["group"], ["tag"])).json().data;
  assert.deepEqual(events, ["prepare", "create"]); assert.equal(f.storage.uploads.size, 0);
  const bytes = Buffer.from("hello"); const put = () => app.inject({ method: "PUT", url: `/api/uploads/${task.id}/parts/1`,
    headers: { ...headers, "content-type": "application/octet-stream", "x-part-checksum": createHash("sha256").update(bytes).digest("hex") }, payload: bytes });
  assert.equal((await app.inject({ method: "PUT", url: `/api/uploads/${task.id}/parts/2`, headers: {
    ...headers, "content-type": "application/octet-stream", "x-part-checksum": createHash("sha256").update(bytes).digest("hex") }, payload: bytes })).statusCode, 400);
  assert.equal(f.storage.uploads.size, 0, "错误分片不得提前初始化云端Multipart");
  const init = f.storage.createMultipart.bind(f.storage); f.storage.createMultipart = async () => { throw new HttpError("STORAGE_UNAVAILABLE"); };
  assert.equal((await put()).statusCode, 503); assert.equal(f.uploads.get(task.id)!.parts.length, 0);
  f.storage.createMultipart = init; assert.equal((await put()).statusCode, 200); assert.ok(events.indexOf("create") < events.indexOf("multipart_started"));
  const complete = () => app.inject({ method: "POST", url: `/api/uploads/${task.id}/complete`, headers, payload: {} });
  archived = true; assert.equal((await complete()).statusCode, 409); assert.equal(f.videos.size, 0);
  archived = false; assert.equal((await complete()).statusCode, 503); assert.equal(f.storage.objects.size, 1); assert.equal(f.uploads.get(task.id)!.task.status, "failed");
  failRegistration = false; const response = await complete(); assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data.video.groupIds, ["group"]); assert.deepEqual(response.json().data.video.tagIds, ["tag"]);
  assert.equal((await complete()).json().data.video.id, response.json().data.video.id); assert.equal(f.videos.size, 1); assert.equal(finishCalls, 2);
  assert.equal(f.storage.objects.size, 1); assert.equal(f.storage.uploads.size, 1);
});

test("导入分页游标绑定owner/login/前缀/TTL、每页独立条目与对象替换/版本检查", async t => {
  const config = readConfig({ NODE_ENV: "test", MAX_PLAYBACK_SESSIONS: "3", TRANSFER_LIMIT_BYTES: "unlimited" });
  const f = fakeDependencies(config);
  f.storage.seed("library/existing/a.mp4", Buffer.from("aaaa")); f.storage.seed("library/existing/b.mp4", Buffer.from("bbbb"));
  const all = await f.storage.list({ prefix: "library/existing/", limit: 100, signal: new AbortController().signal });
  f.storage.list = async input => ({ items: input.cursor ? [all.items[1]!] : [all.items[0]!], nextCursor: input.cursor ? null : "raw-provider-cursor" });
  const app = await buildApp({ config, logger: false, media: { register: createMediaModule(mediaOptions), dependencies: f.dependencies } });
  t.after(() => app.close());
  const preview = (payload: object, selectedHeaders = headers) => app.inject({ method: "POST", url: "/api/imports/preview", headers: selectedHeaders, payload });
  const first = (await preview({ prefix: "library/existing/" })).json().data;
  assert.ok(first.nextCursor); assert.notEqual(first.nextCursor, "raw-provider-cursor");
  assert.equal((await preview({ prefix: "library/existing/", cursor: "raw-provider-cursor" })).statusCode, 404);
  assert.equal((await preview({ prefix: "library/", cursor: first.nextCursor })).statusCode, 404);
  assert.equal((await preview({ prefix: "library/existing/", cursor: first.nextCursor }, { ...headers, "x-test-session": "another" } as typeof headers)).statusCode, 404);
  const second = (await preview({ prefix: "library/existing/", cursor: first.nextCursor })).json().data;
  assert.notEqual(first.id, second.id); assert.equal(second.nextCursor, null);
  const commit = (previewId: string, itemIds: string[], extras = {}) => app.inject({ method: "POST", url: "/api/imports/commit", headers,
    payload: { previewId, itemIds, categoryId: "category", groupIds: [], tagIds: [], ...extras } });
  assert.equal((await commit(second.id, [first.items[0].id])).statusCode, 403);
  const imported = await commit(first.id, [first.items[0].id]); assert.equal(imported.statusCode, 200); assert.deepEqual(imported.json().data.videos[0].tagIds, []);
  assert.equal((await commit(first.id, [first.items[0].id])).json().data.videos[0].id, imported.json().data.videos[0].id);
  f.storage.seed("library/existing/b.mp4", Buffer.from("changed")); assert.equal((await commit(second.id, [second.items[0].id])).statusCode, 409);
  assert.equal(f.videos.size, 1);
  f.storage.seed("library/existing/b.mp4", Buffer.from("bbbb"));
  const versionPreview = (await preview({ prefix: "library/existing/", cursor: first.nextCursor })).json().data;
  f.storage.objects.get("library/existing/b.mp4")!.metadata.versionId = "replacement-version";
  assert.equal((await commit(versionPreview.id, [versionPreview.items[0].id])).statusCode, 409); assert.equal(f.videos.size, 1);
  f.clock.time = new Date(f.clock.time.getTime() + mediaOptions.previewTtlMs + 1);
  assert.equal((await preview({ prefix: "library/existing/", cursor: first.nextCursor })).statusCode, 404);
});

test("实云验收脚本缺授权/错误目标拒绝，准备模式不读会话/视频或联网", async () => {
  const manifest: AcceptanceManifest = { apiOrigin: "http://127.0.0.1:3000", browserOrigin: "http://127.0.0.1:5173", mediaOrigin: "https://oss.meetdawn.top",
    authorizationReference: "isolated-test-only", databaseFile: "unused-isolated.db", verifiedSchemaVersion: 2, databaseBackupReference: "isolated-backup-proof",
    sessionFile: "does-not-exist-session.json", sampleFile: "does-not-exist.mp4", sampleSha256: "0".repeat(64), privateVideoId: "private-test-video",
    categoryId: "category", groupIds: [], tagIds: [], uploadObjectPrefix: "onlineVideo/acceptance/local/isolated-run/",
    authorization: { cloudWrites: true, databaseWrites: true, publicEgress: true, privateObjectRead: true, retainObjects: true, newObjectPrivateAcl: true } };
  assert.equal((await runAcceptance(manifest, false) as { state: string }).state, "prepared");
  const { privateVideoId: _privateVideoId, ...uploadOnly } = manifest;
  assert.equal((await runAcceptance({ ...uploadOnly, verifyUploadedObjectPrivate: true }, false) as { state: string }).state, "prepared");
  for (const bad of [{ ...manifest, apiOrigin: "https://arbitrary.invalid" }, { ...manifest, verifiedSchemaVersion: 1 },
    { ...manifest, authorization: { ...manifest.authorization, cloudWrites: false } }, { ...manifest, mediaOrigin: "http://oss.meetdawn.top" },
    { ...manifest, verifyUploadedObjectPrivate: true }, { ...uploadOnly, verifyUploadedObjectPrivate: false },
    { ...uploadOnly, verifyUploadedObjectPrivate: true, authorization: { ...manifest.authorization, newObjectPrivateAcl: false } }]) {
    assert.throws(() => validateAcceptanceManifest(bad)); await assert.rejects(runAcceptance(bad, true));
  }
});

test("新上传私有验收模式：公共匿名200立即停止、私有403后仅签名Range/下载继续；仅本地HTTP替身", async t => {
  const directory = resolve(".local/tests", `acceptance-private-mode-${randomUUID()}`); await mkdir(directory, { recursive: true });
  const bytes = Buffer.from("isolated-sample"); const sampleFile = resolve(directory, "sample.mp4"); const sessionFile = resolve(directory, "session.json");
  await writeFile(sampleFile, bytes); await writeFile(sessionFile, JSON.stringify({ cookie: "fake-session=local-test", csrfToken: "fake-csrf" }));
  const prefix = "onlineVideo/acceptance/local/mock-after-upload/";
  const manifest: AcceptanceManifest = { apiOrigin: "http://127.0.0.1:3000", browserOrigin: "http://127.0.0.1:5173", mediaOrigin: "https://oss.meetdawn.top",
    authorizationReference: "isolated-mock-test-only", databaseFile: "unused-isolated.db", verifiedSchemaVersion: 2, databaseBackupReference: "isolated-backup-proof",
    sessionFile, sampleFile, sampleSha256: createHash("sha256").update(bytes).digest("hex"), verifyUploadedObjectPrivate: true,
    categoryId: "category", groupIds: [], tagIds: [], uploadObjectPrefix: prefix,
    authorization: { cloudWrites: true, databaseWrites: true, publicEgress: true, privateObjectRead: true, retainObjects: true, newObjectPrivateAcl: true } };
  let anonymousStatus = 200; const operations: string[] = [];
  const sourceUrl = `${manifest.mediaOrigin}/${prefix}new-unique?x-oss-signature-version=OSS4-HMAC-SHA256&x-oss-security-token=fake-token`;
  const sourceExpiresAt = new Date(Date.now() + 300_000).toISOString();
  const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  const replacement = t.mock.method(globalThis, "fetch", async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(target)); operations.push(`${init?.method ?? "GET"} ${url.pathname} ${url.search ? "signed" : "unsigned"} ${new Headers(init?.headers).get("range") ?? "full"}`);
    if (url.origin === manifest.apiOrigin) {
      if (url.pathname === "/api/auth/me") return json({ user: { id: "isolated-owner" } });
      if (url.pathname === "/api/settings/limits") return json({ uploadObjectPrefix: prefix });
      if (url.pathname === "/api/uploads") return json({ id: "upload", partSizeBytes: 102400 });
      if (url.pathname === "/api/uploads/upload/parts/1") {
        for await (const _chunk of init!.body as unknown as Readable) { /* 仅消费本地小样例，不发网络 */ }
        return json({ partNumber: 1 });
      }
      if (url.pathname === "/api/uploads/upload/complete") return json({ upload: { status: "completed" }, video: {
        id: "video", sizeBytes: bytes.length, categoryId: "category", groupIds: [], tagIds: [], status: "unsupported", playable: false } });
      if (url.pathname === "/api/videos/video/download-authorizations") return json({ sourceUrl, sourceExpiresAt });
      if (url.pathname === "/api/settings/usage") return json({ source: "oss_direct", transferredBytes: null });
      assert.fail(`不应调用该控制路径 ${url.pathname}`);
    }
    assert.equal(url.origin, manifest.mediaOrigin);
    if (!url.search) return new Response("", { status: anonymousStatus });
    if (new Headers(init?.headers).get("range")) return new Response(new Uint8Array(bytes.subarray(0, 1)), { status: 206, headers: { "content-range": `bytes 0-0/${bytes.length}` } });
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-disposition": "attachment; filename=sample.mp4" } });
  });
  t.after(() => replacement.mock.restore());
  await assert.rejects(runAcceptance(manifest, true), /私有对象匿名访问未拒绝：200/);
  assert.ok(!operations.some(operation => operation.includes("signed full") && operation.includes(prefix)), "匿名200后不得完整下载或播放");
  assert.ok(!operations.some(operation => operation.includes("playback-sessions")));
  assert.ok(operations.findIndex(operation => operation.includes("download-authorizations")) > operations.findIndex(operation => operation.includes("/complete")));
  anonymousStatus = 403; operations.length = 0;
  const report = await runAcceptance(manifest, true) as { uploadedObjectPrivateVerified: boolean; anonymousStatus: number; playback: string };
  assert.equal(report.uploadedObjectPrivateVerified, true); assert.equal(report.anonymousStatus, 403); assert.match(report.playback, /^unsupported/);
  assert.equal(operations.filter(operation => operation.includes(" signed bytes=0-0")).length, 1);
  assert.equal(operations.filter(operation => operation.includes(" signed full") && operation.includes(prefix)).length, 1);
});

test("导入真SQLite完整对象/资产/组标签/操作登记，重复导入只有一视频，空标签和归档拒绝一致", async t => {
  const database = openDatabase(":memory:", { initialize: true }); t.after(() => database.close());
  database.client.exec("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES('owner','隔离导入','test','test','2026-10-01T00:00:00Z'); INSERT INTO categories(id,owner_id,name,name_key,is_default,created_at) VALUES('category','owner','未分类','未分类',1,'2026-10-01T00:00:00Z'); INSERT INTO library_groups(id,owner_id,name,name_key,description,sort_order,created_at,updated_at) VALUES('group','owner','分组','分组','',0,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z'); INSERT INTO tags(id,owner_id,name,name_key,created_at,updated_at) VALUES('tag','owner','标签','标签','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');");
  const config = readConfig({ NODE_ENV: "test", MAX_PLAYBACK_SESSIONS: "3", TRANSFER_LIMIT_BYTES: "unlimited" });
  const f = fakeDependencies(config); f.storage.seed("library/existing/sql.mp4", Buffer.from("sqlvideo"));
  const repos = createRepositories(database, () => f.clock.time);
  const dependencies = { ...f.dependencies, ...repos };
  const app = await buildApp({ config, logger: false, media: { register: createMediaModule(mediaOptions), dependencies } });
  t.after(() => app.close());
  const preview = (await app.inject({ method: "POST", url: "/api/imports/preview", headers, payload: { prefix: "library/existing/" } })).json().data;
  const commit = (tagIds: string[]) => app.inject({ method: "POST", url: "/api/imports/commit", headers, payload: {
    previewId: preview.id, itemIds: [preview.items[0].id], categoryId: "category", groupIds: ["group"], tagIds } });
  const imported = await commit(["tag"]); assert.equal(imported.statusCode, 200, imported.body);
  assert.deepEqual(imported.json().data.videos[0].groupIds, ["group"]); assert.deepEqual(imported.json().data.videos[0].tagIds, ["tag"]);
  const repeated = await commit([]); assert.equal(repeated.statusCode, 200); assert.equal(repeated.json().data.videos[0].id, imported.json().data.videos[0].id);
  // 幂等导入返回既有记录，不以重复请求的空标签覆盖已经登记的选择。
  assert.deepEqual(repeated.json().data.videos[0].tagIds, ["tag"]);
  const count = (table: string) => (database.client.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  assert.equal(count("videos"), 1); assert.equal(count("storage_objects"), 1); assert.equal(count("video_assets"), 2);
  assert.equal(count("video_group_links"), 1); assert.equal(count("video_tag_links"), 1);
  assert.ok((database.client.prepare("SELECT state FROM storage_operations").all() as { state: string }[]).every(row => row.state === "registered"));
  const record = await repos.videos.findOwned("owner", imported.json().data.videos[0].id);
  assert.equal(record!.originalObject.kind, "registered"); assert.equal(record!.originalObject.kind === "registered" && record!.originalObject.verificationStatus, "verified");
  f.storage.seed("library/existing/legacy.mp4", Buffer.from("legacy"));
  const oldVideo = await repos.videos.register({ ownerId: "owner", originalObject: { key: "library/existing/legacy.mp4" },
    playbackObject: { key: "library/unknown-old-copy.mp4" }, thumbnailObject: null, video: { ...record!.video, id: "legacy-video",
      title: "原始标题", sizeBytes: 6, lastPositionSeconds: 0 } });
  await repos.progress.save("owner", oldVideo.video.id, 4);
  database.client.exec("UPDATE library_groups SET archived_at='2026-10-01T12:00:00Z' WHERE id='group'");
  assert.equal((await commit([])).statusCode, 409); assert.equal(count("videos"), 2); assert.equal(f.storage.objects.size, 2);
  const bindingPreview = (await app.inject({ method: "POST", url: "/api/imports/preview", headers, payload: { prefix: "library/existing/" } })).json().data;
  const legacyItem = bindingPreview.items.find((item: { fileName: string }) => item.fileName === "legacy.mp4");
  const bind = (existingVideoId: string, itemIds = [legacyItem.id]) => app.inject({ method: "POST", url: "/api/imports/commit", headers,
    payload: { previewId: bindingPreview.id, itemIds, categoryId: "category", groupIds: [], tagIds: [], existingVideoId } });
  assert.equal((await bind("missing-video")).statusCode, 404);
  assert.equal((await bind(oldVideo.video.id, bindingPreview.items.map((item: { id: string }) => item.id))).statusCode, 400);
  assert.equal((await bind(imported.json().data.videos[0].id)).statusCode, 409);
  const bound = await bind(oldVideo.video.id); assert.equal(bound.statusCode, 200, bound.body);
  assert.equal(bound.json().data.videos[0].id, "legacy-video"); assert.equal(bound.json().data.videos[0].title, "原始标题");
  assert.deepEqual(bound.json().data.videos[0].groupIds, ["group"]); assert.deepEqual(bound.json().data.videos[0].tagIds, ["tag"]);
  assert.equal(bound.json().data.videos[0].lastPositionSeconds, 4);
  assert.equal((await bind(oldVideo.video.id)).json().data.videos[0].id, oldVideo.video.id);
  const rebound = await repos.videos.findOwned("owner", oldVideo.video.id);
  assert.equal(rebound!.originalObject.kind, "registered"); assert.equal(rebound!.playbackObject.key, "library/existing/legacy.mp4");
  assert.equal(count("videos"), 2); assert.equal(count("storage_objects"), 2); assert.equal(count("video_assets"), 4);
  assert.deepEqual(database.client.pragma("foreign_key_check"), []);
});

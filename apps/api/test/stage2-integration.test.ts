import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import OSS from "ali-oss";
import { startLocalOss } from "./integration/local-oss-server.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/core/config.js";
import { openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { AuthService, initializeAccount } from "../src/modules/auth/service.js";
import { readAuthSettings } from "../src/modules/auth/settings.js";
import { totp } from "../src/modules/auth/crypto.js";
import { createMediaModule } from "../src/modules/media/index.js";
import { OssStorageAdapter } from "../src/modules/media/storage/oss.js";
import type { OssClient } from "../src/modules/media/storage/oss.js";
import { OssPresignedSourceProvider } from "../src/modules/media/storage/signing.js";
import type { MediaDependencies } from "../src/core/contracts/index.js";

const testIdentity = { bucket: "test-bucket", region: "cn-hangzhou", prefix: "onlineVideo/", accessKeyId: "local-sts-readwrite", accessKeySecret: "local-protocol-secret", stsToken: "local-protocol-token" };

test("主控本地协议：真 SDK 流式 Multipart、独立 V4 HMAC校验、匿名/篡改拒绝、Range及附件响应", async t => {
  const server = await startLocalOss(testIdentity); t.after(() => server.close());
  const sdk = new OSS({ ...testIdentity, endpoint: server.endpoint, cname: true, region: "oss-cn-hangzhou", authorizationV4: true });
  const key = "onlineVideo/acceptance/local/protocol.mp4"; const bytes = Buffer.from("0123456789 protocol sample");
  const multipart = await sdk.initMultipartUpload(key, { headers: { "Content-Type": "video/mp4", "x-oss-forbid-overwrite": "true" } });
  const part = await sdk.uploadPart(key, multipart.uploadId, 1, Readable.from([bytes.subarray(0, 9), bytes.subarray(9)]), 0, bytes.length);
  await sdk.completeMultipartUpload(key, multipart.uploadId, [{ number: 1, etag: part.etag }], { headers: { "x-oss-forbid-overwrite": "true" } });
  assert.equal(server.objects.size, 1); assert.deepEqual(server.objects.get(key)!.bytes, bytes);
  const head = await sdk.head(key);
  assert.equal(Number((head.res.headers as Record<string, string>)["content-length"]), bytes.length);
  const unsigned = await fetch(`${server.endpoint}/${key}`); assert.equal(unsigned.status, 403);
  const source = await sdk.signatureUrlV4("GET", 30, {}, key);
  const response = await fetch(source, { headers: { range: "bytes=2-5" } });
  assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), `bytes 2-5/${bytes.length}`); assert.equal(await response.text(), "2345");
  assert.equal((await fetch(source, { method: "HEAD" })).status, 403);
  const tampered = new URL(source); tampered.searchParams.set("x-oss-expires", "3600"); assert.equal((await fetch(tampered)).status, 403);
  const wrongKey = new URL(source); wrongKey.pathname = "/onlineVideo/other.mp4"; assert.equal((await fetch(wrongKey)).status, 403);
  const download = await sdk.signatureUrlV4("GET", 30, { queries: { "response-content-disposition": "attachment; filename=original.mp4" } }, key);
  const original = await fetch(download); assert.equal(original.status, 200); assert.equal(original.headers.get("content-disposition"), "attachment; filename=original.mp4");
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  assert.ok(server.requests.some(entry => entry.signed && entry.status === 206));
  assert.ok(server.requests.some(entry => !entry.signed && entry.status === 403));
});

test("主控隔离真HTTP+SQLite+OSS协议：组织→分片→唯一登记→直连/续签/下载→重启→撤销，回归proxy", async t => {
  const server = await startLocalOss(testIdentity); t.after(() => server.close());
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `stage2-integration-${Date.now()}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true }); const path = resolve(directory, "application.db"); new Database(path).close();
  let database = openDatabase(path, { initialize: true }); const key = randomBytes(32);
  const credentials = await initializeAccount(database, key, "隔离主控测试");
  const now = () => new Date(); const origin = "http://127.0.0.1:5173";
  const config = readConfig({ NODE_ENV: "test", STORAGE_DRIVER: "oss", PLAYBACK_MODE: "oss", USAGE_TIMEZONE: "Asia/Shanghai", MAX_PLAYBACK_SESSIONS: "3",
    MAX_UPLOAD_BYTES: "2147483648", UPLOAD_PART_SIZE_BYTES: "8388608", MAX_UPLOAD_CONCURRENCY: "2", PLAYBACK_SESSION_TTL_MS: "120000",
    MAX_AUTHORIZATIONS_PER_MINUTE: "12", MEDIA_REQUESTS_PER_MINUTE: "120", IMPORT_PREVIEW_TTL_MS: "600000", MAX_IMPORT_PREVIEWS: "16",
    OSS_REGION: "cn-hangzhou", OSS_BUCKET: testIdentity.bucket, OSS_OBJECT_PREFIX: testIdentity.prefix,
    OSS_ENDPOINT: "https://oss-cn-hangzhou.aliyuncs.com", OSS_NETWORK: "public", OSS_ALLOW_PUBLIC_NETWORK: "true", OSS_PLAYBACK_ENDPOINT: "https://media.example.invalid",
    OSS_CREDENTIAL_FILE: resolve(directory, "unused-oss.json"), OSS_ROLE_ARN: "acs:ram::123456789:role/local-test",
    OSS_STS_DURATION_SECONDS: "3600", OSS_STS_REFRESH_BEFORE_SECONDS: "300", OSS_SIGNED_URL_TTL_SECONDS: "3600", OSS_CLOCK_SKEW_SECONDS: "30" });
  let readCredentialsRequests = 0;
  const provider = { get: async (input?: { purpose: string }) => {
    if (input?.purpose === "read") readCredentialsRequests++;
    return { ...testIdentity, expiration: new Date(Date.now() + 3_600_000).toISOString() };
  } };
  const storage = new OssStorageAdapter({ bucket: testIdentity.bucket, region: "cn-hangzhou", endpoint: config.oss!.endpoint,
    network: "public", allowPublicNetwork: true, objectPrefix: testIdentity.prefix, credentialFile: "unused-protocol-test" },
    input => new OSS({ ...input, endpoint: server.endpoint, cname: true }) as unknown as OssClient, async () => provider.get());
  const sources = new OssPresignedSourceProvider({ bucket: testIdentity.bucket, region: "cn-hangzhou", endpoint: server.endpoint,
    objectPrefix: testIdentity.prefix, ttlSeconds: 3600, safetySeconds: 30, renewBeforeSeconds: 300, kind: "test" }, provider, input => new OSS(input));
  // 隔离协议样例的分析结果受控注入；真实FFprobe/手机原片另验，不凭上传成功宣称格式验收。
  const metadata = { inspect: async () => ({ status: "ready" as const, durationSeconds: 30, codec: "h264/aac", width: 640, height: 360, playable: true }) };
  let modeConfig = config;
  const assemble = async () => {
    const auth = new AuthService(database, key, readAuthSettings("test", {}), now);
    const dependencies: MediaDependencies = { ...createRepositories(database, now), kind: "test", config: modeConfig, auth, storage, sources, now };
    return buildApp({ config: modeConfig, logger: false, auth, backend: { database, auth, config: modeConfig, now },
      media: { register: createMediaModule({ ...modeConfig.media!, metadata }), dependencies } });
  };
  let app = await assemble();
  t.after(async () => { await app.close(); if (database.client.open) database.close(); });
  await app.listen({ host: "127.0.0.1", port: 0 });
  let apiOrigin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let cookie = ""; let csrf = "";
  async function call(route: string, method = "GET", payload?: unknown, expected = 200) {
    const response = await fetch(`${apiOrigin}${route}`, { method, headers: { origin, cookie, "x-csrf-token": csrf,
      ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const value = await response.json() as { data: any; error?: { code: string } };
    assert.equal(response.status, expected, `API ${method} ${route}: ${value.error?.code ?? response.status}`); return { response, value };
  }
  const logged = await call("/api/auth/login", "POST", { password: credentials.password, totp: totp(credentials.totpSecret).generate() });
  cookie = logged.response.headers.get("set-cookie")!.split(";")[0]!; csrf = logged.value.data.csrfToken;
  const category = (await call("/api/categories", "POST", { name: "主控旅行" })).value.data.id as string;
  const group = (await call("/api/groups", "POST", { name: "旅途", description: "真HTTP隔离数据" })).value.data.id as string;
  const tag = (await call("/api/tags", "POST", { name: "杭州" })).value.data.id as string;
  const secondTag = (await call("/api/tags", "POST", { name: "夜景" })).value.data.id as string;
  assert.equal((await call("/api/settings/limits")).value.data.maxUploadBytes, 2147483648);
  await call("/api/uploads", "POST", { fileName: "too-big.mp4", title: "超限", categoryId: category, sizeBytes: 2147483649 }, 400);
  const bytes = Buffer.alloc(8388608 + 7, 7); const upload = (await call("/api/uploads", "POST", { fileName: "原片.mp4", title: "杭州夜景",
    categoryId: category, groupIds: [group], tagIds: [tag, secondTag], sizeBytes: bytes.length })).value.data;
  assert.deepEqual(upload.groupIds, [group]); assert.equal(upload.partSizeBytes, 8388608);
  for (let partNumber = 1; partNumber <= 2; partNumber++) {
    const chunk = bytes.subarray((partNumber - 1) * upload.partSizeBytes, partNumber * upload.partSizeBytes);
    const response = await fetch(`${apiOrigin}/api/uploads/${upload.id}/parts/${partNumber}`, { method: "PUT", headers: { origin, cookie, "x-csrf-token": csrf,
      "content-type": "application/octet-stream", "x-part-checksum": createHash("sha256").update(chunk).digest("hex") }, body: new Uint8Array(chunk) });
    assert.equal(response.status, 200, `part ${partNumber}`); await response.arrayBuffer();
  }
  const done = (await call(`/api/uploads/${upload.id}/complete`, "POST", {})).value.data;
  const videoId = done.video.id as string;
  assert.equal(done.upload.status, "completed"); assert.equal(done.upload.videoId, videoId); assert.equal(done.video.sizeBytes, bytes.length);
  assert.deepEqual(done.video.groupIds, [group]); assert.deepEqual([...done.video.tagIds].sort(), [tag, secondTag].sort());
  assert.equal((await call(`/api/uploads/${upload.id}/complete`, "POST", {})).value.data.video.id, videoId);
  assert.equal((database.client.prepare("SELECT count(*) n FROM videos").get() as { n: number }).n, 1);
  assert.equal((database.client.prepare("SELECT count(*) n FROM video_assets").get() as { n: number }).n, 2);
  const list = (await call(`/api/videos?groupIds=${group}&tagIds=${tag},${secondTag}&q=${encodeURIComponent("杭州")}`)).value.data;
  assert.equal(list.total, 1); assert.equal(list.items[0].id, videoId);
  assert.equal((await call(`/api/videos?tagIds=${tag},missing`)).value.data.total, 0);
  const record = await createRepositories(database).videos.findOwned(logged.value.data.user.id, videoId);
  assert.equal(record!.originalObject.kind, "registered"); assert.equal(server.objects.size, 1);
  const unsigned = await fetch(`${server.endpoint}/${record!.originalObject.key}`); assert.equal(unsigned.status, 403);
  const created = (await call(`/api/videos/${videoId}/playback-sessions`, "POST", {})).value.data;
  assert.equal(created.mode, "oss"); assert.equal(new URL(created.sourceUrl).origin, server.endpoint);
  assert.ok(Date.parse(created.sourceExpiresAt) - Date.now() <= 3_600_000);
  assert.equal(Date.parse(created.sourceExpiresAt) - Date.parse(created.renewAfter), 300_000);
  const other = (await call(`/api/videos/${videoId}/playback-sessions`, "POST", {})).value.data;
  const third = (await call(`/api/videos/${videoId}/playback-sessions`, "POST", {})).value.data;
  const beforeRejected = readCredentialsRequests;
  await call(`/api/videos/${videoId}/playback-sessions`, "POST", {}, 429);
  assert.equal(readCredentialsRequests, beforeRejected, "并发已满时不能先生成一个新的签名");
  const direct = await fetch(created.sourceUrl, { headers: { range: "bytes=1-8" } }); assert.equal(direct.status, 206);
  assert.deepEqual(Buffer.from(await direct.arrayBuffer()), bytes.subarray(1, 9));
  const renewed = (await call(`/api/playback-sessions/${created.id}/source`, "POST", {})).value.data;
  assert.equal(renewed.id, created.id);
  await call(`/api/playback-sessions/${other.id}/close`, "POST", {});
  await call(`/api/playback-sessions/${third.id}/close`, "POST", {});
  const download = (await call(`/api/videos/${videoId}/download-authorizations`, "POST", {})).value.data;
  const original = await fetch(download.sourceUrl); assert.equal(original.status, 200); assert.match(original.headers.get("content-disposition")!, /^attachment;/);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  const usage = (await call("/api/settings/usage")).value.data;
  assert.equal(usage.source, "oss_direct"); assert.equal(usage.transferredBytes, null); assert.equal(usage.timezone, "Asia/Shanghai");
  assert.equal(usage.authorizationCount, 5); assert.equal(usage.activePlaybackSessions, 1);
  await call(`/api/videos/${videoId}/progress`, "PUT", { positionSeconds: 12.5 });
  await call(`/api/videos/${videoId}`, "PATCH", { title: "修改杭州夜景", tagIds: [] });
  await app.close(); database.close(); database = openDatabase(path); app = await assemble(); await app.listen({ host: "127.0.0.1", port: 0 });
  apiOrigin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  assert.equal((await call("/api/auth/me")).value.data.user.id, logged.value.data.user.id);
  assert.equal((await call(`/api/videos/${videoId}/progress`)).value.data.positionSeconds, 12.5);
  const detail = (await call(`/api/videos/${videoId}`)).value.data;
  assert.equal(detail.title, "修改杭州夜景"); assert.deepEqual(detail.tagIds, []); assert.deepEqual(detail.groupIds, [group]);
  await call("/api/auth/logout", "POST", {}); await call(`/api/playback-sessions/${created.id}/source`, "POST", {}, 401);
  const priorUrl = await fetch(created.sourceUrl, { headers: { range: "bytes=0-0" } }); assert.equal(priorUrl.status, 206); await priorUrl.arrayBuffer();
  // 旧签名仍有效是直连的真实边界；显式proxy每次由站内Cookie/会话检查，并记录实际正文byte。
  modeConfig = { ...config, playbackMode: "proxy", transferPolicy: { kind: "limited", limitBytes: 1024 } };
  await app.close(); app = await assemble(); await app.listen({ host: "127.0.0.1", port: 0 });
  apiOrigin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  await new Promise(resolve => setTimeout(resolve, 31_000 - Date.now() % 30_000));
  cookie = ""; csrf = "";
  const proxyLogin = await call("/api/auth/login", "POST", { password: credentials.password, totp: totp(credentials.totpSecret).generate() });
  cookie = proxyLogin.response.headers.get("set-cookie")!.split(";")[0]!; csrf = proxyLogin.value.data.csrfToken;
  const proxy = (await call(`/api/videos/${videoId}/playback-sessions`, "POST", {})).value.data;
  assert.equal(proxy.mode, "proxy"); assert.ok(proxy.sourceUrl.startsWith("/api/"));
  const proxied = await fetch(`${apiOrigin}${proxy.sourceUrl}`, { headers: { cookie, range: "bytes=0-7" } });
  assert.equal(proxied.status, 206); assert.deepEqual(Buffer.from(await proxied.arrayBuffer()), bytes.subarray(0, 8));
  assert.equal((await call("/api/settings/usage")).value.data.transferredBytes, 8);
  assert.equal(database.client.pragma("integrity_check", { simple: true }), "ok"); assert.deepEqual(database.client.pragma("foreign_key_check"), []);
});

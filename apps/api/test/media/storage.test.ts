import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { MockStorageAdapter } from "../../src/modules/media/storage/mock.js";
import { ObjectScope } from "../../src/modules/media/storage/scope.js";
import { HttpError } from "../../src/core/errors.js";
import { createServer } from "node:http";
import { once } from "node:events";
import OSS from "ali-oss";
import { OssStorageAdapter, validateOssOptions } from "../../src/modules/media/storage/oss.js";
import type { OssClient, OssOptions } from "../../src/modules/media/storage/oss.js";

test("Mock 存储验证授权前缀、闭区间读取及 Multipart，不访问真实 OSS", async () => {
  const storage = new MockStorageAdapter(); const signal = new AbortController().signal;
  storage.seed("library/original.mp4", Buffer.from("0123456789"));
  const read = await storage.openRead({ object: { key: "library/original.mp4" }, range: { start: 2, end: 4 }, signal });
  let data = ""; for await (const chunk of read.stream) data += String(chunk); assert.equal(data, "234");
  const object = { key: "library/new.mp4" }; const { uploadId } = await storage.createMultipart({ object, contentType: "video/mp4", signal });
  const bytes = Buffer.from("hello"); const checksum = createHash("sha256").update(bytes).digest("hex");
  const { etag } = await storage.uploadPart({ object, uploadId, partNumber: 1, sizeBytes: 5, checksum, stream: Readable.from([bytes]), signal });
  const result = await storage.completeMultipart({ object, uploadId, parts: [{ partNumber: 1, sizeBytes: 5, checksum, etag }], signal });
  assert.equal(result.sizeBytes, 5); assert.equal((await storage.list({ prefix: "library/", limit: 1, signal })).items.length, 1);
  for (const key of ["else/a", "library/../x", "library/%2e%2e/x", "library/\\x", "/library/a"]) {
    await assert.rejects(storage.head({ object: { key }, signal }), (error: unknown) => error instanceof HttpError && error.code === "FORBIDDEN");
  }
  assert.throws(() => new ObjectScope(""));
  await assert.rejects(storage.list({ prefix: "lib/", limit: 2, signal }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(storage.head({ object, signal: controller.signal }));
});

const ossOptions: OssOptions = { bucket: "test-bucket", region: "cn-hangzhou", endpoint: "https://oss-cn-hangzhou-internal.aliyuncs.com",
  objectPrefix: "library/", network: "internal", credentialFile: "unused-test-secret" };

test("OSS 配置拒绝隐式公网和越界 endpoint；真 SDK 只连本地 HTTP，验证 V4/Range/未返回请求取消", async t => {
  for (const config of [{ ...ossOptions, endpoint: "http://oss-cn-hangzhou-internal.aliyuncs.com" },
    { ...ossOptions, network: "public" as const, endpoint: "https://oss-cn-hangzhou.aliyuncs.com" },
    { ...ossOptions, endpoint: "https://evil.invalid" }]) assert.throws(() => validateOssOptions(config));
  let delayedStarted!: () => void;
  const started = new Promise<void>(resolve => { delayedStarted = resolve; });
  let delayedClosed!: () => void;
  const closed = new Promise<void>(resolve => { delayedClosed = resolve; });
  const signatures: string[] = [];
  const server = createServer((request, response) => {
    signatures.push(String(request.headers.authorization));
    if (request.url?.includes("delayed")) { response.once("close", delayedClosed); delayedStarted(); return; }
    response.setHeader("etag", '"testetag"'); response.setHeader("content-type", "video/mp4");
    if (request.method === "HEAD") { response.setHeader("content-length", 10); response.end(); return; }
    if (request.headers.range) {
      assert.equal(request.headers.range, "bytes=2-4"); response.statusCode = 206;
      response.setHeader("content-range", "bytes 2-4/10"); response.setHeader("content-length", 3); response.end("234");
    } else { response.setHeader("content-length", 10); response.end("0123456789"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  // 显式测试工厂替换 endpoint，真实适配器配置仍只允许指定杭州 HTTPS 地址。
  const storage = new OssStorageAdapter(ossOptions,
    config => new OSS({ ...config, endpoint: `http://127.0.0.1:${address.port}` }) as unknown as OssClient,
    async () => ({ accessKeyId: "fake-key", accessKeySecret: "fake-secret" }));
  const read = await storage.openRead({ object: { key: "library/test.mp4" }, range: { start: 2, end: 4 }, signal: new AbortController().signal });
  let bytes = ""; for await (const chunk of read.stream) bytes += String(chunk);
  assert.equal(bytes, "234"); assert.ok(signatures.every(value => value.startsWith("OSS4-HMAC-SHA256")));
  const controller = new AbortController(); const start = Date.now();
  const pending = storage.head({ object: { key: "library/delayed" }, signal: controller.signal });
  await started; controller.abort(); await assert.rejects(pending); await closed;
  assert.ok(Date.now() - start < 2000);
});

test("真 ali-oss SDK 在本地 HTTP 验证 Readable 分片与完成清单、限定 prefix 列表，不缓冲整个视频", async t => {
  let received = Buffer.alloc(0); let completed = false; let completionXml = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      response.setHeader("content-type", "application/xml"); response.end('<InitiateMultipartUploadResult><Bucket>test-bucket</Bucket><Key>library/new</Key><UploadId>server-upload</UploadId></InitiateMultipartUploadResult>'); return;
    }
    if (request.method === "PUT") {
      assert.equal(url.searchParams.get("partNumber"), "1"); assert.equal(url.searchParams.get("uploadId"), "server-upload");
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); received = Buffer.concat(chunks);
      response.setHeader("etag", '"part-etag"'); response.end(); return;
    }
    if (request.method === "POST") {
      assert.equal(request.headers["x-oss-forbid-overwrite"], "true");
      for await (const chunk of request) completionXml += String(chunk); completed = true;
      response.setHeader("content-type", "application/xml"); response.end('<CompleteMultipartUploadResult><Bucket>test-bucket</Bucket><Key>library/new</Key><ETag>object-etag</ETag></CompleteMultipartUploadResult>'); return;
    }
    if (request.method === "HEAD") { assert.equal(completed, true); response.setHeader("etag", '"object-etag"'); response.setHeader("content-length", received.length); response.end(); return; }
    assert.equal(url.searchParams.get("prefix"), "library/"); assert.equal(url.searchParams.get("max-keys"), "10");
    response.setHeader("content-type", "application/xml"); response.end('<ListBucketResult><Name>test-bucket</Name><Prefix>library/</Prefix><KeyCount>1</KeyCount><MaxKeys>10</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>library/new.mp4</Key><LastModified>2026-10-01T00:00:00.000Z</LastModified><ETag>object-etag</ETag><Size>5</Size><StorageClass>Standard</StorageClass></Contents></ListBucketResult>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const adapter = new OssStorageAdapter(ossOptions, config => new OSS({ ...config, endpoint: `http://127.0.0.1:${address.port}` }) as unknown as OssClient,
    async () => ({ accessKeyId: "fake-key", accessKeySecret: "fake-secret" }));
  const object = { key: "library/new.mp4" }; const signal = new AbortController().signal;
  const task = await adapter.createMultipart({ object, contentType: "application/octet-stream", signal });
  const bytes = Buffer.from("hello"); const checksum = createHash("sha256").update(bytes).digest("hex");
  const part = await adapter.uploadPart({ object, uploadId: task.uploadId, partNumber: 1, sizeBytes: 5, checksum,
    stream: Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]), signal });
  assert.equal(received.toString(), "hello"); assert.equal(part.etag, '"part-etag"');
  const metadata = await adapter.completeMultipart({ object, uploadId: task.uploadId, parts: [{ partNumber: 1, sizeBytes: 5, checksum, etag: part.etag }], signal });
  assert.equal(metadata.sizeBytes, 5); assert.ok(completionXml.includes('<ETag>"part-etag"</ETag>'));
  const list = await adapter.list({ prefix: "library/", limit: 10, signal }); assert.equal(list.items[0]?.object.key, "library/new.mp4");
});

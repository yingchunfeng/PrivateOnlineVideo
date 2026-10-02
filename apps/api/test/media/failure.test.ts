import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { request as httpRequest, get } from "node:http";
import type { IncomingMessage } from "node:http";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/core/config.js";
import { createMediaModule, registerMediaModule } from "../../src/modules/media/index.js";
import { fakeDependencies, headers, options } from "./fakes.js";
import { fixture, createSession } from "./playback.test.js";
import { HttpError } from "../../src/core/errors.js";

test("存储错误公共响应安全且预留释放，测试默认注册不得用于生产依赖", async t => {
  const f = await fixture(); t.after(() => f.app.close()); const session = await createSession(f.app);
  f.storage.openRead = async () => { throw new Error("AccessKeySecret=never-expose; library/private"); };
  const response = await f.app.inject({ url: session.sourceUrl, headers });
  assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, "STORAGE_UNAVAILABLE"); assert.ok(!response.body.includes("AccessKey"));
  assert.equal([...f.periods.values()].reduce((sum, period) => sum + period.reserved, 0), 0);
  const config = readConfig({ NODE_ENV: "test", TRANSFER_LIMIT_BYTES: "unlimited", MAX_PLAYBACK_SESSIONS: "1" });
  const productionMarked = fakeDependencies(config).dependencies; productionMarked.kind = "production";
  await assert.rejects(buildApp({ config, logger: false, media: { register: registerMediaModule, dependencies: productionMarked } }),
    (error: unknown) => error instanceof HttpError && error.code === "SERVICE_NOT_CONFIGURED");
});

test("真实上传断线后不登记分片，可重新读取任务及重试同片；不删除 OSS Multipart", async t => {
  const f = await fixture(); const response = await f.app.inject({ method: "POST", url: "/api/uploads", headers,
    payload: { fileName: "large.mp4", sizeBytes: options.partSizeBytes, title: "large", categoryId: "category" } });
  const id = response.json().data.id; const bytes = Buffer.alloc(options.partSizeBytes, 7); const hash = createHash("sha256").update(bytes).digest("hex");
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
  const uploadPart = f.storage.uploadPart.bind(f.storage);
  f.storage.uploadPart = async input => { started(); return uploadPart(input); };
  await f.app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => f.app.close());
  const address = f.app.server.address(); assert.ok(address && typeof address !== "string");
  const request = httpRequest(`http://127.0.0.1:${address.port}/api/uploads/${id}/parts/1`, { method: "PUT",
    headers: { ...headers, "content-type": "application/octet-stream", "content-length": bytes.length, "x-part-checksum": hash } });
  request.on("error", () => { /* 本用例主动断开自己创建的客户端。 */ }); request.write(bytes.subarray(0, 4096)); await start; request.destroy();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.uploads.get(id)!.parts.length, 0); assert.equal(f.uploads.get(id)!.task.status, "uploading");
  assert.equal(f.storage.uploads.size, 1);
  assert.equal((await f.app.inject({ url: `/api/uploads/${id}`, headers })).json().data.uploadedParts.length, 0);
  const retried = await f.app.inject({ method: "PUT", url: `/api/uploads/${id}/parts/1`,
    headers: { ...headers, "content-type": "application/octet-stream", "x-part-checksum": hash }, payload: bytes });
  assert.equal(retried.statusCode, 200, retried.body);
});

test("播放 heartbeat 延期，已撤销登录在持续流下一块停止转发并结算", async t => {
  const f = await fixture(); const size = 256 * 1024; f.seedVideo("large", Buffer.alloc(size, 6));
  const session = await createSession(f.app, "large"); const oldExpiry = f.sessions.get(session.id)!.session.expiresAt;
  f.clock.time = new Date(f.clock.time.getTime() + 60_000);
  await f.app.inject({ method: "POST", url: `/api/playback-sessions/${session.id}/heartbeat`, headers });
  assert.ok(f.sessions.get(session.id)!.session.expiresAt > oldExpiry);
  let revoked = false; const requireUser = f.dependencies.auth.requireUser;
  f.dependencies.auth.requireUser = async (...args) => { if (revoked) throw new HttpError("SESSION_EXPIRED"); return requireUser(...args); };
  const meta = await f.storage.head({ object: { key: "library/large.mp4" }, signal: new AbortController().signal });
  let produced = 0; let timer: NodeJS.Timeout | undefined; let destroyed = false;
  f.dependencies.storage.openRead = async input => {
    const stream = new Readable({ read() {
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; produced += 4096; this.push(Buffer.alloc(4096, 6)); }, 10);
    }, destroy(error, callback) { destroyed = true; if (timer) clearTimeout(timer); callback(error); } });
    input.signal.addEventListener("abort", () => stream.destroy(), { once: true }); return { stream, metadata: meta, range: null };
  };
  await f.app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => f.app.close());
  const address = f.app.server.address(); assert.ok(address && typeof address !== "string");
  const received = await new Promise<number>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${address.port}${session.sourceUrl}`, { headers }, response => {
      let count = 0; response.on("data", chunk => { count += chunk.length; revoked = true; });
      response.once("close", () => resolve(count)); response.once("error", () => resolve(count));
    }); request.once("error", reject);
  });
  assert.equal(destroyed, true); assert.ok(produced < size); assert.ok(received >= 4096 && received < size);
  assert.equal([...f.periods.values()].reduce((sum, period) => sum + period.reserved, 0), 0);
  assert.equal((await f.app.inject({ url: session.sourceUrl, headers })).statusCode, 401);
});

test("上传并发上限与不读取鉴权失败请求；分片仍流式，不接受适配器提前成功", async t => {
  const config = readConfig({ NODE_ENV: "test", TRANSFER_LIMIT_BYTES: "unlimited", MAX_PLAYBACK_SESSIONS: "1" });
  const f = fakeDependencies(config);
  const app = await buildApp({ config, logger: false, media: { register: createMediaModule({ ...options, maxUploadConcurrency: 1 }), dependencies: f.dependencies } });
  t.after(() => app.close());
  const uploaded = await app.inject({ method: "POST", url: "/api/uploads", headers, payload: { fileName: "v", title: "v", sizeBytes: 5, categoryId: "category" } });
  const id = uploaded.json().data.id; const bytes = Buffer.from("hello"); const hash = createHash("sha256").update(bytes).digest("hex");
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const uploadPart = f.storage.uploadPart.bind(f.storage);
  f.storage.uploadPart = async input => { assert.ok(input.stream instanceof Readable); started(); await wait; return uploadPart(input); };
  const put = () => app.inject({ method: "PUT", url: `/api/uploads/${id}/parts/1`,
    headers: { ...headers, "content-type": "application/octet-stream", "x-part-checksum": hash }, payload: bytes });
  const first = put(); await start; const denied = await put(); assert.equal(denied.statusCode, 429);
  release(); assert.equal((await first).statusCode, 200);
  const another = await app.inject({ method: "POST", url: "/api/uploads", headers, payload: { fileName: "v", title: "v", sizeBytes: 5, categoryId: "category" } });
  f.storage.uploadPart = async () => ({ etag: "fake-premature-success" });
  const premature = await app.inject({ method: "PUT", url: `/api/uploads/${another.json().data.id}/parts/1`,
    headers: { ...headers, "content-type": "application/octet-stream", "x-part-checksum": hash }, payload: bytes });
  assert.equal(premature.statusCode, 409); assert.equal(f.uploads.get(another.json().data.id)!.parts.length, 0);
});

function abortGate() {
  let begin!: () => void; let cancelled!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const aborted = new Promise<void>(resolve => { cancelled = resolve; });
  return { started, aborted, wait: async (signal: AbortSignal) => {
    begin();
    await new Promise<void>(resolve => {
      const abort = () => { cancelled(); resolve(); };
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
  } };
}

async function completedBodyDisconnect(app: Awaited<ReturnType<typeof fixture>>["app"], path: string,
  method: "PUT" | "POST", bytes: Buffer, contentType: string, gate: ReturnType<typeof abortGate>, hash?: string) {
  const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const client = httpRequest(`http://127.0.0.1:${address.port}${path}`, { method, headers: {
    ...headers, "content-type": contentType, "content-length": bytes.length, ...(hash ? { "x-part-checksum": hash } : {})
  } });
  client.on("error", () => { /* 本用例完整发送请求后主动取消等待响应。 */ });
  client.end(bytes); await gate.started; client.destroy(); await gate.aborted;
  // 等待已取消 handler 的后续 microtask，防止仅在其恢复前断言状态。
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("完整 PUT 请求体已消费、等待存储响应时客户端断开会取消上游且不登记成功分片", { timeout: 5000 }, async t => {
  const f = await fixture(); const gate = abortGate(); let raw: IncomingMessage | undefined;
  f.app.addHook("onRequest", async request => { if (request.method === "PUT") raw = request.raw; });
  const response = await f.app.inject({ method: "POST", url: "/api/uploads", headers,
    payload: { fileName: "v", title: "v", sizeBytes: 5, categoryId: "category" } });
  const id = response.json().data.id; const bytes = Buffer.from("hello"); const hash = createHash("sha256").update(bytes).digest("hex");
  f.storage.uploadPart = async input => {
    for await (const _chunk of input.stream) { /* 已完成消费所有请求字节，模拟仅等待 OSS 响应。 */ }
    assert.equal(raw?.complete, true); assert.equal(raw?.aborted, false);
    await gate.wait(input.signal); return { etag: "must-not-register-after-cancel" };
  };
  await f.app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => f.app.close());
  await completedBodyDisconnect(f.app, `/api/uploads/${id}/parts/1`, "PUT", bytes, "application/octet-stream", gate, hash);
  for (let attempt = 0; attempt < 20 && f.uploads.get(id)!.parts.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.uploads.get(id)!.parts.length, 0); assert.equal(f.uploads.get(id)!.task.status, "uploading");
});

test("完整 complete 请求等待内容分析时断开会取消探针，保留已完成对象但不登记虚假视频", { timeout: 5000 }, async t => {
  const f = await fixture(); await f.app.close(); const gate = abortGate(); let raw: IncomingMessage | undefined;
  f.app = await buildApp({ config: f.dependencies.config, logger: false, media: {
    register: createMediaModule({ ...options, metadata: { inspect: async input => {
      assert.equal(raw?.complete, true); assert.equal(raw?.aborted, false); await gate.wait(input.signal);
      return { status: "ready", playable: true, durationSeconds: 10, codec: "h264/aac", width: 1920, height: 1080 };
    } } }), dependencies: f.dependencies
  } });
  f.app.addHook("onRequest", async request => { if (request.url.endsWith("/complete")) raw = request.raw; });
  const response = await f.app.inject({ method: "POST", url: "/api/uploads", headers,
    payload: { fileName: "v", title: "v", sizeBytes: 5, categoryId: "category" } });
  const id = response.json().data.id; const bytes = Buffer.from("hello"); const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal((await f.app.inject({ method: "PUT", url: `/api/uploads/${id}/parts/1`,
    headers: { ...headers, "content-type": "application/octet-stream", "x-part-checksum": hash }, payload: bytes })).statusCode, 200);
  await f.app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => f.app.close());
  await completedBodyDisconnect(f.app, `/api/uploads/${id}/complete`, "POST", Buffer.from("{}"), "application/json", gate);
  for (let attempt = 0; attempt < 30 && f.uploads.get(id)!.task.status === "finalizing"; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.uploads.get(id)!.task.status, "failed"); assert.equal(f.uploads.get(id)!.parts.length, 1);
  assert.equal(f.videos.size, 1); assert.ok(f.storage.objects.has(f.uploads.get(id)!.object.key));
});

test("完整 preview 请求等待存储列表时断开也会取消上游", { timeout: 5000 }, async t => {
  const f = await fixture(); const gate = abortGate(); let raw: IncomingMessage | undefined;
  f.app.addHook("onRequest", async request => { if (request.url === "/api/imports/preview") raw = request.raw; });
  f.storage.list = async input => {
    assert.equal(raw?.complete, true); assert.equal(raw?.aborted, false); await gate.wait(input.signal);
    return { items: [], nextCursor: null };
  };
  await f.app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => f.app.close());
  await completedBodyDisconnect(f.app, "/api/imports/preview", "POST", Buffer.from('{"prefix":""}'), "application/json", gate);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { ERROR_DEFINITIONS, isPartChecksum } from "@online-video/shared";
import type { ApplicationUsage, ErrorResponse, HealthResponse } from "@online-video/shared";
import { buildApp } from "../src/app.js";
import { ConfigurationError, readConfig } from "../src/core/config.js";
import { HttpError } from "../src/core/errors.js";
import { startServer } from "../src/core/start.js";
import type { MediaDependencies, MediaModule } from "../src/core/contracts/index.js";
import { createTestMediaDependencies } from "./helpers/media-dependencies.js";

test("健康检查和未知路由只返回公共结构，requestId 不相信客户端输入", async t => {
  const app = await buildApp({ config: readConfig({}), logger: false });
  t.after(() => app.close());
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json<HealthResponse>(), { data: { status: "ok" } });
  assert.equal(health.headers["cache-control"], "no-store");
  const missing = await app.inject({ method: "GET", url: "/api/videos?secret=do-not-echo",
    headers: { "x-request-id": "untrusted-id" } });
  const body = missing.json<ErrorResponse>();
  assert.equal(missing.statusCode, 404);
  assert.equal(body.error.code, "NOT_FOUND");
  assert.match(body.error.requestId, /^[a-f0-9-]{36}$/);
  assert.ok(!missing.body.includes("secret"));
});

test("配置严格校验，未配置限额不能等同无限，真实服务及生产模式安全失败", () => {
  const defaults = readConfig({});
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.port, 3000);
  assert.equal(defaults.storageDriver, "mock");
  assert.deepEqual(defaults.transferPolicy, { kind: "unconfigured" });
  assert.deepEqual(readConfig({ TRANSFER_LIMIT_BYTES: "0" }).transferPolicy, { kind: "limited", limitBytes: 0 });
  assert.deepEqual(readConfig({ TRANSFER_LIMIT_BYTES: "unlimited" }).transferPolicy, { kind: "unlimited" });
  for (const env of [
    { API_PORT: "3000x" }, { API_PORT: "65536" }, { API_HOST: "" },
    { NODE_ENV: "typo" }, { PLAYBACK_MODE: "oss_direct" }, { STORAGE_DRIVER: "local" },
    { STORAGE_DRIVER: "oss" }, { NODE_ENV: "production" }, { USAGE_TIMEZONE: "bad/timezone" },
    { TRANSFER_LIMIT_BYTES: "" }, { TRANSFER_LIMIT_BYTES: "-1" },
    { TRANSFER_LIMIT_BYTES: "9007199254740992" }, { MAX_PLAYBACK_SESSIONS: "0" }
  ]) assert.throws(() => readConfig(env), ConfigurationError);
});

test("公共错误码、JSON/schema/异常响应一致，内部错误消息不向客户端泄漏", async t => {
  const app = await buildApp({ config: readConfig({}), logger: false });
  t.after(() => app.close());
  app.get<{ Params: { code: keyof typeof ERROR_DEFINITIONS } }>("/test/error/:code", async request => {
    throw new HttpError(request.params.code);
  });
  app.get("/test/internal", async () => { throw new Error("password=secret; E:/private/database.db"); });
  app.post("/test/schema", { schema: { body: {
    type: "object", required: ["count"], properties: { count: { type: "integer", minimum: 1 } }
  } } }, async () => ({ data: { success: true } }));
  for (const [code, definition] of Object.entries(ERROR_DEFINITIONS)) {
    const response = await app.inject({ method: "GET", url: `/test/error/${code}` });
    assert.equal(response.statusCode, definition.status);
    assert.equal(response.json<ErrorResponse>().error.code, code);
    assert.equal(response.json<ErrorResponse>().error.message, definition.message);
  }
  const internal = await app.inject({ method: "GET", url: "/test/internal" });
  assert.equal(internal.statusCode, 500);
  assert.ok(!internal.body.includes("password"));
  const invalid = await app.inject({ method: "POST", url: "/test/schema", payload: { count: -1 } });
  assert.equal(invalid.json<ErrorResponse>().error.code, "VALIDATION_ERROR");
  const malformed = await app.inject({ method: "POST", url: "/test/schema",
    headers: { "content-type": "application/json" }, payload: "{" });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json<ErrorResponse>().error.code, "VALIDATION_ERROR");
  const tooLarge = await app.inject({ method: "POST", url: "/test/schema",
    headers: { "content-type": "application/json" }, payload: "x".repeat(1024 * 1024 + 1) });
  assert.equal(tooLarge.statusCode, 413);
  const unsupported = await app.inject({ method: "POST", url: "/test/schema",
    headers: { "content-type": "application/octet-stream" }, payload: "part" });
  assert.equal(unsupported.statusCode, 415);
});

test("媒体注册可以独立注入测试依赖，缺鉴权/限额时拒绝注册，默认鉴权始终拒绝", async t => {
  const config = readConfig({ TRANSFER_LIMIT_BYTES: "0", MAX_PLAYBACK_SESSIONS: "1" });
  const dependencies = createTestMediaDependencies(config);
  const register: MediaModule = async (app, deps) => {
    app.get("/test/protected", async request => {
      await deps.auth.requireUser(request, { mutation: false });
      return { data: { success: true } };
    });
  };
  const app = await buildApp({ config, logger: false, media: { register, dependencies } });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: "/test/protected" })).statusCode, 401);
  const incomplete = { ...dependencies, auth: undefined } as unknown as MediaDependencies;
  await assert.rejects(buildApp({ config, logger: false, media: { register, dependencies: incomplete } }), /auth/);
  const unset = readConfig({});
  await assert.rejects(buildApp({ config: unset, logger: false,
    media: { register, dependencies: createTestMediaDependencies(unset) } }), /TRANSFER_LIMIT_BYTES/);
  await assert.rejects(buildApp({ config: { ...config, environment: "production" }, logger: false }), /生产/);
});

test("分片 checksum 使用原始字节的 SHA-256 小写 hex，拒绝错格式", () => {
  const checksum = createHash("sha256").update("abc").digest("hex");
  assert.equal(checksum, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.ok(isPartChecksum(checksum));
  assert.ok(!isPartChecksum(checksum.toUpperCase()));
  assert.ok(!isPartChecksum("sha256:" + checksum));
  assert.ok(!isPartChecksum("abc"));
  // 前端用量 Mock 必须明确 null 的含义，不能省略限额模式。
  const usage: ApplicationUsage = { periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-10-02T00:00:00.000Z", timezone: "UTC", transferredBytes: 0,
    activePlaybackSessions: 0, source: "application_proxy", limitMode: "unconfigured", limitBytes: null };
  assert.equal(usage.limitMode, "unconfigured");
});

test("监听端口占用时给出明确错误，保留原进程和端口", async t => {
  const occupied = createServer();
  t.after(() => new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())));
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(startServer(readConfig({ API_PORT: String(address.port), LOG_LEVEL: "silent" })), /已被占用/);
  assert.equal(occupied.listening, true);
});

test("日志记录状态与关联 ID，但不记录凭证、原始 URL、请求体和内部错误", async t => {
  const lines: string[] = [];
  const app = await buildApp({ config: readConfig({}), logStream: { write: line => { lines.push(line); } } });
  t.after(() => app.close());
  app.post("/test/log", async () => { throw new Error("internal-secret-marker"); });
  await app.inject({ method: "POST", url: "/test/log?token=query-secret-marker", payload: { password: "body-secret-marker" },
    headers: { cookie: "session=cookie-secret-marker", authorization: "Bearer auth-secret-marker", "x-csrf-token": "csrf-secret-marker" } });
  const output = lines.join("");
  assert.ok(output.includes("INTERNAL_ERROR"));
  assert.ok(output.includes("request completed"));
  assert.ok(!output.includes("secret-marker"));
});

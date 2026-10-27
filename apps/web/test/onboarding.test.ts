import assert from "node:assert/strict";
import test from "node:test";
import type { AuthSession, InstallationSettingsSummary } from "@online-video/shared";
import { ApiClient, ApiError } from "../src/api/client";
import { authApi, validateAuthSession } from "../src/api/auth";
import { installationApi, validateInstallationSummary, validateSetupStatus } from "../src/api/installation";
import { publicMediaUrl, validatePublicMediaPolicy } from "../src/library-data";

const summary: InstallationSettingsSummary = { version: 0, oss: null, mail: [], ossTest: null };
test("安装状态只有真实404兼容旧后端，网络/权限/损坏响应不能进入业务", async () => {
  const absent = new ApiClient(async () => Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 }));
  assert.deepEqual(await installationApi(absent).status(), { stage: "ready", authenticated: false, setupAvailable: false });
  for (const status of [403, 500, 503]) {
    const client = new ApiClient(async () => Response.json({ error: { code: "NOT_FOUND" } }, { status }));
    await assert.rejects(installationApi(client).status(), ApiError);
  }
  for (const data of [{ stage: "ready" }, { stage: "unknown", authenticated: false, setupAvailable: true }, { stage: "configuration", authenticated: true, setupAvailable: true }, { stage: "password", authenticated: false, setupAvailable: false }]) assert.throws(() => validateSetupStatus(data as never), ApiError);
  await assert.rejects(installationApi(new ApiClient(async () => { throw new Error("network"); })).status(), (error: unknown) => error instanceof ApiError && error.code === "NETWORK_ERROR");
});

test("安装登录精确豁免CSRF；改密、保存、测试与完成仍要求受限会话CSRF", async () => {
  const calls: { path: string; csrf: string | null }[] = [];
  const client = new ApiClient(async (path, init) => { calls.push({ path, csrf: new Headers(init?.headers).get("x-csrf-token") }); return Response.json({ data: { stage: "password", authenticated: true, setupAvailable: true, csrfToken: "setup-token" } }); });
  await installationApi(client).login({ password: "adminadmin", installationCode: "isolated-installation-code" });
  assert.equal(calls[0]?.csrf, null);
  for (const path of ["/api/setup/password", "/api/setup/complete", "/api/setup/login?extra=1", "/api/installation/oss", "/api/installation/mail/test"] as const) await assert.rejects(client.request(path, { method: "POST", body: {} }), (error: unknown) => error instanceof ApiError && error.code === "CSRF_REJECTED");
  assert.equal(calls.length, 1); client.setSession("setup-token");
  await installationApi(client).password({ newPassword: "isolated-password-123", confirmPassword: "isolated-password-123" });
  assert.equal(calls[1]?.csrf, "setup-token");
});

test("纯密码会话与登录已支持，不放宽邮箱模式的已验证邮箱约束", async () => {
  const session: AuthSession = { user: { id: "owner", displayName: "管理员", authMethod: "password", authVersion: 1, totpEnabled: false, emailMasked: null, emailVerified: false }, csrfToken: "csrf" };
  assert.deepEqual(validateAuthSession(session), session);
  let body: unknown;
  const client = new ApiClient(async (_path, init) => { body = JSON.parse(String(init?.body)); return Response.json({ data: session }); });
  await authApi(client).login({ authMethod: "password", password: "new-password-123" });
  assert.deepEqual(body, { authMethod: "password", password: "new-password-123" });
  assert.throws(() => validateAuthSession({ ...session, user: { ...session.user, authMethod: "email" } }), ApiError);
});

test("安装摘要拒绝秘密回传、重复服务和畸形版本；测试结果不冒充完整上传或邮件送达", async () => {
  assert.deepEqual(validateInstallationSummary(summary), summary);
  const oss = { accessKeyIdMasked: "LTAI***test", secretConfigured: true, bucket: "test-bucket", region: "cn-hangzhou", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", network: "public" as const, allowPublicNetwork: true, mediaBaseUrl: "https://media.example.test", objectPrefix: "onlineVideo/", credentialMode: "direct" as const };
  assert.throws(() => validateInstallationSummary({ ...summary, version: -1 }), ApiError);
  assert.throws(() => validateInstallationSummary({ ...summary, oss: { ...oss, accessKeySecret: "must-not-return" } } as never), ApiError);
  const mail = { providerCode: "qq" as const, host: "smtp.qq.com", port: 465, secure: true, user: "owner@qq.com", from: "owner@qq.com", timeoutMs: 15000, passwordConfigured: true, testedAt: null };
  assert.throws(() => validateInstallationSummary({ ...summary, mail: [mail, mail] }), ApiError);
  assert.throws(() => validateInstallationSummary({ ...summary, mail: [{ ...mail, password: "must-not-return" }] } as never), ApiError);
  const client = new ApiClient(async () => Response.json({ data: { accepted: true, testedAt: new Date().toISOString(), toMasked: "o***@qq.com", delivery: "inbox-delivered" } })); client.setSession("csrf");
  await assert.rejects(installationApi(client).testMail({ version: 0, providerCode: "qq", to: "owner@qq.com" }), ApiError);
});

test("保存OSS与SMTP只提交明确字段，敏感错误正文不向页面回显", async () => {
  const sent: unknown[] = [];
  const client = new ApiClient(async (_path, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json({ data: summary }); }); client.setSession("csrf");
  const body = { version: 0, bucket: "test-bucket", region: "cn-hangzhou", network: "public" as const, allowPublicNetwork: true, mediaBaseUrl: "https://media.example.test", objectPrefix: "onlineVideo/" };
  await installationApi(client).saveOss(body); assert.deepEqual(sent[0], body); assert.equal(Object.hasOwn(sent[0] as object, "accessKeySecret"), false);
  const failure = new ApiClient(async () => Response.json({ error: { code: "MAIL_SEND_FAILED", message: "SECRET SMTP RAW ERROR" } }, { status: 503 })); failure.setSession("csrf");
  await assert.rejects(installationApi(failure).testMail({ version: 0, providerCode: "qq", to: "owner@qq.com" }), (error: unknown) => error instanceof ApiError && !error.message.includes("SECRET"));
});

test("完成安装必须POST空对象并重新读取ready，动态媒体严格绑定服务端配置而非任意HTTPS", async () => {
  const calls: { path: string; body?: BodyInit | null }[] = [];
  const client = new ApiClient(async (path, init) => { calls.push({ path, ...(init?.body ? { body: init.body } : {}) }); return Response.json({ data: path.endsWith("complete") ? { success: true } : { stage: "ready", setupAvailable: true, authenticated: false } }); });
  client.setSession("setup-csrf"); assert.equal((await installationApi(client).complete()).stage, "ready");
  assert.deepEqual(calls, [{ path: "/api/setup/complete", body: "{}" }, { path: "/api/setup/status" }]);
  const policy = { mediaBaseUrl: "https://media.example.com", objectPrefix: "demo-videos/" };
  assert.equal(publicMediaUrl("https://media.example.com/demo-videos/video.mp4", policy), "https://media.example.com/demo-videos/video.mp4");
  for (const value of ["https://evil.example.com/demo-videos/video.mp4", "https://media.example.com/private/video.mp4", "https://media.example.com/demo-videos/%2e%2e/video.mp4", "https://media.example.com/demo-videos/video.mp4?token=x", "https://media.example.com/demo-videos/video.mp4#x", "https://media.example.com.evil/demo-videos/video.mp4"]) assert.throws(() => publicMediaUrl(value, policy), ApiError);
  assert.throws(() => publicMediaUrl("https://media.example.com/demo-videos/video.mp4", undefined), ApiError);
  assert.throws(() => validatePublicMediaPolicy({ ...policy, mediaBaseUrl: "http://media.example.com" }), ApiError);
});

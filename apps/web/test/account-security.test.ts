import assert from "node:assert/strict";
import test from "node:test";
import { findEmailProvider, isEmailProviderList, normalizeEmailAddress, SUPPORTED_EMAIL_PROVIDERS } from "@online-video/shared";
import type { AuthSession, EmailChallenge } from "@online-video/shared";
import { ApiClient, ApiError } from "../src/api/client";
import { authApi, validateAuthSession, validateEmailChallenge } from "../src/api/auth";

const challenge: EmailChallenge = { challengeId: "isolated-challenge", operationId: null, maskedEmail: "o***@example.invalid", serverTime: "2026-10-04T10:00:00.000Z", expiresAt: "2026-10-04T10:05:00.000Z", resendAt: "2026-10-04T10:01:00.000Z" };
const session: AuthSession = { user: { id: "isolated-owner", displayName: "隔离账号", totpEnabled: true, authMethod: "email", authVersion: 2, emailMasked: "o***@example.invalid", emailVerified: true }, csrfToken: "isolated-csrf" };

test("未登录发码只精确豁免 /api/auth/login/code，不能放开整个 auth 命名空间", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const client = new ApiClient(async (path, init) => { calls.push({ path, ...(init ? { init } : {}) }); return Response.json({ data: challenge }); });
  await authApi(client).loginCode({ password: "isolated-password" });
  assert.equal(calls[0]?.path, "/api/auth/login/code"); assert.equal(calls[0]?.init?.credentials, "same-origin"); assert.equal(new Headers(calls[0]?.init?.headers).has("x-csrf-token"), false);
  for (const path of ["/api/auth/password/code", "/api/auth/email/bind/code", "/api/auth/operations/cancel", "/api/auth/login/code/extra", "/api/auth/login/code?bypass=true"] as const) {
    await assert.rejects(client.request(path, { method: "POST", body: {} }), (error: unknown) => error instanceof ApiError && error.code === "CSRF_REJECTED");
  }
  assert.equal(calls.length, 1);
});

test("改密码/验证码表单错误保持 CSRF 与登录态，真正会话失效和异常 401 保留安全退出", async () => {
  for (const code of ["SECONDARY_AUTH_FAILED", "EMAIL_CODE_INVALID", "EMAIL_CHALLENGE_EXPIRED", "EMAIL_CODE_ATTEMPTS_EXCEEDED", "PASSWORD_POLICY_FAILED", "ACCOUNT_OPERATION_INVALID"] as const) {
    let exited = 0; let csrf = "";
    const client = new ApiClient(async (_path, init) => { csrf = new Headers(init?.headers).get("x-csrf-token") ?? ""; return Response.json({ error: { code, message: "private detail" } }, { status: 400 }); });
    client.setSession("persisted-csrf"); client.onUnauthorized(() => exited++);
    await assert.rejects(client.request("/api/auth/password/confirm", { method: "POST", body: {} }), (error: unknown) => error instanceof ApiError && error.code === code);
    await assert.rejects(client.request("/api/auth/password/code", { method: "POST", body: {} }), ApiError);
    assert.equal(exited, 0); assert.equal(csrf, "persisted-csrf");
  }
  for (const response of [Response.json({ error: { code: "AUTH_REQUIRED" } }, { status: 401 }), Response.json({ error: { code: "SESSION_EXPIRED" } }, { status: 401 }), new Response("invalid", { status: 401 }), Response.json({ error: { code: "unknown" } }, { status: 401 })]) {
    let exited = 0; const client = new ApiClient(async () => response.clone()); client.setSession("csrf"); client.onUnauthorized(() => exited++);
    await assert.rejects(client.request("/api/auth/me"), ApiError); assert.equal(exited, 1);
    await assert.rejects(client.request("/api/auth/password/code", { method: "POST", body: {} }), (error: unknown) => error instanceof ApiError && error.code === "CSRF_REJECTED");
  }
});

test("邮箱登录请求、账号安全 API 与成功通知失败结果完整传递，所有安全操作携带 CSRF", async () => {
  const calls: { path: string; body: unknown; csrf: string | null }[] = [];
  const client = new ApiClient(async (path, init) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null, csrf: new Headers(init?.headers).get("x-csrf-token") });
    const data = path === "/api/auth/login" ? session : path.endsWith("/confirm") ? { success: true, reloginRequired: true, notificationStatus: "failed" } : path.endsWith("/code") ? { ...challenge, operationId: "isolated-operation" } : { success: true };
    return Response.json({ data });
  });
  const api = authApi(client); const login = { authMethod: "email" as const, password: "test-password", challengeId: challenge.challengeId, code: "123456" };
  assert.deepEqual(await api.login(login), session); assert.deepEqual(calls[0]?.body, login);
  client.setSession(session.csrfToken); await api.passwordCode({ currentPassword: "current-password" });
  const result = await api.passwordConfirm({ currentPassword: "current-password", newPassword: "long-new-password", confirmPassword: "long-new-password", operationId: "isolated-operation", challengeId: challenge.challengeId, code: "123456" });
  assert.equal(result.success, true); assert.equal(result.notificationStatus, "failed"); assert.equal(calls[1]?.csrf, session.csrfToken); assert.equal(calls[2]?.csrf, session.csrfToken);
  await api.cancelOperation({ operationId: "isolated-operation" }); assert.equal(calls[3]?.path, "/api/auth/operations/cancel");
});

test("损坏的认证方式、邮箱状态、版本或挑战时间不能被当作有效响应", () => {
  assert.deepEqual(validateAuthSession(session), session); assert.deepEqual(validateEmailChallenge(challenge), challenge);
  for (const user of [{ ...session.user, authMethod: "unsupported" }, { ...session.user, authVersion: 0 }, { ...session.user, emailVerified: false }, { ...session.user, emailMasked: null }]) assert.throws(() => validateAuthSession({ ...session, user } as AuthSession), ApiError);
  for (const value of [{ ...challenge, challengeId: "" }, { ...challenge, operationId: "" }, { ...challenge, expiresAt: challenge.serverTime }, { ...challenge, resendAt: "invalid" }]) assert.throws(() => validateEmailChallenge(value), ApiError);
});

test("邮箱类型校验只接受完整QQ/163域名，前后端归一化一致，未知/重复码表拒绝", async () => {
  assert.equal(normalizeEmailAddress(" Owner@QQ.COM "), "owner@qq.com"); assert.equal(findEmailProvider(" Owner@QQ.COM ")?.code, "qq");
  assert.equal(findEmailProvider("owner@163.com")?.code, "163");
  for (const email of ["owner@qq.com.evil", "owner@vip.qq.com", "owner@126.com", "owner@gmail.com", "a..b@qq.com", "owner@@163.com"]) assert.equal(findEmailProvider(email), undefined);
  assert.equal(findEmailProvider("owner@qq.com", SUPPORTED_EMAIL_PROVIDERS.filter(provider => provider.code === "163")), undefined);
  assert.equal(isEmailProviderList([...SUPPORTED_EMAIL_PROVIDERS]), true); assert.equal(isEmailProviderList([]), true);
  for (const emailProviders of [undefined, [{ code: "gmail", name: "其他邮箱", domain: "gmail.com" }], [{ code: "qq", name: "QQ", domain: "qq.com.evil" }], [SUPPORTED_EMAIL_PROVIDERS[0], SUPPORTED_EMAIL_PROVIDERS[0]]]) {
    assert.equal(isEmailProviderList(emailProviders), false);
    const client = new ApiClient(async () => Response.json({ data: { authMethod: "totp", serverTime: "2026-10-04T10:00:00.000Z", emailProviders } }));
    await assert.rejects(authApi(client).options(), (error: unknown) => error instanceof ApiError && error.code === "INVALID_RESPONSE");
  }
});

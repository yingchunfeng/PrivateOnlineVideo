import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import type { InstallationSettingsSummary, SetupStatus } from "@online-video/shared";
import { SUPPORTED_EMAIL_PROVIDERS } from "@online-video/shared";

test("首次安装网页：独立API替身验证安装门禁、密码登录、配置测试与邮箱开关，不访问真实云或邮件", async t => {
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), mode: "test", plugins: [react()], server: { host: "127.0.0.1", port: 0, strictPort: true } });
  t.after(() => vite.close()); await vite.listen();
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  await context.addInitScript("window.__name = (fn) => fn;");
  let status: SetupStatus = { stage: "password", authenticated: false, setupAvailable: true };
  let summary: InstallationSettingsSummary = { version: 0, oss: null, mail: [], ossTest: null };
  let failStatus = true; let loggedIn = false; let verification = false;
  const requests: { path: string; body: Record<string, unknown>; csrf?: string }[] = [];
  const earlyBusiness: string[] = []; const errors: string[] = [];
  const password = "new-installation-password-123";
  const user = () => ({ id: "isolated-owner", displayName: "管理员", totpEnabled: false, authMethod: verification ? "email" : "password", authVersion: verification ? 2 : 1, emailMasked: verification ? "o***@qq.com" : null, emailVerified: verification });
  const challenge = () => ({ challengeId: "isolated-toggle-challenge", operationId: null, maskedEmail: "o***@qq.com", serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), resendAt: new Date(Date.now() + 60000).toISOString() });
  await context.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(); const path = new URL(request.url()).pathname; const method = request.method();
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    const csrf = request.headers()["x-csrf-token"]; requests.push({ path, body, ...(csrf ? { csrf } : {}) });
    const ok = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
    const error = (code: string, responseStatus = 400) => route.fulfill({ status: responseStatus, contentType: "application/json", body: JSON.stringify({ error: { code, message: "untrusted raw text" } }) });
    if (path === "/api/setup/status") return failStatus ? error("SERVICE_NOT_CONFIGURED", 503) : ok(status);
    if (path === "/api/setup/login") {
      assert.equal(body.password, "adminadmin"); assert.equal(body.installationCode, "isolated-install-code"); assert.equal(csrf, undefined);
      status = { ...status, authenticated: true, csrfToken: "setup-csrf-one" }; return ok(status);
    }
    if (path === "/api/setup/password") {
      assert.equal(csrf, "setup-csrf-one"); assert.equal(body.newPassword, password); assert.equal(body.confirmPassword, password);
      status = { ...status, stage: "configuration", csrfToken: "setup-csrf-two" }; return ok(status);
    }
    if (path === "/api/installation/settings") return ok(summary);
    if (path === "/api/installation/oss") {
      assert.equal(csrf, "setup-csrf-two"); assert.equal(body.accessKeySecret, "isolated-oss-secret");
      summary = { ...summary, version: summary.version + 1, oss: { accessKeyIdMasked: "LTAI***test", secretConfigured: true, bucket: String(body.bucket), region: String(body.region), endpoint: "https://oss-cn-hangzhou.aliyuncs.com", network: "public", allowPublicNetwork: true, mediaBaseUrl: String(body.mediaBaseUrl), objectPrefix: String(body.objectPrefix), credentialMode: "direct" } }; return ok(summary);
    }
    if (path === "/api/installation/mail") {
      assert.equal(csrf, "setup-csrf-two"); assert.equal(body.password, "isolated-smtp-secret");
      summary = { ...summary, version: summary.version + 1, mail: [{ providerCode: "qq", host: "smtp.qq.com", port: 465, secure: true, user: "owner@qq.com", from: "owner@qq.com", timeoutMs: 15000, passwordConfigured: true, testedAt: null }] }; return ok(summary);
    }
    if (path === "/api/installation/mail/test") {
      assert.equal(body.version, summary.version); assert.equal(body.to, "owner@qq.com"); const testedAt = new Date().toISOString();
      summary = { ...summary, mail: summary.mail.map(mail => ({ ...mail, testedAt })) }; return ok({ accepted: true, testedAt, toMasked: "o***@qq.com", delivery: "smtp-accepted" });
    }
    if (path === "/api/installation/oss/test") {
      const checkedAt = new Date().toISOString(); summary = { ...summary, ossTest: { checkedAt, scope: "list-prefix" } };
      return ok({ checkedAt, scope: "list-prefix", writePermissionVerified: false });
    }
    if (path === "/api/setup/complete") {
      assert.equal(csrf, "setup-csrf-two"); status = { stage: "ready", authenticated: false, setupAvailable: true }; return ok({ success: true });
    }
    if (status.stage !== "ready") earlyBusiness.push(path);
    if (path === "/api/auth/me") return loggedIn ? ok({ user: user(), csrfToken: "normal-csrf" }) : error("AUTH_REQUIRED", 401);
    if (path === "/api/auth/login/options") return ok({ authMethod: verification ? "email" : "password", serverTime: new Date().toISOString(), emailProviders: SUPPORTED_EMAIL_PROVIDERS });
    if (path === "/api/auth/login") { assert.equal(body.password, password); assert.equal(body.authMethod, "password"); assert.equal(Object.hasOwn(body, "totp"), false); loggedIn = true; return ok({ user: user(), csrfToken: "normal-csrf" }); }
    if (path === "/api/auth/security") return ok({ authMethod: verification ? "email" : "password", authVersion: verification ? 2 : 1, email: verification ? "owner@qq.com" : null, emailVerified: verification, emailVerifiedAt: verification ? new Date().toISOString() : null, totpAvailable: false, serverTime: new Date().toISOString(), emailProviders: SUPPORTED_EMAIL_PROVIDERS });
    if (path === "/api/auth/email-verification/code") { assert.equal(csrf, "normal-csrf"); assert.equal(body.enabled, true); assert.equal(body.email, "owner@qq.com"); return ok(challenge()); }
    if (path === "/api/auth/email-verification/confirm") { assert.equal(csrf, "normal-csrf"); assert.equal(body.code, "123456"); verification = true; loggedIn = false; return ok({ success: true, reloginRequired: true, notificationStatus: "not_required" }); }
    if (path === "/api/library") return ok({ mediaBaseUrl: "https://media.example.test", objectPrefix: "onlineVideo/", categories: [] });
    if (path === "/api/videos") return ok({ items: [], page: 1, pageSize: 24, total: 0 });
    if (path === "/api/categories" || path === "/api/tags" || path === "/api/groups") return ok([]);
    if (method === "GET") return error("NOT_FOUND", 404);
    throw new Error(`unexpected request: ${path}`);
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on("pageerror", error => errors.push(error.message));
  const evidence = resolve(fileURLToPath(new URL("../../..", import.meta.url)), ".local/acceptance", `onboarding-ui-${randomUUID()}`); await mkdir(evidence, { recursive: true });
  console.log(`Isolated UI evidence (not real OSS/SMTP): ${evidence}`);

  await t.test("安装状态失败保持封锁，重试后深链接进入安装而非上传", async () => {
    await page.goto(`${origin}/upload`); await expect(page.getByRole("heading", { name: "检查安装状态" })).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0); assert.equal(requests.some(item => item.path === "/api/auth/me"), false);
    failStatus = false; await page.getByRole("button", { name: "重新加载" }).click(); await expect(page).toHaveURL(`${origin}/setup`);
    await expect(page.getByRole("heading", { name: "验证首次安装身份" })).toBeVisible(); await expect(page.getByRole("navigation")).toHaveCount(0);
  });
  await t.test("安装码登录、强制改密、秘密配置和真实动作按钮分离", async () => {
    await page.getByLabel("初始密码", { exact: true }).fill("adminadmin"); await page.getByLabel("一次性安装码").fill("isolated-install-code"); await page.getByRole("button", { name: "继续设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "必须修改初始密码" })).toBeVisible(); await page.getByLabel("新密码", { exact: true }).fill(password); await page.getByLabel("确认新密码").fill(password); await page.getByRole("button", { name: "保存新密码并继续" }).click();
    await expect(page.getByRole("region", { name: "OSS 配置" })).toBeVisible(); await expect(page.getByRole("button", { name: "完成设置，前往登录" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "发送测试邮件", exact: true })).toBeDisabled();
    await page.getByLabel(/^AccessKeyId/).fill("LTAI-isolated-test"); await page.getByLabel(/^AccessKeySecret/).fill("isolated-oss-secret"); await page.getByLabel("Bucket 名称").fill("isolated-bucket"); await page.getByLabel("媒体 HTTPS 地址").fill("https://media.example.test"); await page.getByRole("checkbox").check(); await page.getByRole("button", { name: "保存 OSS 配置", exact: true }).click();
    await expect(page.getByLabel(/^AccessKeySecret/)).toHaveValue(""); await expect(page.getByLabel(/^AccessKeyId/)).toHaveValue("");
    await page.getByLabel("发信账号", { exact: true }).fill("owner@qq.com"); await page.getByLabel("SMTP 授权码").fill("isolated-smtp-secret"); await page.getByRole("button", { name: "保存邮件配置", exact: true }).click();
    await expect(page.getByLabel("SMTP 授权码")).toHaveValue(""); await page.getByLabel("测试收件邮箱").fill("owner@qq.com"); await page.getByRole("button", { name: "发送测试邮件", exact: true }).click(); await expect(page.getByRole("status")).toContainText("SMTP 已接受");
    await page.getByRole("button", { name: "测试 OSS 只读连通性", exact: true }).click(); await expect(page.getByRole("status")).toContainText("不能证明上传权限");
    assert.equal(earlyBusiness.length, 0); await expect(page.getByRole("navigation")).toHaveCount(0);
    const stored = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
    for (const secret of [password, "isolated-install-code", "isolated-oss-secret", "isolated-smtp-secret"]) assert.equal(stored.includes(secret), false);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: resolve(evidence, "phone-configuration.png"), fullPage: true });
  });
  await t.test("完成后纯密码登录，再通过独立验证码开启邮箱验证", async () => {
    await page.getByRole("button", { name: "完成设置，前往登录", exact: true }).click(); await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible();
    await expect(page.getByLabel(/^动态验证码/)).toHaveCount(0); await page.getByLabel("密码", { exact: true }).fill(password); await page.getByRole("button", { name: "进入视频库", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "主要导航" })).toBeVisible(); await page.goto(`${origin}/settings`);
    const form = page.getByRole("region", { name: "登录邮箱验证", exact: true }); await expect(form).toBeVisible(); await form.getByLabel("当前密码").fill(password); await form.getByLabel("接收登录验证码的邮箱").fill("owner@qq.com"); await form.getByRole("button", { name: "发送开启验证的验证码" }).click();
    await form.getByLabel("设置确认验证码", { exact: true }).fill("123456"); await page.screenshot({ path: resolve(evidence, "phone-email-verification.png"), fullPage: true });
    await form.getByRole("button", { name: "确认开启邮箱验证" }).click(); await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "发送验证码", exact: true })).toBeVisible();
    assert.equal(verification, true); assert.deepEqual(errors, []);
  });
});

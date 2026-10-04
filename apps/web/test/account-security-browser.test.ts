import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { buildApp } from "../../api/src/app";
import { readConfig } from "../../api/src/core/config";
import { openDatabase, WORKSPACE_ROOT } from "../../api/src/db/database";
import { AuthService, initializeAccount } from "../../api/src/modules/auth/service";
import { readAuthSettings } from "../../api/src/modules/auth/settings";
import { totp } from "../../api/src/modules/auth/crypto";
import { FakeMailSender } from "../../api/test/helpers/account-email-fixture";

test("账号手机浏览器：真实 SQLite/HTTP/Cookie/CSRF + Fake 邮件，绑定→登录→密码→邮箱→受保护恢复", async t => {
  const database = openDatabase(":memory:", { initialize: true }); const key = randomBytes(32);
  const credentials = await initializeAccount(database, key, "账号隔离浏览器");
  let offset = 0; const now = () => new Date(Date.now() + offset); const advance = (ms = 60_001) => { offset += ms; };
  const sender = new FakeMailSender(); const settings = readAuthSettings("test", { AUTH_MAX_FAILURES: "100" });
  const auth = new AuthService(database, key, settings, now, sender); const config = readConfig({ NODE_ENV: "test" });
  const app = await buildApp({ config, logger: false, auth, backend: { database, auth, config, now } });
  t.after(async () => { await app.close(); database.close(); }); await app.listen({ host: "127.0.0.1", port: 0 });
  const apiOrigin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  // 独立 Vite 配置避免加载用户实际 .env、正式服务或开发 Mock。
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), mode: "test", plugins: [react()], server: { host: "127.0.0.1", port: 0, strictPort: true, proxy: { "/api": { target: apiOrigin } } } });
  t.after(() => vite.close()); await vite.listen(); const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`; settings.allowedOrigins.splice(0, settings.allowedOrigins.length, origin);
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  await context.addInitScript("window.__name = (fn) => fn;"); const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const evidence = resolve(WORKSPACE_ROOT, ".local/acceptance", `account-security-${randomUUID()}`); await mkdir(evidence, { recursive: true });
  console.log(`Account real HTTP + Fake mail browser evidence: ${evidence}`);
  const statuses: { path: string; status: number }[] = []; const failures: string[] = [];
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/auth/")) statuses.push({ path, status: response.status() }); });
  page.on("pageerror", error => failures.push(error.message));
  let currentPassword = credentials.password; let currentSecret = credentials.totpSecret;
  const token = () => totp(currentSecret).generate({ timestamp: now().getTime() });
  const user = () => database.client.prepare("SELECT * FROM users").get() as { auth_method: string; auth_version: number; email: string | null; email_verified_at: string | null };
  const phoneCheck = async (name: string) => {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(geometry.document <= geometry.viewport && geometry.body <= geometry.viewport, `${name} 手机横向溢出：${JSON.stringify(geometry)}`);
    await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
  };
  const noCredentialsStored = async () => {
    const stored = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
    for (const value of [credentials.password, currentPassword, currentSecret, ...sender.messages.filter(message => message.kind === "verification").flatMap(message => message.kind === "verification" ? [message.challengeId, message.code] : [])]) assert.equal(stored.includes(value), false, "凭据或挑战不得写浏览器持久存储");
  };
  const security = async () => { await page.goto(`${origin}/security`); await expect(page.getByRole("heading", { name: "账户安全", exact: true })).toBeVisible(); await expect(page.getByRole("region", { name: "账号安全摘要" })).toBeVisible(); };
  const loginTotp = async () => {
    await page.getByLabel("密码", { exact: true }).fill(currentPassword); await page.getByLabel(/^动态验证码/).fill(token()); await page.getByRole("button", { name: "进入视频库", exact: true }).click(); await expect(page.getByRole("navigation", { name: "主要导航" })).toBeVisible();
  };
  const loginEmail = async () => {
    advance(); await page.getByLabel("密码", { exact: true }).fill(currentPassword); await page.getByRole("button", { name: "发送验证码", exact: true }).click(); await expect(page.getByLabel("邮箱验证码", { exact: true })).toBeVisible();
    await page.getByLabel("邮箱验证码", { exact: true }).fill(sender.latest("login").code); await page.getByRole("button", { name: "进入视频库", exact: true }).click(); await expect(page.getByRole("navigation", { name: "主要导航" })).toBeVisible();
  };

  await t.test("旧账号 TOTP 登录与首次绑定；Cookie保护、当前密码验证、成功后转邮箱登录", async () => {
    await page.goto(origin); await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible(); await loginTotp();
    const cookie = (await context.cookies()).find(cookie => cookie.name === "ov_session"); assert.ok(cookie?.httpOnly); assert.equal(cookie?.sameSite, "Strict");
    await security(); const bind = page.getByRole("region", { name: "绑定邮箱", exact: true }); advance(30_001);
    await expect(bind.getByText("支持 QQ 邮箱（@qq.com） 和 163 邮箱（@163.com）。", { exact: true })).toBeVisible();
    await bind.getByLabel("当前密码", { exact: true }).fill(currentPassword); await bind.getByLabel(/^当前 TOTP 验证码/).fill(token());
    await bind.getByLabel("绑定邮箱", { exact: true }).fill("owner@qq.com.evil");
    await expect(bind.getByRole("button", { name: "发送绑定验证码", exact: true })).toBeDisabled(); assert.equal(sender.messages.length, 0);
    await bind.getByLabel("当前密码", { exact: true }).fill("wrong-password"); await bind.getByLabel(/^当前 TOTP 验证码/).fill(token()); await bind.getByLabel("绑定邮箱", { exact: true }).fill("owner@qq.com");
    await bind.getByRole("button", { name: "发送绑定验证码", exact: true }).click(); await expect(bind.getByRole("alert")).toBeVisible(); assert.equal(sender.messages.length, 0); assert.equal(user().auth_method, "totp");
    await bind.getByLabel("当前密码", { exact: true }).fill(currentPassword); await bind.getByRole("button", { name: "发送绑定验证码", exact: true }).click(); await expect(bind.getByLabel("绑定邮箱验证码", { exact: true })).toBeVisible();
    await expect(bind.getByRole("button", { name: /秒后可重发/ })).toBeDisabled(); assert.equal(user().email, null); await phoneCheck("phone-first-bind");
    await bind.getByLabel("绑定邮箱验证码", { exact: true }).fill(sender.latest("bind_email").code); await noCredentialsStored(); await bind.getByRole("button", { name: "验证并绑定邮箱", exact: true }).click();
    await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible(); await expect(page.getByRole("status").filter({ hasText: "邮箱验证成功" }).first()).toBeVisible();
    assert.equal(user().auth_method, "email"); assert.equal(user().auth_version, 2); assert.equal((await context.cookies()).some(cookie => cookie.name === "ov_session"), false);
  });

  await t.test("邮箱登录先验证密码再发码，未登录 API 精确豁免，冷却清楚且不新增邮箱输入", async () => {
    await expect(page.getByLabel(/^动态验证码/)).toHaveCount(0); assert.equal(await page.locator('input[type="email"]').count(), 0);
    const before = sender.messages.length; await page.getByLabel("密码", { exact: true }).fill("wrong-password"); await page.getByRole("button", { name: "发送验证码", exact: true }).click(); await expect(page.getByRole("alert").first()).toBeVisible(); assert.equal(sender.messages.length, before);
    await page.getByLabel("密码", { exact: true }).fill(currentPassword); await page.getByRole("button", { name: "发送验证码", exact: true }).click(); await expect(page.getByLabel("邮箱验证码", { exact: true })).toBeVisible();
    await expect(page.getByText("验证码已发送至 o***@qq.com", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: /秒后可重发/ })).toBeDisabled(); await phoneCheck("phone-email-login");
    await page.getByLabel("邮箱验证码", { exact: true }).fill(sender.latest("login").code); await noCredentialsStored(); await page.getByRole("button", { name: "进入视频库", exact: true }).click(); await expect(page.getByRole("navigation", { name: "主要导航" })).toBeVisible();
    await page.reload(); await expect(page.getByRole("navigation", { name: "主要导航" })).toBeVisible();
  });

  await t.test("改密码输错凭据保持安全页，通知失败仍成功且清会话；新密码可邮箱登录", async () => {
    await security(); const form = page.getByRole("region", { name: "修改密码", exact: true });
    await form.getByLabel("当前密码", { exact: true }).fill("wrong-password"); await form.getByRole("button", { name: "发送密码验证码", exact: true }).click(); await expect(form.getByRole("alert")).toBeVisible(); assert.ok(page.url().endsWith("/security"));
    await form.getByLabel("当前密码", { exact: true }).fill(currentPassword); await form.getByRole("button", { name: "发送密码验证码", exact: true }).click(); await expect(form.getByLabel("绑定邮箱验证码", { exact: true })).toBeVisible();
    await form.getByLabel(/^新密码/).fill("browser-updated-password-123"); await form.getByLabel("确认新密码", { exact: true }).fill("browser-updated-password-123");
    await form.getByLabel("绑定邮箱验证码", { exact: true }).fill(sender.latest("change_password").code); await form.getByLabel("当前密码", { exact: true }).fill("wrong-password"); await form.getByRole("button", { name: "确认修改密码", exact: true }).click(); await expect(form.getByRole("alert")).toBeVisible(); assert.ok(page.url().endsWith("/security"));
    await phoneCheck("phone-password-error"); await form.getByLabel("当前密码", { exact: true }).fill(currentPassword); sender.failNotification = true; await form.getByRole("button", { name: "确认修改密码", exact: true }).click();
    await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible(); await expect(page.getByRole("status").filter({ hasText: "安全通知未能发送，账号修改已完成" }).first()).toBeVisible();
    assert.equal(user().auth_version, 3); assert.equal((await context.cookies()).some(cookie => cookie.name === "ov_session"), false); currentPassword = "browser-updated-password-123"; sender.failNotification = false; await loginEmail();
  });

  await t.test("改邮箱目标锁定与取消；新邮箱发送失败保留旧绑定，完成双验证后仅新邮箱收码", async () => {
    await security(); const form = page.getByRole("region", { name: "修改邮箱", exact: true });
    await expect(form.getByText("支持 QQ 邮箱（@qq.com） 和 163 邮箱（@163.com）。", { exact: true })).toBeVisible();
    await form.getByLabel("当前密码", { exact: true }).fill(currentPassword); await form.getByLabel(/^新邮箱/).fill("owner@126.com");
    await expect(form.getByRole("button", { name: "发送旧邮箱验证码", exact: true })).toBeDisabled();
    await form.getByLabel("当前密码", { exact: true }).fill(currentPassword); await form.getByLabel(/^新邮箱/).fill("cancelled@163.com"); await form.getByRole("button", { name: "发送旧邮箱验证码", exact: true }).click(); await expect(form.getByLabel("旧邮箱验证码", { exact: true })).toBeVisible(); await expect(form.getByLabel(/^新邮箱/)).toBeDisabled();
    await form.getByLabel("旧邮箱验证码", { exact: true }).fill(sender.latest("change_email_old").code); await form.getByRole("button", { name: "验证旧邮箱并继续", exact: true }).click(); await expect(form.getByRole("button", { name: "发送新邮箱验证码", exact: true })).toBeVisible(); await form.getByRole("button", { name: "取消修改邮箱", exact: true }).click(); await expect(form.getByLabel(/^新邮箱/)).toBeEnabled(); assert.equal(user().email, "owner@qq.com");
    advance(); await form.getByLabel("当前密码", { exact: true }).fill(currentPassword); await form.getByLabel(/^新邮箱/).fill("next@163.com"); await form.getByRole("button", { name: "发送旧邮箱验证码", exact: true }).click(); await expect(form.getByLabel("旧邮箱验证码", { exact: true })).toBeVisible();
    await form.getByLabel("旧邮箱验证码", { exact: true }).fill(sender.latest("change_email_old").code); await form.getByRole("button", { name: "验证旧邮箱并继续", exact: true }).click(); await expect(form.getByRole("button", { name: "发送新邮箱验证码", exact: true })).toBeVisible();
    sender.failVerification = true; await form.getByRole("button", { name: "发送新邮箱验证码", exact: true }).click(); await expect(form.getByRole("alert")).toBeVisible(); assert.equal(user().email, "owner@qq.com"); sender.failVerification = false; advance();
    await form.getByRole("button", { name: "发送新邮箱验证码", exact: true }).click(); await expect(form.getByLabel("新邮箱验证码", { exact: true })).toBeVisible(); assert.equal(sender.latest("change_email_new").to, "next@163.com"); await phoneCheck("phone-email-change");
    await form.getByLabel("新邮箱验证码", { exact: true }).fill(sender.latest("change_email_new").code); await noCredentialsStored(); await form.getByRole("button", { name: "确认修改邮箱", exact: true }).click(); await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible();
    assert.equal(user().email, "next@163.com"); assert.equal(user().auth_version, 4); assert.equal([...sender.messages].reverse().find(message => message.kind === "notification")?.to, "owner@qq.com"); await loginEmail(); assert.equal(sender.latest("login").to, "next@163.com");
  });

  await t.test("真实会话撤销退出；本地恢复保留待验证邮箱，使用新 TOTP 登录并重新验证邮箱", async () => {
    const recovery = await auth.recover(currentPassword, credentials.recoveryCodes[0]!); currentSecret = recovery.totpSecret;
    assert.equal(user().auth_method, "totp"); assert.equal(user().email, "next@163.com"); assert.equal(user().email_verified_at, null); await page.reload(); await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible();
    await loginTotp(); await security(); await expect(page.getByRole("heading", { name: "重新验证邮箱", exact: true })).toBeVisible(); const form = page.getByRole("region", { name: "绑定邮箱", exact: true }); advance(30_001);
    await form.getByLabel("当前密码", { exact: true }).fill(currentPassword); await form.getByLabel(/^当前 TOTP 验证码/).fill(token()); await form.getByRole("button", { name: "发送绑定验证码", exact: true }).click(); await expect(form.getByLabel("绑定邮箱验证码", { exact: true })).toBeVisible();
    await form.getByLabel("绑定邮箱验证码", { exact: true }).fill(sender.latest("bind_email").code); await form.getByRole("button", { name: "验证并绑定邮箱", exact: true }).click(); await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible(); assert.equal(user().auth_method, "email"); await phoneCheck("phone-recovered-login"); await noCredentialsStored();
  });
  await t.test("无 Cookie 的安全页先登录；有效会话刷新和新页面继续访问，退出后旧 Cookie 失效", async () => {
    advance(3_600_001);
    await page.goto(`${origin}/security`);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "账户安全", exact: true })).toHaveCount(0);
    await loginEmail(); await security();
    const cookie = (await context.cookies()).find(cookie => cookie.name === "ov_session"); assert.ok(cookie);
    await page.reload(); await expect(page.getByRole("heading", { name: "账户安全", exact: true })).toBeVisible();
    const secondPage = await context.newPage();
    try {
      await secondPage.goto(`${origin}/security`);
      await expect(secondPage.getByRole("heading", { name: "账户安全", exact: true })).toBeVisible();
      await secondPage.getByRole("button", { name: "退出登录", exact: true }).click();
      await expect(secondPage.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible();
      assert.equal((await context.cookies()).some(cookie => cookie.name === "ov_session"), false);
      const oldCookie = await fetch(`${apiOrigin}/api/auth/me`, { headers: { cookie: `${cookie.name}=${cookie.value}` } });
      assert.equal(oldCookie.status, 401);
      await secondPage.goto(`${origin}/upload`); await expect(secondPage).toHaveURL(/\/login$/);
      await expect(secondPage.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible();
      await page.reload(); await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible();
      await phoneCheck("phone-logout-login");
    } finally { await secondPage.close(); }
  });
  assert.deepEqual(failures, [], "浏览器出现未处理异常");
  assert.ok(statuses.some(entry => entry.path === "/api/auth/login/code" && entry.status === 200)); assert.ok(statuses.some(entry => entry.path === "/api/auth/password/confirm" && entry.status === 400)); assert.ok(statuses.some(entry => entry.path === "/api/auth/me" && entry.status === 401));
  // 跨站发码使用真实 HTTP 验证，不通过页面 Mock 伪造响应。
  const crossed = await fetch(`${apiOrigin}/api/auth/login/code`, { method: "POST", headers: { origin: "https://evil.invalid", "content-type": "application/json" }, body: JSON.stringify({ password: currentPassword }) }); assert.equal(crossed.status, 403);
  assert.ok(page.url().startsWith(origin));
});

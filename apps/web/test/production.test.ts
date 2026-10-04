import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";
import { SUPPORTED_EMAIL_PROVIDERS } from "@online-video/shared";

test("实际生产入口、chunk 无开发 Mock/凭据/样例，默认走站内真实 API", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map(match => match[1]!);
  assert.ok(scripts.length > 0);
  const assets = (await readdir(new URL("../dist/assets/", import.meta.url))).filter(name => name.endsWith(".js"));
  const checked = new Set<string>();
  while (scripts.length) {
    const src = scripts.pop()!; if (checked.has(src)) continue; checked.add(src);
    const bundle = await readFile(new URL(`../dist${src}`, import.meta.url), "utf8");
    for (const marker of ["demo-password", "mock-owner", "ov.dev-mock", "devMock=1", "AccessKey", "test/fixtures", "better-sqlite3", "ali-oss", "node:crypto", "node:fs", "account-setup.json", "totpSecret", "auth.key", "SMTP_CONFIG_FILE", "smtp.json", "nodemailer", "mock-password", "MockMailSender"]) assert.equal(bundle.includes(marker), false, `Unexpected production marker: ${marker}`);
    for (const name of assets) if (bundle.includes(name)) scripts.push(`/assets/${name}`);
  }
  assert.equal((await readdir(new URL("../dist", import.meta.url))).includes("test"), false);
  const server = await preview({ root, mode: "production", preview: { port: 0 } });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    let checkedSession = false;
    await page.route("**/api/auth/me", async route => { checkedSession = true; await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "AUTH_REQUIRED", message: "请先登录", requestId: "production-test" } }) }); });
    let checkedOptions = false;
    await page.route("**/api/auth/login/options", async route => { checkedOptions = true; await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { authMethod: "email", serverTime: "2026-10-04T10:00:00.000Z", emailProviders: [...SUPPORTED_EMAIL_PROVIDERS] } }) }); });
    const address = server.httpServer.address(); if (!address || typeof address === "string") throw new Error("Preview server has no address");
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect(page.getByRole("heading", { name: "安全登录" })).toBeVisible();
    assert.equal(checkedSession, true);
    await expect(page.getByLabel("密码", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "发送验证码", exact: true })).toBeVisible();
    assert.equal(checkedOptions, true); await expect(page.locator('input[type="email"]')).toHaveCount(0);
    await expect(page.getByText("支持 QQ 邮箱（@qq.com） 和 163 邮箱（@163.com）。", { exact: true })).toBeVisible();
    await expect(page.getByText("开发 Mock · 所有业务为模拟数据，未连接真实 OSS", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("模拟场景")).toHaveCount(0);
    await expect(page.getByText("开发样例：", { exact: false })).toHaveCount(0);
  } finally { await browser.close(); await new Promise<void>((resolve, reject) => server.httpServer.close(err => err ? reject(err) : resolve())); }
});

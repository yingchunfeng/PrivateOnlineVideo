import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { SUPPORTED_EMAIL_PROVIDERS } from "@online-video/shared";
import { normalizeSpaceSettings, SPACE_EFFECTS_STORAGE_KEY } from "../src/space-meteor-settings";
import { fixtureSiteSettings, openSpaceSettings } from "./page-settings-helpers";

const evidence = fileURLToPath(new URL(`../../../.local/acceptance/site-settings-${randomUUID()}/`, import.meta.url));

test("页面管理与上传上限：正式入口、草稿、冲突、新登录默认和响应式", { timeout: 120000 }, async t => {
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), cacheDir: `${evidence}/vite-cache`, mode: "test", plugins: [react()], server: { host: "127.0.0.1", port: 0, watch: null, hmr: false } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await mkdir(evidence, { recursive: true }); await server.listen();
    const address = server.httpServer?.address(); if (!address || typeof address === "string") throw new Error("隔离测试服务器未启动");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference" });
    const initialSpace = normalizeSpaceSettings({ normal: { maxVisible: 9 }, shower: { enabled: false } });
    await context.addInitScript(({ key, settings }) => {
      (window as Window & { __name?: unknown }).__name = (fn: unknown) => fn;
      if (!localStorage.getItem("site-fixture-seeded")) {
        localStorage.setItem("ov.theme.v1", "dark"); localStorage.setItem(key, JSON.stringify(settings)); localStorage.setItem("site-fixture-seeded", "yes");
      }
    }, { key: SPACE_EFFECTS_STORAGE_KEY, settings: initialSpace });
    let site = { ...fixtureSiteSettings }; let authenticated = true; let failNext = false;
    const writes: Record<string, unknown>[] = []; let releaseSave: (() => void) | undefined; let pendingSave: Promise<void> | undefined;
    const user = { id: "site-owner", displayName: "隔离页面验收", totpEnabled: false, authMethod: "password", authVersion: 1, emailMasked: null, emailVerified: false };
    await context.route("**/*", async route => {
      const url = new URL(route.request().url()); if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      const ok = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
      const fail = (code: string, status: number) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code } }) });
      switch (url.pathname) {
        case "/api/setup/status": return ok({ stage: "ready", authenticated: false, setupAvailable: false });
        case "/api/auth/me": return authenticated ? ok({ user, csrfToken: "site-fixture-csrf" }) : fail("AUTH_REQUIRED", 401);
        case "/api/auth/login/options": return ok({ authMethod: "password", serverTime: new Date().toISOString(), emailProviders: SUPPORTED_EMAIL_PROVIDERS });
        case "/api/auth/login": authenticated = true; return ok({ user, csrfToken: "site-fixture-csrf", defaultTheme: site.defaultTheme });
        case "/api/auth/logout": authenticated = false; return ok({ success: true });
        case "/api/settings/site": {
          if (route.request().method() !== "PATCH") return ok(site);
          assert.equal(route.request().headers()["x-csrf-token"], "site-fixture-csrf");
          const body = route.request().postDataJSON() as Record<string, unknown>; writes.push(body);
          if (pendingSave) { const gate = pendingSave; pendingSave = undefined; await gate; }
          if (failNext) { failNext = false; return fail("INTERNAL_ERROR", 500); }
          if (body.version !== site.version) return fail("CONFIG_VERSION_CONFLICT", 409);
          site = { ...site, ...body, version: site.version + 1 } as typeof site; return ok(site);
        }
        case "/api/settings/limits": return ok({ maxUploadBytes: site.maxUploadBytes, partSizeBytes: site.partSizeBytes, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 });
        case "/api/installation/settings": return ok({ version: 0, oss: null, mail: [], ossTest: null });
        case "/api/auth/security": return ok({ authMethod: "password", authVersion: 1, email: null, emailVerified: false, emailVerifiedAt: null, totpAvailable: false, serverTime: new Date().toISOString(), emailProviders: SUPPORTED_EMAIL_PROVIDERS });
        case "/api/library": return ok({ mediaBaseUrl: "https://unused-site.invalid", objectPrefix: "onlineVideo/", categories: [{ id: "default", name: "未分类", tags: [] }] });
        case "/api/videos": return ok({ items: [], total: 0, page: 1, pageSize: 12 });
        case "/api/uploads": return ok({ items: [], total: 0, page: 1, pageSize: 20 });
        default: return fail("NOT_FOUND", 404);
      }
    });
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/pages`);

    await t.test("页面只读列表保留旧浏览器配置；个人外观取消不变、保存刷新保留", async () => {
      await expect(page.getByRole("heading", { name: "页面管理", exact: true })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(page.locator(".page-settings-table input")).toHaveCount(0);
      await expect(page.locator(".side-theme, .theme-toolbar")).toHaveCount(0);
      const opener = page.getByRole("button", { name: "编辑个人外观", exact: true });
      await opener.click(); await page.getByRole("radio", { name: "浅色", exact: true }).check();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await expect(opener).toBeFocused(); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark"); assert.equal(writes.length, 0);
      await opener.click(); await page.getByRole("radio", { name: "浅色", exact: true }).check();
      await page.getByRole("button", { name: "保存", exact: true }).click(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SPACE_EFFECTS_STORAGE_KEY), initialSpace);
    });

    await t.test("默认外观失败保留、版本冲突显式重试、保存中锁定；新登录覆盖旧缓存", async () => {
      await page.getByRole("button", { name: "编辑默认外观", exact: true }).click(); await page.getByRole("radio", { name: "深色", exact: true }).check();
      failNext = true; await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible(); await expect(page.getByRole("radio", { name: "深色", exact: true })).toBeChecked();
      site.version++; await page.getByRole("button", { name: "保存", exact: true }).click(); await expect(page.getByRole("button", { name: "使用最新版本重试", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "使用最新版本重试", exact: true }).click();
      pendingSave = new Promise<void>(resolve => { releaseSave = resolve; });
      const before = writes.length; await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveAttribute("aria-busy", "true"); await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeVisible();
      assert.equal(writes.length, before + 1); releaseSave!(); await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.locator(".side-logout-btn").click(); await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light"); await page.getByLabel("密码", { exact: true }).fill("isolated-fixture-password"); await page.getByRole("button", { name: "进入视频库", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark"); assert.equal(await page.evaluate(() => localStorage.getItem("ov.theme.v1")), "dark");
      await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    });

    await t.test("星空草稿与预览不持久化，取消恢复；显式保存与总开关刷新保持", async () => {
      await openSpaceSettings(page); await expect(page.getByLabel("同屏最大数量", { exact: true })).toHaveValue("9");
      await page.getByLabel("同屏最大数量", { exact: true }).fill("14");
      await page.getByRole("button", { name: "预览普通流星", exact: true }).click();
      assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).normal.maxVisible, SPACE_EFFECTS_STORAGE_KEY), 9);
      await page.getByRole("button", { name: "取消", exact: true }).click(); await openSpaceSettings(page); await expect(page.getByLabel("同屏最大数量", { exact: true })).toHaveValue("9");
      await page.getByLabel("同屏最大数量", { exact: true }).fill("14"); await page.getByRole("checkbox", { name: /^启用动态星空/ }).uncheck();
      await page.getByRole("button", { name: "保存星空设置", exact: true }).click(); await expect(page.locator("html")).toHaveAttribute("data-space-motion", "off");
      await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-space-motion", "off"); await openSpaceSettings(page); await expect(page.getByLabel("同屏最大数量", { exact: true })).toHaveValue("14"); await page.getByRole("button", { name: "取消", exact: true }).click();
    });

    await t.test("系统设置GiB限额、边界、失败保留和冲突重试；新上传页面读取同一生效值", async () => {
      const upload = await context.newPage();
      await upload.goto(`${origin}/upload`); await expect(upload.locator(".storage-chip-cap")).toHaveText("单片限 2 GiB");
      await upload.getByLabel("视频文件", { exact: true }).setInputFiles(fileURLToPath(new URL("./fixtures/demo.webm", import.meta.url)));
      await expect(upload.locator(".pending-upload-row")).toHaveCount(1);
      await upload.getByLabel("视频标题", { exact: true }).fill("跨标签上限刷新保留草稿");
      await page.goto(`${origin}/settings`); const field = page.getByLabel("单个视频文件最大值（GiB）", { exact: true }); await expect(field).toHaveValue("2");
      for (const value of ["", "0", "-1", "3"]) { await field.fill(value); await expect(page.getByRole("button", { name: "保存单文件上限", exact: true })).toBeDisabled(); }
      await field.fill("0.5"); failNext = true; await page.getByRole("button", { name: "保存单文件上限", exact: true }).click();
      await expect(field).toHaveValue("0.5"); await expect(page.locator('[aria-label="上传限制"] [role="alert"]')).toBeVisible();
      site.version++; await page.getByRole("button", { name: "保存单文件上限", exact: true }).click(); await page.getByRole("button", { name: "使用最新版本重试", exact: true }).click(); await expect(field).toHaveValue("0.5");
      await page.getByRole("button", { name: "保存单文件上限", exact: true }).click(); await expect(page.locator('[aria-label="上传限制"]')).toContainText("当前上限：512 MiB"); assert.equal(site.maxUploadBytes, 536870912);
      await expect(upload.locator(".storage-chip-cap")).toHaveText("单片限 512 MiB"); await expect(upload.locator(".pending-upload-row")).toHaveCount(1); await expect(upload.getByLabel("视频标题", { exact: true })).toHaveValue("跨标签上限刷新保留草稿");
      await upload.close();
      await page.screenshot({ path: `${evidence}/upload-limit-desktop-dark.png` });
      await page.reload(); await expect(field).toHaveValue("0.5"); await page.goto(`${origin}/upload`); await expect(page.locator(".storage-chip-cap")).toHaveText("单片限 512 MiB");
    });

    await t.test("浅深色桌面、手机、平板、横屏的表格和复杂弹窗不溢出且保存固定可见", async () => {
      await page.goto(`${origin}/pages`);
      for (const theme of ["light", "dark"] as const) {
        await page.getByRole("button", { name: "编辑个人外观", exact: true }).click(); await page.getByRole("radio", { name: theme === "dark" ? "深色" : "浅色", exact: true }).check(); await page.getByRole("button", { name: "保存", exact: true }).click();
        for (const [width, height] of [[1440, 1000], [375, 667], [320, 568], [768, 700], [667, 375]]) {
          await page.setViewportSize({ width: width!, height: height! }); if (width! < 1024) await expect(page.locator('.bottom-nav a[href="/pages"]')).toBeInViewport();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          if (width === 1440 || width === 375) await page.screenshot({ path: `${evidence}/page-management-${theme}-${width}.png` });
          await openSpaceSettings(page); await expect(page.getByRole("button", { name: "保存星空设置", exact: true })).toBeInViewport();
          assert.equal(await page.getByRole("dialog").evaluate(node => node.scrollWidth <= node.clientWidth), true);
          if (height! < 500) assert.ok(await page.locator(".management-modal-body").evaluate(node => node.clientHeight) > 80, "横屏弹窗需要保留可用的中间滚动区");
          await page.screenshot({ path: `${evidence}/page-space-${theme}-${width}x${height}.png` }); await page.getByRole("button", { name: "取消", exact: true }).click();
        }
      }
    });
    assert.deepEqual(errors, []); t.diagnostic(`页面管理截图：${evidence}`);
  } finally { await browser?.close(); await server.close(); }
});

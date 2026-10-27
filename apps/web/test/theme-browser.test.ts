import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { SUPPORTED_EMAIL_PROVIDERS } from "@online-video/shared";
import { themeStorageKey } from "../src/theme";

const evidence = fileURLToPath(new URL(`../../../.local/acceptance/theme-${randomUUID()}/`, import.meta.url));
const mediaOrigin = "https://theme-media.example";

async function installFixture(context: BrowserContext, origin: string, mode = "ready") {
  const media = await readFile(new URL("./fixtures/demo.webm", import.meta.url));
  const user = { id: "theme-owner", displayName: "主题验收", totpEnabled: false, authMethod: "password", authVersion: 1, emailMasked: null, emailVerified: false };
  const video = { id: "theme-video", title: "星际旅行 · 观测记录", categoryId: "space", tags: ["宇宙"], objectKey: "media/space/demo.webm", publicUrl: `${mediaOrigin}/media/space/demo.webm`, fileName: "demo.webm", sizeBytes: media.length, durationSeconds: 12, status: "ready", thumbnailUrl: null, createdAt: "2026-10-01T10:00:00.000Z", codec: "VP8", width: 640, height: 360, playable: true, lastPositionSeconds: 0 };
  await context.addInitScript("window.__name = (fn) => fn;");
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === mediaOrigin && url.pathname === "/media/space/demo.webm") return route.fulfill({ contentType: "video/webm", body: media });
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const ok = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
    switch (url.pathname) {
      case "/api/setup/status": return ok({ stage: mode === "setup" ? "password" : "ready", authenticated: false, setupAvailable: mode === "setup" });
      case "/api/auth/me": return mode === "login" ? route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "AUTH_REQUIRED" } }) }) : ok({ user, csrfToken: "theme-csrf" });
      case "/api/auth/login/options": return ok({ authMethod: "password", serverTime: new Date().toISOString(), emailProviders: SUPPORTED_EMAIL_PROVIDERS });
      case "/api/auth/security": return ok({ authMethod: "password", authVersion: 1, email: null, emailVerified: false, emailVerifiedAt: null, totpAvailable: false, serverTime: new Date().toISOString(), emailProviders: SUPPORTED_EMAIL_PROVIDERS });
      case "/api/auth/sessions": return ok([{ id: "theme-session", isCurrent: true, createdAt: "2026-10-01T10:00:00.000Z", lastSeenAt: "2026-10-01T10:00:00.000Z", expiresAt: "2026-11-01T10:00:00.000Z" }]);
      case "/api/library": return ok({ mediaBaseUrl: mediaOrigin, objectPrefix: "media/", categories: [{ id: "space", name: "星际", tags: ["宇宙"] }] });
      case "/api/library/configuration": return ok({ version: "theme-v1", writable: true, categories: [{ id: "space", name: "星际", enabled: true, isDefault: true, tagIds: ["universe"], videoCount: 1, uploadCount: 0 }], tags: [{ id: "universe", name: "宇宙", enabled: true, categoryIds: ["space"], videoCount: 1, uploadCount: 0 }] });
      case "/api/settings/limits": return ok({ maxUploadBytes: 2147483648, partSizeBytes: 65536, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 });
      case "/api/videos": return ok({ items: [video], total: 1, page: 1, pageSize: 12 });
      case "/api/videos/theme-video": return ok(video);
      case "/api/videos/theme-video/progress": return ok({ videoId: video.id, positionSeconds: 0, updatedAt: null });
      case "/api/uploads": return ok({ items: [], total: 0, page: 1, pageSize: 20 });
      case "/api/installation/settings": return ok({ version: 0, oss: null, mail: [], ossTest: null });
      default: return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND" } }) });
    }
  });
}

async function verifyTheme(page: Page, theme: "light" | "dark") {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.getByRole("button", { name: theme === "light" ? "浅色" : "深色", exact: true })).toHaveAttribute("aria-pressed", "true");
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), theme);
  assert.equal(await page.locator("body").evaluate(node => getComputedStyle(node).backgroundColor), theme === "light" ? "rgb(255, 255, 255)" : "rgb(8, 12, 20)");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", theme === "light" ? "#ffffff" : "#080c14");
}

async function verifyWidth(page: Page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "page must not overflow horizontally");
}

test("light/dark theme: isolated browser acceptance, no real API or storage service", { timeout: 120000 }, async t => {
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), mode: "test", plugins: [react()], server: { host: "127.0.0.1", port: 0, strictPort: true } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark", reducedMotion: "reduce" });
    await installFixture(context, origin);
    const page = await context.newPage();
    const errors: string[] = [];
    context.on("page", tab => tab.on("pageerror", error => errors.push(error.message)));
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(7000);
    await mkdir(evidence, { recursive: true });

    await t.test("defaults to white even on a dark OS; keyboard switching and reload persistence", async () => {
      await page.goto(origin);
      await expect(page.locator(".video-card")).toHaveCount(1);
      await verifyTheme(page, "light");
      await expect(page.locator(".theme-toolbar")).toBeHidden();
      await expect(page.locator(".side-theme")).toBeVisible();
      await verifyWidth(page);
      await page.screenshot({ path: `${evidence}/desktop-library-light.png`, fullPage: true });
      const dark = page.getByRole("button", { name: "深色", exact: true });
      await dark.focus();
      await page.keyboard.press("Enter");
      await verifyTheme(page, "dark");
      assert.equal(await page.evaluate(key => localStorage.getItem(key), themeStorageKey), "dark");
      await page.reload();
      await expect(page.locator(".video-card")).toHaveCount(1);
      await verifyTheme(page, "dark");
      await page.screenshot({ path: `${evidence}/desktop-library-dark.png`, fullPage: true });
      await page.getByRole("button", { name: "浅色", exact: true }).click();
    });

    await t.test("tabs synchronize only the local theme preference, including removal", async () => {
      const other = await context.newPage();
      await other.goto(origin);
      await expect(other.locator(".video-card")).toHaveCount(1);
      await page.getByRole("button", { name: "深色", exact: true }).click();
      await verifyTheme(other, "dark");
      await other.evaluate(key => sessionStorage.setItem(key, "light"), themeStorageKey);
      await verifyTheme(page, "dark");
      await other.evaluate(key => localStorage.removeItem(key), themeStorageKey);
      await verifyTheme(page, "light");
      await other.close();
    });

    await t.test("pages, native player, forms and dialog retain readable theme surfaces", async () => {
      const routes = [["/upload", "上传 / 编辑视频"], ["/tasks", "任务列表"], ["/categories", "配置管理"], ["/settings", "系统设置"], ["/security", "账户安全"], ["/videos/theme-video", "星际旅行 · 观测记录"]];
      for (const theme of ["light", "dark"] as const) {
        await page.getByRole("button", { name: theme === "light" ? "浅色" : "深色", exact: true }).click();
        for (const [path, title] of routes) {
          await page.goto(`${origin}${path}`);
          await expect(page.getByRole("heading", { name: title!, level: 1, exact: true })).toBeVisible();
          await expect(page.locator(".loading")).toHaveCount(0);
          await expect(page.getByRole("alert")).toHaveCount(0);
          await verifyTheme(page, theme);
          await verifyWidth(page);
          if (path === "/upload" || path === "/settings") await page.screenshot({ path: `${evidence}/desktop-${path.slice(1)}-${theme}.png`, fullPage: true });
        }
        assert.equal(await page.locator(".player-frame").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(2, 6, 23)");
        await page.getByRole("button", { name: "编辑信息", exact: true }).click();
        await page.getByLabel("视频标题", { exact: true }).fill("未保存的主题检查");
        await page.getByRole("button", { name: theme === "light" ? "深色" : "浅色", exact: true }).click();
        await expect(page.getByLabel("视频标题", { exact: true })).toHaveValue("未保存的主题检查");
        await page.getByRole("button", { name: theme === "light" ? "浅色" : "深色", exact: true }).click();
        await page.goto(`${origin}/security`);
        await page.getByRole("button", { name: "撤销当前会话", exact: true }).click();
        await expect(page.getByRole("alertdialog")).toBeVisible();
        await expect(page.getByRole("alertdialog")).toBeInViewport();
        const dialogColor = await page.getByRole("alertdialog").evaluate(node => getComputedStyle(node).backgroundColor);
        assert.equal(dialogColor, theme === "light" ? "rgb(255, 255, 255)" : "rgb(15, 23, 42)");
        await page.screenshot({ path: `${evidence}/desktop-dialog-${theme}.png` });
        await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
      }
    });

    await t.test("mobile and tablet keep a visible switch, readable surfaces and no overflow", async () => {
      for (const width of [375, 768]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ["light", "dark"] as const) {
          await page.goto(origin);
          await expect(page.locator(".video-card")).toHaveCount(1);
          await page.getByRole("button", { name: theme === "light" ? "浅色" : "深色", exact: true }).click();
          await verifyTheme(page, theme);
          await expect(page.locator(".theme-toolbar")).toBeVisible();
          await expect(page.getByRole("navigation", { name: "主要导航" })).toBeVisible();
          await verifyWidth(page);
          await page.screenshot({ path: `${evidence}/library-${width}-${theme}.png`, fullPage: true });
          await page.goto(`${origin}/upload`);
          await expect(page.getByRole("heading", { name: "上传 / 编辑视频" })).toBeVisible();
          await verifyWidth(page);
        }
      }
      await page.setViewportSize({ width: 1024, height: 720 });
      await page.goto(origin);
      await expect(page.locator(".video-card")).toHaveCount(1);
      await page.getByRole("button", { name: "浅色", exact: true }).click();
      await verifyTheme(page, "light");
      await page.locator(".side-dock-footer").scrollIntoViewIfNeeded();
      await expect(page.locator(".side-dock-footer")).toBeInViewport();
      assert.equal(await page.locator(".side-storage-widget").evaluate(node => node.scrollHeight <= node.clientHeight), true);
      await verifyWidth(page);
    });

    await t.test("login and setup expose theme control; inaccessible storage does not break toggling", async () => {
      for (const mode of ["login", "setup"]) {
        const isolated = await browser!.newContext({ viewport: { width: 375, height: 812 } });
        await installFixture(isolated, origin, mode);
        await isolated.addInitScript(() => {
          Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("Blocked", "SecurityError"); } });
        });
        const tab = await isolated.newPage();
        tab.on("pageerror", error => errors.push(error.message));
        await tab.goto(origin);
        await expect(tab.getByRole("heading", { name: mode === "login" ? "安全登录" : "云影匣 · 首次设置" })).toBeVisible();
        await verifyTheme(tab, "light");
        await tab.getByRole("button", { name: "深色", exact: true }).click();
        await verifyTheme(tab, "dark");
        await verifyWidth(tab);
        await isolated.close();
      }
    });
    assert.deepEqual(errors, []);
    console.log(`Theme screenshots: ${evidence}`);
  } finally {
    await browser?.close();
    await server.close();
  }
});

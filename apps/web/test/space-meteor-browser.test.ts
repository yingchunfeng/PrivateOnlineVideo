import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { DEFAULT_SPACE_SETTINGS, normalizeSpaceSettings, SPACE_EFFECTS_STORAGE_KEY } from "../src/space-meteor-settings";
import type { SpaceEffectsSettings } from "../src/space-meteor-settings";
import { fixtureSiteSettings, openSpaceSettings } from "./page-settings-helpers";

const frozenTime = new Date("2026-10-28T12:00:00Z");

async function fixture(context: BrowserContext, origin: string) {
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const ok = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
    switch (url.pathname) {
      case "/api/setup/status": return ok({ stage: "ready", authenticated: false, setupAvailable: false });
      case "/api/auth/me": return ok({ user: { id: "meteor-owner", displayName: "流星验收", totpEnabled: false, authMethod: "password", authVersion: 1, emailMasked: null, emailVerified: false }, csrfToken: "meteor-csrf" });
      case "/api/library": return ok({ mediaBaseUrl: "https://unused-meteor.example", objectPrefix: "media/", categories: [] });
      case "/api/settings/limits": return ok({ maxUploadBytes: 2147483648, partSizeBytes: 65536, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 });
      case "/api/settings/site": return ok(fixtureSiteSettings);
      case "/api/videos": return ok({ items: [], total: 0, page: 1, pageSize: 12 });
      case "/api/uploads": return ok({ items: [], total: 0, page: 1, pageSize: 20 });
      default: return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND" } }) });
    }
  });
}

function deterministicSettings(): SpaceEffectsSettings {
  const value = normalizeSpaceSettings(DEFAULT_SPACE_SETTINGS);
  value.normal = { ...value.normal, batchMin: 2, batchMax: 2, maxVisible: 6, intervalMin: 1, intervalMax: 1, durationMin: 4, durationMax: 4, foregroundRatio: 100 };
  value.shower = { ...value.shower, probability: 0, batchMin: 6, batchMax: 6, maxVisible: 12, intervalMin: .2, intervalMax: .2, duration: 4 };
  return value;
}

test("meteor settings and global provider: deterministic isolated browser integration", { timeout: 120000 }, async t => {
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), mode: "test", plugins: [react()], server: { host: "127.0.0.1", port: 0, watch: null, hmr: false } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const contexts: BrowserContext[] = [];
  const errors: string[] = [];
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Missing meteor test server");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const createPage = async (options: { settings?: SpaceEffectsSettings; mobile?: boolean; denied?: boolean; reduced?: boolean } = {}) => {
      const context = await browser!.newContext({ viewport: { width: options.mobile ? 375 : 1440, height: 1000 }, reducedMotion: options.reduced ? "reduce" : "no-preference" });
      contexts.push(context);
      context.on("page", tab => tab.on("pageerror", error => errors.push(error.message)));
      await fixture(context, origin);
      await context.addInitScript("window.__name = (fn) => fn;");
      await context.addInitScript(({ key, settings, denied, origin }) => {
        let seed = 113;
        Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
        Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, value: 12 });
        Object.defineProperty(navigator, "deviceMemory", { configurable: true, value: 8 });
        if (denied) Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("Denied", "SecurityError"); } });
        else if (location.origin === origin && !localStorage.getItem("meteor-unrelated")) {
          localStorage.setItem(key, JSON.stringify(settings)); localStorage.setItem("meteor-unrelated", "preserve");
        }
      }, { key: SPACE_EFFECTS_STORAGE_KEY, settings: options.settings ?? deterministicSettings(), denied: options.denied ?? false, origin });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.clock.install({ time: frozenTime });
      await page.clock.pauseAt(new Date(frozenTime.getTime() + 1000));
      await page.goto(origin);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      return { context, page };
    };
    const openSettings = async (page: Page) => {
      await openSpaceSettings(page);
      await expect(page.locator("dialog[data-space-settings] ")).toBeVisible();
    };

    await t.test("settings save explicitly, cancel keeps saved values, survive refresh, synchronize tabs and recover corruption", async () => {
      const { context, page } = await createPage();
      await openSettings(page);
      await page.getByLabel("同屏最大数量", { exact: true }).fill("4");
      assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).normal.maxVisible, SPACE_EFFECTS_STORAGE_KEY), 6);
      for (const invalid of ["", "-1", "1000000"]) {
        await page.getByLabel("同屏最大数量", { exact: true }).fill(invalid);
        await expect(page.getByLabel("同屏最大数量", { exact: true })).toHaveAttribute("aria-invalid", "true");
        assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).normal.maxVisible, SPACE_EFFECTS_STORAGE_KEY), 6);
        await page.getByRole("button", { name: "关闭弹窗" }).focus();
        await expect(page.getByLabel("同屏最大数量", { exact: true })).toHaveValue("4");
      }
      const slider = page.getByRole("slider", { name: "同屏最大数量滑块", exact: true });
      await slider.focus(); await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight");
      await expect(page.getByLabel("同屏最大数量", { exact: true })).toHaveValue("2");
      await page.getByLabel("同屏最大数量", { exact: true }).fill("4");
      await page.getByRole("tab", { name: "普通流星", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("tab", { name: "流星雨", exact: true })).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog[data-space-settings]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "编辑动态星空", exact: true })).toBeFocused();
      await openSettings(page);
      await expect(page.getByLabel("同屏最大数量", { exact: true })).toHaveValue("6");
      await page.getByLabel("同屏最大数量", { exact: true }).fill("4");
      await page.getByRole("button", { name: "保存星空设置", exact: true }).click();
      await page.reload(); await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); await openSettings(page);
      await expect(page.getByLabel("同屏最大数量", { exact: true })).toHaveValue("4");
      const other = await context.newPage(); await other.goto(origin);
      await other.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: SPACE_EFFECTS_STORAGE_KEY, value: { ...deterministicSettings(), normal: { ...deterministicSettings().normal, maxVisible: 9 } } });
      await expect(page.getByLabel("同屏最大数量", { exact: true })).toHaveValue("4");
      await page.getByRole("button", { name: "取消", exact: true }).click(); await openSettings(page);
      await expect(page.getByLabel("同屏最大数量", { exact: true })).toHaveValue("9");
      await other.evaluate(key => localStorage.setItem(key, "{broken"), SPACE_EFFECTS_STORAGE_KEY);
      await page.getByRole("button", { name: "取消", exact: true }).click(); await openSettings(page);
      await expect(page.getByLabel("同屏最大数量", { exact: true })).toHaveValue("6");
      await page.getByRole("button", { name: "恢复默认值", exact: true }).click();
      assert.equal(await page.evaluate(() => localStorage.getItem("meteor-unrelated")), "preserve");
      assert.equal(await page.evaluate(key => localStorage.getItem(key), SPACE_EFFECTS_STORAGE_KEY), "{broken");
      await page.getByRole("button", { name: "保存星空设置", exact: true }).click();
      assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SPACE_EFFECTS_STORAGE_KEY), normalizeSpaceSettings(null));
      await context.close();
    });

    await t.test("native settings dialog allows preview; repeated clicks do not stack or extend it, switching modes replaces it", async () => {
      const { context, page } = await createPage();
      await openSettings(page);
      await page.getByRole("button", { name: "立即预览流星雨", exact: true }).click();
      await expect(page.locator(".space-meteors-background")).toHaveAttribute("data-shower", "true");
      await expect(page.locator(".space-meteors-background")).toHaveCSS("visibility", "visible");
      await page.clock.runFor(1000);
      assert.ok(await page.locator(".space-meteor").count() >= 3);
      const ids = await page.locator(".space-meteor").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-meteor-id")));
      await page.getByRole("button", { name: "立即预览流星雨", exact: true }).click();
      assert.deepEqual(await page.locator(".space-meteor").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-meteor-id"))), ids);
      await page.clock.runFor(3040);
      await expect(page.locator(".space-meteors-background")).toHaveAttribute("data-shower", "false");
      await expect(page.getByRole("button", { name: "停止预览", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "立即预览流星雨", exact: true }).click();
      await page.getByRole("button", { name: "预览普通流星", exact: true }).click();
      await expect(page.locator(".space-meteors-background")).toHaveAttribute("data-shower", "false");
      assert.ok((await page.locator(".space-meteor").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-meteor-mode")))).every(mode => mode === "normal"));
      await page.getByRole("button", { name: "停止预览", exact: true }).click();
      await expect(page.locator(".space-meteor")).toHaveCount(0);
      await context.close();
    });

    await t.test("input suppresses foreground and automatic rain while normal backgrounds remain possible", async () => {
      const value = deterministicSettings(); value.shower.probability = 100;
      const { context, page } = await createPage({ settings: value });
      await openSettings(page);
      await page.getByLabel("同屏最大数量", { exact: true }).focus();
      await page.clock.runFor(2200);
      await expect(page.locator("html")).toHaveAttribute("data-space-meteor-input", "true");
      await expect(page.locator(".space-meteors-foreground")).toHaveCSS("visibility", "hidden");
      await expect(page.locator(".space-meteors-background")).toHaveAttribute("data-shower", "false");
      assert.ok(await page.locator(".space-meteors-background .space-meteor").count() > 0);
      await page.getByRole("button", { name: "立即预览流星雨", exact: true }).click();
      await expect(page.locator(".space-meteors-background")).toHaveAttribute("data-shower", "true");
      await context.close();
    });

    await t.test("business dialogs and captured playback events stop preview immediately; background resume never catches up", async () => {
      const { context, page } = await createPage();
      await openSettings(page);
      await page.getByRole("button", { name: "立即预览流星雨", exact: true }).click();
      await page.evaluate(() => { const node = document.createElement("dialog"); node.id = "meteor-business-dialog"; node.textContent = "业务确认"; document.body.append(node); node.showModal(); });
      await expect(page.locator("html")).toHaveAttribute("data-space-meteor-blocked", "true");
      await expect(page.locator(".space-meteor")).toHaveCount(0);
      await page.evaluate(() => document.getElementById("meteor-business-dialog")?.remove());
      await expect(page.locator("html")).toHaveAttribute("data-space-meteor-blocked", "false");
      await page.getByRole("button", { name: "立即预览流星雨", exact: true }).click();
      await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
      await expect(page.locator(".space-meteor")).toHaveCount(0);
      await page.clock.runFor(60000);
      await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
      await expect(page.locator("html")).toHaveAttribute("data-space-meteor-blocked", "false");
      await expect(page.locator(".space-meteor")).toHaveCount(0);
      await page.clock.runFor(999); await expect(page.locator(".space-meteor")).toHaveCount(0);
      await page.clock.runFor(1); await expect(page.locator(".space-meteor")).toHaveCount(2);
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.evaluate(() => {
        const frame = document.createElement("div"); frame.className = "player-frame";
        const video = document.createElement("video"); Object.defineProperty(video, "paused", { configurable: true, value: false });
        frame.append(video); document.getElementById("main")!.append(frame); video.dispatchEvent(new Event("playing", { bubbles: true }));
      });
      await expect(page.locator("html")).toHaveAttribute("data-space-playing", "true");
      await expect(page.locator(".space-meteor")).toHaveCount(0);
      await page.evaluate(() => document.querySelector(".player-frame")?.remove());
      await expect(page.locator("html")).toHaveAttribute("data-space-playing", "false");
      await expect(page.locator(".space-meteor")).toHaveCount(0);
      await context.close();
    });

    await t.test("client-side navigation preserves the global scene and one fixed-rate emission schedule", async () => {
      const { context, page } = await createPage();
      await page.clock.runFor(1000);
      await expect(page.locator(".space-meteor")).toHaveCount(2);
      const originalIds = await page.locator(".space-meteor").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-meteor-id")));
      await page.locator(".space-atmosphere").evaluate(node => node.setAttribute("data-scene-identity", "retained"));
      await page.locator('.side-nav-menu a[href="/tasks"]').click();
      await expect(page.getByRole("heading", { level: 1, name: "任务列表" })).toBeVisible();
      await expect(page.locator(".space-atmosphere")).toHaveAttribute("data-scene-identity", "retained");
      await page.clock.runFor(1000);
      await expect(page.locator(".space-meteor")).toHaveCount(4);
      const nextIds = await page.locator(".space-meteor").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-meteor-id")));
      assert.ok(originalIds.every(id => nextIds.includes(id)));
      await page.locator('.side-nav-menu a[href="/"]').click();
      await page.clock.runFor(1000);
      await expect(page.locator(".space-meteor")).toHaveCount(6);
      await context.close();
    });

    await t.test("mobile enforces actual caps, range floors and no foreground even for extreme saved preferences", async () => {
      const value = deterministicSettings();
      value.normal.maxVisible = 48; value.normal.batchMin = value.normal.batchMax = 24;
      value.shower.maxVisible = 48; value.shower.batchMin = value.shower.batchMax = 24; value.shower.intervalMin = value.shower.intervalMax = .1;
      const { context, page } = await createPage({ settings: value, mobile: true });
      await openSettings(page);
      await expect(page.getByLabel("设备实际生效设置")).toContainText("普通同屏 ≤ 4 条，流星雨 ≤ 8 条");
      await expect(page.getByLabel("设备实际生效设置")).toContainText("当前设备前景强制关闭");
      await page.getByRole("button", { name: "立即预览流星雨", exact: true }).click();
      for (let index = 0; index < 8; index++) {
        await page.clock.runFor(350);
        assert.ok(await page.locator(".space-meteor").count() <= 8);
        await expect(page.locator(".space-meteors-foreground .space-meteor")).toHaveCount(0);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const sizes = await page.locator(".space-meteor").evaluateAll(nodes => nodes.map(node => Number(node.getAttribute("data-meteor-size"))));
      assert.ok(sizes.length > 0 && sizes.every(size => size <= 1.5));
      await context.close();
    });

    await t.test("denied storage leaves editable in-memory settings; reduced motion saves but cannot preview", async () => {
      const denied = await createPage({ denied: true });
      await openSettings(denied.page);
      await expect(denied.page.locator("dialog[data-space-settings]")).toContainText("浏览器存储受限");
      await denied.page.getByLabel("同屏最大数量", { exact: true }).fill("3");
      await denied.page.getByRole("button", { name: "保存星空设置", exact: true }).click();
      await openSettings(denied.page); await expect(denied.page.getByLabel("同屏最大数量", { exact: true })).toHaveValue("3");
      await denied.context.close();
      const reduced = await createPage({ reduced: true });
      await openSettings(reduced.page);
      await expect(reduced.page.locator("dialog[data-space-settings]")).toContainText("动画和预览当前不会播放");
      await reduced.page.getByLabel("同屏最大数量", { exact: true }).fill("4");
      await expect(reduced.page.getByRole("button", { name: "立即预览流星雨", exact: true })).toBeDisabled();
      await reduced.page.clock.runFor(10000); await expect(reduced.page.locator(".space-meteor")).toHaveCount(0);
      await reduced.page.getByRole("button", { name: "保存星空设置", exact: true }).click();
      assert.equal(await reduced.page.evaluate(key => JSON.parse(localStorage.getItem(key)!).normal.maxVisible, SPACE_EFFECTS_STORAGE_KEY), 4);
      await reduced.context.close();
    });

    await t.test("quota errors with readable storage retain in-memory edits and show the persistence warning", async () => {
      const { context, page } = await createPage();
      await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("Quota full", "QuotaExceededError"); }; });
      await openSettings(page);
      await page.getByLabel("同屏最大数量", { exact: true }).fill("3");
      await expect(page.getByLabel("同屏最大数量", { exact: true })).toHaveValue("3");
      assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).normal.maxVisible, SPACE_EFFECTS_STORAGE_KEY), 6);
      await page.getByRole("button", { name: "预览普通流星", exact: true }).click();
      await page.clock.runFor(2000);
      assert.ok(await page.locator(".space-meteor").count() <= 3);
      await page.getByRole("button", { name: "保存星空设置", exact: true }).click();
      await openSettings(page); await expect(page.getByLabel("同屏最大数量", { exact: true })).toHaveValue("3");
      await expect(page.locator("dialog[data-space-settings]")).toContainText("浏览器存储受限");
      await context.close();
    });

    await t.test("draft preview and explicit save apply foreground and duration without waiting for the old scene to finish", async () => {
      const { context, page } = await createPage();
      await page.clock.runFor(1000);
      await expect(page.locator(".space-meteors-foreground .space-meteor")).toHaveCount(2);
      await openSettings(page);
      await page.getByRole("checkbox", { name: /^前景流星/ }).uncheck();
      await page.getByRole("button", { name: "预览普通流星", exact: true }).click();
      await expect(page.locator(".space-meteors-foreground .space-meteor")).toHaveCount(0);
      await page.getByRole("button", { name: "保存星空设置", exact: true }).click();
      await openSettings(page);
      await page.getByRole("button", { name: "立即预览流星雨", exact: true }).click();
      await page.clock.runFor(2000);
      await expect(page.locator(".space-meteors-background")).toHaveAttribute("data-shower", "true");
      await page.getByRole("tab", { name: "流星雨", exact: true }).click();
      await page.getByLabel("持续时间", { exact: true }).fill("1");
      assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).shower.duration, SPACE_EFFECTS_STORAGE_KEY), 4);
      await page.getByRole("button", { name: "保存星空设置", exact: true }).click();
      await expect(page.locator(".space-meteors-background")).toHaveAttribute("data-shower", "false");
      await openSettings(page);
      await expect(page.getByRole("button", { name: "停止预览", exact: true })).toBeDisabled();
      assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).shower.duration, SPACE_EFFECTS_STORAGE_KEY), 1);
      await context.close();
    });
    assert.deepEqual(errors, []);
  } finally {
    for (const context of contexts) await context.close();
    await browser?.close();
    await server.close();
  }
});

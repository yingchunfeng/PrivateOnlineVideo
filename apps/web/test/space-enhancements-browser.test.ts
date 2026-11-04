import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import type { UploadTask } from "@online-video/shared";
import { fixtureSiteSettings, openSpaceSettings, selectPersonalTheme, setSpaceEnabled } from "./page-settings-helpers";

const evidence = fileURLToPath(new URL(`../../../.local/acceptance/space-enhancements-${randomUUID()}/`, import.meta.url));

test("remaining space effects: single confirmations, navigation continuity and one entrance per route", { timeout: 90000 }, async t => {
  // 固定本轮测试代码快照，避免共享构建产物重写触发上下文模块的热替换。
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), cacheDir: `${evidence}/vite-cache`, mode: "test", plugins: [react()], server: { host: "127.0.0.1", port: 0, watch: null, hmr: false } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Missing test server");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference" });
    await context.addInitScript(() => {
      (window as Window & { __name?: unknown }).__name = (fn: unknown) => fn;
      localStorage.setItem("ov.space-effects.v1", JSON.stringify({ normal: { enabled: false }, shower: { enabled: false } }));
      const log: string[] = [];
      (window as Window & { entranceLog?: string[] }).entranceLog = log;
      document.addEventListener("animationstart", event => { if (event.animationName === "space-page-enter") log.push((event.target as HTMLElement).dataset.spaceEntered ?? "unknown"); });
    });
    const newTask: UploadTask = { id: "new-confirmation", videoId: null, title: "等待真实登记的任务", fileName: "new.mp4", sizeBytes: 4, partSizeBytes: 4, status: "finalizing", uploadedParts: [{ partNumber: 1, sizeBytes: 4, checksum: "a".repeat(64) }], createdAt: "2026-10-28T00:00:00.000Z" };
    let currentTask = { ...newTask };
    const oldTask = { ...newTask, id: "history", title: "历史已完成任务", status: "completed", videoId: "history-video" };
    let confirmationRequested = false;
    let releaseConfirmation!: () => void;
    const confirmation = new Promise<void>(resolve => { releaseConfirmation = resolve; });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      const ok = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
      switch (url.pathname) {
        case "/api/setup/status": return ok({ stage: "ready", authenticated: false, setupAvailable: false });
        case "/api/auth/me": return ok({ user: { id: "enhancement-owner", displayName: "隔离动效验收", totpEnabled: false, authMethod: "password", authVersion: 1, emailMasked: null, emailVerified: false }, csrfToken: "fixture" });
        case "/api/library": return ok({ mediaBaseUrl: "https://fixture.invalid", objectPrefix: "media/", categories: [{ id: "space", name: "星际", tags: [] }] });
        case "/api/settings/limits": return ok({ maxUploadBytes: 2147483648, partSizeBytes: 65536, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 });
        case "/api/settings/site": return ok(fixtureSiteSettings);
        case "/api/videos": return ok({ items: [{ id: "fixture-video", title: `首屏模块 ${url.searchParams.get("page") ?? "1"}`, categoryId: "space", tags: [], publicUrl: "https://fixture.invalid/media/test.mp4", coverUrl: null, fileName: "fixture.mp4", sizeBytes: 4, durationSeconds: 12, status: "ready", playable: true, createdAt: "2026-10-28T00:00:00.000Z" }], total: 24, page: Number(url.searchParams.get("page") ?? "1"), pageSize: 12 });
        case "/api/uploads": return ok({ items: [currentTask, oldTask], total: 2, page: 1, pageSize: 20 });
        case "/api/uploads/new-confirmation": return ok(currentTask);
        case "/api/uploads/new-confirmation/complete": {
          confirmationRequested = true;
          await confirmation;
          currentTask = { ...currentTask, status: "completed", videoId: "confirmed-video" };
          return ok({ upload: currentTask, video: { id: "confirmed-video", publicUrl: "https://fixture.invalid/media/test.mp4", coverStatus: "missing" } });
        }
        default: return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND" } }) });
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await mkdir(evidence, { recursive: true });

    await t.test("one low-contrast nebula moves at 72 seconds without rebuilding the background", async () => {
      await page.goto(origin);
      await expect(page.locator(".video-grid")).toBeVisible();
      const nebula = page.locator(".space-nebula-violet");
      await expect(nebula).toHaveCSS("animation-name", "space-nebula-drift");
      await expect(nebula).toHaveCSS("animation-duration", "72s");
      const transforms = await nebula.evaluate(node => {
        const animation = node.getAnimations()[0]!;
        animation.pause(); animation.currentTime = 0;
        const first = getComputedStyle(node).transform;
        animation.currentTime = 36000;
        return [first, getComputedStyle(node).transform];
      });
      assert.notEqual(transforms[0], transforms[1]);
      await expect(page.locator(".space-nebula-blue")).toHaveCSS("animation-name", "none");
      await page.locator(".space-atmosphere").evaluate(node => { (node as HTMLElement).dataset.fixtureIdentity = "stable-background"; });
      for (const theme of ["light", "dark"]) {
        await selectPersonalTheme(page, theme);
        await page.evaluate(() => document.getAnimations().filter(animation => animation instanceof CSSTransition).forEach(animation => animation.finish()));
        await page.screenshot({ path: `${evidence}/nebula-navigation-${theme}.png`, animations: "allow" });
      }
    });

    await t.test("title and first module enter once, not on search, paging or normal data refresh", async () => {
      const entrances = () => page.evaluate(() => (window as Window & { entranceLog?: string[] }).entranceLog ?? []);
      await expect.poll(async () => (await entrances()).length).toBe(2);
      const original = await entrances();
      assert.deepEqual(original.sort(), ["heading", "module"]);
      await page.getByRole("button", { name: "搜索", exact: true }).click();
      await page.getByRole("searchbox").fill("首屏");
      await page.getByRole("button", { name: "应用搜索", exact: true }).click();
      await expect(page.locator(".loading")).toHaveCount(0);
      const beforeScroll = await page.locator(".video-card").count();
      await page.locator(".infinite-sentinel").scrollIntoViewIfNeeded();
      await expect(page.locator(".video-card").count()).toBeGreaterThan(beforeScroll);
      await expect(page.locator(".video-grid")).toBeVisible();
      assert.deepEqual(await entrances(), original);
      await expect(page.locator(".space-enter-heading, .space-enter-module")).toHaveCount(0);
    });

    await t.test("orbit marker follows the selected menu and preserves keyboard focus and aria-current", async () => {
      const menu = page.getByRole("navigation", { name: "系统主菜单" });
      const marker = menu.locator(".side-nav-orbit");
      await expect(marker).toHaveAttribute("data-ready", "true");
      await expect(marker).toHaveCSS("pointer-events", "none");
      await expect(marker).toHaveCSS("transition-duration", "0.32s");
      const before = await marker.evaluate(node => getComputedStyle(node).transform);
      const tasksLink = menu.getByRole("link", { name: "任务列表" });
      await tasksLink.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "任务列表", exact: true })).toBeVisible();
      await expect(tasksLink).toHaveAttribute("aria-current", "page");
      await expect(tasksLink).toBeFocused();
      await expect.poll(() => marker.evaluate(node => getComputedStyle(node).transform)).not.toBe(before);
      await expect.poll(() => marker.evaluate(node => {
        const current = node.parentElement!.querySelector('[aria-current="page"]')!.getBoundingClientRect();
        const box = node.getBoundingClientRect();
        return Math.abs(box.top + box.height / 2 - current.top - current.height / 2);
      })).toBeLessThan(1);
      assert.equal(await menu.getByRole("link").count(), 8);
      await expect(menu.getByRole("link", { name: "访客管理", exact: true })).toHaveAttribute("href", "/guests");
      await expect(page.locator(".space-atmosphere")).toHaveAttribute("data-fixture-identity", "stable-background");
    });

    await t.test("100% and historical success have no halo; genuine new confirmation expands exactly once", async () => {
      await expect(page.locator(".task-completion-halo")).toHaveCount(0);
      await expect(page.locator('[data-task-id="new-confirmation"]')).toContainText("尚未确认视频登记");
      await page.getByRole("button", { name: "重试完成确认", exact: true }).click();
      await expect.poll(() => confirmationRequested).toBe(true);
      await expect(page.locator(".task-completion-halo")).toHaveCount(0);
      await selectPersonalTheme(page, "light");
      releaseConfirmation();
      const halo = page.locator('[data-task-id="new-confirmation"] .task-completion-halo');
      await expect(halo).toHaveCount(1);
      await expect(halo).toHaveCSS("pointer-events", "none");
      await halo.evaluate(node => { const animation = node.getAnimations()[0]; if (animation) { animation.pause(); animation.currentTime = 250; } });
      await page.evaluate(() => document.getAnimations().filter(animation => animation instanceof CSSTransition).forEach(animation => animation.finish()));
      await page.screenshot({ path: `${evidence}/completion-halo-light.png`, animations: "allow" });
      await selectPersonalTheme(page, "dark");
      await page.evaluate(() => document.getAnimations().filter(animation => animation instanceof CSSTransition).forEach(animation => animation.finish()));
      await page.screenshot({ path: `${evidence}/completion-halo-dark.png`, animations: "allow" });
      await expect(halo).toHaveCount(0);
      await page.getByRole("button", { name: "刷新任务历史", exact: true }).click();
      await expect(page.locator(".loading")).toHaveCount(0);
      await expect(page.locator(".task-completion-halo")).toHaveCount(0);
      await page.getByRole("navigation", { name: "系统主菜单" }).getByRole("link", { name: "高光时刻" }).click();
      await page.getByRole("navigation", { name: "系统主菜单" }).getByRole("link", { name: "任务列表" }).click();
      await expect(page.locator('[data-task-id="new-confirmation"]')).toBeVisible();
      await expect(page.locator(".task-completion-halo")).toHaveCount(0);
    });

    await t.test("individual switches, global static and reduced-motion keep selection accurate without animation", async () => {
      await openSpaceSettings(page);
      await page.getByRole("tab", { name: "其他动效", exact: true }).click();
      await page.getByRole("checkbox", { name: /^星云慢漂移/ }).uncheck();
      await page.getByRole("checkbox", { name: /^导航轨道指示/ }).uncheck();
      await page.getByRole("button", { name: "保存星空设置", exact: true }).click();
      await expect(page.locator(".space-nebula-violet")).toHaveCSS("animation-name", "none");
      await expect(page.locator(".side-nav-orbit")).toHaveCSS("transition-duration", "0s");
      await openSpaceSettings(page);
      await page.getByRole("tab", { name: "其他动效", exact: true }).click();
      await page.getByRole("checkbox", { name: /^星云慢漂移/ }).check();
      await page.getByRole("checkbox", { name: /^导航轨道指示/ }).check();
      await page.getByRole("button", { name: "保存星空设置", exact: true }).click();
      await setSpaceEnabled(page, false);
      await expect(page.locator(".space-nebula-violet")).toHaveCSS("animation-name", "none");
      await expect(page.locator(".side-nav-orbit")).toHaveCSS("transition-duration", "0s");
      await setSpaceEnabled(page, true);
      await page.getByRole("navigation", { name: "系统主菜单" }).getByRole("link", { name: "任务列表", exact: true }).click();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(page.locator("html")).toHaveAttribute("data-space-motion", "off");
      await expect(page.locator(".space-nebula-violet")).toHaveCSS("animation-name", "none");
      await expect(page.locator(".side-nav-orbit")).toHaveCSS("transition-duration", "0s");
      await expect(page.locator(".task-completion-halo")).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "系统主菜单" }).getByRole("link", { name: "任务列表" })).toHaveAttribute("aria-current", "page");
      await page.setViewportSize({ width: 375, height: 812 });
      await page.screenshot({ path: `${evidence}/remaining-effects-mobile-static.png`, animations: "allow" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });
    assert.deepEqual(errors, []);
    console.log(`Remaining effects screenshots: ${evidence}`);
  } finally {
    await browser?.close();
    await server.close();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import type { UploadTask, VideoDetail } from "@online-video/shared";
import { spaceMotionStorageKey } from "../src/space-motion";
import { DEFAULT_SPACE_SETTINGS, SPACE_EFFECTS_STORAGE_KEY } from "../src/space-meteor-settings";
import { fixtureSiteSettings, openSpaceSettings, selectPersonalTheme, setSpaceEnabled } from "./page-settings-helpers";

const evidence = fileURLToPath(new URL(`../../../.local/acceptance/space-a-${randomUUID()}/`, import.meta.url));
const mediaOrigin = "https://space-preview.example";

// Only the isolated browser fixture uses these covers and sample records.
function sampleCover(index: number) {
  const colors = ["#5ec5d7", "#d3a580", "#81a7db", "#86b9a4"];
  const color = colors[index % colors.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><radialGradient id="sky"><stop stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="#081321"/></radialGradient><linearGradient id="planet"><stop stop-color="${color}"/><stop offset="1" stop-color="#10253a"/></linearGradient></defs><rect width="640" height="360" fill="#081321"/><rect width="640" height="360" fill="url(#sky)"/><g fill="#e5f4ff" opacity=".6"><circle cx="45" cy="80" r="1.5"/><circle cx="140" cy="36" r="1"/><circle cx="600" cy="110" r="2"/><circle cx="510" cy="48" r="1"/><circle cx="220" cy="270" r="1"/></g><circle cx="${340 + index * 12}" cy="140" r="${65 + index * 5}" fill="url(#planet)"/><ellipse cx="${340 + index * 12}" cy="140" rx="185" ry="40" transform="rotate(-24 ${340 + index * 12} 140)" fill="none" stroke="${color}" opacity=".65"/><path d="M0 320 70 260 150 296 260 245 345 292 445 228 545 278 640 242V360H0Z" fill="#0a1726"/><path d="M0 340 115 310 248 330 390 280 520 320 640 290V360H0Z" fill="#060f1c"/></svg>`;
}

test("scheme A+: decorative isolation, dynamic atmosphere, playback focus and responsive layout", { timeout: 120000 }, async t => {
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), cacheDir: `${evidence}/vite-cache`, mode: "test", plugins: [react()], server: { host: "127.0.0.1", port: 0, watch: null, hmr: false } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Missing preview address");
    const origin = `http://127.0.0.1:${address.port}`;
    const media = await readFile(new URL("./fixtures/cover-timeline.mp4", import.meta.url));
    const titles = ["环星航行", "远方的地平线", "深空观测", "山海之间", "月面漫步", "日落航线", "轨道之外", "旅行手记"];
    const videos: VideoDetail[] = titles.map((title, index) => ({ id: `space-${index}`, title: `${title} · 预览样例`, categoryId: "space", tags: [index % 2 ? "旅行" : "宇宙"], fileName: `sample-${index}.mp4`, objectKey: `media/sample-${index}.mp4`, publicUrl: `${mediaOrigin}/media/sample-${index}.mp4`, coverUrl: `${mediaOrigin}/media/cover-${index}.svg`, sizeBytes: media.length, durationSeconds: 23.4, status: "ready", thumbnailUrl: null, createdAt: "2026-10-01T10:00:00.000Z", codec: "H.264", width: 640, height: 360, playable: true, lastPositionSeconds: 0 }));
    const tasks: UploadTask[] = [0, 1, 2].map((parts, index) => ({ id: `task-${index}`, videoId: null, title: `传输样例 ${index + 1}`, fileName: `sample-${index}.webm`, sizeBytes: 1024, partSizeBytes: 512, status: index === 2 ? "finalizing" : "uploading", createdAt: "2026-10-01T10:00:00.000Z", uploadedParts: Array.from({ length: parts }, (_, part) => ({ partNumber: part + 1, sizeBytes: 512, checksum: "a".repeat(64) })) }));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, reducedMotion: "reduce" });
    await context.addInitScript("window.__name = (fn) => fn;");
    await context.addInitScript(({ key, defaults }) => {
      let seed = 7291;
      Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ ...defaults, shower: { ...defaults.shower, enabled: false, probability: 0 } })); } catch { /* 存储受限场景使用内存默认值。 */ }
    }, { key: SPACE_EFFECTS_STORAGE_KEY, defaults: DEFAULT_SPACE_SETTINGS });
    const unexpectedRequests: string[] = [];
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === mediaOrigin) {
        const cover = url.pathname.match(/cover-(\d+)\.svg$/);
        if (cover) return route.fulfill({ contentType: "image/svg+xml", body: sampleCover(Number(cover[1])) });
        // 支持真实字节范围，避免媒体替身把跳转末尾悄悄回退到开头。
        const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
        return route.fulfill({ status: range ? 206 : 200, contentType: "video/mp4", headers: { "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${media.length}` } : {}) }, body: media.subarray(start, end + 1) });
      }
      if (url.origin !== origin) { unexpectedRequests.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      const ok = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
      switch (url.pathname) {
        case "/api/setup/status": return ok({ stage: "ready", authenticated: false, setupAvailable: false });
        case "/api/auth/me": return ok({ user: { id: "preview-owner", displayName: "界面预览", totpEnabled: false, authMethod: "password", authVersion: 1, emailMasked: null, emailVerified: false }, csrfToken: "preview-csrf" });
        case "/api/library": return ok({ mediaBaseUrl: mediaOrigin, objectPrefix: "media/", categories: [{ id: "space", name: "私人影像", tags: ["宇宙", "旅行"] }] });
        case "/api/settings/limits": return ok({ maxUploadBytes: 2147483648, partSizeBytes: 65536, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 });
        case "/api/settings/site": return ok(fixtureSiteSettings);
        case "/api/videos": { const query = url.searchParams.get("q") ?? ""; const items = videos.filter(video => video.title.includes(query)); return ok({ items, total: items.length, page: 1, pageSize: 12 }); }
        case "/api/uploads": return ok({ items: tasks, total: tasks.length, page: 1, pageSize: 20 });
        case "/api/videos/space-0": return ok(videos[0]);
        case "/api/videos/space-0/progress": return ok({ videoId: "space-0", positionSeconds: 0, updatedAt: null });
        case "/api/videos/space-2": return ok(videos[2]);
        case "/api/videos/space-2/progress": return ok({ videoId: "space-2", positionSeconds: 0, updatedAt: null });
        default: return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND" } }) });
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await mkdir(evidence, { recursive: true });
    const assertWidth = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const settleSurfaces = () => page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
    });

    await t.test("both themes keep eight real DOM cards; decoration cannot capture clicks or focus", async () => {
      for (const theme of ["light", "dark"]) {
        await page.goto(origin);
        await expect(page.locator(".video-card")).toHaveCount(8);
        await selectPersonalTheme(page, theme);
        await expect(page.locator(".space-atmosphere")).toHaveAttribute("aria-hidden", "true");
        await expect(page.locator(".space-atmosphere")).toHaveCSS("pointer-events", "none");
        await expect(page.locator(".orbit-chart")).toHaveAttribute("focusable", "false");
        await expect.poll(() => page.locator(".thumbnail img, img.thumbnail").evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
        await assertWidth();
        await page.screenshot({ path: `${evidence}/library-${theme}.png`, fullPage: true });
        const firstLink = page.locator(".video-card-preview").first();
        await firstLink.focus();
        assert.equal(await firstLink.locator(".thumbnail-wrapper").evaluate(node => getComputedStyle(node, "::after").opacity), "1");
        await page.keyboard.press("Enter");
        await expect(page.locator("video")).toBeVisible();
        await expect(page.locator(".player-frame")).toHaveCSS("background-color", "rgb(2, 6, 23)");
        await page.screenshot({ path: `${evidence}/player-${theme}.png`, fullPage: true });
        await page.goto(`${origin}/upload`);
        await expect(page.getByRole("button", { name: "选择视频文件", exact: true })).toBeEnabled();
        await expect(page.locator(".pending-upload-empty .orbit-illustration")).toBeVisible();
        await page.screenshot({ path: `${evidence}/upload-${theme}.png`, fullPage: true });
        const dropzone = page.getByRole("button", { name: "选择视频文件", exact: true });
        const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
        await dropzone.dispatchEvent("dragover", { dataTransfer });
        await expect(dropzone).toHaveClass(/dragging/);
        await expect(dropzone.locator(".radar-pulse-ring.delay")).toHaveCSS("animation-name", "none");
        await dropzone.dispatchEvent("dragleave");
        await dataTransfer.dispose();
      }
    });

    await t.test("video data panel hides the public address by default and supports mouse and keyboard toggling", async () => {
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ["light", "dark"]) {
          await page.goto(`${origin}/videos/space-0`);
          await selectPersonalTheme(page, theme);
          const panel = page.locator("details.sci-data-panel");
          const toggle = panel.locator("summary");
          const address = panel.getByLabel("公共地址", { exact: true });
          await expect(toggle).toContainText("数据面板");
          await expect(panel).not.toHaveAttribute("open");
          await expect(address).toBeHidden();
          await expect(panel.locator(".sci-data-grid")).toBeHidden();
          await expect(page.locator(".video-detail-bar").getByLabel("公共地址", { exact: true })).toHaveCount(0);
          await assertWidth();
          await panel.screenshot({ path: `${evidence}/video-panel-collapsed-${theme}-${width}.png` });

          await page.locator("video").evaluate(node => { node.dataset.panelTest = "same-player"; });
          await toggle.click();
          await expect(panel).toHaveAttribute("open", "");
          await expect(toggle.locator(".sci-data-panel-collapse")).toBeVisible();
          await expect(address).toBeVisible();
          await expect(address).toHaveValue(videos[0]!.publicUrl!);
          await expect(address).not.toBeEditable();
          await expect(panel.getByRole("link", { name: "打开原地址", exact: true })).toHaveAttribute("href", videos[0]!.publicUrl!);
          await expect(panel.getByRole("button", { name: "复制公共地址", exact: true })).toBeVisible();
          await expect(panel.locator(".sci-data-cell")).toHaveCount(7);
          await assertWidth();
          await panel.screenshot({ path: `${evidence}/video-panel-expanded-${theme}-${width}.png` });

          await toggle.focus();
          await page.keyboard.press("Enter");
          await expect(address).toBeHidden();
          await page.keyboard.press("Space");
          await expect(address).toBeVisible();
          await expect(page.locator("video")).toHaveAttribute("data-panel-test", "same-player");
          await page.reload();
          await expect(page.locator("video")).toBeVisible();
          await expect(address).toBeHidden();
        }
      }
      await page.setViewportSize({ width: 1600, height: 1100 });
    });

    await t.test("empty state and confirmed-byte rings never invent completion", async () => {
      await page.goto(`${origin}/?q=no-match`);
      await expect(page.getByRole("heading", { name: "没有找到匹配的视频" })).toBeVisible();
      await expect(page.locator(".empty .orbit-illustration")).toBeVisible();
      await page.screenshot({ path: `${evidence}/empty-dark.png`, fullPage: true });
      await page.goto(`${origin}/tasks`);
      await expect(page.locator("tr[data-task-id]")).toHaveCount(3);
      const ringProgress: string[] = [];
      for (const id of ["task-0", "task-1", "task-2"]) {
        await page.locator(`[data-task-id="${id}"]`).getByRole("button", { name: "查看详情", exact: true }).click();
        ringProgress.push((await page.getByRole("dialog", { name: "任务详情", exact: true }).locator(".transfer-orbit").getAttribute("data-progress"))!);
        await page.keyboard.press("Escape");
      }
      assert.deepEqual(ringProgress, ["0", "50", "100"]);
      await expect(page.locator('[data-task-id="task-2"]')).toContainText("尚未确认视频登记");
      await expect(page.locator('[data-task-id="task-2"]')).not.toContainText("视频已登记");
      await page.screenshot({ path: `${evidence}/tasks-dark.png`, fullPage: true });
    });

    await t.test("mobile, tablet and short desktop preserve navigation and one-screen upload layout", async () => {
      for (const width of [320, 375, 768, 1280]) {
        await page.setViewportSize({ width, height: width === 1280 ? 720 : 900 });
        for (const theme of ["light", "dark"]) {
          await page.goto(origin);
          await expect(page.locator(".video-card")).toHaveCount(8);
          await selectPersonalTheme(page, theme);
          await assertWidth();
          if (width <= 375) {
            assert.equal(await page.locator(".video-card-actions").count(), 0, "窄屏卡片不再渲染操作按钮");
            assert.equal(await page.locator(".library-page .video-grid").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length), 2, "窄屏为双列网格");
          }
          if (width === 375) await page.screenshot({ path: `${evidence}/mobile-${theme}.png`, fullPage: true });
          await page.goto(`${origin}/upload`);
          await expect(page.getByRole("button", { name: "选择视频文件", exact: true })).toBeEnabled();
          await assertWidth();
          if (width === 1280) {
            assert.equal(await page.locator(".prepared-upload-page").evaluate(node => node.getBoundingClientRect().bottom <= innerHeight + 1), true);
            await page.screenshot({ path: `${evidence}/upload-1280-${theme}.png` });
          }
        }
      }
    });

    await t.test("the sky and orbital nodes really animate; keyboard toggle persists independently of theme", async () => {
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(origin);
      await expect(page.locator("html")).toHaveAttribute("data-space-motion", "on");
      await expect(page.locator(".space-star")).toHaveCount(112);
      await expect(page.locator(".space-star-twinkle")).toHaveCount(14);
      const star = page.locator(".space-star-twinkle").first();
      await expect(star).toHaveCSS("animation-name", "space-twinkle");
      const time = await star.evaluate(node => Number(node.getAnimations()[0]?.currentTime ?? -1));
      assert.ok(time >= 0);
      await expect.poll(() => star.evaluate(node => Number(node.getAnimations()[0]?.currentTime ?? -1))).toBeGreaterThan(time + 100);
      const traveler = page.locator(".orbit-chart-traveler").first();
      const x = await traveler.evaluate(node => node.getBoundingClientRect().x);
      await expect.poll(() => traveler.evaluate(node => node.getBoundingClientRect().x).then(next => Math.abs(next - x))).toBeGreaterThan(1);
      for (const theme of ["light", "dark"]) {
        await selectPersonalTheme(page, theme);
        await settleSurfaces();
        await page.screenshot({ path: `${evidence}/library-motion-${theme}.png`, fullPage: true });
      }
      await setSpaceEnabled(page, false);
      await expect(star).toHaveCSS("animation-name", "none");
      await expect(traveler).toHaveCSS("animation-name", "none");
      assert.equal(await page.evaluate(key => localStorage.getItem(key), spaceMotionStorageKey), "off");
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-space-motion", "off");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(page.locator(".video-card")).toHaveCount(8);
      await selectPersonalTheme(page, "light");
      await expect(page.locator("html")).toHaveAttribute("data-space-motion", "off");
      await page.goto(`${origin}/upload`);
      const transfer = await page.evaluateHandle(() => new DataTransfer());
      const dropzone = page.getByRole("button", { name: "选择视频文件", exact: true });
      await dropzone.dispatchEvent("dragover", { dataTransfer: transfer });
      await expect(dropzone.locator(".radar-pulse-ring.delay")).toHaveCSS("animation-name", "none");
      await expect(dropzone.locator(".upload-orbit-satellite")).toHaveCSS("animation-name", "none");
      await dropzone.dispatchEvent("dragleave");
      await transfer.dispose();
      await setSpaceEnabled(page, true);
    });

    await t.test("SPA navigation reuses one background, planet and running orbital timeline", async () => {
      await page.goto(origin);
      await expect(page.locator(".video-card")).toHaveCount(8);
      const atmosphere = await page.locator(".space-atmosphere").elementHandle();
      const chart = await page.locator(".space-atmosphere > .orbit-chart").elementHandle();
      const foreground = await page.locator(".space-meteors-foreground").elementHandle();
      assert.ok(atmosphere && chart && foreground);
      const timeline = await page.locator(".orbit-chart-traveler").first().evaluateHandle(node => node.getAnimations()[0]!);
      const time = await timeline.evaluate(animation => Number(animation.currentTime));
      const verifyShared = async () => {
        await expect(page.locator(".orbit-chart")).toHaveCount(1);
        assert.equal(await atmosphere.evaluate(node => node === document.querySelector(".space-atmosphere")), true);
        assert.equal(await chart.evaluate(node => node === document.querySelector(".space-atmosphere > .orbit-chart")), true);
        assert.equal(await foreground.evaluate(node => node === document.querySelector(".space-meteors-foreground")), true);
        assert.equal(await timeline.evaluate(animation => animation === document.querySelector(".orbit-chart-traveler")?.getAnimations()[0]), true);
        await expect(page.locator(".orbit-chart-traveler").first()).toHaveCSS("animation-play-state", "running");
        await assertWidth();
      };
      try {
        for (const [name, heading] of [["上传视频", "上传 / 编辑视频"], ["任务列表", "任务列表"], ["高光时刻", "云影匣·高光时刻"]]) {
          await page.getByRole("navigation", { name: "系统主菜单", exact: true }).getByRole("link", { name: name!, exact: true }).click();
          await expect(page.getByRole("heading", { name: heading!, exact: true })).toBeVisible();
          await verifyShared();
        }
        await page.locator(".video-card-preview").first().click();
        await expect(page.locator("video")).toBeVisible();
        await verifyShared();
        assert.ok(await timeline.evaluate(animation => Number(animation.currentTime)) > time);
      } finally {
        await atmosphere.dispose();
        await chart.dispose();
        await foreground.dispose();
        await timeline.dispose();
      }
    });

    await t.test("system reduced motion overrides the switch and preference changes synchronize across tabs", async () => {
      await page.goto(origin);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openSpaceSettings(page);
      await expect(page.getByRole("button", { name: "立即预览流星雨", exact: true })).toBeDisabled();
      await expect(page.getByRole("checkbox", { name: /^启用动态星空/ })).toBeChecked();
      await expect(page.locator(".space-star-twinkle").first()).toHaveCSS("animation-name", "none");
      await expect(page.locator(".orbit-chart-traveler").first()).toHaveCSS("animation-name", "none");
      await expect(page.locator(".space-meteors-foreground")).toBeHidden();
      await expect(page.locator(".space-meteor")).toHaveCount(0);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await expect(page.getByRole("button", { name: "立即预览流星雨", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      const other = await context.newPage();
      try {
        await other.goto(origin);
        await other.evaluate(key => localStorage.setItem(key, "off"), spaceMotionStorageKey);
        await expect(page.locator("html")).toHaveAttribute("data-space-motion", "off");
        await other.evaluate(key => localStorage.removeItem(key), spaceMotionStorageKey);
        await expect(page.locator("html")).toHaveAttribute("data-space-motion", "on");
      } finally { await other.close(); }
    });

    await t.test("background visibility pauses decorative timelines and restores them without a timer loop", async () => {
      await page.goto(origin);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect(page.locator("html")).toHaveAttribute("data-space-paused", "true");
      await expect(page.locator(".space-star-twinkle").first()).toHaveCSS("animation-play-state", "paused");
      await expect(page.locator(".space-atmosphere > .orbit-chart .orbit-chart-traveler").first()).toHaveCSS("animation-play-state", "paused");
      await expect(page.locator(".orbit-chart-traveler").first()).toHaveCSS("animation-play-state", "paused");
      await expect(page.locator(".space-meteors-foreground")).toHaveCSS("visibility", "hidden");
      await expect(page.locator(".space-meteor")).toHaveCount(0);
      await page.evaluate(() => {
        Reflect.deleteProperty(document, "visibilityState");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect(page.locator("html")).toHaveAttribute("data-space-paused", "false");
      await expect(page.locator(".orbit-chart-traveler").first()).toHaveCSS("animation-play-state", "running");
    });

    await t.test("upload hover, keyboard focus and drag-in animate only the enabled source", async () => {
      await page.goto(`${origin}/upload`);
      const dropzone = page.getByRole("button", { name: "选择视频文件", exact: true });
      await expect(dropzone).toBeEnabled();
      await selectPersonalTheme(page, "dark");
      const satellite = dropzone.locator(".upload-orbit-satellite");
      await dropzone.hover();
      await expect(satellite).toHaveCSS("animation-name", "station-satellite");
      await expect(page.getByRole("button", { name: "选择文件夹", exact: true }).locator(".upload-orbit-satellite")).toHaveCSS("animation-name", "none");
      await dropzone.focus();
      await page.mouse.move(0, 0);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(dropzone).toBeFocused();
      await expect(satellite).toHaveCSS("animation-name", "station-satellite");
      const transfer = await page.evaluateHandle(() => new DataTransfer());
      await dropzone.dispatchEvent("dragover", { dataTransfer: transfer });
      await expect(dropzone.locator(".radar-pulse-ring.delay")).toHaveCSS("animation-name", "station-acquire");
      const time = await satellite.evaluate(node => Number(node.getAnimations()[0]?.currentTime ?? -1));
      await expect.poll(() => satellite.evaluate(node => Number(node.getAnimations()[0]?.currentTime ?? -1))).toBeGreaterThan(time + 100);
      await page.screenshot({ path: `${evidence}/upload-motion-dark.png`, fullPage: true });
      await dropzone.dispatchEvent("dragleave");
      await transfer.dispose();
      await page.locator('.side-nav-menu a[href="/pages"]').focus();
      await expect(satellite).toHaveCSS("animation-name", "none");
    });

    await t.test("real playback dims decoration only; pause, ended and navigation restore the environment", async () => {
      await page.goto(`${origin}/videos/space-0`);
      const video = page.locator("video");
      const textColor = await page.locator(".video-header-title").evaluate(node => getComputedStyle(node).color);
      await video.evaluate(async element => { const node = element as HTMLVideoElement; node.muted = true; await node.play(); });
      await expect(page.locator("html")).toHaveAttribute("data-space-playing", "true");
      await expect(page.locator("html")).toHaveAttribute("data-space-paused", "true");
      await expect(page.locator(".space-atmosphere")).toHaveCSS("opacity", "0.2");
      await expect(page.locator(".space-star-twinkle").first()).toHaveCSS("animation-play-state", "paused");
      await expect(page.locator(".space-meteors-foreground")).toHaveCSS("visibility", "hidden");
      await expect(page.locator(".space-meteors-background")).toHaveCSS("visibility", "hidden");
      await expect(video).toHaveCSS("filter", "none");
      await expect(page.locator(".player-frame")).toHaveCSS("background-color", "rgb(2, 6, 23)");
      assert.equal(await page.locator(".video-header-title").evaluate(node => getComputedStyle(node).color), textColor);
      await page.screenshot({ path: `${evidence}/player-focused-dark.png`, fullPage: true });
      await video.evaluate(node => (node as HTMLVideoElement).pause());
      await expect(page.locator("html")).toHaveAttribute("data-space-playing", "false");
      await expect(page.locator(".space-atmosphere")).toHaveCSS("opacity", "1");
      await video.evaluate(async element => { const node = element as HTMLVideoElement; node.currentTime = node.duration - .15; await node.play(); });
      await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).ended)).toBe(true);
      await expect(page.locator("html")).toHaveAttribute("data-space-playing", "false");
      await video.evaluate(async element => { const node = element as HTMLVideoElement; node.currentTime = 0; await node.play(); });
      await expect(page.locator("html")).toHaveAttribute("data-space-playing", "true");
      await page.getByRole("link", { name: "返回", exact: true }).click();
      await expect(page.locator(".video-card")).toHaveCount(8);
      await expect(page.locator("html")).toHaveAttribute("data-space-playing", "false");
      await expect(page.locator("html")).toHaveAttribute("data-space-paused", "false");
      await page.goto(`${origin}/videos/space-0`);
      await video.evaluate(async element => { const node = element as HTMLVideoElement; node.muted = true; await node.play(); });
      await expect(page.locator("html")).toHaveAttribute("data-space-playing", "true");
      await video.evaluate(node => node.remove());
      await expect(page.locator("html")).toHaveAttribute("data-space-playing", "false");
    });

    await t.test("colorful meteors cross the page with trails, yield to inputs and cannot intercept clicks", async () => {
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.goto(origin);
      await expect(page.locator(".video-card")).toHaveCount(8);
      await page.evaluate(({ key, defaults }) => {
        localStorage.setItem(key, JSON.stringify({ ...defaults, normal: { ...defaults.normal, batchMin: 6, batchMax: 6, maxVisible: 6, intervalMin: .1, intervalMax: .1, durationMin: 8, durationMax: 8, foregroundRatio: 100 }, shower: { ...defaults.shower, enabled: false } }));
        window.dispatchEvent(new StorageEvent("storage", { key, storageArea: localStorage }));
      }, { key: SPACE_EFFECTS_STORAGE_KEY, defaults: DEFAULT_SPACE_SETTINGS });
      await expect(page.locator(".space-meteors-foreground .space-meteor")).toHaveCount(6);
      await expect(page.locator(".space-meteors-background .space-meteor")).toHaveCount(0);
      for (const layer of ["background", "foreground"]) {
        await expect(page.locator(`.space-meteors-${layer}`)).toHaveAttribute("aria-hidden", "true");
        await expect(page.locator(`.space-meteors-${layer}`)).toHaveCSS("pointer-events", "none");
      }
      await expect(page.locator(".space-meteors-foreground")).toHaveCSS("position", "fixed");
      assert.equal(await page.locator(".space-meteors-foreground").evaluate(node => Number(getComputedStyle(node).zIndex) > 0), true);
      assert.ok(await page.locator(".space-meteor").evaluateAll(nodes => new Set(nodes.map(node => getComputedStyle(node).color)).size) >= 2);
      assert.ok(await page.locator(".space-meteor").evaluateAll(nodes => new Set(nodes.map(node => node.getAttribute("data-meteor-size"))).size) > 1);
      const near = page.locator(".space-meteors-foreground .space-meteor").first();
      const time = await near.evaluate(node => Number(node.getAnimations()[0]?.currentTime ?? -1));
      await expect.poll(() => near.evaluate(node => Number(node.getAnimations()[0]?.currentTime ?? -1))).toBeGreaterThan(time + 100);
      const seekMeteor = (selector: string, elapsed: number) => page.locator(selector).evaluate(async (node, elapsed) => {
        const animation = node.getAnimations()[0]!;
        animation.pause();
        await animation.ready;
        animation.currentTime = Number(animation.effect!.getTiming().delay) + elapsed;
      }, elapsed);
      const nearSelector = ".space-meteors-foreground .space-meteor:first-child";
      await seekMeteor(nearSelector, 1000);
      const before = await near.evaluate(node => node.getBoundingClientRect().x);
      await seekMeteor(nearSelector, 4000);
      assert.ok(await near.evaluate(node => node.getBoundingClientRect().x) < before - 200);
      await page.locator(".space-meteor").evaluateAll(nodes => {
        for (const node of nodes) {
          const animation = node.getAnimations()[0]!;
          animation.pause();
          animation.currentTime = Number(animation.effect!.getTiming().duration) * .45;
        }
      });
      assert.ok(await page.locator(`${nearSelector} .meteor-streak`).evaluate(node => node.getBoundingClientRect().width) > 50);
      assert.ok(await page.locator(nearSelector).evaluate(node => Number(getComputedStyle(node).opacity)) > .3);
      for (const theme of ["light", "dark"]) {
        await selectPersonalTheme(page, theme);
        await page.screenshot({ path: `${evidence}/meteors-over-content-${theme}.png`, animations: "allow" });
      }
      await page.getByRole("button", { name: "搜索", exact: true }).click();
      const search = page.getByRole("searchbox");
      await search.fill("输入时避让");
      await expect(page.locator(".space-meteors-foreground")).toHaveCSS("visibility", "hidden");
      await expect(page.locator(nearSelector)).toHaveCSS("animation-play-state", "paused");
      await search.fill("");
      await page.locator('.side-nav-menu a[href="/pages"]').focus();
      await expect(page.locator(".space-meteors-foreground")).toHaveCSS("visibility", "visible");
      // 将现有星核定位到卡片链接内部，命中测试不依赖随机轨迹落点。
      const cardPoint = await page.locator('.video-card-preview[href="/videos/space-2"]').evaluate(node => { const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
      await page.locator(nearSelector).evaluate((node, point) => { const element = node as HTMLElement; element.style.setProperty("animation", "none"); element.style.transform = "none"; element.style.left = `${point.x}px`; element.style.top = `${point.y}px`; element.style.opacity = "1"; }, cardPoint);
      const point = await page.locator(`${nearSelector} .meteor-head`).evaluate(node => {
        const box = node.getBoundingClientRect();
        const x = box.x + box.width / 2; const y = box.y + box.height / 2;
        return { x, y, target: document.elementFromPoint(x, y)?.closest("a.video-card-preview")?.getAttribute("href") };
      });
      assert.equal(point.target, "/videos/space-2");
      await page.mouse.click(point.x, point.y);
      await expect(page.locator("video")).toBeVisible();
      assert.ok(page.url().endsWith("/videos/space-2"));
      await page.evaluate(({ key, defaults }) => { localStorage.setItem(key, JSON.stringify({ ...defaults, shower: { ...defaults.shower, enabled: false } })); }, { key: SPACE_EFFECTS_STORAGE_KEY, defaults: DEFAULT_SPACE_SETTINGS });
    });

    await t.test("rain covers the viewport without a light curtain; settings preview and three groups render in both themes and on phones", async () => {
      await page.evaluate(({ key, defaults }) => localStorage.setItem(key, JSON.stringify({ ...defaults, normal: { ...defaults.normal, intervalMin: 1, intervalMax: 1 }, shower: { ...defaults.shower, enabled: true, probability: 100, batchMin: 8, batchMax: 8, maxVisible: 24, intervalMin: .1, intervalMax: .1, durationMin: 2.8, durationMax: 2.8 } })), { key: SPACE_EFFECTS_STORAGE_KEY, defaults: DEFAULT_SPACE_SETTINGS });
      const visual = await context.newPage();
      visual.on("pageerror", error => errors.push(error.message));
      const time = new Date("2026-10-28T10:00:00Z");
      try {
        await visual.emulateMedia({ reducedMotion: "no-preference" });
        await visual.clock.install({ time });
        await visual.clock.pauseAt(new Date(time.getTime() + 1000));
        await visual.goto(origin);
        await expect(visual.locator(".video-card")).toHaveCount(8);
        await visual.clock.runFor(3000);
        await expect(visual.locator(".space-meteor")).toHaveCount(24);
        const freezeScene = () => visual.evaluate(() => {
          for (const animation of document.getAnimations()) {
            const node = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
            if (node instanceof Element && node.classList.contains("space-meteor")) {
              animation.pause(); animation.currentTime = Number(animation.effect!.getTiming().duration) * .42;
            } else if (animation.effect?.getTiming().iterations !== Infinity) { animation.finish(); }
          }
        });
        for (const theme of ["light", "dark"]) {
          if (theme === "dark") {
            await visual.reload();
            await expect(visual.locator(".video-card")).toHaveCount(8);
            await visual.clock.runFor(3000);
            await expect(visual.locator(".space-meteor")).toHaveCount(24);
          }
          await selectPersonalTheme(visual, theme);
          await freezeScene();
          await visual.screenshot({ path: `${evidence}/meteor-rain-wide-${theme}.png`, animations: "allow" });
          await openSpaceSettings(visual);
          await expect(visual.getByRole("dialog", { name: "星空动效设置", exact: true })).toBeInViewport();
          await expect(visual.locator("dialog[data-space-settings]")).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(15, 23, 42)");
          await expect(visual.locator(".space-meteors-background")).toHaveCSS("visibility", "visible");
          for (const [tab, file] of [["普通流星", "normal"], ["流星雨", "shower"], ["其他动效", "other"]]) {
            await visual.getByRole("tab", { name: tab!, exact: true }).click();
            await visual.evaluate(() => document.getAnimations().filter(animation => animation instanceof CSSTransition).forEach(animation => animation.finish()));
            await visual.screenshot({ path: `${evidence}/space-settings-${file}-${theme}.png`, animations: "allow" });
          }
          await visual.getByRole("button", { name: "立即预览流星雨", exact: true }).click();
          await expect(visual.locator(".space-meteors-background")).toHaveAttribute("data-shower", "true");
          await visual.getByRole("button", { name: "停止预览", exact: true }).click();
          await expect(visual.locator(".space-meteor")).toHaveCount(0);
          await visual.getByRole("button", { name: "取消", exact: true }).click();
          await visual.locator('.side-nav-menu a[href="/"]').click();
          await expect(visual.locator(".video-card")).toHaveCount(8);
        }
        for (const width of [320, 375]) {
          await visual.setViewportSize({ width, height: 900 });
          await openSpaceSettings(visual);
          await visual.getByRole("tab", { name: "流星雨", exact: true }).click();
          await visual.evaluate(() => document.getAnimations().filter(animation => animation instanceof CSSTransition).forEach(animation => animation.finish()));
          await visual.getByRole("button", { name: "立即预览流星雨", exact: true }).click();
          await visual.clock.runFor(1000);
          await freezeScene();
          await expect(visual.locator(".space-meteors-foreground .space-meteor")).toHaveCount(0);
          assert.ok(await visual.locator(".space-meteor").count() <= 8);
          assert.equal(await visual.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          assert.equal(await visual.locator("dialog[data-space-settings]").evaluate(node => node.scrollWidth <= node.clientWidth), true);
          await visual.screenshot({ path: `${evidence}/space-settings-shower-mobile-${width}.png`, animations: "allow" });
          await visual.getByRole("button", { name: "取消", exact: true }).click();
        }
      } finally {
        // Playwright 的 clock 属于整个 context，不能把后续实时时间线留在暂停态。
        await context.clock.resume();
        await visual.close();
        await page.bringToFront();
        await page.evaluate(({ key, defaults }) => localStorage.setItem(key, JSON.stringify({ ...defaults, shower: { ...defaults.shower, enabled: false } })), { key: SPACE_EFFECTS_STORAGE_KEY, defaults: DEFAULT_SPACE_SETTINGS });
      }
    });

    await t.test("empty-state satellites float and orbit; the motion switch leaves their static art visible", async () => {
      await page.goto(`${origin}/?q=no-match`);
      const art = page.locator(".empty > .satellite-illustration");
      await expect(art).toBeVisible();
      await expect(art.locator(".satellite-panels rect")).toHaveCount(2);
      const craft = art.locator(".satellite-craft");
      await expect(craft).toHaveCSS("animation-name", "satellite-hover");
      await expect(art.locator(".satellite-beacon")).toHaveCSS("animation-name", "space-orbit");
      const time = await craft.evaluate(node => Number(node.getAnimations()[0]?.currentTime ?? -1));
      await expect.poll(() => craft.evaluate(node => Number(node.getAnimations()[0]?.currentTime ?? -1))).toBeGreaterThan(time + 100);
      await page.screenshot({ path: `${evidence}/satellite-empty-dark.png`, animations: "allow" });
      await setSpaceEnabled(page, false);
      await expect(craft).toHaveCSS("animation-name", "none");
      await expect(art.locator(".satellite-beacon")).toHaveCSS("animation-name", "none");
      await expect(page.locator(".space-meteors-foreground")).toHaveCSS("visibility", "hidden");
      await expect(page.locator(".space-meteor")).toHaveCount(0);
      await expect(art).toBeVisible();
      await setSpaceEnabled(page, true);
      await page.goto(`${origin}/upload`);
      await expect(page.locator(".pending-upload-empty > .satellite-illustration")).toBeVisible();
      await expect(page.locator(".pending-upload-empty .satellite-craft")).toHaveCSS("animation-name", "satellite-hover");
      await page.screenshot({ path: `${evidence}/satellite-upload-dark.png`, animations: "allow" });
    });

    await t.test("mobile renders only 28 stars, reduces meteors and keeps page-management controls reachable", async () => {
      for (const width of [320, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(origin);
        assert.equal(await page.locator(".space-star").evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).display !== "none").length), 28);
        await expect(page.locator(".space-meteors-foreground")).toHaveCSS("display", "none");
        await expect.poll(() => page.locator(".space-meteors-background .space-meteor").count()).toBeGreaterThan(0);
        assert.ok(await page.locator(".space-meteors-background .space-meteor").count() <= 4);
        await expect(page.locator('.bottom-nav a[href="/pages"]')).toBeInViewport();
        await openSpaceSettings(page);
        await expect(page.getByRole("checkbox", { name: /^启用动态星空/ })).toBeInViewport();
        await expect(page.getByRole("button", { name: "保存星空设置", exact: true })).toBeInViewport();
        await page.getByRole("button", { name: "取消", exact: true }).click();
        await page.locator('.bottom-nav a[href="/"]').click();
        await assertWidth();
        if (width === 375) await page.screenshot({ path: `${evidence}/mobile-motion-dark.png` });
      }
    });

    await t.test("storage denial leaves the in-memory motion switch functional", async () => {
      await page.addInitScript(() => Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("Storage denied", "SecurityError"); } }));
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-space-motion", "on");
      await setSpaceEnabled(page, false, true);
      await expect(page.locator("html")).toHaveAttribute("data-space-motion", "off");
      await setSpaceEnabled(page, true, true);
      await expect(page.locator("html")).toHaveAttribute("data-space-motion", "on");
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, []);
    console.log(`Scheme A+ isolated preview screenshots: ${evidence}`);
  } finally {
    await browser?.close();
    await server.close();
  }
});

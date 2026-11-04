import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import type { LibraryConfig, VideoDetail } from "@online-video/shared";
import { BLESSING_REVEAL_MS, blessingWords } from "../src/pages/library-blessing";

const evidenceRoot = fileURLToPath(new URL(`../../../.local/acceptance/ui-home-${randomUUID()}/`, import.meta.url));
const library: LibraryConfig = {
  mediaBaseUrl: "https://media.fixture.invalid", objectPrefix: "videos/",
  categories: Array.from({ length: 14 }, (_, index) => ({ id: `category-${index}`, name: index === 0 ? "未分类" : `分类 ${index} 的较长名称`, tags: ["旅行", "家人", "逗号,标签", "第四个标签"] }))
};
const originalVideos = (): VideoDetail[] => Array.from({ length: 14 }, (_, index) => ({
  id: `video-${index}`, title: index % 2 ? `日常回忆-${index}` : `${index === 0 ? "独特片段" : "日常回忆"}：这是一个在手机中不应该撑高卡片的很长很长的视频标题-${index}`,
  categoryId: "category-0", tags: index % 3 === 1 ? [] : index % 3 === 2 ? ["旅行"] : ["旅行", "家人", "逗号,标签", "第四个标签"],
  fileName: `demo-${index}.webm`, objectKey: `videos/demo-${index}.webm`, publicUrl: `https://media.fixture.invalid/videos/demo-${index}.webm`,
  sizeBytes: index % 2 ? 2147483648 : 123456, durationSeconds: index % 2 ? null : 93,
  status: index === 2 ? "failed" : index === 3 ? "processing" : index === 4 ? "unsupported" : "ready", thumbnailUrl: null,
  coverUrl: index % 2 ? null : "https://media.fixture.invalid/videos/cover.svg", coverStatus: index % 2 ? "missing" : "saved",
  createdAt: "2026-10-30T10:00:00.000Z", codec: null, width: null, height: null, playable: index !== 2, lastPositionSeconds: 0
}));

async function fixture(context: BrowserContext, videos = originalVideos()) {
  const queries: URL[] = []; const registrations: Record<string, unknown>[] = []; let failRegistration = true;
  let holdRegistration = false; let releaseRegistration: (() => void) | undefined;
  await context.addInitScript("window.__name = (fn) => fn;");
  await context.route("https://media.fixture.invalid/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#23495d"/><circle cx="220" cy="45" r="26" fill="#e1b973"/></svg>' }));
  await context.route("**/api/**", async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const ok = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
    if (path === "/api/auth/me") return ok({ user: { id: "fixture-owner", displayName: "页面验收", totpEnabled: true, authMethod: "totp", authVersion: 1, emailMasked: null, emailVerified: false }, csrfToken: "fixture-csrf" });
    if (path === "/api/setup/status") return ok({ stage: "ready", authenticated: false, setupAvailable: false });
    if (path === "/api/library") return ok(library);
    if (path === "/api/guests" && request.method() === "GET") return ok({ items: [], persistenceAvailable: true, serverTime: new Date().toISOString() });
    if (path === "/api/settings/limits") return ok({ maxUploadBytes: 2147483648, partSizeBytes: 262144, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 });
    if (path === "/api/videos") {
      queries.push(url); const q = url.searchParams.get("q") ?? ""; const category = url.searchParams.get("categoryId");
      const tags = JSON.parse(url.searchParams.get("tags") ?? "[]") as string[]; const page = Number(url.searchParams.get("page") ?? 1);
      const filtered = videos.filter(video => (!category || video.categoryId === category) && (!q || video.title.includes(q)) && tags.every(tag => video.tags?.includes(tag)));
      return ok({ items: filtered.slice((page - 1) * 12, page * 12), total: filtered.length, page, pageSize: 12 });
    }
    if (path === "/api/videos/register-public") {
      assert.equal(request.headers()["x-csrf-token"], "fixture-csrf"); const body = request.postDataJSON() as Record<string, unknown>; registrations.push(body);
      if (holdRegistration) { holdRegistration = false; await new Promise<void>(resolve => { releaseRegistration = resolve; }); }
      if (failRegistration) { failRegistration = false; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "STORAGE_UNAVAILABLE", requestId: "fixture-registration-error" } }) }); }
      const video = { ...videos[0]!, id: "imported", title: String(body.title), publicUrl: String(body.publicUrl), categoryId: String(body.categoryId), tags: body.tags as string[] };
      videos.unshift(video); return ok(video);
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND" } }) });
  });
  return { videos, queries, registrations, holdNextRegistration: () => { holdRegistration = true; }, releaseRegistration: () => releaseRegistration?.() };
}

async function noOverflow(page: Page) {
  const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(geometry.scroll <= geometry.width, `整页横向溢出: ${JSON.stringify(geometry)}`);
}

async function cardPositions(page: Page) {
  return page.locator(".library-page .video-card").evaluateAll(nodes => nodes.map(node => {
    const bounds = node.getBoundingClientRect(); const grid = node.parentElement!.getBoundingClientRect();
    return { top: bounds.top - grid.top, bottom: bounds.bottom - grid.top, left: bounds.left - grid.left, width: bounds.width, height: bounds.height };
  }));
}

async function feedPositions(page: Page) {
  return page.locator(".library-page .library-grid-entry").evaluateAll(nodes => nodes.filter(node => node.getClientRects().length > 0).map(node => {
    const bounds = node.getBoundingClientRect(); const grid = node.parentElement!.getBoundingClientRect();
    return { top: bounds.top - grid.top, bottom: bounds.bottom - grid.top, left: bounds.left - grid.left, width: bounds.width, height: bounds.height };
  }));
}

function assertMobileColumns(cards: Awaited<ReturnType<typeof cardPositions>>) {
  assert.equal(new Set(cards.map(card => card.left)).size, 2, "手机端应保留两列");
  assert.ok(Math.abs(cards[0]!.top - cards[1]!.top) < 1, "首行两张卡片顶部必须对齐，不能通过整体下移一列制造错落");
  for (const left of new Set(cards.map(card => card.left))) {
    const column = cards.filter(card => card.left === left).sort((a, b) => a.top - b.top);
    for (let index = 1; index < column.length; index++) {
      const gap = column[index]!.top - column[index - 1]!.bottom;
      assert.ok(gap >= 9 && gap <= 14, `每个独立条目应紧接同列前一张，不得重叠或留出整行空白：gap=${gap}`);
    }
  }
}

test("首页自适应卡片、访客有效期及上传页导入在浅深色和窄屏下可用", { timeout: 180000 }, async t => {
  await mkdir(evidenceRoot, { recursive: true });
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, cacheDir: join(evidenceRoot, "vite-cache"), mode: "development", plugins: [{ name: "isolate-home-api", configureServer(server) { server.middlewares.use((request, response, next) => { if (!request.url?.startsWith("/api/")) return next(); response.statusCode = 503; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ error: { code: "SERVICE_NOT_CONFIGURED" } })); }); } }], server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen(); const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const address = server.httpServer?.address(); if (!address || typeof address === "string") throw new Error("隔离服务未监听"); const origin = `http://127.0.0.1:${address.port}`;
    await t.test("独立寄语卡片：首行对齐、随机三条循环、隐藏暂停入口与静态模式、桌面不插卡", async () => {
      for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce" });
        await context.addInitScript(value => localStorage.setItem("ov.theme.v1", value), theme);
        const videos = originalVideos().slice(0, 6).map((video, index) => ({ ...video, title: `生活片段 ${index + 1}`, tags: [], durationSeconds: 93 }));
        await fixture(context, videos); const page = await context.newPage();
        try {
          await page.goto(origin); await expect(page.locator(".video-card")).toHaveCount(6);
          for (const width of [375, 320, 600]) {
            await page.setViewportSize({ width, height: 900 });
            await expect(page.locator(".video-grid > .library-encouragement")).toHaveCount(1);
            await expect(page.locator(".video-card .library-encouragement")).toHaveCount(0);
            await expect(page.locator(".library-result-bar")).toContainText("6 个视频");
            const cards = await cardPositions(page); assertMobileColumns(await feedPositions(page));
            const baseHeight = cards[1]!.height;
            for (const index of [1, 2, 3, 4]) assert.ok(Math.abs(cards[index]!.height - baseHeight) < 1, "动画不能再作为视频内部内容拉长视频");
            for (const index of [0, 5]) assert.ok(Math.abs(cards[index]!.height - baseHeight - 12) < 1, "只有两张卡片保留少量内容区留白");
            assert.equal((await feedPositions(page)).length, 7, "六个视频与一个寄语数据条目应分别参与布局");
            await expect(page.locator(".library-encouragement-message")).toHaveCount(3);
            await expect(page.locator(".library-encouragement-cosmos")).toHaveCount(1);
            await expect(page.locator(".library-encouragement-cosmos")).toHaveCSS("position", "absolute");
            await expect(page.locator(".library-encouragement-cosmos")).toHaveCSS("pointer-events", "none");
            await expect(page.locator(".library-cosmos-orbit")).toHaveCSS("animation-name", "none");
            await expect(page.locator(".library-cosmos-meteor")).toHaveCSS("opacity", "0");
            assert.ok(await page.locator(".library-encouragement-message p").evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height <= node.parentElement!.getBoundingClientRect().height + 1)), "星空图案不得挤占用户设定高度内的文案空间");
            assert.ok(await page.locator(".library-encouragement-cosmos [id]").evaluateAll(nodes => nodes.every(node => Array.from(document.querySelectorAll("[id]")).filter(element => element.id === node.id).length === 1)), "SVG 渐变不能与其他星空组件发生 ID 冲突");
            await expect(page.locator(".library-encouragement-message").first()).toHaveCSS("opacity", "1");
            await expect(page.locator(".library-encouragement-message").nth(1)).toHaveCSS("opacity", "0");
            await expect(page.locator(".library-encouragement-pause")).toBeHidden();
            await expect(page.locator(".library-encouragement-pause")).toBeDisabled();
            await expect(page.getByRole("button", { name: "暂停寄语", exact: true })).toHaveCount(0);
            await noOverflow(page);
            await page.locator(".video-grid").evaluate(node => { node.scrollIntoView({ block: "start", behavior: "instant" }); window.scrollBy(0, -16); });
            await page.screenshot({ path: join(evidenceRoot, `six-encouragement-${width}-${theme}.png`), fullPage: false });
          }
          const encouragement = page.locator(".library-encouragement");
          const messages = encouragement.locator(".library-encouragement-message");
          const selected = await messages.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-message-id")));
          assert.equal(new Set(selected).size, 3, "每次选出的三条寄语不得重复");
          await expect(encouragement.locator(".library-encouragement-accessible li")).toHaveCount(3);
          await page.setViewportSize({ width: 375, height: 900 });
          await encouragement.evaluate(node => node.scrollIntoView({ block: "center", behavior: "instant" }));
          await page.mouse.move(0, 0);
          const staticPositions = await cardPositions(page);
          const cardHeight = await encouragement.evaluate(node => node.getBoundingClientRect().height);
          await page.emulateMedia({ reducedMotion: "no-preference" });
          await expect(messages.first()).toHaveCSS("animation-name", "library-encouragement-message");
          await expect(encouragement.locator(".library-cosmos-orbit")).toHaveCSS("animation-name", "library-cosmos-orbit");
          await expect(encouragement.locator(".library-cosmos-star").first()).toHaveCSS("animation-name", "library-cosmos-twinkle");
          const pauseControl = encouragement.locator(".library-encouragement-pause");
          await expect(pauseControl).toBeHidden();
          await pauseControl.evaluate(node => (node as HTMLButtonElement).focus());
          await expect(pauseControl).not.toBeFocused();
          // 仅冻结测试时间线，界面不再提供寄语暂停入口。
          await encouragement.evaluate(node => node.querySelectorAll("*").forEach(element => element.getAnimations().forEach(animation => animation.pause())));
          await expect.poll(() => messages.first().evaluate(node => node.getAnimations()[0]?.playState)).toBe("paused");
          await expect.poll(() => encouragement.locator(".library-cosmos-orbit").evaluate(node => node.getAnimations()[0]?.playState)).toBe("paused");
          const meteorOpacity = await encouragement.locator(".library-cosmos-meteor").evaluate(node => {
            const animation = node.getAnimations()[0]!; const timing = animation.effect!.getTiming();
            animation.currentTime = Number(timing.duration) * .73 + Number(timing.delay);
            return Number(getComputedStyle(node).opacity);
          });
          assert.ok(meteorOpacity > .5, "流星应在循环中的飞行阶段实际显现");
          for (let index = 0; index < 4; index++) {
            const opacity = await encouragement.evaluate((node, time) => {
              node.querySelectorAll(".library-encouragement-message, .library-encouragement-dots span").forEach(element => element.getAnimations().forEach(animation => { animation.currentTime = time; }));
              return Array.from(node.querySelectorAll(".library-encouragement-message")).map(element => Number(getComputedStyle(element).opacity));
            }, index * 6000 + 1000);
            assert.ok(opacity[index % 3]! > .99 && opacity.filter((_, position) => position !== index % 3).every(value => value < .01), "三条寄语应按顺序播放并回到第一条");
            if (index < 3) await encouragement.screenshot({ path: join(evidenceRoot, `encouragement-message-${index + 1}-${theme}.png`) });
          }
          await encouragement.evaluate(node => node.querySelectorAll("*").forEach(element => element.getAnimations().forEach(animation => animation.play())));
          const time = await messages.first().evaluate(node => Number(node.getAnimations()[0]!.currentTime));
          await expect.poll(() => messages.first().evaluate(node => Number(node.getAnimations()[0]!.currentTime))).toBeGreaterThan(time + 100);
          const orbitTime = await encouragement.locator(".library-cosmos-orbit").evaluate(node => Number(node.getAnimations()[0]!.currentTime));
          await expect.poll(() => encouragement.locator(".library-cosmos-orbit").evaluate(node => Number(node.getAnimations()[0]!.currentTime))).toBeGreaterThan(orbitTime + 100);
          const preferencePage = await context.newPage();
          try {
            await preferencePage.goto(origin);
            await preferencePage.evaluate(() => localStorage.setItem("ov.space-motion.v1", "off"));
            await expect(messages.first()).toHaveCSS("animation-name", "none");
            await expect(encouragement.locator(".library-cosmos-orbit")).toHaveCSS("animation-name", "none");
            await expect(pauseControl).toBeHidden();
            await expect(pauseControl).toBeDisabled();
            await preferencePage.evaluate(() => localStorage.setItem("ov.space-motion.v1", "on"));
            await expect(messages.first()).toHaveCSS("animation-name", "library-encouragement-message");
          } finally { await preferencePage.close(); }
          await page.emulateMedia({ reducedMotion: "reduce" });
          await expect(messages.first()).toHaveCSS("animation-name", "none");
          await expect(encouragement.locator(".library-cosmos-orbit")).toHaveCSS("animation-name", "none");
          await expect(messages.first()).toHaveCSS("opacity", "1");
          assert.deepEqual(await messages.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-message-id"))), selected, "重绘和切换动效不能重新抽取寄语");
          // 关闭测试标签页后，鼠标可能悬停在视频上；先排除既有的 2px 悬浮位移。
          await page.mouse.move(0, 0);
          await expect.poll(() => page.locator(".video-card").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).transform === "none"))).toBe(true);
          const reducedPositions = await cardPositions(page);
          assert.equal(await encouragement.evaluate(node => node.getBoundingClientRect().height), cardHeight, "SVG 动画不得改变用户调整后的寄语卡片高度");
          for (let index = 0; index < staticPositions.length; index++) assert.ok(Math.abs(staticPositions[index]!.top - reducedPositions[index]!.top) < 1, `动画开关不能引起布局跳动：${JSON.stringify({ index, before: staticPositions[index], after: reducedPositions[index] })}`);
          await expect(page.locator(".video-card-title-link")).toHaveText(videos.map(video => video.title));
          await page.setViewportSize({ width: 1440, height: 900 });
          await expect.poll(async () => Math.abs((await cardPositions(page))[0]!.top - (await cardPositions(page))[1]!.top)).toBeLessThan(1);
          const desktopCards = await cardPositions(page);
          await expect(encouragement).toBeHidden();
          assert.ok(Math.max(...desktopCards.map(card => card.height)) - Math.min(...desktopCards.map(card => card.height)) < 1, "手机端的局部增高不能影响桌面卡片");
          assert.equal(await page.locator(".video-card").first().evaluate(node => node.style.getPropertyValue("--library-card-rows")), "");
          await noOverflow(page);
        } finally { await context.close(); }
      }
    });
    await t.test("寄语每次进入或刷新才重新抽取，搜索与追加加载不会换组或重复插卡", async () => {
      const context = await browser.newContext({ viewport: { width: 375, height: 900 }, reducedMotion: "reduce" });
      await context.addInitScript(() => { Math.random = () => sessionStorage.getItem("encouragement-test-rng") === "last" ? .999999 : 0; });
      await fixture(context); const page = await context.newPage();
      const selected = () => page.locator(".library-encouragement-message").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-message-id")));
      const first = ["encouragement-1", "encouragement-2", "encouragement-3"];
      try {
        await page.goto(origin); await expect(page.locator(".video-card")).toHaveCount(12); assert.deepEqual(await selected(), first);
        await page.getByRole("button", { name: "搜索", exact: true }).click(); await page.getByRole("searchbox").fill("日常回忆");
        await page.getByRole("button", { name: "应用搜索", exact: true }).click(); await expect(page.locator(".video-card")).toHaveCount(12); assert.deepEqual(await selected(), first);
        await page.getByRole("button", { name: "清空搜索与标签", exact: true }).click(); await expect(page.locator(".video-card")).toHaveCount(12);
        await page.locator(".infinite-sentinel").scrollIntoViewIfNeeded(); await expect(page.locator(".video-card")).toHaveCount(14);
        await expect(page.locator(".video-grid > .library-encouragement")).toHaveCount(1); assert.deepEqual(await selected(), first);
        await page.evaluate(() => sessionStorage.setItem("encouragement-test-rng", "last"));
        await page.locator('a[href="/upload"]:visible').first().click(); await expect(page).toHaveURL(/\/upload$/);
        await page.locator('a[href="/"]:visible').first().click(); await expect(page.locator(".video-card")).toHaveCount(12);
        assert.deepEqual(await selected(), ["encouragement-30", "encouragement-1", "encouragement-2"]);
        await page.evaluate(() => sessionStorage.removeItem("encouragement-test-rng")); await page.reload();
        await expect(page.locator(".video-card")).toHaveCount(12); assert.deepEqual(await selected(), first);
      } finally { await context.close(); }
    });
    await t.test("点击彩蛋：全屏流星雨后展示祝福语，防重入、自动恢复、取消及减少动效", async () => {
      const longestIndex = blessingWords.reduce((longest, word, index) => Array.from(word).length > Array.from(blessingWords[longest]!).length ? index : longest, 0);
      for (const [width, theme] of [[375, "light"], [320, "dark"]] as const) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "no-preference" });
        await context.addInitScript(value => localStorage.setItem("ov.theme.v1", value), theme);
        await context.addInitScript(value => { Math.random = () => value; }, (longestIndex + .5) / blessingWords.length);
        const videos = originalVideos().slice(0, 6); await fixture(context, videos); const page = await context.newPage(); page.setDefaultTimeout(10000);
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        try {
          await page.goto(origin); await expect(page.locator(".video-card")).toHaveCount(6);
          const card = page.locator(".library-encouragement"); const trigger = card.getByRole("button", { name: "点亮祝福彩蛋", exact: true });
          const effect = page.getByRole("region", { name: "祝福彩蛋", exact: true });
          // 先等既有页面入场结束，再核对彩蛋是否改变用户的滚动位置。
          await page.locator(".video-grid").evaluate(async node => { await Promise.all(node.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
          await card.evaluate(node => node.scrollIntoView({ block: "center", behavior: "instant" }));
          const selected = await card.locator(".library-encouragement-message").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-message-id")));
          await expect(card.locator(".library-encouragement-pause")).toBeHidden(); await expect(effect).toHaveCount(0);
          await expect(card.getByRole("button", { name: "暂停寄语", exact: true })).toHaveCount(0);
          const baseline = await page.evaluate(() => ({ overflow: document.body.style.overflow, position: document.body.style.position, scroll: scrollY, settings: localStorage.getItem("ov.space-effects.v1") }));
          const before = await cardPositions(page);
          await trigger.click();
          await expect(effect).toHaveAttribute("data-phase", "rain"); await expect(effect.locator(".library-blessing-word")).toHaveCount(0);
          await expect(effect.locator(".library-blessing-meteor")).toHaveCount(8);
          await expect(effect).toHaveCSS("position", "fixed"); await expect(effect).toHaveCSS("pointer-events", "none");
          assert.equal(await effect.evaluate(node => node.parentElement === document.body), true, "全屏层必须通过 Portal 脱离卡片的裁切容器");
          const bounds = await effect.boundingBox(); assert.ok(bounds && bounds.x === 0 && bounds.y === 0 && bounds.width === width && bounds.height === 900);
          await trigger.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
          await expect(effect).toHaveCount(1); await expect(trigger).toHaveAttribute("aria-busy", "true");
          await expect(effect).toHaveAttribute("data-phase", "blessing");
          const word = effect.locator(".library-blessing-word");
          const message = await word.getAttribute("data-word");
          assert.equal(message, blessingWords[longestIndex]);
          await expect(word).toHaveCSS("animation-name", "library-blessing-word");
          await expect(effect.locator(".library-blessing-letter")).toHaveCount(Array.from(message!).length);
          await expect(effect.locator(".library-blessing-ring")).toHaveCount(2);
          await expect(word).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
          const wordBounds = await word.boundingBox(); assert.ok(wordBounds && Math.abs(wordBounds.x + wordBounds.width / 2 - width / 2) < 2 && Math.abs(wordBounds.y + wordBounds.height / 2 - 450) < 2, "祝福语应位于屏幕正中央");
          const letteringBounds = await word.locator(".library-blessing-lettering").boundingBox(); assert.ok(letteringBounds && letteringBounds.x >= 12 && letteringBounds.x + letteringBounds.width <= width - 12, "最长祝福语在窄屏不能被裁切");
          await page.screenshot({ path: join(evidenceRoot, `blessing-burst-${width}-${theme}.png`) });
          if (theme === "light") await expect(effect).toHaveCount(0, { timeout: 6500 });
          else await page.keyboard.press("Escape");
          await expect(effect).toHaveCount(0); await expect(trigger).toBeFocused();
          await expect(trigger).toHaveAttribute("aria-busy", "false");
          assert.deepEqual(await page.evaluate(() => ({ overflow: document.body.style.overflow, position: document.body.style.position, scroll: scrollY, settings: localStorage.getItem("ov.space-effects.v1") })), baseline, "结束后不得留下滚动锁、位置变化或设置修改");
          const after = await cardPositions(page); assert.deepEqual(after.map(item => item.height), before.map(item => item.height));
          assert.deepEqual(await card.locator(".library-encouragement-message").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-message-id"))), selected);
          await expect(card.locator(".library-cosmos-orbit")).toHaveCSS("animation-play-state", "running");

          await trigger.click(); await effect.getByRole("button", { name: "关闭祝福彩蛋", exact: true }).click();
          await page.waitForTimeout(BLESSING_REVEAL_MS + 100); await expect(effect).toHaveCount(0);
          await expect(card).toHaveAttribute("data-paused", "false");
          await expect(card.locator(".library-cosmos-orbit")).toHaveCSS("animation-play-state", "running");
          await trigger.focus(); await page.keyboard.press("Enter"); await expect(effect).toHaveCount(1);
          await page.locator('a[href="/upload"]:visible').first().click(); await expect(page).toHaveURL(/\/upload$/);
          await page.waitForTimeout(BLESSING_REVEAL_MS + 100); await expect(effect).toHaveCount(0);
          await page.locator('a[href="/"]:visible').first().click(); await expect(page.locator(".video-card")).toHaveCount(6);
          await card.evaluate(node => node.scrollIntoView({ block: "center", behavior: "instant" }));
          await trigger.click();
          await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
          await expect(effect).toHaveCount(0);
          await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
          await trigger.click(); await page.emulateMedia({ reducedMotion: "reduce" }); await expect(effect).toHaveCount(0);
          await trigger.click(); await expect(effect).toHaveAttribute("data-motion", "false");
          await expect(effect.locator(".library-blessing-meteor")).toHaveCount(0); await expect(effect.locator(".library-blessing-ray")).toHaveCount(0);
          await expect(effect.locator(".library-blessing-word")).toHaveCSS("animation-name", "none");
          await expect(effect).toHaveCount(0, { timeout: 3500 });
          await page.getByRole("button", { name: "搜索", exact: true }).click(); await expect(page.getByRole("searchbox")).toBeFocused();
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
    });
    for (const view of [{ width: 1440, height: 900, theme: "light" }, { width: 1440, height: 900, theme: "dark" }, { width: 1024, height: 900, theme: "light" }, { width: 375, height: 812, theme: "light" }, { width: 375, height: 812, theme: "dark" }, { width: 320, height: 740, theme: "dark" }, { width: 768, height: 1024, theme: "light" }, { width: 600, height: 900, theme: "light" }, { width: 601, height: 900, theme: "dark" }]) {
      await t.test(`${view.width}px ${view.theme}`, async () => {
        const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, reducedMotion: "reduce" });
        await context.addInitScript(theme => localStorage.setItem("ov.theme.v1", theme), view.theme);
        const data = await fixture(context); const page = await context.newPage(); const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(origin);
        try { await expect(page.locator(".video-card")).toHaveCount(12); }
        catch (error) { console.error("首页加载诊断:", await page.locator("body").innerText(), errors); throw error; }
        const cardSurface = page.locator(".video-card").first();
        await expect(cardSurface).toHaveCSS("background-color", "rgb(255, 255, 255)");
        await expect(cardSurface).toHaveCSS("background-image", "linear-gradient(145deg, rgb(255, 255, 255) 0%, rgb(255, 255, 255) 45%, rgb(240, 246, 252) 100%)");
        await expect(cardSurface).toHaveCSS("backdrop-filter", "none");
        await expect(cardSurface.locator("h2")).toHaveCSS("color", "rgb(24, 42, 64)");
        await expect(cardSurface.locator(".card-meta").first()).toHaveCSS("color", "rgb(75, 97, 120)");
        await expect(cardSurface.locator(".badge").first()).toHaveCSS("color", "rgb(112, 66, 182)");
        await expect(page.getByRole("heading", { name: "云影匣·高光时刻", exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: "高光时刻", exact: true })).toBeVisible();
        await expect(page.locator(".library-page").getByRole("link", { name: "上传视频", exact: true })).toHaveCount(0);
        await expect(page.locator(".library-page").getByRole("button", { name: "导入已有视频", exact: true })).toHaveCount(0);
        await expect(page.locator(".library-page").getByText("已登记", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("searchbox")).toHaveCount(0); await expect(page.getByRole("checkbox")).toHaveCount(0);
        const search = page.getByRole("button", { name: "搜索", exact: true }); const filter = page.getByRole("button", { name: "筛选", exact: true });
        for (const button of [search, filter]) { const bounds = await button.boundingBox(); assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44 && bounds.x + bounds.width <= view.width); }
        await noOverflow(page);
        const cards = await page.locator(".video-card").evaluateAll(nodes => nodes.map(node => {
          const bounds = node.getBoundingClientRect(); const title = node.querySelector("h2")!; const cover = node.querySelector(".thumbnail-wrapper")!.getBoundingClientRect(); const css = getComputedStyle(title); const body = node.querySelector(".card-body")!;
          return { width: bounds.width, height: bounds.height, titleHeight: title.getBoundingClientRect().height, font: Number.parseFloat(css.fontSize), line: Number.parseFloat(css.lineHeight), aspect: cover.width / cover.height, tags: node.querySelectorAll(".badge").length, contentOverflow: body.scrollHeight - body.clientHeight, hasActions: !!node.querySelector(".video-card-actions") };
        }));
        const compact = view.width <= 600;
        for (const card of cards) {
          assert.equal(card.hasActions, false, "卡片不应再有操作按钮，点击卡片直接进入详情");
          assert.ok(Math.abs(card.aspect - 16 / 9) < .02); assert.ok(card.titleHeight <= card.line * (compact ? 2 : 1) + 1); assert.ok(card.tags <= 2);
          assert.ok(card.contentOverflow <= 1, "卡片内容不得溢出");
          if (compact) assert.ok(card.font >= 13 && card.font <= 14);
        }
        if (compact) {
          const columns = await page.locator(".library-page .video-grid").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length);
          assert.equal(columns, 2, "窄屏应为双列网格");
          assert.equal(new Set(cards.map(card => card.width)).size, 1, "同网格卡片宽度一致");
          assert.ok(new Set(cards.map(card => card.height)).size > 1, "不同标题和标签应允许卡片自然呈现不同高度");
          assert.ok(cards[0]!.titleHeight > cards[0]!.line * 1.5, "手机端长标题应允许显示两行");
          assertMobileColumns(await feedPositions(page));
        } else {
          assert.equal(new Set(cards.map(card => card.width)).size, 1, "桌面卡片宽度一致");
        }
        await expect(page.locator(".library-page .state-text")).toHaveCount(0);
        for (const status of ["处理中", "处理失败", "格式不支持", "可播放"]) await expect(page.locator(".video-card").getByText(status, { exact: true })).toHaveCount(0);
        await expect(page.locator(".video-card-title-link").first()).toHaveAttribute("title", data.videos[0]!.title);
        await page.screenshot({ path: join(evidenceRoot, `home-${view.width}-${view.theme}.png`), fullPage: false });
        const beforeAppend = await cardPositions(page);
        await page.locator(".infinite-sentinel").scrollIntoViewIfNeeded();
        await expect(page.locator(".video-card")).toHaveCount(14);
        const afterAppend = await cardPositions(page);
        for (let index = 0; index < beforeAppend.length; index++) assert.ok(Math.abs(beforeAppend[index]!.top - afterAppend[index]!.top) < 1, "追加视频不能移动已加载卡片");
        if (compact) {
          assertMobileColumns(await feedPositions(page));
          assert.equal(await page.locator(".video-card").evaluateAll(nodes => nodes.filter(node => Number.parseFloat(getComputedStyle(node).getPropertyValue("--library-card-extra-space")) > 0).length), 2, "追加到14张后仍只能有两张额外留白，不能循环增加");
          await expect(page.locator(".video-grid > .library-encouragement")).toHaveCount(1);
          await expect(page.locator(".video-card .library-encouragement")).toHaveCount(0);
          if (view.width === 375) {
            await page.emulateMedia({ reducedMotion: "no-preference" });
            await expect(page.locator(".library-encouragement-message").first()).toHaveCSS("animation-name", "library-encouragement-message");
            await page.locator(".library-encouragement").evaluate(node => node.scrollIntoView({ block: "center", behavior: "instant" }));
            await page.locator(".library-encouragement").screenshot({ path: join(evidenceRoot, `encouragement-standalone-${view.theme}.png`) });
            await page.emulateMedia({ reducedMotion: "reduce" });
          }
        }
        await expect(page.getByText("已经到底了", { exact: false })).toBeVisible();
        await search.focus(); await page.keyboard.press("Enter"); await expect(page.getByRole("searchbox")).toBeFocused(); await page.getByRole("searchbox").fill("独特片段"); await page.getByRole("button", { name: "应用搜索", exact: true }).click();
        await expect(page.locator(".video-card")).toHaveCount(1); assert.equal(new URL(page.url()).searchParams.has("page"), false);
        const singleCard = await page.locator(".video-card").boundingBox(); assert.equal(singleCard?.width, cards[0]!.width); assert.equal(singleCard?.height, cards[0]!.height);
        await search.click(); await expect(page.getByRole("searchbox")).toHaveCount(0); await expect(search).toHaveAttribute("aria-pressed", "true");
        await filter.click(); const commaTag = page.getByRole("checkbox", { name: "逗号,标签", exact: true }); await commaTag.click(); await expect(commaTag).toBeChecked(); await expect(filter).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => data.queries.some(url => JSON.parse(url.searchParams.get("tags") ?? "[]").includes("逗号,标签"))).toBe(true);
        await filter.click(); await expect(page.getByRole("checkbox")).toHaveCount(0); await expect(filter).toContainText("1");
        await page.getByRole("button", { name: "清空搜索与标签", exact: true }).click(); await expect(page.locator(".video-card")).toHaveCount(12);
        await expect(search).toHaveAttribute("aria-pressed", "false"); await expect(filter).toHaveAttribute("aria-pressed", "false");
        await page.getByRole("button", { name: "分类 13 的较长名称", exact: true }).click(); await expect(page.getByRole("heading", { name: "没有找到匹配的视频", exact: true })).toBeVisible(); await noOverflow(page); await expect(search).toBeVisible();
        await page.getByRole("button", { name: "全部视频", exact: true }).click(); await expect(page.locator(".video-card")).toHaveCount(12);
        if (view.width === 375) {
          await page.goto(`${origin}/upload`); const opener = page.getByRole("button", { name: "导入已有视频", exact: true }); await expect(opener).toBeEnabled(); await noOverflow(page); await opener.click();
          const dialog = page.getByRole("dialog", { name: "导入已有视频", exact: true }); await expect(dialog).toBeVisible();
          const url = dialog.getByLabel("公开视频地址", { exact: true }); const title = dialog.getByLabel("视频标题", { exact: true });
          await url.fill("https://media.fixture.invalid/videos/import.webm"); await title.fill("保留失败填写的导入标题"); await dialog.getByRole("checkbox", { name: "旅行", exact: true }).check();
          data.holdNextRegistration(); await dialog.getByRole("button", { name: "登记公开视频", exact: true }).click();
          try { await expect(dialog).toHaveAttribute("aria-busy", "true"); await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeDisabled(); await page.keyboard.press("Escape"); await expect(dialog).toBeVisible(); }
          finally { data.releaseRegistration(); }
          await expect(dialog.getByRole("alert")).toContainText("fixture-registration-error");
          await expect(title).toHaveValue("保留失败填写的导入标题"); await expect(url).toHaveValue("https://media.fixture.invalid/videos/import.webm"); await expect(dialog.getByRole("checkbox", { name: "旅行", exact: true })).toBeChecked();
          await noOverflow(page); const submitBounds = await dialog.getByRole("button", { name: "登记公开视频", exact: true }).boundingBox(); assert.ok(submitBounds && submitBounds.y >= 0 && submitBounds.y + submitBounds.height <= view.height); await page.screenshot({ path: join(evidenceRoot, `import-375-${view.theme}.png`), fullPage: false });
          await dialog.getByRole("button", { name: "登记公开视频", exact: true }).click(); await expect(dialog.getByRole("status").filter({ hasText: "登记成功" })).toBeInViewport(); assert.equal(data.registrations.length, 2); assert.deepEqual(data.registrations[1]!.tags, ["旅行"]);
          await dialog.getByRole("button", { name: "关闭", exact: true }).click(); await expect(opener).toBeFocused();
          await opener.click(); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused(); assert.equal(data.registrations.length, 2);
          await page.goto(origin); await expect(page.locator(".video-card-title-link").first()).toHaveText("保留失败填写的导入标题");
        }
        await page.goto(`${origin}/guests`); await page.getByRole("button", { name: "新增访客", exact: true }).click();
        const editor = page.getByRole("dialog", { name: "新增访客", exact: true }); const shortcut = editor.getByRole("combobox", { name: /^有效期快捷选项/ }); const expiry = editor.locator('input[type="datetime-local"]');
        await expect(shortcut).toBeVisible(); await expect(expiry).toBeVisible(); await noOverflow(page);
        const quickBounds = await shortcut.boundingBox(); const expiryBounds = await expiry.boundingBox(); assert.ok(quickBounds && expiryBounds); assert.equal(quickBounds.height, 48); assert.equal(expiryBounds.height, 48);
        const labels = await editor.locator(".guest-time-fields > label").evaluateAll(nodes => nodes.map(node => ({ top: node.getBoundingClientRect().top, controlTop: node.querySelector("input, select")!.getBoundingClientRect().top })));
        assert.ok(Math.abs((labels[0]!.controlTop - labels[0]!.top) - (labels[1]!.controlTop - labels[1]!.top)) < 1, "有效期标签与控件间距应一致");
        if (view.width > 600) assert.ok(Math.abs(quickBounds.y - expiryBounds.y) < 1, "桌面端有效期控件应顶部对齐");
        else assert.ok(expiryBounds.y >= quickBounds.y + quickBounds.height, "窄屏有效期控件应纵向排列");
        await shortcut.selectOption("168"); const expiryHours = (Date.parse(await expiry.inputValue()) - Date.now()) / 3_600_000; assert.ok(expiryHours > 167.9 && expiryHours <= 168);
        await page.screenshot({ path: join(evidenceRoot, `guest-expiry-${view.width}-${view.theme}.png`), fullPage: false });
        await editor.getByRole("button", { name: "取消", exact: true }).click();
        assert.deepEqual(errors, []); await context.close();
      });
    }
    console.log(`首页验收截图: ${evidenceRoot}`);
  } finally { await browser.close(); await server.close(); }
});

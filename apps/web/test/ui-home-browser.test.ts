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

async function fixture(context: BrowserContext) {
  const videos = originalVideos(); const queries: URL[] = []; const registrations: Record<string, unknown>[] = []; let failRegistration = true;
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

test("首页自适应卡片、访客有效期及上传页导入在浅深色和窄屏下可用", { timeout: 180000 }, async t => {
  await mkdir(evidenceRoot, { recursive: true });
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, cacheDir: join(evidenceRoot, "vite-cache"), mode: "development", plugins: [{ name: "isolate-home-api", configureServer(server) { server.middlewares.use((request, response, next) => { if (!request.url?.startsWith("/api/")) return next(); response.statusCode = 503; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ error: { code: "SERVICE_NOT_CONFIGURED" } })); }); } }], server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen(); const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const address = server.httpServer?.address(); if (!address || typeof address === "string") throw new Error("隔离服务未监听"); const origin = `http://127.0.0.1:${address.port}`;
    for (const view of [{ width: 1440, height: 900, theme: "light" }, { width: 1440, height: 900, theme: "dark" }, { width: 1024, height: 900, theme: "light" }, { width: 375, height: 812, theme: "light" }, { width: 375, height: 812, theme: "dark" }, { width: 320, height: 740, theme: "dark" }, { width: 768, height: 1024, theme: "light" }, { width: 600, height: 900, theme: "light" }, { width: 601, height: 900, theme: "dark" }]) {
      await t.test(`${view.width}px ${view.theme}`, async () => {
        const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, reducedMotion: "reduce" });
        await context.addInitScript(theme => localStorage.setItem("ov.theme.v1", theme), view.theme);
        const data = await fixture(context); const page = await context.newPage(); const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(origin);
        try { await expect(page.locator(".video-card")).toHaveCount(12); }
        catch (error) { console.error("首页加载诊断:", await page.locator("body").innerText(), errors); throw error; }
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
          assert.ok(Math.abs(card.aspect - 16 / 9) < .02); assert.ok(card.titleHeight <= card.line + 1); assert.ok(card.tags <= 2);
          assert.ok(card.contentOverflow <= 1, "卡片内容不得溢出");
          if (compact) assert.ok(card.font >= 13 && card.font <= 14);
        }
        if (compact) {
          const columns = await page.locator(".library-page .video-grid").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length);
          assert.equal(columns, 2, "窄屏应为双列网格");
          assert.equal(new Set(cards.map(card => card.width)).size, 1, "同网格卡片宽度一致");
          assert.ok(new Set(cards.map(card => card.height)).size >= 1);
        } else {
          assert.equal(new Set(cards.map(card => card.width)).size, 1, "桌面卡片宽度一致");
        }
        await expect(page.locator(".library-page .state-text")).toHaveCount(0);
        for (const status of ["处理中", "处理失败", "格式不支持", "可播放"]) await expect(page.locator(".video-card").getByText(status, { exact: true })).toHaveCount(0);
        await expect(page.locator(".video-card-title-link").first()).toHaveAttribute("title", data.videos[0]!.title);
        await page.screenshot({ path: join(evidenceRoot, `home-${view.width}-${view.theme}.png`), fullPage: false });
        await page.locator(".infinite-sentinel").scrollIntoViewIfNeeded();
        await expect(page.locator(".video-card")).toHaveCount(14);
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

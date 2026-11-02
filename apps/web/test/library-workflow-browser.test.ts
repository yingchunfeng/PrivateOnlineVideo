import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import type { BrowserContext, Page as BrowserPage } from "@playwright/test";
import type { LibraryConfiguration, SaveLibraryConfigurationRequest, VideoDetail } from "@online-video/shared";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const evidenceRoot = fileURLToPath(new URL(`../../../.local/acceptance/library-workflow-${randomUUID()}/`, import.meta.url));
const owner = { user: { id: "isolated-owner", displayName: "界面验收", totpEnabled: true, authMethod: "totp", authVersion: 1, emailMasked: null, emailVerified: false }, csrfToken: "fixture-csrf" };
const configuration = (): LibraryConfiguration => ({
  version: "v1", writable: true,
  categories: [
    { id: "base", name: "未分类", enabled: true, isDefault: true, tagIds: ["shared"], videoCount: 1, uploadCount: 0 },
    { id: "travel", name: "旅行", enabled: true, isDefault: false, tagIds: ["shared"], videoCount: 0, uploadCount: 0 }
  ],
  tags: [{ id: "shared", name: "收藏", enabled: true, categoryIds: ["base", "travel"], videoCount: 1, uploadCount: 0 }]
});

async function openBrowser() {
  const server = await createServer({
    root: webRoot, mode: "development",
    plugins: [{ name: "isolated-workflow-api", configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/api/")) return next();
        response.statusCode = 503; response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: { code: "SERVICE_NOT_CONFIGURED" } }));
      });
    } }],
    server: { host: "127.0.0.1", port: 0, strictPort: false }
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("隔离服务器未监听");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  return { server, browser, origin: `http://127.0.0.1:${address.port}` };
}

async function installFixture(context: BrowserContext) {
  let config = configuration(); let revision = 1; let serial = 0;
  const media = await readFile(new URL("./fixtures/demo.webm", import.meta.url));
  const videos: VideoDetail[] = [{
    id: "video-1", title: "当前视频", categoryId: "base", tags: ["收藏"],
    fileName: "demo.webm", objectKey: "onlineVideo/base/demo.webm", publicUrl: "https://oss.meetdawn.top/onlineVideo/base/demo.webm",
    coverObjectKey: "onlineVideo/base/covers/demo.jpg", coverUrl: "https://oss.meetdawn.top/onlineVideo/base/covers/demo.jpg",
    coverStatus: "saved", sizeBytes: media.length, durationSeconds: 1, status: "ready", thumbnailUrl: null,
    createdAt: "2026-10-03T10:00:00.000Z", codec: null, width: null, height: null, playable: true, lastPositionSeconds: 0
  }];
  const edits: Record<string, unknown>[] = [];
  await context.addInitScript("window.__name = (fn) => fn;");
  await context.route("https://oss.meetdawn.top/**", route => route.fulfill({
    contentType: route.request().url().endsWith(".jpg") ? "image/jpeg" : "video/webm",
    body: route.request().url().endsWith(".jpg") ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : media
  }));
  await context.route("**/api/**", async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const ok = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
    const body = request.headers()["content-type"]?.includes("application/json") ? request.postDataJSON() as Record<string, unknown> : {};
    if (request.method() !== "GET") assert.equal(request.headers()["x-csrf-token"], "fixture-csrf");
    if (path === "/api/auth/me") return ok(owner);
    if (path === "/api/settings/limits") return ok({ maxUploadBytes: 2147483648, partSizeBytes: 65536, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 });
    if (path === "/api/library") return ok({ mediaBaseUrl: "https://oss.meetdawn.top", objectPrefix: "onlineVideo/", categories: config.categories.map(category => ({ ...category, tags: config.tags.filter(tag => tag.enabled && category.tagIds.includes(tag.id)).map(tag => tag.name) })) });
    if (path === "/api/library/configuration") {
      if (request.method() === "PUT") {
        const update = body as unknown as SaveLibraryConfigurationRequest;
        assert.equal(update.version, config.version);
        const old = config;
        config = {
          version: `v${++revision}`, writable: true,
          categories: update.categories.map(category => ({ ...category, id: category.id ?? `new-category-${++serial}`, isDefault: category.id === "base", videoCount: videos.filter(video => video.categoryId === category.id).length, uploadCount: 0 })),
          tags: update.tags.map(tag => ({ ...tag, id: tag.id ?? `new-tag-${++serial}`, categoryIds: [], videoCount: 0, uploadCount: 0 }))
        };
        for (const tag of config.tags) {
          if (!old.tags.some(item => item.id === tag.id)) for (const category of config.categories.filter(category => category.enabled)) if (!category.tagIds.includes(tag.id)) category.tagIds.push(tag.id);
          tag.categoryIds = config.categories.filter(category => category.tagIds.includes(tag.id)).map(category => category.id);
          const previous = old.tags.find(item => item.id === tag.id);
          if (previous && previous.name !== tag.name) for (const video of videos) video.tags = (video.tags ?? []).map(name => name === previous.name ? tag.name : name);
        }
        for (const category of config.categories) if (!old.categories.some(item => item.id === category.id)) category.tagIds = config.tags.filter(tag => tag.enabled).map(tag => tag.id);
        for (const video of videos) if (config.categories.some(category => category.id === video.categoryId && !category.enabled)) video.categoryId = "base";
      }
      return ok(config);
    }
    if (path === "/api/videos") {
      const category = url.searchParams.get("categoryId"); const query = url.searchParams.get("q") ?? "";
      const tags = JSON.parse(url.searchParams.get("tags") ?? "[]") as string[];
      const items = videos.filter(video => (!category || video.categoryId === category) && video.title.includes(query) && tags.every(tag => video.tags?.includes(tag)));
      return ok({ items, total: items.length, page: 1, pageSize: 12 });
    }
    if (path === "/api/videos/video-1") {
      if (request.method() === "PATCH") { edits.push(body); Object.assign(videos[0]!, body); }
      return ok(videos[0]);
    }
    if (path === "/api/videos/video-1/progress") return ok({ videoId: "video-1", positionSeconds: 0, updatedAt: null });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND" } }) });
  });
  return { config: () => config, videos, edits, media };
}

async function noDesktopScroll(page: BrowserPage, name: string) {
  while (await page.getByRole("button", { name: "关闭消息", exact: true }).count()) await page.getByRole("button", { name: "关闭消息", exact: true }).first().click();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, panels: ["main", ".prepared-upload-page", ".upload-sci-left", ".upload-sci-right", ".pending-upload-panel", ".upload-information-panel", ".pending-upload-panel .cover-preview-header", ".pending-upload-list", ".pending-upload-row", ".pending-upload-pagination", ".upload-validation-notice"].map(selector => { const node = document.querySelector(selector); if (!node) return { selector }; const rect = node.getBoundingClientRect(); return { selector, y: rect.y, height: rect.height, bottom: rect.bottom }; }) }));
  await page.screenshot({ path: join(evidenceRoot, `${name}.png`), fullPage: false });
  assert.ok(geometry.scrollWidth <= geometry.width, `${name} 横向溢出: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.scrollHeight <= geometry.height + 1, `${name} 页面纵向溢出: ${JSON.stringify(geometry)}`);
  for (const selector of [".upload-sci-left", ".upload-sci-right", ".pending-upload-panel", ".save-action-btn"]) {
    const bounds = await page.locator(selector).boundingBox(); assert.ok(bounds, `${selector} 不可见`);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= geometry.height + 1, `${name} ${selector} 超出视口`);
  }
  for (const [left, right] of [[".upload-source-grid", ".upload-information-panel"], [".upload-sci-left > .cover-preview-panel", ".pending-upload-panel"]]) {
    const a = await page.locator(left!).boundingBox(); const b = await page.locator(right!).boundingBox();
    assert.ok(a && b && Math.abs(a.y - b.y) <= 1 && Math.abs(a.height - b.height) <= 1, `${name} ${left} 与 ${right} 未上下对齐`);
  }
}

test("分类标签CRUD同步首页、播放旁编辑分类标签后筛选命中", { timeout: 90000 }, async t => {
  const { server, browser, origin } = await openBrowser();
  try {
    await mkdir(evidenceRoot, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const fixture = await installFixture(context); const page = await context.newPage(); const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin); await expect(page.getByRole("button", { name: "全部视频", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.goto(`${origin}/categories`); await page.getByRole("button", { name: "新增分类", exact: true }).click(); await page.getByRole("dialog", { name: "新增分类", exact: true }).getByLabel("分类名称").fill("学习"); await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => fixture.config().categories.some(category => category.name === "学习")).toBe(true);
    const addedId = fixture.config().categories.find(category => category.name === "学习")!.id;
    await page.getByRole("tab", { name: "标签配置", exact: true }).click(); await page.getByRole("button", { name: "新增标签", exact: true }).click(); await page.getByLabel("标签名称").fill("待复习"); await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => fixture.config().tags.some(tag => tag.name === "待复习" && tag.categoryIds.includes(addedId))).toBe(true);
    const addedTag = fixture.config().tags.find(tag => tag.name === "待复习")!;
    const row = page.locator(`[data-tag-id="${addedTag.id}"]`); await row.getByRole("button", { name: "编辑标签", exact: true }).click(); await page.getByLabel("标签名称").fill("复习"); await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "确认保存", exact: true }).click();
    await expect.poll(() => fixture.config().tags.find(tag => tag.id === addedTag.id)?.name).toBe("复习");
    await page.locator(".side-nav-menu").getByRole("link", { name: "首页库", exact: true }).click(); await expect(page.getByRole("button", { name: "学习", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "学习", exact: true }).click(); await expect(page.locator(".video-card")).toHaveCount(0);
    await page.getByRole("button", { name: "全部视频", exact: true }).click(); await page.locator(".video-card").getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.getByLabel("视频分类", { exact: true })).toBeVisible();
    const oldObjects = fixture.videos.map(({ publicUrl, objectKey, coverUrl, coverObjectKey }) => ({ publicUrl, objectKey, coverUrl, coverObjectKey }));
    await page.getByLabel("视频分类", { exact: true }).selectOption(addedId); await page.getByLabel("复习", { exact: true }).check(); await page.getByRole("button", { name: "保存视频信息", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "编辑视频信息", exact: true })).toHaveCount(0); assert.equal(new URL(page.url()).pathname, "/");
    await expect(page.locator(".video-card")).toContainText("学习"); await expect(page.locator(".video-card")).toContainText("复习"); assert.equal(fixture.edits.at(-1)?.categoryId, addedId);
    assert.deepEqual(fixture.videos.map(({ publicUrl, objectKey, coverUrl, coverObjectKey }) => ({ publicUrl, objectKey, coverUrl, coverObjectKey })), oldObjects);
    await page.screenshot({ path: join(evidenceRoot, "video-edited.png"), fullPage: true });
    await page.goto(origin); await page.getByRole("button", { name: "学习", exact: true }).click(); await expect(page.locator(".video-card")).toHaveCount(1);
    await page.goto(`${origin}/categories`); await page.getByRole("tab", { name: "标签配置", exact: true }).click();
    await page.locator(`[data-tag-id="${addedTag.id}"]`).getByRole("button", { name: "删除标签", exact: true }).click(); await page.getByRole("alertdialog").getByRole("button", { name: "确认删除标签", exact: true }).click();
    await expect.poll(() => fixture.config().tags.find(tag => tag.id === addedTag.id)?.enabled).toBe(false);
    await page.getByRole("tab", { name: "分类配置", exact: true }).click(); await page.locator(`[data-category-id="${addedId}"]`).getByRole("button", { name: "删除分类", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "确认删除分类", exact: true }).click(); await expect.poll(() => fixture.config().categories.find(category => category.id === addedId)?.enabled).toBe(false);
    await page.goto(origin); await expect(page.getByRole("button", { name: "学习", exact: true })).toHaveCount(0); await page.getByRole("button", { name: "未分类", exact: true }).click(); await expect(page.locator(".video-card")).toHaveCount(1);
    assert.deepEqual(errors, []); t.diagnostic(`界面证据：${evidenceRoot}`); await context.close();
  } finally { await browser.close(); await server.close(); }
});

test("文件与文件夹分开追加视频、嵌套目录过滤、分页编辑和桌面一屏布局", { timeout: 90000 }, async t => {
  const { server, browser, origin } = await openBrowser();
  try {
    await mkdir(evidenceRoot, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
    const fixture = await installFixture(context); const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const folder = join(evidenceRoot, "folder-fixture"); await mkdir(join(folder, "nested"), { recursive: true });
    await Promise.all([
      writeFile(join(folder, "root.webm"), fixture.media), writeFile(join(folder, "notes.txt"), "不是视频", "utf8"),
      writeFile(join(folder, "nested", "nested.MP4"), "视频校验占位", "utf8"),
      ...Array.from({ length: 6 }, (_, index) => writeFile(join(folder, `clip-${index}.webm`), fixture.media))
    ]);
    await page.goto(`${origin}/upload`); await expect(page.getByLabel("视频文件", { exact: true })).toBeAttached();
    await noDesktopScroll(page, "upload-empty-1366");
    await page.getByLabel("视频文件", { exact: true }).setInputFiles([{ name: "manual.webm", mimeType: "video/webm", buffer: fixture.media }]);
    await page.getByLabel("视频文件夹", { exact: true }).setInputFiles(folder);
    await expect(page.locator(".pending-upload-panel")).toContainText("9 项"); await expect(page.locator(".pending-upload-panel")).not.toContainText("notes.txt");
    await expect(page.locator(".upload-source-note")).toContainText("已跳过 1 个非视频文件");
    const divider = await page.locator(".folder-source").evaluate(node => getComputedStyle(node, "::before").width); assert.equal(divider, "1px");
    await expect(page.getByLabel("视频文件夹", { exact: true })).toHaveAttribute("webkitdirectory", "");
    await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeEnabled();
    await page.getByLabel("视频标题", { exact: true }).fill("单独文件标题"); await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.locator(".pending-upload-choice").first().click(); await page.getByLabel("视频标题", { exact: true }).fill("文件夹视频标题");
    await page.getByRole("button", { name: "上一页", exact: true }).click(); await page.locator(".pending-upload-choice").filter({ hasText: "manual.webm" }).click();
    await expect(page.getByLabel("视频标题", { exact: true })).toHaveValue("单独文件标题");
    await noDesktopScroll(page, "upload-folder-1366"); await page.setViewportSize({ width: 1440, height: 900 }); await noDesktopScroll(page, "upload-folder-1440");
    await page.setViewportSize({ width: 1280, height: 720 }); await noDesktopScroll(page, "upload-folder-1280");
    await page.setViewportSize({ width: 1366, height: 640 }); await noDesktopScroll(page, "upload-folder-short");
    await page.getByLabel("视频文件", { exact: true }).setInputFiles([{ name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from("invalid") }]);
    while (await page.getByRole("button", { name: "下一页", exact: true }).isEnabled()) await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.locator(".pending-upload-choice").filter({ hasText: "bad.txt" }).click(); await expect(page.locator(".upload-validation-notice")).toContainText("仅支持");
    await expect(page.locator(".pending-upload-row").filter({ hasText: "bad.txt" }).getByRole("button", { name: "选择封面", exact: true })).toBeDisabled();
    await noDesktopScroll(page, "upload-invalid-short");
    const noVideos = join(evidenceRoot, "non-video-folder"); await mkdir(noVideos); await writeFile(join(noVideos, "notes.txt"), "非视频", "utf8");
    await page.getByLabel("视频文件夹", { exact: true }).setInputFiles(noVideos); await expect(page.locator(".upload-source-note")).toContainText("没有支持的视频"); await expect(page.locator(".pending-upload-panel")).toContainText("10 项");
    await page.getByLabel("视频文件夹", { exact: true }).setInputFiles(folder); await expect(page.locator(".pending-upload-panel")).toContainText("18 项");
    await noDesktopScroll(page, "upload-repeat-folder-short");
    await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await expect(page.locator('.pending-upload-choice[aria-pressed="true"]')).toHaveCount(1);
    while (await page.getByRole("button", { name: "关闭消息", exact: true }).count()) await page.getByRole("button", { name: "关闭消息", exact: true }).first().click();
    await page.getByRole("button", { name: "上一页", exact: true }).scrollIntoViewIfNeeded(); await expect(page.getByRole("button", { name: "上一页", exact: true })).toBeVisible();
    await page.screenshot({ path: join(evidenceRoot, "upload-mobile-390.png"), fullPage: true });
    assert.deepEqual(errors, []);
    t.diagnostic(`文件夹及布局证据：${evidenceRoot}`); await context.close();
  } finally { await browser.close(); await server.close(); }
});

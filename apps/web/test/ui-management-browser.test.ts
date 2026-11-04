import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import type { LibraryConfiguration, SaveLibraryConfigurationRequest, UploadTask, VideoDetail } from "@online-video/shared";

const evidenceRoot = fileURLToPath(new URL(`../../../.local/acceptance/ui-management-${randomUUID()}/`, import.meta.url));
const configuration = (): LibraryConfiguration => ({ version: "v1", writable: true, categories: [
  { id: "base", name: "未分类", enabled: true, isDefault: true, tagIds: ["tag-1"], videoCount: 1, uploadCount: 0 },
  { id: "travel", name: "旅行", enabled: true, isDefault: false, tagIds: ["tag-1"], videoCount: 1, uploadCount: 1 }
], tags: [{ id: "tag-1", name: "收藏", enabled: true, categoryIds: ["base", "travel"], videoCount: 2, uploadCount: 1 }] });

async function openBrowser() {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), cacheDir: join(evidenceRoot, "vite-cache"), mode: "development", plugins: [{ name: "isolated-management-api", configureServer(server) {
    server.middlewares.use((request, response, next) => { if (!request.url?.startsWith("/api/")) return next(); response.statusCode = 503; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ error: { code: "SERVICE_NOT_CONFIGURED" } })); });
  } }], server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen(); const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("隔离服务器未监听");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  return { server, browser, origin: `http://127.0.0.1:${address.port}` };
}

async function installFixture(context: BrowserContext) {
  let config = configuration(); let revision = 1; let serial = 0; let nextFailure = "";
  const saves: SaveLibraryConfigurationRequest[] = []; const requests: string[] = [];
  const media = await readFile(new URL("./fixtures/demo.webm", import.meta.url));
  const task: UploadTask = { id: "task-1", title: "可暂停续传的长标题任务·云端旅行记录", fileName: "demo.webm", categoryId: "travel", tags: ["收藏"], videoId: null, sizeBytes: media.length, partSizeBytes: Math.ceil(media.length / 4), status: "uploading", uploadedParts: [], createdAt: "2026-10-30T09:00:00.000Z" };
  const video: VideoDetail = { id: "uploaded", title: task.title!, categoryId: "travel", tags: ["收藏"], fileName: task.fileName, sizeBytes: media.length, durationSeconds: null, objectKey: "onlineVideo/travel/demo.webm", publicUrl: "https://media.invalid/onlineVideo/travel/demo.webm", status: "ready", thumbnailUrl: null, createdAt: task.createdAt, codec: null, width: null, height: null, playable: true, lastPositionSeconds: 0, coverStatus: "missing" };
  await context.addInitScript("window.__name = (fn) => fn;");
  await context.route("https://media.invalid/**", route => route.fulfill({ contentType: "video/webm", body: media }));
  await context.route("**/api/**", async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname; if (!path.startsWith("/api/")) return route.continue(); requests.push(`${request.method()} ${path}`);
    const body = request.headers()["content-type"]?.includes("application/json") ? request.postDataJSON() as Record<string, unknown> : {};
    const ok = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
    const fail = (code: string, status = 409) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code, requestId: "fixture-error" } }) });
    if (request.method() !== "GET") assert.equal(request.headers()["x-csrf-token"], "fixture-csrf");
    if (path === "/api/auth/me") return ok({ user: { id: "isolated-owner", displayName: "管理页验收", totpEnabled: true, authMethod: "totp", authVersion: 1, emailMasked: null, emailVerified: false }, csrfToken: "fixture-csrf" });
    if (path === "/api/settings/limits") return ok({ maxUploadBytes: 2147483648, partSizeBytes: task.partSizeBytes, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 });
    if (path === "/api/library") return ok({ mediaBaseUrl: "https://media.invalid", objectPrefix: "onlineVideo/", categories: config.categories.map(category => ({ ...category, tags: config.tags.filter(tag => tag.enabled && category.tagIds.includes(tag.id)).map(tag => tag.name) })) });
    if (path === "/api/videos") return ok({ items: [], total: 0, page: 1, pageSize: 12 });
    if (path === "/api/library/configuration") {
      if (request.method() !== "PUT") return ok(config);
      const update = body as unknown as SaveLibraryConfigurationRequest; saves.push(update);
      if (nextFailure) { const code = nextFailure; nextFailure = ""; if (code === "CONFIG_VERSION_CONFLICT") config = { ...config, version: `v${++revision}`, tags: [...config.tags, { id: "external", name: "他人新增", enabled: true, categoryIds: [], videoCount: 0, uploadCount: 0 }] }; return fail(code, code === "CONFIG_VERSION_CONFLICT" ? 409 : 503); }
      if (update.version !== config.version) return fail("CONFIG_VERSION_CONFLICT");
      config = { version: `v${++revision}`, writable: true, categories: update.categories.map(category => ({ ...category, id: category.id ?? `category-${++serial}`, isDefault: category.id === "base", videoCount: category.id === "travel" ? 1 : 0, uploadCount: 0 })), tags: update.tags.map(tag => ({ ...tag, id: tag.id ?? `tag-${++serial}`, categoryIds: [], videoCount: 0, uploadCount: 0 })) };
      for (const tag of config.tags) tag.categoryIds = config.categories.filter(category => category.tagIds.includes(tag.id)).map(category => category.id);
      return ok(config);
    }
    if (path === "/api/uploads") { const visible = !url.searchParams.get("status") || url.searchParams.get("status") === task.status; return ok({ items: visible ? [task] : [], total: visible ? 1 : 0, page: 1, pageSize: 20 }); }
    if (path === `/api/uploads/${task.id}`) return ok(task);
    const part = path.match(/\/parts\/(\d+)$/);
    if (part) {
      const partNumber = Number(part[1]); const bytes = request.postDataBuffer()!; const checksum = createHash("sha256").update(bytes).digest("hex");
      assert.equal(request.headers()["x-part-checksum"], checksum);
      const item = { partNumber, sizeBytes: bytes.length, checksum };
      await new Promise(resolve => setTimeout(resolve, 180));
      task.uploadedParts = [...task.uploadedParts.filter(value => value.partNumber !== partNumber), item];
      try { return await ok(item); } catch { return; }
    }
    if (path.endsWith("/complete")) { task.status = "completed"; task.videoId = video.id; task.publicUrl = video.publicUrl!; return ok({ upload: task, video }); }
    if (path === `/api/videos/${video.id}`) return ok(video);
    if (path === `/api/videos/${video.id}/cover`) { video.coverStatus = "saved"; video.coverUrl = "https://media.invalid/onlineVideo/travel/cover.jpg"; task.coverStatus = "saved"; return ok(video); }
    return fail("NOT_FOUND", 404);
  });
  return { config: () => config, saves, requests, task, media, failNext: (code: string) => { nextFailure = code; } };
}

async function checkGeometry(page: Page, name: string) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} 页面不应横向溢出`);
  const footer = page.locator("dialog[open] .management-modal-footer");
  if (await footer.count()) { const box = await footer.boundingBox(); assert.ok(box && box.y >= 0 && box.y + box.height <= await page.evaluate(() => innerHeight) + 1, `${name} 弹窗底部必须在视口内`); }
  await page.screenshot({ path: join(evidenceRoot, `${name}.png`), fullPage: false });
}

test("配置只读表格与弹窗：取消、排序、失败保留、冲突重试、停用恢复和浅深色小屏", { timeout: 90000 }, async t => {
  const { server, browser, origin } = await openBrowser();
  try {
    await mkdir(evidenceRoot, { recursive: true }); const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const fixture = await installFixture(context); const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/categories`); await expect(page.locator("tbody input")).toHaveCount(0); await expect(page.locator("[data-category-id=travel]")).toContainText("收藏");
    const opener = page.getByRole("button", { name: "新增分类", exact: true }); await opener.click(); await page.getByLabel("分类名称").fill("取消的草稿"); await page.keyboard.press("Escape"); await expect(opener).toBeFocused(); assert.equal(fixture.saves.length, 0);
    await opener.click(); await page.getByLabel("分类名称").fill("亲友"); await page.getByLabel("显示顺序").fill("0"); await expect(page.getByRole("checkbox", { name: "收藏", exact: true })).toBeChecked(); await page.getByRole("checkbox", { name: "收藏", exact: true }).uncheck(); await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => fixture.config().categories[0]?.name).toBe("亲友"); await expect(page.getByRole("dialog")).toHaveCount(0); assert.deepEqual(fixture.saves[0]?.categories[0]?.tagIds, []);
    await page.locator("[data-category-id=travel]").getByRole("button", { name: "编辑分类" }).click(); await page.getByLabel("分类名称").fill("旅途"); fixture.failNext("SERVICE_NOT_CONFIGURED");
    await page.getByRole("button", { name: "保存", exact: true }).click(); await page.getByRole("alertdialog").getByRole("button", { name: "确认保存" }).click();
    await expect(page.getByRole("dialog", { name: "编辑分类" }).getByRole("alert")).toBeVisible(); await expect(page.getByLabel("分类名称")).toHaveValue("旅途"); assert.equal(fixture.config().categories.find(item => item.id === "travel")?.name, "旅行");
    fixture.failNext("CONFIG_VERSION_CONFLICT"); await page.getByRole("button", { name: "保存", exact: true }).click(); await page.getByRole("alertdialog").getByRole("button", { name: "确认保存" }).click();
    await expect(page.getByRole("button", { name: "使用最新版本重试" })).toBeEnabled(); await expect(page.getByLabel("分类名称")).toHaveValue("旅途"); await page.getByRole("button", { name: "使用最新版本重试" }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click(); await page.getByRole("alertdialog").getByRole("button", { name: "确认保存" }).click();
    await expect.poll(() => fixture.config().categories.find(item => item.id === "travel")?.name).toBe("旅途"); assert.ok(fixture.config().tags.some(item => item.id === "external"));
    await page.locator("[data-category-id=travel]").getByRole("button", { name: "删除分类" }).click(); await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click(); await expect(page.locator("[data-category-id=travel]").getByRole("button", { name: "删除分类" })).toBeFocused(); assert.equal(fixture.config().categories.find(item => item.id === "travel")?.enabled, true);
    await page.locator("[data-category-id=travel]").getByRole("button", { name: "删除分类" }).click(); await page.getByRole("alertdialog").getByRole("button", { name: "确认删除分类" }).click(); await expect(page.locator("[data-category-id=travel]")).toHaveCount(0);
    await page.getByLabel("显示已删除分类").check(); await page.locator("[data-category-id=travel]").getByRole("button", { name: "恢复分类" }).click(); await expect.poll(() => fixture.config().categories.find(item => item.id === "travel")?.enabled).toBe(true);
    await page.getByRole("tab", { name: "标签配置", exact: true }).click(); await page.getByRole("button", { name: "新增标签", exact: true }).click(); await page.getByLabel("标签名称").fill("记忆"); await page.getByRole("button", { name: "保存", exact: true }).click(); await expect.poll(() => fixture.config().tags.some(item => item.name === "记忆")).toBe(true);
    await page.getByRole("tab", { name: "分类配置", exact: true }).click(); await checkGeometry(page, "configuration-desktop-light");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      await page.setViewportSize({ width: 1440, height: 900 }); await checkGeometry(page, `configuration-desktop-${theme}`);
      for (const width of [375, 320, 768]) { await page.setViewportSize({ width, height: width === 768 ? 600 : 667 }); await page.getByRole("button", { name: "新增分类", exact: true }).click(); await expect(page.getByLabel("分类名称")).toBeFocused(); await checkGeometry(page, `configuration-${theme}-${width}`); await page.getByRole("button", { name: "取消", exact: true }).click(); }
    }
    assert.deepEqual(errors, []); t.diagnostic(`配置管理证据：${evidenceRoot}`); await context.close();
  } finally { await browser.close(); await server.close(); }
});

test("任务表格：原文件校验、开始暂停续传、跨页执行、详情与移动端横向滚动", { timeout: 90000 }, async t => {
  const { server, browser, origin } = await openBrowser();
  try {
    await mkdir(evidenceRoot, { recursive: true }); const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: "reduce" });
    const fixture = await installFixture(context); const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/tasks`); const row = page.locator("tr[data-task-id=task-1]"); await expect(row).toHaveCount(1); await expect(page.locator(".upload-task-card")).toHaveCount(0);
    await row.getByLabel("原文件 demo.webm").setInputFiles({ name: "wrong.webm", mimeType: "video/webm", buffer: Buffer.from("wrong") }); await expect(row.getByRole("alert")).toContainText("大小"); assert.equal(fixture.task.uploadedParts.length, 0);
    await row.getByLabel("原文件 demo.webm").setInputFiles({ name: "demo.webm", mimeType: "video/webm", buffer: fixture.media }); await expect(row.getByRole("button", { name: "开始 / 继续上传", exact: true })).toBeEnabled();
    await row.getByRole("button", { name: "开始 / 继续上传", exact: true }).click(); await expect(row.getByRole("button", { name: "暂停上传" })).toBeVisible(); await row.getByRole("button", { name: "暂停上传" }).click(); await expect(row).toContainText("本机已暂停");
    await new Promise(resolve => setTimeout(resolve, 250)); await row.getByRole("button", { name: "开始 / 继续上传", exact: true }).click();
    await page.locator(".side-nav-menu").getByRole("link", { name: "高光时刻", exact: true }).click(); await expect.poll(() => fixture.task.status).toBe("completed");
    await page.locator(".side-nav-menu").getByRole("link", { name: "任务列表", exact: true }).click(); await expect(row).toContainText("视频已登记"); await expect(row.getByRole("link", { name: "播放视频" })).toHaveAttribute("href", "/videos/uploaded");
    await row.getByRole("button", { name: "查看详情", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "任务详情", exact: true }); await expect(dialog.getByLabel("公共地址", { exact: true })).toHaveValue("https://media.invalid/onlineVideo/travel/demo.webm"); await expect(dialog).toContainText("100%");
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("clipboard fixture denied"); } } }));
    await dialog.getByRole("button", { name: "复制公共地址", exact: true }).click(); await expect(dialog.getByText("浏览器未允许复制，请选中公共地址手动复制。", { exact: true })).toBeVisible();
    await dialog.getByLabel("公共地址", { exact: true }).focus(); assert.equal(await dialog.getByLabel("公共地址", { exact: true }).evaluate(node => { const input = node as HTMLInputElement; return input.selectionEnd! - input.selectionStart! === input.value.length; }), true);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } }));
    await dialog.getByRole("button", { name: "复制公共地址", exact: true }).click(); await expect(dialog.getByText("公共地址已复制", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(row.getByRole("button", { name: "查看详情" })).toBeFocused();
    await checkGeometry(page, "tasks-desktop-light");
    for (const theme of ["light", "dark"]) { await page.evaluate(value => document.documentElement.dataset.theme = value, theme); await page.setViewportSize({ width: 1366, height: 900 }); await checkGeometry(page, `tasks-desktop-${theme}`); await page.setViewportSize({ width: 375, height: 667 }); await checkGeometry(page, `tasks-${theme}-375`); await row.getByRole("button", { name: "查看详情" }).click(); await checkGeometry(page, `tasks-detail-${theme}-375`); await page.getByRole("button", { name: "关闭", exact: true }).click(); }
    await page.getByLabel("任务状态筛选").selectOption("failed"); await expect(page.getByRole("heading", { name: "暂无匹配任务" })).toBeVisible();
    assert.deepEqual(errors, []); assert.ok(fixture.requests.some(path => path.endsWith("/complete"))); t.diagnostic(`任务表格证据：${evidenceRoot}`); await context.close();
  } finally { await browser.close(); await server.close(); }
});

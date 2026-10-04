import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import type { LibraryConfiguration, SaveLibraryConfigurationRequest, UploadTask, VideoDetail } from "@online-video/shared";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
async function openBrowser() {
  const server = await createServer({ root: webRoot, mode: "development", plugins: [{ name: "isolate-api-fallback", configureServer(server) { server.middlewares.use((request, response, next) => { if (!request.url?.startsWith("/api/")) { next(); return; } response.statusCode = 503; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ error: { code: "SERVICE_NOT_CONFIGURED" } })); }); } }], server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen();
  const address = server.httpServer?.address(); if (!address || typeof address === "string") throw new Error("本机隔离测试端口不可用");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  return { server, browser, origin: `http://127.0.0.1:${address.port}` };
}
const initialConfig = (): LibraryConfiguration => ({ version: "v1", writable: true, categories: [{ id: "base", name: "基线分类", enabled: true, isDefault: true, tagIds: ["shared"], videoCount: 1, uploadCount: 0 }, { id: "empty", name: "空分类", enabled: true, isDefault: false, tagIds: ["shared"], videoCount: 0, uploadCount: 0 }], tags: [{ id: "shared", name: "共享标签", enabled: true, categoryIds: ["base", "empty"], videoCount: 1, uploadCount: 0 }] });
const library = (config: LibraryConfiguration) => ({ mediaBaseUrl: "https://oss.meetdawn.top", objectPrefix: "onlineVideo/", categories: config.categories.map(category => ({ id: category.id, name: category.name, enabled: category.enabled, tags: config.tags.filter(tag => tag.enabled && category.tagIds.includes(tag.id)).map(tag => tag.name) })) });
const owner = { user: { id: "loopback-owner", displayName: "隔离页面测试", totpEnabled: true, authMethod: "totp", authVersion: 1, emailMasked: null, emailVerified: false }, csrfToken: "fixture-csrf" };

test("手动封面真实解码：取消、区间缓存、微调、独立保存、恢复、短片异常与最终上传图片", { timeout: 120000 }, async t => {
  const { server, browser, origin } = await openBrowser();
  const evidence = fileURLToPath(new URL(`../../../.local/acceptance/manual-cover-${randomUUID()}/`, import.meta.url));
  const [timeline, short] = await Promise.all([readFile(new URL("./fixtures/cover-timeline.mp4", import.meta.url)), readFile(new URL("./fixtures/cover-short.mp4", import.meta.url))]);
  const tasks: UploadTask[] = []; const covers = new Map<string, Buffer>(); const errors: string[] = [];
  let failCover = true;
  try {
    await mkdir(evidence, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
    await context.addInitScript(`window.__name = (fn) => fn;
      const active = new Set(); const create = URL.createObjectURL; const revoke = URL.revokeObjectURL;
      URL.createObjectURL = blob => { const url = create(blob); active.add(url); return url; };
      URL.revokeObjectURL = url => { active.delete(url); revoke(url); };
      window.coverUrls = active;`);
    await context.route("https://**", route => route.abort());
    await context.route("**/api/**", async route => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      const ok = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
      if (path === "/api/auth/me") return ok(owner);
      if (path === "/api/library") return ok(library(initialConfig()));
      if (path === "/api/settings/limits") return ok({ maxUploadBytes: 2147483648, partSizeBytes: 1048576, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 });
      if (path === "/api/uploads" && request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        const task: UploadTask = { id: `manual-${tasks.length}`, videoId: null, fileName: String(body.fileName), sizeBytes: Number(body.sizeBytes), partSizeBytes: 1048576, status: "uploading", uploadedParts: [], title: String(body.title), categoryId: String(body.categoryId), tags: [], createdAt: new Date().toISOString() };
        tasks.push(task); return ok(task);
      }
      if (path === "/api/uploads") return ok({ items: tasks, total: tasks.length, page: 1, pageSize: 20 });
      const upload = path.match(/^\/api\/uploads\/(manual-\d+)(?:\/parts\/(\d+)|\/(complete))?$/);
      if (upload) {
        const task = tasks.find(item => item.id === upload[1])!;
        if (upload[2]) { const part = { partNumber: Number(upload[2]), sizeBytes: request.postDataBuffer()!.length, checksum: request.headers()["x-part-checksum"]! }; task.uploadedParts.push(part); return ok(part); }
        if (upload[3]) { task.status = "completed"; task.videoId = task.id; return ok({ upload: task, video: { id: task.id, title: task.title, publicUrl: `https://isolated.invalid/${task.id}.mp4`, coverStatus: "missing" } }); }
        return ok(task);
      }
      const cover = path.match(/^\/api\/videos\/(manual-\d+)\/cover$/);
      if (cover) {
        covers.set(cover[1]!, request.postDataBuffer()!);
        if (failCover) { failCover = false; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "COVER_REGISTRATION_FAILED" } }) }); }
        return ok({ id: cover[1], title: "隔离视频", publicUrl: `https://isolated.invalid/${cover[1]}.mp4`, coverUrl: `https://isolated.invalid/${cover[1]}.jpg`, coverStatus: "saved" });
      }
      return route.fulfill({ status: 404, body: JSON.stringify({ error: { code: "NOT_FOUND" } }) });
    });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/upload`);
    await page.getByLabel("视频文件", { exact: true }).setInputFiles([{ name: "时间轴样例.mp4", mimeType: "video/mp4", buffer: timeline }, { name: "第二个视频.mp4", mimeType: "video/mp4", buffer: timeline }, { name: "不足一秒.mp4", mimeType: "video/mp4", buffer: short }, { name: "损坏视频.mp4", mimeType: "video/mp4", buffer: Buffer.from("broken") }]);
    const rows = page.locator(".pending-upload-row"); const first = rows.filter({ hasText: "时间轴样例.mp4" }); const second = rows.filter({ hasText: "第二个视频.mp4" }); const shortRow = rows.filter({ hasText: "不足一秒.mp4" }); const broken = rows.filter({ hasText: "损坏视频.mp4" });
    await expect(shortRow.locator("img")).toBeVisible(); await expect(broken).not.toContainText("封面采集中");
    const original = await first.locator("img").getAttribute("src"); const secondOriginal = await second.locator("img").getAttribute("src");
    const open = async (row = first) => { await row.getByRole("button", { name: "选择封面", exact: true }).click(); await expect(page.getByRole("dialog").getByRole("button", { name: "使用当前画面", exact: true })).toBeEnabled(); };
    const dialog = page.getByRole("dialog"); const input = dialog.getByLabel("跳转时间（秒）"); const player = dialog.locator("video");
    const jump = async (time: number) => { await input.fill(String(time)); await dialog.getByRole("button", { name: "跳转", exact: true }).click(); await expect.poll(() => player.evaluate(node => (node as HTMLVideoElement).seeking)).toBe(false); await expect.poll(() => player.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(time, 2); };
    await open(); assert.equal(await player.evaluate(node => (node as HTMLVideoElement).paused), true);
    await page.keyboard.press("Shift+Tab"); await expect(dialog.getByRole("button", { name: "使用当前画面", exact: true })).toBeFocused();
    await page.keyboard.press("Tab"); await expect(dialog.getByRole("button", { name: "关闭封面选择", exact: true })).toBeFocused();
    await jump(0); await jump(0); await expect(dialog.getByRole("button", { name: "使用当前画面", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toHaveCount(0); assert.equal(await first.locator("img").getAttribute("src"), original); await expect(first.getByRole("button", { name: "选择封面", exact: true })).toBeFocused();
    await open(); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
    await open(); await dialog.getByRole("button", { name: "关闭封面选择", exact: true }).click(); await expect(dialog).toHaveCount(0);
    await open(); await expect(dialog.locator(".cover-picker-thumbnails img")).toHaveCount(10);
    const zeroUrls = await dialog.locator(".cover-picker-thumbnails img").evaluateAll(nodes => nodes.map(node => (node as HTMLImageElement).src));
    assert.ok(await dialog.locator(".cover-picker-thumbnails img").evaluateAll(nodes => nodes.every(node => Math.max((node as HTMLImageElement).naturalWidth, (node as HTMLImageElement).naturalHeight) <= 192)));
    const next = dialog.getByRole("button", { name: "下一个时间区间", exact: true }); const previous = dialog.getByRole("button", { name: "上一个时间区间", exact: true });
    await next.click(); await next.click(); await previous.click(); await next.click();
    await expect(dialog.locator(".cover-picker-thumbnail")).toHaveCount(4); await expect(dialog.locator(".cover-picker-thumbnails img")).toHaveCount(4);
    assert.deepEqual(await dialog.locator(".cover-picker-thumbnail").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))), ["预览 20 秒", "预览 21 秒", "预览 22 秒", "预览 23 秒"]);
    await previous.click(); await previous.click(); await expect(dialog.locator(".cover-picker-thumbnails img")).toHaveCount(10);
    assert.deepEqual(await dialog.locator(".cover-picker-thumbnails img").evaluateAll(nodes => nodes.map(node => (node as HTMLImageElement).src)), zeroUrls);
    await dialog.getByRole("button", { name: "预览 5 秒", exact: true }).click();
    await dialog.getByLabel("预览进度").fill("4.2"); await expect(input).toHaveValue("4.2"); await jump(5.2);
    await dialog.getByRole("button", { name: "前进 0.1 秒", exact: true }).click(); await expect(input).toHaveValue("5.3");
    await dialog.getByRole("button", { name: "后退 0.1 秒", exact: true }).click(); await expect(input).toHaveValue("5.2");
    await player.evaluate(node => (node as HTMLVideoElement).play()); await expect.poll(() => player.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(5.2);
    await jump(5.4); await expect(dialog.getByRole("button", { name: "预览 5 秒", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: join(evidence, "cover-picker-desktop.png") });
    await dialog.getByRole("button", { name: "使用当前画面", exact: true }).click(); await expect(dialog).toHaveCount(0);
    const manual = await first.locator("img").getAttribute("src"); assert.notEqual(manual, original); assert.equal(await page.locator(".single-cover img").getAttribute("src"), manual); assert.equal(await second.locator("img").getAttribute("src"), secondOriginal);
    await expect(page.locator(".auto-gen-badge")).toContainText("手动选择封面");
    await expect.poll(() => page.evaluate(() => (window as unknown as { coverUrls: Set<string> }).coverUrls.size)).toBe(3);
    await open(); await expect(input).toHaveValue("5.4"); await jump(2); await dialog.getByRole("button", { name: "取消", exact: true }).click(); assert.equal(await first.locator("img").getAttribute("src"), manual);
    await open(second); await jump(7.1); await dialog.getByRole("button", { name: "使用当前画面", exact: true }).click(); await expect(dialog).toHaveCount(0); assert.equal(await first.locator("img").getAttribute("src"), manual);
    await open(second); await dialog.getByRole("button", { name: "恢复自动封面", exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(page.locator(".auto-gen-badge")).toContainText("视频截帧");
    await open(second); await expect(input).toHaveValue("1"); await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await open(shortRow); await expect(dialog.locator(".cover-picker-thumbnail")).toHaveCount(1); await jump(0);
    await input.fill("0.8"); await dialog.getByRole("button", { name: "跳转", exact: true }).click(); await expect(input).toHaveValue("0.799"); await expect(dialog.getByRole("button", { name: "使用当前画面", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "使用当前画面", exact: true }).click(); await expect(dialog).toHaveCount(0);
    await broken.getByRole("button", { name: "选择封面", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("无法解码"); await expect(dialog.getByRole("button", { name: "使用当前画面", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "恢复自动封面", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("封面未替换"); assert.equal(await broken.locator("img").count(), 0); await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1366, height: 600 }); await page.getByRole("button", { name: "上一页", exact: true }).click(); await open(); await jump(12.3); await expect(dialog.locator(".cover-picker-thumbnails img")).toHaveCount(10); await expect(dialog.getByRole("button", { name: "使用当前画面", exact: true })).toBeInViewport(); await page.waitForTimeout(400); await page.screenshot({ path: join(evidence, "cover-picker-short-window.png") }); await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 }); await open(); await expect(dialog.locator(".cover-picker-thumbnails img")).toHaveCount(10); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.waitForTimeout(400); await page.screenshot({ path: join(evidence, "cover-picker-mobile.png") });
    await dialog.getByRole("button", { name: "前进 0.1 秒", exact: true }).scrollIntoViewIfNeeded(); await expect(dialog.getByRole("button", { name: "前进 0.1 秒", exact: true })).toBeInViewport();
    await page.screenshot({ path: join(evidence, "cover-picker-mobile-adjustment.png") }); await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.setViewportSize({ width: 1366, height: 768 });
    await broken.getByRole("button", { name: "移出待选 损坏视频.mp4", exact: true }).click();
    const expected = Buffer.from(await page.evaluate(async url => [...new Uint8Array(await (await fetch(url!)).arrayBuffer())], manual));
    await writeFile(join(evidence, "selected-cover.jpg"), expected);
    await page.getByRole("button", { name: "提交 3 个视频并上传", exact: true }).click(); await expect(page).toHaveURL(/\/tasks$/);
    await expect.poll(() => covers.size).toBe(3); assert.deepEqual(covers.get("manual-0"), expected);
    const failed = page.locator('[data-task-id="manual-0"]'); await failed.getByRole("button", { name: "单独重试保存封面", exact: true }).click(); await expect(failed).toContainText("封面已保存"); assert.deepEqual(covers.get("manual-0"), expected);
    await page.locator(".side-nav-menu").getByRole("link", { name: "上传视频", exact: true }).click(); await expect(page.locator(".pending-upload-cover").first()).toBeDisabled();
    assert.deepEqual(errors, []);
    t.diagnostic(`封面选择证据：${evidence}`); await context.close();
  } finally { if (errors.length) t.diagnostic(JSON.stringify(errors)); await browser.close(); await server.close(); }
});

test("手动封面异常隔离：生成超时、取消后的晚回调、恢复失败与时长不可用", { timeout: 60000 }, async () => {
  const { server, browser, origin } = await openBrowser();
  try {
    const context = await browser.newContext(); await context.addInitScript("window.__name = (fn) => fn;");
    const page = await context.newPage();
    await page.route("**/api/**", route => {
      const path = new URL(route.request().url()).pathname; if (!path.startsWith("/api/")) return route.continue();
      const data = path === "/api/auth/me" ? owner : path === "/api/library" ? library(initialConfig()) : path === "/api/settings/limits" ? { maxUploadBytes: 2147483648, partSizeBytes: 1048576, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 } : null;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) });
    });
    await page.goto(`${origin}/upload`); await page.getByLabel("视频文件", { exact: true }).setInputFiles(fileURLToPath(new URL("./fixtures/cover-timeline.mp4", import.meta.url)));
    const row = page.locator(".pending-upload-row"); await expect(row.locator("img")).toBeVisible();
    const original = await row.locator("img").getAttribute("src");
    const dialog = page.getByRole("dialog");
    const open = async () => { await row.getByRole("button", { name: "选择封面", exact: true }).click(); await expect(dialog.getByRole("button", { name: "使用当前画面", exact: true })).toBeEnabled(); };
    await open(); await expect(dialog.locator(".cover-picker-thumbnails img")).toHaveCount(10);
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.toBlob;
      const fixture = window as unknown as { resumeCanvas?: () => void; resetCanvas: () => void };
      fixture.resetCanvas = () => { HTMLCanvasElement.prototype.toBlob = original; };
      HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
        if (this.width > 192) fixture.resumeCanvas = () => original.call(this, callback, type, quality);
        else original.call(this, callback, type, quality);
      };
    });
    await dialog.getByRole("button", { name: "使用当前画面", exact: true }).click(); await expect(dialog).toContainText("正在生成正式封面");
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { resumeCanvas?: () => void }).resumeCanvas?.());
    await expect(row.locator("img")).toHaveAttribute("src", original!);
    await open(); await dialog.getByRole("button", { name: "使用当前画面", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("图片生成超时", { timeout: 7000 }); await expect(row.locator("img")).toHaveAttribute("src", original!);
    await expect(dialog.getByRole("button", { name: "使用当前画面", exact: true })).toBeEnabled();
    await page.evaluate(() => (window as unknown as { resetCanvas: () => void }).resetCanvas());
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.toBlob;
      (window as unknown as { resetCanvas: () => void }).resetCanvas = () => { HTMLCanvasElement.prototype.toBlob = original; };
      HTMLCanvasElement.prototype.toBlob = function(callback) { callback(null); };
    });
    await dialog.getByRole("button", { name: "恢复自动封面", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("未能生成封面图片"); await expect(row.locator("img")).toHaveAttribute("src", original!);
    await page.evaluate(() => (window as unknown as { resetCanvas: () => void }).resetCanvas()); await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "duration")!;
      Object.defineProperty(HTMLMediaElement.prototype, "duration", { ...descriptor, get() { return (this as HTMLVideoElement).getAttribute("aria-label") === "封面视频预览" ? Infinity : descriptor.get!.call(this); } });
    });
    await row.getByRole("button", { name: "选择封面", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("时长暂不可用"); await expect(dialog.getByRole("button", { name: "使用当前画面", exact: true })).toBeDisabled(); await page.keyboard.press("Escape"); await expect(row.locator("img")).toHaveAttribute("src", original!);
    const timeout = await page.evaluate(async () => {
      const path = "/src/cover.ts"; const { seekCoverVideo } = await import(path) as typeof import("../src/cover");
      const video = document.createElement("video"); Object.defineProperty(video, "duration", { value: 5 }); Object.defineProperty(video, "currentTime", { value: 0, writable: true });
      try { await seekCoverVideo(video, 2, new AbortController().signal); return "未超时"; } catch (error) { return (error as Error).message; }
    });
    assert.match(timeout, /采集超时/); await context.close();
  } finally { await browser.close(); await server.close(); }
});

test("本机真实视频解析：MP4 covr、无内嵌封面截帧、0.8秒中间帧及损坏失败", { timeout: 90000 }, async t => {
  const { server, browser, origin } = await openBrowser();
  const sampleDir = process.env.COVER_SAMPLE_DIR ?? fileURLToPath(new URL("../../../.local/acceptance/cover-samples-b8cb9e4c-ed98-464e-a345-2aab7c0f5aa7/", import.meta.url));
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } }); await context.addInitScript("window.__name = (fn) => fn;"); const page = await context.newPage(); page.on("pageerror", error => t.diagnostic(`页面错误：${error.message}`)); page.on("console", message => { if (message.type() === "error") t.diagnostic(`控制台错误：${message.text()}`); }); page.on("requestfailed", request => t.diagnostic(`请求失败：${request.url()} ${request.failure()?.errorText}`));
    await page.route("**/api/**", route => { const path = new URL(route.request().url()).pathname; if (!path.startsWith("/api/")) return route.continue(); const data = path === "/api/auth/me" ? owner : path === "/api/library" ? library(initialConfig()) : path === "/api/settings/limits" ? { maxUploadBytes: 2147483648, partSizeBytes: 65536, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 } : null; return route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) }); });
    await page.goto(`${origin}/upload`); await expect(page.getByLabel("视频文件", { exact: true })).toBeAttached({ timeout: 5000 }).catch(async error => { t.diagnostic(await page.content()); throw error; });
    await page.evaluate(() => { const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!; (window as unknown as { coverSeeks: { duration: number; time: number }[] }).coverSeeks = []; Object.defineProperty(HTMLMediaElement.prototype, "currentTime", { ...descriptor, set(value) { (window as unknown as { coverSeeks: { duration: number; time: number }[] }).coverSeeks.push({ duration: (this as HTMLMediaElement).duration, time: value as number }); descriptor.set!.call(this, value); } }); });
    let embedded: Buffer; let normal: Buffer; let short: Buffer;
    try { [embedded, normal, short] = await Promise.all([readFile(`${sampleDir}/with-embedded-cover.mp4`), readFile(new URL("../../../.local/acceptance/samples/ces-h264-aac-20261002.mp4", import.meta.url)), readFile(`${sampleDir}/short-0.8s.mp4`)]); }
    catch { t.skip("可选授权本机MP4样例未提供；设置 COVER_SAMPLE_DIR 指向保留样例目录后执行"); return; }
    await page.getByLabel("视频文件", { exact: true }).setInputFiles([{ name: "embedded.mp4", mimeType: "video/mp4", buffer: embedded }, { name: "normal.mp4", mimeType: "video/mp4", buffer: normal }, { name: "short.mp4", mimeType: "video/mp4", buffer: short }, { name: "broken.mp4", mimeType: "video/mp4", buffer: Buffer.from("corrupt media") }]);
    await expect(page.locator(".auto-gen-badge")).toContainText("视频自带封面", { timeout: 20000 }); await expect(page.locator(".single-cover img")).toBeVisible();
    await page.locator(".pending-upload-choice").filter({ hasText: "normal.mp4" }).click(); await expect(page.locator(".auto-gen-badge")).toContainText("视频截帧", { timeout: 20000 });
    await page.locator(".pending-upload-choice").filter({ hasText: "short.mp4" }).click(); await expect(page.locator(".auto-gen-badge")).toContainText("视频截帧", { timeout: 20000 });
    const seeks = await page.evaluate(() => (window as unknown as { coverSeeks: { duration: number; time: number }[] }).coverSeeks); const shortSeek = seeks.find(seek => seek.duration < 1); assert.ok(shortSeek); assert.ok(shortSeek.time > .3 && shortSeek.time < .5); assert.ok(seeks.some(seek => seek.duration > 2 && seek.time === 1));
    await page.locator(".pending-upload-choice").filter({ hasText: "broken.mp4" }).click(); await expect(page.locator(".auto-gen-badge")).toContainText("暂无封面", { timeout: 20000 }); await expect(page.locator(".cover-preview-panel").first()).toContainText("不会阻止视频上传");
    t.diagnostic(JSON.stringify({ sampleBytes: { embedded: embedded.length, normal: normal.length, short: short.length }, sources: ["embedded", "frame", "frame", "failed"], seeks }));
    await context.close();
  } finally { await browser.close(); await server.close(); }
});

test("隔离页面业务闭环：配置CRUD、多文件逐项编辑、跨页执行、独立重试与刷新历史", { timeout: 120000 }, async t => {
  const { server, browser, origin } = await openBrowser(); const media = await readFile(new URL("./fixtures/demo.webm", import.meta.url));
  let config = initialConfig(); let revision = 1; let serial = 0; let loseCreate = true; let failComplete = true; let failCover = true; let conflictNext = false;
  const tasks = new Map<string, UploadTask>(); const byClient = new Map<string, UploadTask>(); const videoFixtures: VideoDetail[] = [];
  const paths: string[] = []; const partRequests: string[] = []; const coverRequests: string[] = []; const creates: { clientRequestId: string; title: string }[] = []; const dialogs: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" }); await context.addInitScript("window.__name = (fn) => fn;"); const page = await context.newPage(); page.setDefaultTimeout(10000); page.on("pageerror", error => t.diagnostic(`页面错误：${error.message}`));
    page.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
    await context.route("https://oss.meetdawn.top/**", route => route.fulfill({ contentType: route.request().url().endsWith(".jpg") ? "image/jpeg" : "video/webm", body: route.request().url().endsWith(".jpg") ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : media }));
    await context.route("**/api/**", async route => {
      const request = route.request(); const url = new URL(request.url()); const path = url.pathname; const method = request.method(); if (!path.startsWith("/api/")) return route.continue(); paths.push(path);
      const ok = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data }) }); const fail = (code: string) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code } }) });
      if (method !== "GET") assert.equal(request.headers()["x-csrf-token"], "fixture-csrf");
      const body = request.headers()["content-type"]?.includes("application/json") ? request.postDataJSON() as Record<string, unknown> : {};
      if (path === "/api/auth/me") return ok(owner);
      if (path === "/api/library") return ok(library(config));
      if (path === "/api/library/configuration") {
        if (method === "PUT") {
          const update = body as unknown as SaveLibraryConfigurationRequest; if (update.version !== config.version || conflictNext) { conflictNext = false; return fail("CONFIG_VERSION_CONFLICT"); }
          const old = config;
          const deleted = old.categories.filter(category => category.enabled && update.categories.some(next => next.id === category.id && !next.enabled)).map(category => category.id);
          for (const video of videoFixtures) if (deleted.includes(video.categoryId)) video.categoryId = "base";
          config = { version: `v${++revision}`, writable: true, categories: update.categories.map(category => ({ ...category, id: category.id ?? `c-${++serial}`, isDefault: category.id === "base", videoCount: videoFixtures.filter(video => video.categoryId === category.id).length, uploadCount: [...tasks.values()].filter(task => task.categoryId === category.id).length })), tags: update.tags.map(tag => ({ ...tag, id: tag.id ?? `t-${++serial}`, categoryIds: [], videoCount: 1, uploadCount: 0 })) };
          for (const tag of config.tags) { if (!old.tags.some(item => item.id === tag.id)) for (const category of config.categories.filter(category => category.enabled)) if (!category.tagIds.includes(tag.id)) category.tagIds.push(tag.id); tag.categoryIds = config.categories.filter(category => category.tagIds.includes(tag.id)).map(category => category.id); const previous = old.tags.find(item => item.id === tag.id); if (previous && previous.name !== tag.name) { for (const video of videoFixtures) video.tags = video.tags?.map(name => name === previous.name ? tag.name : name) ?? []; } }
        }
        return ok(config);
      }
      if (path === "/api/settings/limits") return ok({ maxUploadBytes: 2147483648, partSizeBytes: 65536, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 });
      if (path === "/api/uploads" && method === "POST") {
        const clientId = String(body.clientRequestId); const title = String(body.title); creates.push({ clientRequestId: clientId, title });
        let task = byClient.get(clientId); if (!task) { task = { id: `u-${tasks.size + 1}`, clientRequestId: clientId, videoId: null, fileName: String(body.fileName), sizeBytes: Number(body.sizeBytes), partSizeBytes: 65536, status: "uploading", uploadedParts: [], title, categoryId: String(body.categoryId), tags: body.tags as string[], objectKey: `onlineVideo/${body.categoryId}/u-${tasks.size + 1}.webm`, createdAt: new Date().toISOString() }; tasks.set(task.id, task); byClient.set(clientId, task); }
        if (title === "乙视频" && loseCreate) { loseCreate = false; return route.abort("failed"); } return ok(task);
      }
      if (path === "/api/uploads") { const page = Number(url.searchParams.get("page") ?? 1); const pageSize = Number(url.searchParams.get("pageSize") ?? 20); const status = url.searchParams.get("status"); const all = [...tasks.values()].filter(task => !status || task.status === status); return ok({ items: all.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: all.length }); }
      const upload = path.match(/^\/api\/uploads\/([^/]+)(?:\/parts\/(\d+)|\/(complete))?$/);
      if (upload) {
        const task = tasks.get(upload[1]!)!;
        if (upload[2]) { await new Promise(resolve => setTimeout(resolve, 180)); const part = { partNumber: Number(upload[2]), sizeBytes: request.postDataBuffer()!.length, checksum: request.headers()["x-part-checksum"]! }; if (!task.uploadedParts.some(item => item.partNumber === part.partNumber)) task.uploadedParts.push(part); partRequests.push(`${task.id}:${part.partNumber}`); return ok(part); }
        if (upload[3]) {
          if (task.title === "甲视频" && failComplete) { failComplete = false; task.status = "failed"; return fail("UPLOAD_REGISTRATION_FAILED"); }
          let video = videoFixtures.find(video => video.id === task.videoId); if (!video) { video = { id: `v-${task.id}`, title: task.title!, categoryId: task.categoryId!, tags: task.tags ?? [], objectKey: task.objectKey!, publicUrl: `https://oss.meetdawn.top/${task.objectKey}`, fileName: task.fileName, durationSeconds: null, sizeBytes: task.sizeBytes, status: "processing", thumbnailUrl: null, coverStatus: "missing", createdAt: new Date().toISOString(), width: null, height: null, codec: null, playable: false, lastPositionSeconds: 0 }; videoFixtures.push(video); } task.videoId = video.id; task.status = "completed"; task.publicUrl = video.publicUrl!; return ok({ upload: task, video });
        }
        return ok(task);
      }
      const cover = path.match(/^\/api\/videos\/([^/]+)\/cover$/);
      if (cover) { coverRequests.push(cover[1]!); if (failCover) { failCover = false; return fail("COVER_REGISTRATION_FAILED"); } const video = videoFixtures.find(video => video.id === cover[1])!; video.coverStatus = "saved"; video.coverObjectKey = `onlineVideo/${video.categoryId}/covers/${video.id}.jpg`; video.coverUrl = `https://oss.meetdawn.top/${video.coverObjectKey}`; const task = [...tasks.values()].find(task => task.videoId === video.id)!; task.coverUrl = video.coverUrl; task.coverStatus = "saved"; task.coverObjectKey = video.coverObjectKey; return ok(video); }
      if (path === "/api/videos") { const category = url.searchParams.get("categoryId"); const q = url.searchParams.get("q") ?? ""; const items = videoFixtures.filter(video => (!category || video.categoryId === category) && (video.title.includes(q) || video.tags?.some(tag => tag.includes(q)))); return ok({ items, total: items.length, page: 1, pageSize: 12 }); }
      const video = path.match(/^\/api\/videos\/([^/]+)(?:\/progress)?$/); if (video) { const item = videoFixtures.find(item => item.id === video[1])!; return ok(path.endsWith("/progress") ? { videoId: item.id, positionSeconds: item.lastPositionSeconds, updatedAt: null } : item); }
      return fail("NOT_FOUND");
    });
    await page.goto(`${origin}/categories`); await page.getByLabel("新建分类名称").fill("新增空分类"); await page.getByRole("button", { name: "添加分类", exact: true }).click(); await expect(page.locator(".toast-stack")).toContainText("已新增");
    const added = config.categories.find(category => category.name === "新增空分类")!; await page.locator(".side-nav-menu").getByRole("link", { name: "首页库", exact: true }).click(); await expect(page.getByRole("button", { name: "新增空分类", exact: true })).toBeVisible();
    await page.goto(`${origin}/categories`); let row = page.locator(`[data-category-id="${added.id}"]`); await row.getByLabel("重命名分类 新增空分类").fill("准备分类"); await row.getByLabel("新增空分类 排序位置").fill("1"); await row.locator("summary").click(); await row.getByLabel("新增空分类 可选标签 共享标签").check(); await row.getByRole("button", { name: "保存分类", exact: true }).click(); await page.getByRole("alertdialog").getByRole("button", { name: "确认保存", exact: true }).click(); await expect(page.locator(".toast-stack")).toContainText("已保存"); assert.equal(config.categories[1]?.id, added.id);
    await page.getByRole("tab", { name: "标签配置", exact: true }).click(); await page.getByLabel("新建标签名称").fill("专属标签"); await page.getByRole("button", { name: "添加标签", exact: true }).click(); await expect(page.locator(".toast-stack")).toContainText("已新增"); assert.ok(config.tags.find(tag => tag.name === "专属标签")?.categoryIds.includes(added.id));
    await page.goto(`${origin}/upload`); await page.getByLabel("视频文件", { exact: true }).setInputFiles([{ name: "same.webm", mimeType: "video/webm", buffer: media }, { name: "same.webm", mimeType: "video/webm", buffer: media }, { name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from("invalid") }]);
    const choices = page.locator(".pending-upload-choice"); await expect(choices).toHaveCount(3); await page.getByLabel("视频标题", { exact: true }).fill("甲视频"); await page.getByLabel("视频分类", { exact: true }).selectOption(added.id); await page.getByRole("button", { name: "共享标签", exact: true }).click();
    await choices.nth(1).click(); await page.getByLabel("视频标题", { exact: true }).fill("乙视频"); await choices.nth(0).click(); await expect(page.getByLabel("视频标题", { exact: true })).toHaveValue("甲视频"); await page.getByRole("button", { name: "将当前分类和标签应用到全部待提交视频", exact: true }).click(); await choices.nth(1).click(); await expect(page.getByLabel("视频标题", { exact: true })).toHaveValue("乙视频"); await expect(page.getByLabel("视频分类", { exact: true })).toHaveValue(added.id);
    await expect(page.locator(".pending-upload-list img")).toHaveCount(2, { timeout: 20000 }).catch(async error => { t.diagnostic(await page.locator("body").innerText()); throw error; }); const clientIds = await page.locator(".pending-upload-row").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-client-id"))); assert.equal(new Set(clientIds).size, 3);
    await page.locator(".save-action-btn").click(); await expect(page).toHaveURL(/\/tasks$/); await page.locator(".side-nav-menu").getByRole("link", { name: "首页库", exact: true }).click(); await expect.poll(() => partRequests.length).toBeGreaterThan(0); await expect.poll(() => failComplete).toBe(false);
    await page.locator(".side-nav-menu").getByRole("link", { name: "任务列表", exact: true }).click(); const firstCard = page.locator('[data-task-id="u-1"]'); await firstCard.getByRole("button", { name: "重试完成确认", exact: true }).click(); await expect(firstCard.getByRole("status")).toContainText(["视频已登记", "视频已登记，封面待补"]);
    await page.getByRole("button", { name: "重试创建此任务", exact: true }).click(); await expect.poll(() => [...tasks.values()].filter(task => task.status === "completed").length).toBe(2);
    const partsBefore = partRequests.length; await firstCard.getByRole("button", { name: "单独重试保存封面", exact: true }).click(); await expect.poll(() => videoFixtures.every(video => video.coverStatus === "saved")).toBe(true); assert.equal(partRequests.length, partsBefore); assert.equal(tasks.size, 2); assert.equal(new Set(creates.filter(create => create.title === "乙视频").map(create => create.clientRequestId)).size, 1);
    await page.reload(); await expect(page.locator('[aria-label="服务端任务历史"] [data-task-id]')).toHaveCount(2); await expect(page.getByText("视频已登记，封面已保存", { exact: true })).toHaveCount(2); await page.getByLabel("任务状态筛选").selectOption("completed"); await expect(page.locator('[aria-label="服务端任务历史"] [data-task-id]')).toHaveCount(2);
    await firstCard.getByRole("link", { name: "播放视频", exact: true }).click(); await expect(page.locator("video")).toHaveAttribute("poster", /oss\.meetdawn\.top\/onlineVideo\/.+\/covers\//); await expect(page.locator("video")).toHaveAttribute("src", /oss\.meetdawn\.top\/onlineVideo\//);
    await page.goto(`${origin}/categories`); await page.getByRole("tab", { name: "标签配置", exact: true }).click(); const tagRow = page.locator('[data-tag-id="shared"]'); await tagRow.getByLabel("重命名标签 共享标签").fill("共享新名称"); await tagRow.getByRole("button", { name: "保存标签", exact: true }).click(); dialogs.push(await page.getByRole("alertdialog").innerText()); await page.getByRole("alertdialog").getByRole("button", { name: "确认保存", exact: true }).click(); await expect(page.locator(".toast-stack")).toContainText("已保存"); assert.equal(videoFixtures[0]?.tags?.[0], "共享新名称");
    await page.getByRole("tab", { name: "分类配置", exact: true }).click(); row = page.locator(`[data-category-id="${added.id}"]`);
    const oldVideoKeys = videoFixtures.map(video => ({ id: video.id, objectKey: video.objectKey, coverObjectKey: video.coverObjectKey, tags: video.tags }));
    const deletion = row.getByRole("button", { name: "删除分类", exact: true }); await deletion.click(); let confirmation = page.getByRole("alertdialog"); await expect(confirmation).toContainText("2 个视频归入"); await expect(confirmation.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(confirmation.getByRole("button", { name: "确认删除分类", exact: true })).toBeFocused(); await page.keyboard.press("Tab"); await expect(confirmation.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    const versionBeforeCancel = config.version; await page.mouse.click(2, 2); await expect(confirmation).toBeVisible(); await page.keyboard.press("Escape"); await expect(confirmation).toHaveCount(0); await expect(deletion).toBeFocused(); assert.equal(config.version, versionBeforeCancel); assert.ok(videoFixtures.every(video => video.categoryId === added.id));
    await deletion.click(); confirmation = page.getByRole("alertdialog"); await confirmation.getByRole("button", { name: "确认删除分类", exact: true }).click(); const deletedToast = page.locator(".floating-toast").filter({ hasText: "已删除" }); await expect(deletedToast).toBeVisible(); await expect(deletedToast).toHaveCount(0, { timeout: 7000 }); assert.ok(videoFixtures.every(video => video.categoryId === "base")); assert.deepEqual(videoFixtures.map(video => ({ id: video.id, objectKey: video.objectKey, coverObjectKey: video.coverObjectKey, tags: video.tags })), oldVideoKeys);
    await page.getByLabel("显示已删除分类").check(); await row.getByRole("button", { name: "恢复分类", exact: true }).click(); await expect(page.locator(".toast-stack")).toContainText("已恢复"); assert.ok(videoFixtures.every(video => video.categoryId === "base"));
    const libraryTab = await context.newPage(); const storageTab = await context.newPage();
    await libraryTab.addInitScript("window.addEventListener('storage', event => event.stopImmediatePropagation(), { capture: true });");
    await storageTab.addInitScript("window.BroadcastChannel = undefined;");
    await libraryTab.goto(`${origin}/?categoryId=${added.id}`); await storageTab.goto(`${origin}/?categoryId=${added.id}`);
    await expect(libraryTab.getByRole("button", { name: "准备分类", exact: true })).toHaveAttribute("aria-pressed", "true"); await expect(storageTab.getByRole("button", { name: "准备分类", exact: true })).toHaveAttribute("aria-pressed", "true");
    await row.getByRole("button", { name: "删除分类", exact: true }).click(); await page.getByRole("alertdialog").getByRole("button", { name: "确认删除分类", exact: true }).click();
    // 不调用 bringToFront 或派发 focus，成功保存自动通知同 origin 的其他标签页。
    for (const tab of [libraryTab, storageTab]) { await expect(tab).not.toHaveURL(/categoryId=/); await expect(tab.getByRole("button", { name: "全部视频", exact: true })).toHaveAttribute("aria-pressed", "true"); await expect(tab.getByRole("button", { name: "准备分类", exact: true })).toHaveCount(0); }
    await libraryTab.close(); await storageTab.close();
    await page.goto(`${origin}/?categoryId=${added.id}`); await expect(page).not.toHaveURL(/categoryId=/); await expect(page.getByRole("button", { name: "准备分类", exact: true })).toHaveCount(0); await expect(page.locator(".video-card")).toHaveCount(2);
    await page.goto(`${origin}/categories`); conflictNext = true; await page.getByLabel("新建分类名称").fill("冲突不应成功"); await page.getByRole("button", { name: "添加分类", exact: true }).click(); const conflictToast = page.locator(".floating-toast.error"); await expect(conflictToast).toContainText("已被其他请求修改"); assert.equal(config.categories.some(category => category.name === "冲突不应成功"), false); await conflictToast.getByRole("button", { name: "关闭消息", exact: true }).click(); await expect(conflictToast).toHaveCount(0);
    assert.ok(dialogs.some(message => message.includes("标签名称也会更新"))); assert.equal(paths.some(path => /playback-sessions|heartbeat|\/source$|\/stream$|\/groups/.test(path)), false);
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('.bottom-nav a[href="/tasks"]')).toBeVisible(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    t.diagnostic(JSON.stringify({ note: "API和云媒体均为替身；本机视频解码是真实，手机宽度不是安卓设备", tasks: tasks.size, parts: partRequests.length, covers: coverRequests.length, dialogs: dialogs.length }));
    await context.close();
  } finally { await browser.close(); await server.close(); }
});

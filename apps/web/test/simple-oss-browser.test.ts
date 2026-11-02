import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import type { LibraryConfig, UploadTask, VideoDetail } from "@online-video/shared";

// 独立页面契约测试：API与媒体均为替身，不是实际OSS或安卓验收。
test("公共页面配置、上传/登记/编辑与原生播放器，不调用私有授权链", { timeout: 90000 }, async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const media = await readFile(new URL("./fixtures/demo.webm", import.meta.url));
  const library: LibraryConfig = { mediaBaseUrl: "https://oss.meetdawn.top", objectPrefix: "onlineVideo/", categories: [{ id: "zeta", name: "首类", tags: ["旅行", "逗号,标签"] }, { id: "alpha", name: "空类", tags: [] }, { id: "old", name: "停用类", tags: [], enabled: false }] };
  const fixture = (id: string, title: string): VideoDetail => ({ id, title, categoryId: "zeta", tags: ["旅行", "逗号,标签"], objectKey: `onlineVideo/zeta/${id}.webm`, publicUrl: `https://oss.meetdawn.top/onlineVideo/zeta/${id}.webm`, fileName: `${id}.webm`, durationSeconds: null, sizeBytes: media.length, status: "processing", thumbnailUrl: null, createdAt: "2026-10-03T10:00:00.000Z", codec: null, width: null, height: null, playable: false, lastPositionSeconds: 0 });
  const videos = Array.from({ length: 14 }, (_, index) => fixture(`v-${index}`, `页面样例 ${index}`));
  const paths: string[] = []; const tagQueries: string[][] = []; const mutations: { path: string; body: Record<string, unknown> }[] = [];
  let task: UploadTask | undefined; let completionFailures = 0;
  const server = await createServer({ root, mode: "development", plugins: [{ name: "isolate-public-api-fallback", configureServer(server) { server.middlewares.use((request, response, next) => { if (!request.url?.startsWith("/api/")) { next(); return; } response.statusCode = 503; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ error: { code: "SERVICE_NOT_CONFIGURED" } })); }); } }], server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const address = server.httpServer?.address(); if (!address || typeof address === "string") throw new Error("No browser test address");
    const origin = `http://127.0.0.1:${address.port}`;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript("window.__name = (fn) => fn;");
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => console.error("Browser fixture error:", error.message));
    await page.route("https://oss.meetdawn.top/**", route => route.fulfill({ status: 200, contentType: "video/webm", body: media }));
    await page.route("**/api/**", async route => {
      const request = route.request(); const url = new URL(request.url()); const path = url.pathname; const method = request.method(); if (!path.startsWith("/api/")) return route.continue(); paths.push(path);
      const body = request.headers()["content-type"]?.includes("application/json") ? request.postDataJSON() as Record<string, unknown> : {};
      if (method !== "GET") mutations.push({ path, body });
      const ok = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
      if (path === "/api/auth/me") return ok({ user: { id: "fixture-owner", displayName: "页面测试", totpEnabled: true, authMethod: "totp", authVersion: 1, emailMasked: null, emailVerified: false }, csrfToken: "fixture-csrf" });
      if (path === "/api/library") return ok(library);
      if (path === "/api/library/configuration") return ok({ version: "fixture-v1", writable: false, categories: library.categories.map(category => ({ id: category.id, name: category.name, enabled: category.enabled !== false, tagIds: [], isDefault: false, videoCount: 0, uploadCount: 0 })), tags: [] });
      if (path === "/api/settings/limits") return ok({ maxUploadBytes: 2147483648, partSizeBytes: 262144, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 });
      if (path === "/api/videos") {
        const tags = JSON.parse(url.searchParams.get("tags") ?? "[]") as string[]; tagQueries.push(tags);
        const query = url.searchParams.get("q") ?? ""; const category = url.searchParams.get("categoryId");
        const items = videos.filter(video => (!category || video.categoryId === category) && (video.title.includes(query) || video.tags?.some(tag => tag.includes(query))) && tags.every(tag => video.tags?.includes(tag)));
        const currentPage = Number(url.searchParams.get("page") ?? 1); const pageSize = Number(url.searchParams.get("pageSize") ?? 12);
        return ok({ items: items.slice((currentPage - 1) * pageSize, currentPage * pageSize), total: items.length, page: currentPage, pageSize });
      }
      if (path === "/api/videos/register-public") { const registered = { ...fixture("registered", String(body.title)), categoryId: String(body.categoryId), tags: body.tags as string[], publicUrl: String(body.publicUrl), objectKey: new URL(String(body.publicUrl)).pathname.slice(1) }; videos.unshift(registered); return ok(registered); }
      if (path === "/api/uploads" && method === "GET") return ok({ items: task ? [task] : [], total: task ? 1 : 0, page: 1, pageSize: 20 });
      if (path === "/api/uploads" && method === "POST") { task = { id: "upload-fixture", videoId: null, fileName: String(body.fileName), sizeBytes: Number(body.sizeBytes), partSizeBytes: 262144, status: "uploading", uploadedParts: [], createdAt: "2026-10-03T10:00:00.000Z", title: String(body.title), categoryId: String(body.categoryId), tags: body.tags as string[], clientRequestId: String(body.clientRequestId) }; return ok(task); }
      if (path.startsWith("/api/uploads/") && task) {
        if (path.endsWith("/complete")) {
          if (completionFailures++ === 0) { task.status = "failed"; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UPLOAD_REGISTRATION_FAILED", requestId: "fixture-register-failure" } }) }); }
          const uploaded = { ...fixture("uploaded", task.title ?? ""), tags: task.tags ?? [], fileName: task.fileName }; if (!videos.some(video => video.id === uploaded.id)) videos.unshift(uploaded); task.status = "completed"; task.videoId = uploaded.id; task.publicUrl = uploaded.publicUrl!; return ok({ upload: task, video: uploaded });
        }
        const partMatch = path.match(/\/parts\/(\d+)$/);
        if (partMatch) { const part = { partNumber: Number(partMatch[1]), sizeBytes: request.postDataBuffer()?.length ?? 0, checksum: request.headers()["x-part-checksum"] ?? "" }; task.uploadedParts.push(part); return ok(part); }
        return ok(task);
      }
      const videoMatch = path.match(/^\/api\/videos\/([^/]+)(?:\/progress)?$/);
      if (videoMatch) { const video = videos.find(item => item.id === videoMatch[1]); assert.ok(video); if (path.endsWith("/progress")) { if (method === "PUT") video.lastPositionSeconds = Number(body.positionSeconds); return ok({ videoId: video.id, positionSeconds: video.lastPositionSeconds, updatedAt: null }); } if (method === "PATCH") { if (typeof body.title === "string") video.title = body.title; if (Array.isArray(body.tags)) video.tags = body.tags as string[]; } return ok(video); }
      if (path === "/api/auth/sessions") return ok([]);
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND" } }) });
    });
    await page.goto(origin);
    try { await expect(page.locator(".category-tabs button")).toHaveText(["全部视频", "首类", "空类"]); }
    catch (error) { console.error("Fixture API paths:", paths, "Page:", await page.locator("body").innerText()); throw error; }
    await expect(page.locator(".video-card")).toHaveCount(12);
    await page.getByRole("button", { name: "下一页", exact: true }).click(); await expect(page.locator(".video-card")).toHaveCount(2);
    await page.getByRole("button", { name: "空类", exact: true }).click(); await expect(page.getByRole("heading", { name: "没有找到匹配的视频" })).toBeVisible();
    await page.getByRole("button", { name: "全部视频", exact: true }).click(); await expect(page.locator(".video-card")).toHaveCount(12); await page.getByRole("button", { name: "筛选", exact: true }).click();
    await page.getByRole("checkbox", { name: "旅行", exact: true }).check(); await page.getByRole("checkbox", { name: "逗号,标签", exact: true }).check();
    await expect.poll(() => tagQueries.some(tags => tags.includes("逗号,标签") && tags.includes("旅行"))).toBe(true);
    await page.locator(".video-card").first().getByRole("link", { name: "播放", exact: true }).click();
    const video = page.locator("video"); await expect(video).toHaveAttribute("src", /https:\/\/oss\.meetdawn\.top\/onlineVideo\//);
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThan(0);
    await video.evaluate(async node => { const media = node as HTMLVideoElement; await media.play(); media.currentTime = 2; media.pause(); });
    await expect.poll(() => mutations.some(entry => entry.path.endsWith("/progress") && Number(entry.body.positionSeconds) >= 1.5)).toBe(true);
    await page.getByRole("button", { name: "编辑信息", exact: true }).click(); await page.getByLabel("视频标题", { exact: true }).fill("编辑后的页面样例"); await page.getByRole("checkbox", { name: "旅行", exact: true }).uncheck(); await page.getByRole("button", { name: "保存视频信息", exact: true }).click();
    await expect(page.locator("h1")).toHaveText("编辑后的页面样例"); assert.ok(mutations.some(entry => entry.path.startsWith("/api/videos/") && entry.body.title === "编辑后的页面样例" && JSON.stringify(entry.body.tags) === JSON.stringify(["逗号,标签"])));
    await video.evaluate(node => { Object.defineProperty(node, "error", { configurable: true, value: { code: 4 } }); node.dispatchEvent(new Event("error")); });
    await expect(page.locator(".player-section [role=alert]").filter({ hasText: "当前浏览器无法播放" })).toBeVisible(); await expect(page.locator(".player-section").getByRole("link", { name: "打开原地址", exact: true })).toHaveAttribute("href", /oss\.meetdawn\.top/);
    await page.goto(`${origin}/upload`); await page.getByRole("button", { name: "导入已有视频", exact: true }).click(); const register = page.getByRole("dialog", { name: "导入已有视频", exact: true });
    await register.getByLabel("公开视频地址", { exact: true }).fill("https://oss.meetdawn.top/onlineVideo/existing.webm"); await register.getByLabel("视频标题", { exact: true }).fill("登记样例"); await register.getByRole("checkbox", { name: "旅行", exact: true }).check(); await register.getByRole("button", { name: "登记公开视频", exact: true }).click(); await expect(page.locator(".toast-stack").getByText("公开视频已登记", { exact: true })).toBeVisible();
    await page.goto(`${origin}/upload`); await expect(page.getByLabel("视频文件", { exact: true })).toBeEnabled(); await page.getByLabel("视频文件", { exact: true }).setInputFiles({ name: "sample.webm", mimeType: "video/webm", buffer: media });
    await page.locator("input.sci-input").fill("上传页面样例"); await page.locator("select.sci-select").selectOption("zeta"); await page.locator(".tag-chips-matrix .tag-chip").filter({ hasText: "旅行" }).click(); await page.locator(".save-action-btn").click();
    await expect(page).toHaveURL(/\/tasks$/); await expect(page.getByRole("alert")).toContainText("视频对象已上传"); await expect(page.getByText("视频已登记，封面待补", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "重试完成确认", exact: true }).click(); await expect(page.getByText("视频已登记，封面待补", { exact: true })).toBeVisible(); await page.locator(".upload-task-row").getByRole("button", { name: "查看详情", exact: true }).click(); const taskDetails = page.getByRole("dialog", { name: "任务详情", exact: true }); await expect(taskDetails.getByLabel("公共地址", { exact: true })).toHaveValue("https://oss.meetdawn.top/onlineVideo/zeta/uploaded.webm");
    await taskDetails.getByRole("link", { name: "播放视频", exact: true }).click(); await expect(page.locator("video")).toHaveAttribute("src", "https://oss.meetdawn.top/onlineVideo/zeta/uploaded.webm");
    await page.goto(`${origin}/?q=${encodeURIComponent("逗号,标签")}`); await expect.poll(() => page.locator(".video-card").count()).toBeGreaterThan(0);
    await page.goto(`${origin}/categories`); await expect(page.locator("[data-category-id]")).toHaveCount(2); await expect(page.locator("tbody input")).toHaveCount(0); await page.getByLabel("显示已删除分类").check(); await expect(page.locator("[data-category-id]")).toHaveCount(3); await expect(page.locator("[data-category-id=old]")).toContainText("停用类"); await expect(page.locator("[data-category-id=old] .management-state")).toHaveText("已删除"); await expect(page.getByText("分组", { exact: true })).toHaveCount(0);
    await page.goto(`${origin}/security`); await expect(page.getByRole("heading", { name: "账户安全", exact: true })).toBeVisible();
    assert.equal(paths.some(path => /playback-sessions|heartbeat|\/source$|\/stream$|download-authorizations|\/settings\/usage$|\/groups/.test(path)), false);
    await context.close();
  } finally { await browser.close(); await server.close(); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import Database from "better-sqlite3";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import type { AuthSession, VideoDetail } from "@online-video/shared";
import { buildApp } from "../../api/src/app";
import { readConfig } from "../../api/src/core/config";
import { HttpError } from "../../api/src/core/errors";
import { openDatabase } from "../../api/src/db/database";
import { createRepositories } from "../../api/src/db/repositories";
import { createMediaModule, MockStorageAdapter, UnavailableMetadataInspector } from "../../api/src/modules/media/index";

test("视频数据闭环：真实可解码样例、新上传/公共登记/历史补采、SQLite重启、原地编辑与仅删记录", { timeout: 150000 }, async t => {
  const evidence = fileURLToPath(new URL(`../../../.local/acceptance/video-data-${randomUUID()}/`, import.meta.url));
  await mkdir(evidence, { recursive: true }); const path = join(evidence, "isolated-video.db"); new Database(path).close();
  let database = openDatabase(path, { initialize: true });
  const config = readConfig({ NODE_ENV: "test", MAX_UPLOAD_BYTES: "16777216", UPLOAD_PART_SIZE_BYTES: "131072", MAX_UPLOAD_CONCURRENCY: "1", MEDIA_REQUESTS_PER_MINUTE: "1000", OSS_OBJECT_PREFIX: "onlineVideo/" });
  config.library = { mediaBaseUrl: "https://isolated-media.test", objectPrefix: "onlineVideo/", categories: [{ id: "category", name: "样例分类", tags: ["收藏"] }] };
  const at = "2026-11-02T10:00:00.000Z";
  database.client.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES('owner','数据闭环测试','test-only','test-only',?)").run(at);
  database.client.prepare("INSERT INTO categories(id,owner_id,name,name_key,is_default,created_at) VALUES('category','owner','样例分类','样例分类',1,?)").run(at);
  const session: AuthSession = { user: { id: "owner", displayName: "数据闭环测试", totpEnabled: false, authMethod: "password", authVersion: 1, emailMasked: null, emailVerified: false }, csrfToken: "isolated-csrf", defaultTheme: "light" };
  let loggedIn = true; let failSave = false; let failDelete = false; let failDuration = false; let failCover = false;
  const storage = new MockStorageAdapter("onlineVideo/"); const sample = await readFile(new URL("./fixtures/cover-timeline.mp4", import.meta.url));
  storage.seed("onlineVideo/existing.mp4", sample, "video/mp4"); storage.seed("onlineVideo/broken.mp4", Buffer.from("not decodable media"), "video/mp4");
  const auth = { requireUser: async (request: { headers: Record<string, unknown> }, { mutation }: { mutation: boolean }) => {
    if (!loggedIn) throw new HttpError("AUTH_REQUIRED");
    if (mutation && request.headers["x-csrf-token"] !== session.csrfToken) throw new HttpError("CSRF_REJECTED");
    return { user: session.user, loginSessionId: "isolated-login" };
  } };
  const start = async () => {
    const repos = createRepositories(database, () => new Date(at), config.library);
    const metadata = new UnavailableMetadataInspector();
    const app = await buildApp({ config, logger: false, backend: { config, database, auth, now: () => new Date(at) }, media: { register: createMediaModule({ ...config.media!, metadata }), dependencies: { kind: "test", config, auth, ...repos, storage, now: () => new Date(at) } } });
    app.get("/api/setup/status", async () => ({ data: { stage: "ready", authenticated: false, setupAvailable: false } }));
    app.get("/api/auth/me", async () => { if (!loggedIn) throw new HttpError("AUTH_REQUIRED"); return { data: session }; });
    app.get("/api/auth/login/options", async () => ({ data: { authMethod: "password", serverTime: at, emailProviders: [] } }));
    app.post("/api/auth/logout", async () => { loggedIn = false; return { data: { success: true } }; });
    app.post("/api/auth/login", async () => { loggedIn = true; return { data: session }; });
    await app.ready(); return app;
  };
  let app = await start();
  const seed = async (key: string, title: string) => (await app.inject({ method: "POST", url: "/api/videos/register-public", headers: { "x-csrf-token": session.csrfToken }, payload: { publicUrl: `${config.library!.mediaBaseUrl}/${key}`, title, categoryId: "category", tags: ["收藏"] } })).json().data as VideoDetail;
  const history = await seed("onlineVideo/existing.mp4", "历史缺失时长"); const broken = await seed("onlineVideo/broken.mp4", "损坏视频可重试");
  const server = await createServer({ configFile: false, cacheDir: join(evidence, "vite-cache"), root: fileURLToPath(new URL("..", import.meta.url)), mode: "test", plugins: [react()], server: { host: "127.0.0.1", port: 15193, strictPort: false, hmr: false, watch: { ignored: ["**/*"] } } });
  await server.listen(); const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = []; const mediaReads: string[] = []; const mutations: string[] = [];
  await context.addInitScript("window.__name = (fn) => fn;");
  await context.route(url => ["http:", "https:"].includes(url.protocol) && url.origin !== origin && url.origin !== config.library!.mediaBaseUrl, route => route.abort());
  await context.route(url => url.protocol === "https:", route => {
    const url = new URL(route.request().url()); if (url.origin !== config.library!.mediaBaseUrl) return route.abort();
    mediaReads.push(url.pathname); const object = storage.objects.get(decodeURIComponent(url.pathname).slice(1));
    return object ? route.fulfill({ status: 200, contentType: object.metadata.contentType, body: object.bytes }) : route.fulfill({ status: 404, body: "missing" });
  });
  await context.route("**/api/**", async route => {
    const request = route.request(); const url = new URL(request.url()); if (!url.pathname.startsWith("/api/")) return route.continue();
    const method = request.method(); if (method !== "GET") mutations.push(`${method} ${url.pathname}`);
    const code = failSave && method === "PATCH" && /^\/api\/videos\/[^/]+$/.test(url.pathname) ? "STORAGE_UNAVAILABLE" : failDelete && method === "DELETE" ? "VIDEO_RECORD_BUSY" : failDuration && url.pathname.endsWith("/duration") ? "STORAGE_UNAVAILABLE" : failCover && url.pathname.endsWith("/cover") ? "COVER_REGISTRATION_FAILED" : undefined;
    if (code) return route.fulfill({ status: code === "VIDEO_RECORD_BUSY" ? 409 : 503, contentType: "application/json", body: JSON.stringify({ error: { code } }) });
    const response = await app.inject({ method: method as "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: `${url.pathname}${url.search}`, headers: request.headers(), ...(request.postDataBuffer() ? { payload: request.postDataBuffer()! } : {}) });
    return route.fulfill({ status: response.statusCode, contentType: String(response.headers["content-type"] ?? "application/json"), body: response.rawPayload });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on("pageerror", error => errors.push(error.message));
  t.after(async () => { await browser.close(); await server.close(); await app.close(); if (database.client.open) database.close(); });
  const durationRow = (id: string) => database.client.prepare("SELECT duration_seconds duration FROM videos WHERE id=?").get(id) as { duration: number | null };

  await page.goto(origin); await expect(page.locator(".video-card")).toHaveCount(2); assert.deepEqual(mediaReads, [], "首页不能加载所有视频采集时长");
  failDuration = true; // 提前打开详情页会触发时长采集，先保持"历史缺失时长"的未采集状态供后续用例使用
  const dialog = page.getByRole("dialog", { name: "编辑视频信息", exact: true });
  await page.goto(`${origin}/videos/${history.id}`); await page.getByRole("button", { name: "编辑信息", exact: true }).click();
  await expect(dialog.getByLabel("视频标题", { exact: true })).toHaveValue(history.title);
  const beforeCancel = mutations.length; await dialog.getByLabel("视频标题", { exact: true }).fill("取消不保存"); await dialog.getByRole("button", { name: "取消", exact: true }).click(); assert.equal(mutations.length, beforeCancel);
  await page.getByRole("button", { name: "编辑信息", exact: true }).click();
  await dialog.getByLabel("视频标题", { exact: true }).fill("保留失败草稿"); failSave = true; await dialog.getByRole("button", { name: "保存视频信息", exact: true }).click(); await expect(dialog.getByRole("alert")).toBeVisible(); await expect(dialog.getByLabel("视频标题", { exact: true })).toHaveValue("保留失败草稿"); failSave = false;
  for (const [theme, width, height] of [["light", 1440, 900], ["dark", 1440, 900], ["light", 375, 812], ["dark", 320, 640], ["light", 768, 900]] as const) {
    await page.setViewportSize({ width, height }); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await expect(dialog.getByRole("button", { name: "保存视频信息", exact: true })).toBeInViewport(); await page.screenshot({ path: join(evidence, `editor-${theme}-${width}.png`) });
  }
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await page.setViewportSize({ width: 1440, height: 900 });

  failDuration = true; await page.goto(`${origin}/videos/${history.id}`); const player = page.locator(".player-section video");
  try { await expect.poll(() => player.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThan(0); }
  catch (error) { t.diagnostic(JSON.stringify({ mediaReads, player: await player.evaluate(node => { const video = node as HTMLVideoElement; return { src: video.src, currentSrc: video.currentSrc, networkState: video.networkState, error: video.error?.message }; }), body: await page.locator("body").innerText() })); throw error; }
  const actual = await player.evaluate(node => (node as HTMLVideoElement).duration); assert.ok(actual > 0 && Number.isFinite(actual));
  await expect(page.getByRole("button", { name: "重新采集时长", exact: true })).toBeVisible(); assert.equal(durationRow(history.id).duration, null); failDuration = false;
  await player.evaluate(async node => { const video = node as HTMLVideoElement; video.dataset.identity = "not-remounted"; await video.play(); });
  await page.getByRole("button", { name: "重新采集时长", exact: true }).click(); await expect.poll(() => durationRow(history.id).duration).toBeCloseTo(actual, 3);
  await expect(page.locator(".sci-data-cell").filter({ hasText: /^时长/ }).locator(".sci-data-value")).not.toHaveText("时长待采集");
  await expect(player).toHaveAttribute("data-identity", "not-remounted"); assert.equal(await player.evaluate(node => (node as HTMLVideoElement).paused), false);
  await page.reload(); await expect(player).toBeVisible(); assert.ok(Math.abs(durationRow(history.id).duration! - actual) < .001);
  await page.goto(origin); await expect(page.locator(".video-card").filter({ hasText: history.title }).locator(".sci-card-hud-time")).toBeVisible();

  await page.goto(`${origin}/upload`); await page.getByRole("button", { name: "导入已有视频", exact: true }).click(); const importing = page.getByRole("dialog", { name: "导入已有视频", exact: true });
  storage.seed("onlineVideo/registered.mp4", sample, "video/mp4"); await importing.getByLabel("公开视频地址", { exact: true }).fill("https://isolated-media.test/onlineVideo/registered.mp4"); await importing.getByLabel("视频标题", { exact: true }).fill("公共地址登记样例"); await importing.getByRole("button", { name: "登记公开视频", exact: true }).click();
  await expect(importing).toContainText("打开视频详情后"); await importing.getByRole("link", { name: "播放视频", exact: true }).click(); await expect(page.locator(".video-duration-feedback")).toContainText("时长已保存");
  const registeredId = new URL(page.url()).pathname.split("/").at(-1)!; assert.ok(Math.abs(durationRow(registeredId).duration! - actual) < .001);

  await page.goto(`${origin}/upload`); await page.getByLabel("视频文件", { exact: true }).setInputFiles({ name: "真实上传样例.mp4", mimeType: "video/mp4", buffer: sample }); await page.locator("input.sci-input").fill("新上传真实时长"); await page.getByRole("button", { name: "提交 1 个视频并上传", exact: true }).click();
  await expect(page).toHaveURL(/\/tasks$/); await expect(page.locator(".task-state-cell")).toContainText("时长已保存");
  const uploaded = database.client.prepare("SELECT id,duration_seconds duration FROM videos WHERE title='新上传真实时长'").get() as { id: string; duration: number };
  assert.ok(Math.abs(uploaded.duration - actual) < .001); const uploadRequests = mutations.filter(value => value === "POST /api/uploads").length; assert.equal(uploadRequests, 1);

  await page.goto(`${origin}/videos/${broken.id}`); await expect(page.getByRole("button", { name: "重新采集时长", exact: true })).toBeVisible(); assert.equal(durationRow(broken.id).duration, null); await expect(page.locator(".sci-data-cell").filter({ hasText: /^时长/ }).locator(".sci-data-value")).toHaveText("时长待采集");
  storage.seed("onlineVideo/broken.mp4", sample, "video/mp4"); await page.getByRole("button", { name: "重新采集时长", exact: true }).click(); await expect.poll(() => durationRow(broken.id).duration).toBeCloseTo(actual, 3);

  await page.goto("about:blank"); await app.close(); database.close(); database = openDatabase(path); app = await start();
  assert.ok(Math.abs(durationRow(uploaded.id).duration! - actual) < .001); assert.ok(Math.abs(durationRow(history.id).duration! - actual) < .001);
  loggedIn = false; await page.goto(origin); await expect(page).toHaveURL(/\/login$/); await page.getByLabel("密码", { exact: true }).fill("isolated-test-password"); await page.getByRole("button", { name: "进入高光时刻", exact: true }).click(); await expect(page.locator(".video-card").filter({ hasText: "新上传真实时长" }).locator(".sci-card-hud-time")).toBeVisible();

  await page.goto(`${origin}/videos/${uploaded.id}`); await page.getByRole("button", { name: "编辑信息", exact: true }).click(); await expect(dialog).toBeVisible();
  const originalCover = (await createRepositories(database, () => new Date(at), config.library).videos.findOwned("owner", uploaded.id))!.video.coverObjectKey;
  // 手机上常见的截图是 1600px 长边的 PNG：前端必须转成服务端允许的 960px 内 JPEG 才能保存成功。
  const screenshot = Buffer.from(await page.evaluate(async () => { const canvas = document.createElement("canvas"); canvas.width = 1600; canvas.height = 1200; const context = canvas.getContext("2d")!; context.fillStyle = "#228855"; context.fillRect(0, 0, 1600, 1200); const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png")); return [...new Uint8Array(await blob.arrayBuffer())]; }));
  await dialog.getByLabel(/替换封面/).setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: screenshot });
  // 关掉系统文件选择框会让窗口重新获得焦点并触发配置刷新；此时编辑器不得被卸载重挂，
  // 否则已选封面会丢失、保存时封面被静默跳过（表现为"保存后封面没变"）。
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog).toBeVisible(); await expect(dialog).toContainText("replacement.jpg");
  failCover = true; await dialog.getByRole("button", { name: "保存视频信息", exact: true }).click(); await expect(dialog).toContainText("当前选择已保留"); await expect(dialog).toContainText("replacement.jpg"); failCover = false;
  await dialog.getByRole("button", { name: "保存视频信息", exact: true }).click(); await expect(dialog).toHaveCount(0);
  const replacedCover = (await createRepositories(database, () => new Date(at), config.library).videos.findOwned("owner", uploaded.id))!.video.coverObjectKey;
  assert.ok(replacedCover && replacedCover !== originalCover, "聚焦刷新后已选封面仍必须在保存时写库");
  assert.ok(storage.objects.has(replacedCover), "新封面对象必须已上传");
  assert.ok(originalCover && storage.objects.has(originalCover), "替换封面不能顺手删除旧对象");
  await page.getByRole("button", { name: "编辑信息", exact: true }).click(); await expect(dialog).toBeVisible();
  const objectCount = storage.objects.size; const deleteButton = dialog.getByRole("button", { name: "仅删除数据库记录", exact: true });
  await deleteButton.click(); await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click(); await expect(deleteButton).toBeFocused(); assert.ok(durationRow(uploaded.id));
  failDelete = true; await deleteButton.click(); await page.getByRole("alertdialog").getByRole("button", { name: "确认仅删除记录", exact: true }).click(); await expect(dialog.getByRole("alert")).toBeVisible(); assert.ok(durationRow(uploaded.id)); failDelete = false;
  await deleteButton.click(); await page.getByRole("alertdialog").getByRole("button", { name: "确认仅删除记录", exact: true }).click(); const result = page.getByRole("dialog", { name: "记录已删除，OSS 内容保留", exact: true }); await expect(result).toBeVisible();
  const manifest = result.getByLabel("OSS 对象路径清单", { exact: true }); await expect(manifest).toHaveValue(/Object Key: onlineVideo\/category\//); assert.equal(durationRow(uploaded.id), undefined); assert.equal(storage.objects.size, objectCount);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("isolated denied"); } } }); });
  await result.getByRole("button", { name: "复制 OSS 路径清单", exact: true }).click(); await expect(result).toContainText("复制失败"); await expect(manifest).not.toBeEditable(); await page.screenshot({ path: join(evidence, "delete-result.png") });
  await result.getByRole("button", { name: "关闭", exact: true }).click(); await expect(page.locator(".video-card").filter({ hasText: "新上传真实时长" })).toHaveCount(0);
  const taskId = (database.client.prepare("SELECT id,video_id FROM upload_tasks WHERE title='新上传真实时长'").get() as { id: string }).id;
  await page.goto(`${origin}/tasks`); const deletedTask = page.locator(`[data-task-id="${taskId}"]`); await expect(deletedTask).toContainText("视频记录已删除，OSS 保留");
  await expect(deletedTask.getByRole("link", { name: "播放视频", exact: true })).toHaveCount(0); await expect(deletedTask.getByRole("button", { name: /单独重试/ })).toHaveCount(0); await expect(deletedTask.locator("input[type=file]")).toHaveCount(0);
  await page.reload(); await expect(deletedTask).toContainText("视频记录已删除，OSS 保留"); await expect(deletedTask.getByRole("link", { name: "播放视频", exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []); await writeFile(join(evidence, "result.json"), JSON.stringify({ actualSeconds: actual, historyId: history.id, registeredId, uploadedId: uploaded.id, mediaReads, mutations, storageObjectsPreserved: objectCount }, null, 2));
  t.diagnostic(`真实解码/SQLite/API证据（身份与OSS均为替身）：${evidence}`);
});

test("时长探测资源边界：真实File、超时/取消/无效值、并发拒绝与整文件读取保护", { timeout: 60000 }, async t => {
  const evidence = fileURLToPath(new URL(`../../../.local/acceptance/video-duration-resource-${randomUUID()}/`, import.meta.url)); await mkdir(evidence, { recursive: true });
  const server = await createServer({ configFile: false, cacheDir: join(evidence, "vite-cache"), root: fileURLToPath(new URL("..", import.meta.url)), plugins: [react()], server: { host: "127.0.0.1", port: 15194, strictPort: false, hmr: false, watch: { ignored: ["**/*"] } } }); await server.listen();
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage(); await page.addInitScript("window.__name = (fn) => fn;"); const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  await page.route(url => ["http:", "https:"].includes(url.protocol) && url.origin !== origin, route => route.abort()); await page.goto(origin);
  const sample = [...await readFile(new URL("./fixtures/cover-timeline.mp4", import.meta.url))];
  const result = await page.evaluate(async data => {
    const path = "/src/media-duration.ts"; const { readMediaDuration, isVideoDuration } = await import(path) as typeof import("../src/media-duration");
    const file = new File([new Uint8Array(data)], "real.mp4", { type: "video/mp4" }); file.arrayBuffer = async () => { throw new Error("禁止整文件arrayBuffer"); };
    const actual = await readMediaDuration(file); const invalid = [null, 0, -1, NaN, Infinity, 2678401].map(value => isVideoDuration(value));
    const create = document.createElement.bind(document); let held: HTMLVideoElement | undefined;
    document.createElement = ((name: string, options?: ElementCreationOptions) => { const element = create(name, options); if (name === "video") { held = element as HTMLVideoElement; Object.defineProperty(element, "src", { configurable: true, set() {} }); } return element; }) as typeof document.createElement;
    let timeout = ""; let concurrent = "";
    const pending = readMediaDuration(file, undefined, 25).catch(error => { timeout = (error as Error).message; return 0; });
    try { await readMediaDuration(file); } catch (error) { concurrent = (error as Error).message; } await pending;
    const controller = new AbortController(); const cancelled = readMediaDuration(file, controller.signal).catch(error => (error as Error).name); controller.abort(); const aborted = await cancelled;
    const invalidPending = readMediaDuration(file).catch(error => (error as Error).message); Object.defineProperty(held!, "readyState", { value: 1 }); Object.defineProperty(held!, "duration", { value: Infinity }); held!.dispatchEvent(new Event("loadedmetadata")); const unknown = await invalidPending;
    document.createElement = create as typeof document.createElement;
    return { actual, invalid, timeout, concurrent, aborted, unknown };
  }, sample);
  assert.ok(result.actual > 0); assert.deepEqual(result.invalid, [false, false, false, false, false, false]); assert.match(result.timeout, /超时/); assert.match(result.concurrent, /另一个视频/); assert.equal(result.aborted, "AbortError"); assert.match(String(result.unknown), /有效的总时长/);
  await writeFile(join(evidence, "result.json"), JSON.stringify(result, null, 2)); t.diagnostic(`时长资源边界证据：${evidence}`);
});

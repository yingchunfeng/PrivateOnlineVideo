import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { chromium, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { preview } from "vite";
import { decryptSecret, readMasterKey, totp, verifyPassword } from "../src/modules/auth/crypto.js";

// 仅在明确 --execute 时执行用户授权的页面上传；报告不包含登录资料或云凭据。
const execute = process.argv.includes("--execute");
const resumeIndex = process.argv.indexOf("--resume");
if (!execute && resumeIndex < 0) throw new Error("EXPLICIT_EXECUTION_REQUIRED");
const sitePortIndex = process.argv.indexOf("--site-port");
const sitePort = sitePortIndex < 0 ? 5173 : Number(process.argv[sitePortIndex + 1]);
assert.ok([5173, 5174].includes(sitePort));
const site = `http://127.0.0.1:${sitePort}`;
const apiPortIndex = process.argv.indexOf("--api-port");
const apiPort = apiPortIndex < 0 ? 3000 : Number(process.argv[apiPortIndex + 1]);
assert.ok([3000, 3010].includes(apiPort));
const mediaOrigin = "https://oss.meetdawn.top";
const sample = resolve(".local/acceptance/samples/ces-h264-aac-20261002.mp4");
const expectedHash = "f7083ce3ecc34bf2639622d4144f545022570e9601f5f9fc447257fc459d12a4";
const directory = resolve(".local/acceptance", `simple-oss-browser-${Date.now()}-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const reportFile = resolve(directory, "report.json");
const report: Record<string, any> = { startedAt: new Date().toISOString(), step: "sample", status: "running", checks: {}, apiPaths: [], media: [] };
const save = () => writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");
const previous = resumeIndex < 0 ? undefined : JSON.parse(await readFile(resolve(process.argv[resumeIndex + 1]!), "utf8"));
if (previous) report.video = previous.video;
assert.equal((await stat(sample)).size, 460063);
assert.equal(createHash("sha256").update(await readFile(sample)).digest("hex"), expectedHash);
report.checks.sample = { bytes: 460063, sha256: expectedHash };
const setup = JSON.parse(await readFile(resolve(".local/account-setup.json"), "utf8"));
const db = new Database(resolve(".local/data/video-library.db"), { readonly: true, fileMustExist: true });
const authColumns = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
if (authColumns.some(column => column.name === "auth_method")) {
  const authentication = db.prepare("SELECT auth_method FROM users WHERE singleton=1").get() as { auth_method: string } | undefined;
  if (authentication?.auth_method !== "totp") { db.close(); throw new Error("此历史真实 OSS 脚本仅支持 TOTP 账号；邮箱账号请使用交互登录及新账号隔离验收，禁止使用旧 TOTP 替代。初始化资料不是当前密码来源。"); }
}
const user = db.prepare("SELECT id,password_hash,totp_cipher,last_totp_counter FROM users WHERE singleton=1").get() as any;
db.close();
assert.ok(await verifyPassword(user.password_hash, setup.password), "初始化历史密码已与当前数据库不同，请改为当前凭据流程；不能重新初始化或覆盖账号");
const secret = decryptSecret(user.totp_cipher, await readMasterKey(resolve(".local/secrets/auth.key")));
if (Math.floor(Date.now() / 30000) <= user.last_totp_counter || Date.now() % 30000 > 26000) {
  await new Promise(done => setTimeout(done, 31000 - Date.now() % 30000));
}
let frontend: Awaited<ReturnType<typeof preview>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
try {
  report.step = "frontend-service";
  frontend = await preview({ root: resolve("apps/web"), mode: "production", preview: { host: "127.0.0.1", port: sitePort, strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}` } } } });
  report.checks.productionBuild = true;
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await context.addInitScript("window.__name=(fn)=>fn;");
  page = await context.newPage(); page.setDefaultTimeout(20000);
  const responseTasks: Promise<void>[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === site && url.pathname.startsWith("/api/")) report.apiPaths.push(`${request.method()} ${url.pathname}`);
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.origin === mediaOrigin) responseTasks.push((async () => {
      const headers = await response.request().allHeaders();
      report.media.push({ url: response.url(), status: response.status(), range: headers.range ?? null, cookieSent: !!headers.cookie });
    })());
  });
  report.step = "existing-account-page-login"; await save();
  await page.goto(`${site}/login`);
  await expect(page.getByText("开发 Mock · 所有业务为模拟数据，未连接真实 OSS", { exact: true })).toHaveCount(0);
  await page.locator('input[autocomplete="current-password"]').fill(setup.password);
  await page.locator('input[autocomplete="one-time-code"]').fill(totp(secret).generate());
  await page.getByRole("button", { name: "进入视频库", exact: true }).click();
  await expect(page.getByRole("heading", { name: "我的视频库", exact: true })).toBeVisible();
  const configResponse = await context.request.get(`${site}/api/library`);
  assert.equal(configResponse.status(), 200); const library = (await configResponse.json()).data;
  report.checks.categories = library.categories;
  const category = library.categories.find((item: any) => item.enabled !== false);
  assert.ok(category, "Need an enabled configured category");
  const selectedTag = category.tags.at(-1);
  if (!previous) {
    report.step = "register-provided-public-address"; await save();
    await page.getByRole("button", { name: "导入已有视频", exact: true }).click();
    const panel = page.locator(".import-panel");
    await panel.locator('input[type="url"]').fill(`${mediaOrigin}/onlineVideo/96257570ce7bc1f46e749df9ab2598f7.mp4`);
    await panel.getByLabel("视频标题", { exact: true }).fill("已登记公开样例20261003");
    await panel.locator("select").selectOption(category.id);
    if (selectedTag) await panel.getByLabel(selectedTag, { exact: true }).check();
    const registered = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/videos/register-public");
    await panel.getByRole("button", { name: "登记公开视频", exact: true }).click();
    const registration = await registered; assert.equal(registration.status(), 200);
    report.registered = (await registration.json()).data;
    assert.equal(report.registered.categoryId, category.id);
    if (selectedTag) assert.ok(report.registered.tags.includes(selectedTag));
    await save();
    report.step = "page-category-tag-file-upload";
    await page.locator("#main .page-head").getByRole("link", { name: "上传视频", exact: true }).click();
    await page.locator('input.visually-hidden-file[type="file"]').setInputFiles(sample);
    const title = `公共上传验收20261003-${Date.now()}`; report.title = title;
    await page.getByPlaceholder("输入视频标题", { exact: true }).fill(title);
    await page.locator("select.sci-select").selectOption(category.id);
    if (selectedTag) await page.locator(".tag-chips-matrix .tag-chip").filter({ hasText: selectedTag }).click();
    const completed = page.waitForResponse(response => response.request().method() === "POST" && /\/api\/uploads\/[^/]+\/complete$/.test(new URL(response.url()).pathname), { timeout: 120000 });
    const created = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/uploads");
    await save(); await page.getByRole("button", { name: "保存并上传", exact: true }).click();
    const started = await created; assert.equal(started.status(), 200); report.upload = (await started.json()).data; await save();
    const finished = await completed; assert.equal(finished.status(), 200);
    const data = (await finished.json()).data; assert.equal(data.upload.status, "completed");
    assert.equal(data.upload.videoId, data.video.id); report.upload = data.upload; report.video = data.video; await save();
    assert.ok(data.video.objectKey.startsWith(`onlineVideo/${category.id}/`));
    assert.match(data.video.objectKey, /\/[a-f0-9-]+\.mp4$/);
    assert.equal(data.video.publicUrl, `${mediaOrigin}/${data.video.objectKey}`);
    assert.equal(new URL(data.video.publicUrl).search, "");
    assert.ok(data.video.tags.includes(selectedTag));
    await expect(page.getByRole("link", { name: "播放视频", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "播放视频", exact: true }).click();
  } else {
    report.step = "restart-persistence";
    const detail = await context.request.get(`${site}/api/videos/${report.video.id}`);
    assert.equal(detail.status(), 200); const current = (await detail.json()).data;
    for (const field of ["id", "title", "categoryId", "tags", "objectKey", "publicUrl"]) assert.deepEqual(current[field], report.video[field]);
    report.checks.restartPreserved = true;
    await page.goto(`${site}/videos/${report.video.id}`);
  }
  report.step = "direct-native-playback"; await save();
  const video = page.locator("video");
  await expect(video).toBeVisible(); assert.equal(await video.getAttribute("src"), report.video.publicUrl);
  assert.equal(await video.evaluate(node => (node as HTMLVideoElement).controls), true);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThan(0);
  await video.evaluate(async node => { const media = node as HTMLVideoElement; media.muted = true; await media.play(); });
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(.3);
  await video.evaluate(node => (node as HTMLVideoElement).pause());
  assert.equal(await video.evaluate(node => (node as HTMLVideoElement).paused), true);
  await video.evaluate(node => { (node as HTMLVideoElement).currentTime = 2; });
  await expect.poll(() => video.evaluate(node => Math.abs((node as HTMLVideoElement).currentTime - 2))).toBeLessThan(.5);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).seeking)).toBe(false);
  await video.click();
  await video.evaluate(async node => { await node.requestFullscreen(); });
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
  await page.evaluate(() => document.exitFullscreen());
  report.checks.playPauseSeekFullscreen = true;
  await page.screenshot({ path: resolve(directory, "native-player.png"), fullPage: true });
  report.step = "anonymous-new-tab"; await save();
  const anonymous = await browser.newContext(); assert.equal((await anonymous.cookies()).length, 0);
  const publicPage = await anonymous.newPage(); const direct = await publicPage.goto(report.video.publicUrl);
  assert.ok(direct && [200, 206].includes(direct.status()));
  await expect.poll(() => publicPage.locator("video").evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThan(0);
  report.checks.anonymousUrl = { status: direct!.status(), url: report.video.publicUrl };
  await anonymous.close();
  report.step = "search-category-tag"; await save();
  await page.goto(site);
  await page.locator('input[type="search"]').fill(report.video.title);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByRole("button", { name: category.name, exact: true }).click();
  await expect(page.getByRole("heading", { name: report.video.title, exact: true })).toBeVisible();
  if (selectedTag) {
    await page.getByRole("button", { name: "筛选", exact: false }).click();
    await page.getByLabel(selectedTag, { exact: true }).check();
    await expect(page.getByRole("heading", { name: report.video.title, exact: true })).toBeVisible();
  }
  report.checks.searchCategoryTag = true;
  await page.screenshot({ path: resolve(directory, "search-result.png"), fullPage: true });
  await Promise.all(responseTasks);
  assert.equal(report.apiPaths.some((path: string) => /playback-sessions|\/source|heartbeat|\/stream|download-authorizations/.test(path)), false);
  assert.ok(report.media.some((item: any) => item.url === report.video.publicUrl && [200, 206].includes(item.status)));
  assert.equal(report.media.some((item: any) => item.cookieSent || new URL(item.url).search), false);
  report.checks.noPrivatePlaybackRequests = true;
  await page.locator(".topbar-logout-btn").click();
  report.status = "passed"; report.step = "completed"; report.completedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: report.status, report: reportFile, videoId: report.video.id, publicUrl: report.video.publicUrl, restart: !!previous }));
} catch (error) {
  report.status = "failed"; report.failure = error instanceof Error ? error.message.replace(/https?:\/\/[^\s]+/g, "<url>").slice(0, 500) : "UNKNOWN_FAILURE";
  await save();
  if (page && report.step !== "existing-account-page-login") await page.screenshot({ path: resolve(directory, "failure.png"), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ status: "failed", step: report.step, report: reportFile })); process.exitCode = 1;
} finally {
  await browser?.close();
  if (frontend) await new Promise<void>((done, reject) => frontend!.httpServer.close(error => error ? reject(error) : done()));
}

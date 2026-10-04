import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import OSS from "ali-oss";
import { createServer } from "vite";
import { startLocalOss } from "../../api/test/integration/local-oss-server";
import { buildApp } from "../../api/src/app";
import { readConfig } from "../../api/src/core/config";
import { openDatabase, WORKSPACE_ROOT } from "../../api/src/db/database";
import { createRepositories } from "../../api/src/db/repositories";
import { AuthService, initializeAccount } from "../../api/src/modules/auth/service";
import { readAuthSettings } from "../../api/src/modules/auth/settings";
import { totp } from "../../api/src/modules/auth/crypto";
import { createMediaModule } from "../../api/src/modules/media/index";
import { OssStorageAdapter } from "../../api/src/modules/media/storage/oss";
import type { OssClient } from "../../api/src/modules/media/storage/oss";
import { OssPresignedSourceProvider } from "../../api/src/modules/media/storage/signing";
import { FFprobeMetadataInspector } from "../../api/src/modules/media/metadata/ffprobe";
import type { MediaDependencies } from "../../api/src/core/contracts/index";

test("真实3600秒H264：长位置Range/续签状态/独立心跳/进度重启/实际会话过期", async t => {
  const sample = resolve(WORKSPACE_ROOT, ".local/tests/stage2-long-media-20261002/long-3600.mp4");
  const probe = resolve(WORKSPACE_ROOT, ".local/tools/ffmpeg-9.0.2-stage2/ffprobe.exe");
  const identity = { bucket: "test-bucket", region: "cn-hangzhou", prefix: "onlineVideo/", accessKeyId: "long-local-sts", accessKeySecret: "long-local-secret", stsToken: "long-local-token" };
  const protocol = await startLocalOss(identity); t.after(() => protocol.close());
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `stage2-long-browser-${Date.now()}-${randomUUID()}`); await mkdir(directory, { recursive: true });
  const path = resolve(directory, "application.db"); new Database(path).close(); let database = openDatabase(path, { initialize: true });
  const key = randomBytes(32); const credentials = await initializeAccount(database, key, "隔离长视频浏览器"); const now = () => new Date();
  const settings = readAuthSettings("test", {});
  const config = readConfig({ NODE_ENV: "test", STORAGE_DRIVER: "oss", PLAYBACK_MODE: "oss", USAGE_TIMEZONE: "Asia/Shanghai", MAX_PLAYBACK_SESSIONS: "3",
    MAX_UPLOAD_BYTES: "2147483648", UPLOAD_PART_SIZE_BYTES: "8388608", MAX_UPLOAD_CONCURRENCY: "2", PLAYBACK_SESSION_TTL_MS: "45000",
    MAX_AUTHORIZATIONS_PER_MINUTE: "120", MEDIA_REQUESTS_PER_MINUTE: "600", IMPORT_PREVIEW_TTL_MS: "600000", MAX_IMPORT_PREVIEWS: "16",
    OSS_REGION: "cn-hangzhou", OSS_BUCKET: identity.bucket, OSS_OBJECT_PREFIX: identity.prefix, OSS_ENDPOINT: "https://oss-cn-hangzhou.aliyuncs.com",
    OSS_NETWORK: "public", OSS_ALLOW_PUBLIC_NETWORK: "true", OSS_PLAYBACK_ENDPOINT: "https://media.example.invalid", OSS_CREDENTIAL_FILE: resolve(directory, "unused.json"),
    OSS_ROLE_ARN: "acs:ram::123456789:role/test", OSS_STS_DURATION_SECONDS: "3600", OSS_STS_REFRESH_BEFORE_SECONDS: "300", OSS_SIGNED_URL_TTL_SECONDS: "3600", OSS_CLOCK_SKEW_SECONDS: "30" });
  // 读取用途只给18秒剩余期；真实签名器把URL压到12秒，绝不调用真实STS。
  const provider = { get: async () => ({ ...identity, expiration: new Date(Date.now() + 18000).toISOString() }) };
  const storage = new OssStorageAdapter({ bucket: identity.bucket, region: "cn-hangzhou", endpoint: config.oss!.endpoint, network: "public", allowPublicNetwork: true, objectPrefix: identity.prefix, credentialFile: "unused-local-test" }, input => new OSS({ ...input, endpoint: protocol.endpoint, cname: true }) as unknown as OssClient, provider.get);
  const sources = new OssPresignedSourceProvider({ bucket: identity.bucket, region: "cn-hangzhou", endpoint: protocol.endpoint, objectPrefix: identity.prefix, ttlSeconds: 12, safetySeconds: 1, renewBeforeSeconds: 4, kind: "test" }, provider, input => new OSS(input));
  const metadata = new FFprobeMetadataInspector({ executable: probe, timeoutMs: 30000, maxReadBytes: 16777216, maxConcurrent: 1 });
  let playbackTtlMs = 45000;
  const assemble = async () => {
    const auth = new AuthService(database, key, settings, now);
    const dependencies: MediaDependencies = { ...createRepositories(database, now), kind: "test", config, auth, storage, sources, now };
    return buildApp({ config, logger: false, auth, backend: { database, auth, config, now }, media: { register: createMediaModule({ ...config.media!, playbackTtlMs, metadata }), dependencies } });
  };
  let app = await assemble(); t.after(async () => { await app.close(); if (database.client.open) database.close(); });
  await app.listen({ host: "127.0.0.1", port: 0 }); const apiPort = (app.server.address() as { port: number }).port;
  const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), mode: "test", server: { port: 0, proxy: { "/api": { target: `http://127.0.0.1:${apiPort}` } } }, define: { "import.meta.env.VITE_MEDIA_ORIGIN": JSON.stringify(protocol.endpoint), "import.meta.env.VITE_MEDIA_PREFIX": JSON.stringify("/onlineVideo/"), "import.meta.env.VITE_ALLOW_LOCAL_MEDIA_HTTP": JSON.stringify("true") } });
  t.after(() => vite.close()); await vite.listen(); const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`; settings.allowedOrigins.splice(0, settings.allowedOrigins.length, origin);
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }); await context.addInitScript("window.__name=(fn)=>fn;");
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const cdp = await context.newCDPSession(page); const heartbeatTimes: number[] = []; const sourceStatuses: number[] = []; const authFailures: string[] = [];
  const mediaResponses: { status: number; range: string | null; contentRange: string | null }[] = [];
  const delayedSource: { capturedExpiry: string; sqlExpiryAtDelivery: string; heartbeatCountAtDelivery: number }[] = [];
  page.on("response", response => {
    const route = new URL(response.url()).pathname; if (route.endsWith("/heartbeat") && response.status() === 200) heartbeatTimes.push(Date.now()); if (route.endsWith("/source")) sourceStatuses.push(response.status());
    if (response.status() === 401 && route.startsWith("/api/")) authFailures.push(route);
    if (response.request().resourceType() === "media" && new URL(response.url()).origin === protocol.endpoint) void response.allHeaders().then(headers => mediaResponses.push({ status: response.status(), range: response.request().headers().range ?? null, contentRange: headers["content-range"] ?? null }));
  });
  let sourceRequests = 0;
  await page.route("**/api/playback-sessions/*/source", async route => {
    sourceRequests++; const response = await route.fetch();
    if (sourceRequests === 2 && response.status() === 200) {
      const payload = await response.json() as { data: { id: string; expiresAt: string } };
      await new Promise(resolve => setTimeout(resolve, 6000));
      const sql = database.client.prepare("SELECT expires_at FROM playback_sessions WHERE id=?").get(payload.data.id) as { expires_at: string };
      delayedSource.push({ capturedExpiry: payload.data.expiresAt, sqlExpiryAtDelivery: sql.expires_at, heartbeatCountAtDelivery: heartbeatTimes.length });
    }
    await route.fulfill({ response });
  });
  const qaDir = fileURLToPath(new URL(`../qa/stage2-long-${new Date().toISOString().replace(/[:.]/g, "-")}`, import.meta.url)); await mkdir(qaDir, { recursive: true }); console.log(`Long-video evidence: ${qaDir}`);
  const login = async () => { await page.getByLabel("密码", { exact: true }).fill(credentials.password); await page.getByLabel("动态验证码").fill(totp(credentials.totpSecret).generate()); await page.getByRole("button", { name: "进入视频库" }).click(); await expect(page.getByRole("navigation", { name: "主要导航" })).toBeVisible(); };
  let videoId = ""; let initialSessionId = ""; let initialExpiry = ""; let started = 0;
  const inspectMedia = () => page.locator("video").evaluate(node => { const video = node as HTMLVideoElement; return { duration: video.duration, position: video.currentTime, paused: video.paused, seeking: video.seeking, readyState: video.readyState, buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]) }; });
  await t.test("真实上传/FFprobe与HTMLVideoElement均确认3600秒", async () => {
    await page.goto(origin); await login(); await page.getByRole("link", { name: "上传", exact: true }).click(); await expect(page.locator('input[type="file"]')).toBeEnabled(); await page.locator('input[type="file"]').setInputFiles(sample);
    await page.getByRole("button", { name: "开始分片上传" }).click(); await expect(page.getByText("服务端已确认登记", { exact: true })).toBeVisible();
    videoId = (database.client.prepare("SELECT id FROM videos").get() as { id: string }).id; const row = database.client.prepare("SELECT duration_seconds,codec,width,height,status FROM videos WHERE id=?").get(videoId) as { duration_seconds: number; codec: string; width: number; height: number; status: string };
    assert.equal(row.duration_seconds, 3600); assert.equal(row.codec, "h264"); assert.equal(row.status, "ready");
    await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 20, downloadThroughput: 1048576, uploadThroughput: -1 });
    await page.goto(`${origin}/videos/${videoId}`); await page.getByRole("button", { name: "开始播放", exact: true }).click(); started = Date.now();
    await expect.poll(() => (database.client.prepare("SELECT count(*) n FROM playback_sessions WHERE closed_at IS NULL").get() as { n: number }).n).toBe(1);
    const session = database.client.prepare("SELECT id,expires_at FROM playback_sessions WHERE closed_at IS NULL").get() as { id: string; expires_at: string }; initialSessionId = session.id; initialExpiry = session.expires_at;
    await expect.poll(async () => (await inspectMedia()).readyState).toBeGreaterThan(0); assert.equal((await inspectMedia()).duration, 3600);
  });
  await t.test("中间/尾部真实seek与Range，换签保留暂停和播放状态", async () => {
    const video = page.locator("video"); await video.evaluate(node => { const media = node as HTMLVideoElement; media.currentTime = 1800; media.pause(); });
    await expect.poll(async () => Math.abs((await inspectMedia()).position - 1800)).toBeLessThan(1);
    await expect.poll(async () => (await inspectMedia()).seeking, { timeout: 15000 }).toBe(false);
    const pausedSource = await video.getAttribute("src"); await expect.poll(async () => (await video.getAttribute("src")) !== pausedSource, { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await inspectMedia()).readyState, { timeout: 15000 }).toBeGreaterThan(0); const paused = await inspectMedia(); assert.ok(paused.paused); assert.ok(Math.abs(paused.position - 1800) < 1);
    const playingSource = await video.getAttribute("src"); await video.evaluate(async node => { await (node as HTMLVideoElement).play(); });
    await expect.poll(async () => (await video.getAttribute("src")) !== playingSource, { timeout: 20000 }).toBe(true); await expect.poll(async () => (await inspectMedia()).paused).toBe(false);
    assert.ok((await inspectMedia()).position >= 1800 && (await inspectMedia()).position < 1820);
    const requestsBeforeTail = protocol.requests.length;
    await video.evaluate(node => { const media = node as HTMLVideoElement; media.currentTime = 3590; media.pause(); }); await expect.poll(async () => Math.abs((await inspectMedia()).position - 3590)).toBeLessThan(1);
    await expect.poll(async () => (await inspectMedia()).seeking, { timeout: 15000 }).toBe(false);
    const tailSource = await video.getAttribute("src"); await expect.poll(async () => (await video.getAttribute("src")) !== tailSource, { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await inspectMedia()).seeking, { timeout: 15000 }).toBe(false); await expect.poll(async () => (await inspectMedia()).readyState).toBeGreaterThanOrEqual(2);
    assert.ok(Math.abs((await inspectMedia()).position - 3590) < 1);
    assert.ok(protocol.requests.slice(requestsBeforeTail).some(entry => entry.signed && entry.status === 206 && /^bytes=[1-9]\d*-/.test(entry.range ?? "")), "尾部位置换源必须产生实际非零起始Range");
    await expect.poll(() => mediaResponses.some(entry => entry.status === 206 && /^bytes [1-9]\d*-\d+\/6411947$/.test(entry.contentRange ?? ""))).toBe(true);
    await expect.poll(() => protocol.requests.filter(entry => entry.signed && entry.status === 206 && /^bytes=[1-9]\d*-/.test(entry.range ?? "")).length).toBeGreaterThan(0);
    console.log(`Long seeks: ${JSON.stringify(await inspectMedia())}`); console.log(`Native signed Range responses: ${JSON.stringify(mediaResponses)}`);
  });
  await t.test("多次短签名续签仍有独立20秒心跳，运行超过45秒应用TTL", async () => {
    const wait = Math.max(0, started + 48000 - Date.now()); if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const row = database.client.prepare("SELECT expires_at,closed_at FROM playback_sessions WHERE id=?").get(initialSessionId) as { expires_at: string; closed_at: string | null };
    console.log(`Heartbeat evidence: elapsedMs=${Date.now() - started}, heartbeats=${heartbeatTimes.length}, initialExpiry=${initialExpiry}, currentExpiry=${row.expires_at}, sourceStatuses=${JSON.stringify(sourceStatuses)}`);
    assert.ok(heartbeatTimes.length >= 2, "短期源续签不能重置20秒心跳定时器"); assert.ok(Date.parse(row.expires_at) > Date.parse(initialExpiry)); assert.ok(Date.parse(row.expires_at) > Date.now()); assert.equal(row.closed_at, null);
    assert.equal(delayedSource.length, 1); assert.ok(delayedSource[0]!.heartbeatCountAtDelivery >= 1); assert.ok(Date.parse(delayedSource[0]!.sqlExpiryAtDelivery) > Date.parse(delayedSource[0]!.capturedExpiry), "延迟源响应确实跨过一次独立真实心跳"); console.log(`Delayed source/heartbeat expiry race: ${JSON.stringify(delayedSource)}`);
    await expect.poll(async () => (await inspectMedia()).readyState).toBeGreaterThan(0);
    await writeFile(resolve(qaDir, "foreground-heartbeat.json"), JSON.stringify({ elapsedMs: Date.now() - started, heartbeatTimes, initialExpiry, currentExpiry: row.expires_at, sourceStatuses, delayedSource, media: await inspectMedia(), mediaResponses }, null, 2), "utf8");
  });
  await t.test("长观看位置真SQLite重启恢复与真实应用会话过期可重建", async () => {
    await page.goto(`${origin}/videos/${videoId}`); await expect(page.getByRole("button", { name: "从 59:50 继续", exact: true })).toBeVisible();
    await app.close(); database.close(); database = openDatabase(path); playbackTtlMs = 8000; app = await assemble(); await app.listen({ host: "127.0.0.1", port: apiPort }); await page.reload();
    await page.getByRole("button", { name: "从 59:50 继续", exact: true }).click(); await expect.poll(async () => (await inspectMedia()).readyState).toBeGreaterThan(0);
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" }); await new Promise(resolve => setTimeout(resolve, 14000)); await cdp.send("Page.setWebLifecycleState", { state: "active" });
    await expect(page.getByRole("button", { name: "手动重新准备播放", exact: true })).toBeVisible({ timeout: 22000 });
    await expect(page.getByRole("alert")).toContainText("播放授权会话已过期，请重新准备播放");
    assert.ok(sourceStatuses.includes(403)); await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toHaveCount(0);
    await page.screenshot({ path: resolve(qaDir, "long-application-session-expired.png"), fullPage: true });
    await page.getByRole("button", { name: "手动重新准备播放", exact: true }).click(); await expect.poll(async () => (await inspectMedia()).readyState).toBeGreaterThan(0); assert.ok(Math.abs((await inspectMedia()).position - 3590) < 1);
  });
  await t.test("真实登录撤销后下一次源授权401，登录失效与播放会话过期分开", async () => {
    const own = database.client.prepare("SELECT id FROM login_sessions WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").get() as { id: string };
    const auth = await (await context.request.get(`${origin}/api/auth/me`)).json() as { data: { csrfToken: string } };
    const active = database.client.prepare("SELECT id FROM playback_sessions WHERE closed_at IS NULL ORDER BY created_at DESC LIMIT 1").get() as { id: string };
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    assert.equal((await context.request.post(`${origin}/api/auth/sessions/${own.id}/revoke`, { headers: { origin, "x-csrf-token": auth.data.csrfToken }, data: {} })).status(), 200);
    await new Promise(resolve => setTimeout(resolve, 14000)); await cdp.send("Page.setWebLifecycleState", { state: "active" });
    await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible({ timeout: 22000 }); assert.ok(authFailures.length > 0); assert.equal((await context.request.post(`${origin}/api/playback-sessions/${active.id}/source`, { headers: { origin, "x-csrf-token": auth.data.csrfToken }, data: {} })).status(), 401);
    await page.screenshot({ path: resolve(qaDir, "long-login-revoked.png"), fullPage: true });
    assert.equal(database.client.pragma("integrity_check", { simple: true }), "ok");
  });
  await context.close();
});

test("自有屏幕外浏览器真实标签页可见状态探测（不操作用户浏览器）", { skip: "本机已实际探测：同窗口双tab/最小化仍报visible；未伪造Document状态，真实后台返回留待可用浏览器环境" }, async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: false, ignoreDefaultArgs: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"], args: ["--window-position=-32000,-32000", "--window-size=900,700"] });
  try {
    const context = await browser.newContext();
    const first = await context.newPage(); await first.goto("data:text/html,private-first");
    const popup = first.waitForEvent("popup");
    await first.evaluate(() => { window.open("about:blank", "_blank"); });
    const second = await popup; await second.goto("data:text/html,private-second");
    const cdp = await context.newCDPSession(first);
    const secondCdp = await context.newCDPSession(second);
    // Playwright 默认强制 focus emulation；关闭它，观察浏览器实际状态，不改 Document 属性。
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await secondCdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    const nativeWindow = await cdp.send("Browser.getWindowForTarget");
    const secondWindow = await secondCdp.send("Browser.getWindowForTarget");
    console.log(`Native tabs window IDs: ${nativeWindow.windowId}/${secondWindow.windowId}`);
    assert.ok((nativeWindow.bounds.left ?? 0) < -10000, "自有测试窗口必须保持屏幕外");
    await second.bringToFront();
    await cdp.send("Browser.setWindowBounds", { windowId: nativeWindow.windowId, bounds: { windowState: "minimized" } });
    await expect.poll(() => first.evaluate(() => document.visibilityState)).toBe("hidden");
    await cdp.send("Browser.setWindowBounds", { windowId: nativeWindow.windowId, bounds: { windowState: "normal" } });
    await first.bringToFront(); await expect.poll(() => first.evaluate(() => document.visibilityState)).toBe("visible");
    assert.ok(((await cdp.send("Browser.getWindowForTarget")).bounds.left ?? 0) < -10000, "返回后自有窗口仍保持屏幕外");
    console.log(`Native visibility probe: hidden → visible; off-screen left=${nativeWindow.bounds.left}`);
  } finally { await browser.close(); }
});

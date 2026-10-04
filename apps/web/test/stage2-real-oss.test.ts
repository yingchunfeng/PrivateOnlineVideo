import { chromium, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { createServer } from "vite";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlaybackSession, VideoDetail, WatchProgress } from "@online-video/shared";

const site = "http://127.0.0.1:5173";
const mediaOrigin = "https://oss.meetdawn.top";
const workspace = fileURLToPath(new URL("../../..", import.meta.url));
const acceptance = resolve(workspace, ".local/acceptance/run-20261002-ces-private");
const ids = { original: "85376723-c12f-4e34-bf5e-0b711bb8a287", compatible: "cf7c94ce-1911-45cb-9670-cacd5878365f" };
const expectedSha = "f7083ce3ecc34bf2639622d4144f545022570e9601f5f9fc447257fc459d12a4";
const phase = process.env.REAL_OSS_BROWSER_PHASE;

interface Evidence {
  phase: string; startedAt: string; completedAt?: string; status: "running" | "passed" | "failed";
  step: string; checks: Record<string, unknown>;
  media: { origin: string; path: string; method: string; status?: number; range: string | null; contentRange?: string | null; siteCookieSent: boolean; contentDispositionAttachment?: boolean }[];
  authorizations: { id: string; videoId: string; mode: string; expiresAt: string; sourceExpiresAt?: string; renewAfter?: string; receivedAt: string; credentialTokenChanged?: boolean }[];
}

/** 显式实云入口：只读已批准的短期session.json，无长期账号/AK/数据库读取。 */
async function runRealBrowser(selectedPhase: "baseline" | "short" | "resume" | "diagnose") {
  const approved = JSON.parse(await readFile(resolve(acceptance, "authorization.json"), "utf8")) as { maximumVideoObjects: number; prefix: string };
  if (approved.maximumVideoObjects !== 2 || approved.prefix !== "onlineVideo/acceptance/local/20261002-ces-private/") throw new Error("本轮具体授权范围不匹配");
  const sessionFile = process.env.REAL_OSS_SESSION_FILE ?? "session.json";
  if (!/^(?:session|session-resume-[a-zA-Z0-9-]+)\.json$/.test(sessionFile)) throw new Error("只允许本轮受保护目录内的短期session文件basename");
  const session = JSON.parse(await readFile(resolve(acceptance, sessionFile), "utf8")) as { cookie: string; csrfToken: string };
  if (!session.cookie || !session.csrfToken || /[\r\n]/.test(session.cookie)) throw new Error("本轮短期会话材料不完整");
  const cookie = session.cookie.split(";", 1)[0]!; const delimiter = cookie.indexOf("="); if (delimiter < 1) throw new Error("短期Cookie格式不完整");
  const reportPath = resolve(acceptance, `browser-${selectedPhase}-${Date.now()}-${randomUUID()}.json`);
  const qaDir = fileURLToPath(new URL(`../qa/stage2-real-${selectedPhase}-${new Date().toISOString().replace(/[:.]/g, "-")}`, import.meta.url)); await mkdir(qaDir, { recursive: true });
  const report: Evidence = { phase: selectedPhase, startedAt: new Date().toISOString(), status: "running", step: "setup", checks: {}, media: [], authorizations: [] };
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8"); await save();
  const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), mode: "acceptance", server: { host: "127.0.0.1", port: 5173, strictPort: true }, define: { "import.meta.env.VITE_API_MODE": JSON.stringify("real"), "import.meta.env.VITE_MEDIA_ORIGIN": JSON.stringify(mediaOrigin), "import.meta.env.VITE_MEDIA_PREFIX": JSON.stringify("/onlineVideo/") } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined; let context: BrowserContext | undefined; let page: Page | undefined;
  const mediaHeaderTasks: Promise<void>[] = []; let priorToken = "";
  try {
    await vite.listen(); browser = await chromium.launch({ channel: "msedge", headless: true });
    context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, reducedMotion: "reduce", acceptDownloads: true });
    await context.addCookies([{ name: cookie.slice(0, delimiter), value: cookie.slice(delimiter + 1), url: site, httpOnly: true, sameSite: "Strict", secure: false }]);
    await context.addInitScript("window.__name=(fn)=>fn;"); page = await context.newPage(); page.setDefaultTimeout(15000);
    context.on("requestfailed", request => {
      const url = new URL(request.url()); if (url.origin !== mediaOrigin) return;
      const reason = request.failure()?.errorText ?? "";
      const category = /CERT|SSL|TLS/i.test(reason) ? "tls" : /NAME_NOT_RESOLVED|DNS/i.test(reason) ? "dns" : /BLOCKED|CORS/i.test(reason) ? "browser-policy" : /ABORTED/i.test(reason) ? "aborted" : "network";
      const code = reason.match(/net::ERR_[A-Z_]+/)?.[0] ?? "unclassified";
      const failures = report.checks.mediaFailures as { origin: string; path: string; category: string }[] | undefined;
      report.checks.mediaFailures = [...(failures ?? []), { origin: url.origin, path: url.pathname, category, code }]; void save();
    });
    context.on("response", response => {
      const request = response.request(); const url = new URL(response.url());
      if (url.origin === mediaOrigin) {
        const task = (async () => {
          const headers = await request.allHeaders(); const responseHeaders = await response.allHeaders();
          report.media.push({ origin: url.origin, path: url.pathname, method: request.method(), status: response.status(), range: headers.range ?? null,
            contentRange: responseHeaders["content-range"] ?? null, siteCookieSent: (headers.cookie ?? "").includes(cookie.slice(0, delimiter) + "="), contentDispositionAttachment: /^attachment;/i.test(responseHeaders["content-disposition"] ?? "") });
          await save();
        })().catch(() => {}); mediaHeaderTasks.push(task);
      }
      if (url.origin === site && /\/(playback-sessions|source)$/.test(url.pathname) && response.status() === 200) {
        const task = (async () => {
          const value = (await response.json() as { data: PlaybackSession }).data;
          if (value.videoId !== ids.compatible || value.mode !== "oss") return;
          const token = new URL(value.sourceUrl).searchParams.get("x-oss-security-token") ?? "";
          const credentialTokenChanged = !!priorToken && token !== priorToken; priorToken = token;
          report.authorizations.push({ id: value.id, videoId: value.videoId, mode: value.mode, expiresAt: value.expiresAt, sourceExpiresAt: value.sourceExpiresAt, renewAfter: value.renewAfter, receivedAt: new Date().toISOString(), credentialTokenChanged });
          await save();
        })().catch(() => {}); mediaHeaderTasks.push(task);
      }
    });
    const call = async <T>(path: string, method = "GET", payload?: unknown): Promise<{ status: number; data: T }> => {
      if (!path.startsWith("/api/")) throw new Error("只允许站内控制请求");
      const response = await context!.request.fetch(site + path, { method, headers: { origin: site, "x-csrf-token": session.csrfToken }, ...(payload === undefined ? {} : { data: payload }) });
      const body = await response.json() as { data: T }; return { status: response.status(), data: body.data };
    };
    const inspect = () => page!.locator("video").evaluate(node => { const video = node as HTMLVideoElement; return { position: video.currentTime, duration: video.duration, paused: video.paused, seeking: video.seeking, readyState: video.readyState, width: video.videoWidth, height: video.videoHeight }; });

    if (selectedPhase === "diagnose") {
      report.step = "native-media-minimal-diagnosis"; await page.goto(site); await expect(page.getByRole("heading", { name: "我的视频库", exact: true })).toBeVisible();
      report.checks.siteHeaders = { secureContext: await page.evaluate(() => isSecureContext), cspMetaPresent: await page.locator('meta[http-equiv="Content-Security-Policy"]').count() > 0 };
      await page.goto(`${site}/videos/${ids.compatible}`); await page.getByRole("button", { name: /开始播放|继续|重新播放/ }).click();
      await expect.poll(() => (report.checks.mediaFailures as unknown[] | undefined)?.length ?? report.media.length).toBeGreaterThan(0);
      report.checks.nativeMedia = await inspect();
      report.status = "passed"; report.completedAt = new Date().toISOString(); report.step = "diagnostic-evidence-collected"; await save(); console.log(`Real OSS safe media diagnosis: ${JSON.stringify(report.checks)}`); return;
    }
    report.step = "restore-real-session"; await page.goto(site); await expect(page.getByRole("heading", { name: "我的视频库", exact: true })).toBeVisible();
    await expect(page.getByLabel("模拟场景")).toHaveCount(0); await expect(page.locator(".video-card")).toHaveCount(2);
    const videos = await Promise.all([call<VideoDetail>(`/api/videos/${ids.original}`), call<VideoDetail>(`/api/videos/${ids.compatible}`)]);
    report.checks.actualVideoStatus = videos.map(value => ({ id: value.data.id, status: value.data.status, codec: value.data.codec, groupIds: value.data.groupIds, tagIds: value.data.tagIds, sizeBytes: value.data.sizeBytes }));
    if (!videos.every(value => value.status === 200) || videos[0]!.data.status !== "unsupported" || videos[1]!.data.status !== "ready") throw new Error("两样例实际状态不匹配");
    await expect(page.getByText("分组 · OSS本地验收20261002", { exact: true })).toHaveCount(2); await page.screenshot({ path: resolve(qaDir, "phone-real-library.png"), fullPage: true });
    if (selectedPhase === "resume") {
      report.step = "restart-progress"; const expected = Number(process.env.REAL_OSS_EXPECTED_POSITION ?? "2"); const progress = await call<WatchProgress>(`/api/videos/${ids.compatible}/progress`);
      if (progress.status !== 200 || Math.abs(progress.data.positionSeconds - expected) > .7) throw new Error("重启后观看位置不匹配"); report.checks.restartProgress = progress.data;
      await page.goto(`${site}/videos/${ids.compatible}`); await expect(page.getByRole("button", { name: /从 0:0[2-4] 继续/ })).toBeVisible();
    } else {
      if (selectedPhase === "baseline") {
        report.step = "unsupported-original"; await page.goto(`${site}/videos/${ids.original}`); await expect(page.getByText("此原片格式暂不支持网页播放。", { exact: false })).toBeVisible(); await expect(page.locator("video")).toHaveCount(0);
        await page.screenshot({ path: resolve(qaDir, "phone-unsupported-original.png"), fullPage: true }); report.checks.originalUnsupportedUi = true;
      }
      report.step = "compatible-private-playback"; await page.goto(`${site}/videos/${ids.compatible}`); await page.getByRole("button", { name: /开始播放|继续|重新播放/ }).click();
      await expect.poll(async () => (await inspect()).readyState).toBeGreaterThan(0); const video = page.locator("video");
      const oldSource = await video.getAttribute("src"); if (!oldSource || new URL(oldSource).origin !== mediaOrigin) throw new Error("播放源未直连限定HTTPS域名");
      await video.evaluate(async node => { const media = node as HTMLVideoElement; await media.play(); media.currentTime = 2; media.pause(); });
      await expect.poll(async () => (await inspect()).seeking).toBe(false); await expect.poll(async () => Math.abs((await inspect()).position - 2)).toBeLessThan(.7); report.checks.media = await inspect();
      await expect.poll(() => report.authorizations.length).toBeGreaterThan(0); const first = report.authorizations[0]!; report.checks.applicationSessionId = first.id;
      if (selectedPhase === "baseline") {
        const firstLifetime = Date.parse(first.sourceExpiresAt!) - Date.parse(first.receivedAt); if (firstLifetime > 3600000 || firstLifetime < 300000) throw new Error("正常角色有效期不符合实际3600秒边界");
        await expect.poll(() => report.media.some(entry => entry.status === 206 && entry.method === "GET" && entry.origin === mediaOrigin)).toBe(true);
        report.checks.nativeHttpsRange = true;
        report.step = "one-byte-browser-cors-get";
        report.checks.browserCorsGet = await page.evaluate(async source => {
          try {
            const response = await fetch(source, { method: "GET", credentials: "omit", headers: { Range: "bytes=0-0" }, redirect: "error" });
            const bytes = await response.arrayBuffer();
            return { readable: true, status: response.status, bytesRead: bytes.byteLength, contentRangeVisible: response.headers.get("content-range"), contentTypeVisible: response.headers.get("content-type"), allowOriginVisible: response.headers.get("access-control-allow-origin") };
          } catch { return { readable: false, category: "cors-or-browser-policy", bytesRead: null }; }
        }, oldSource);
        report.checks.baselineNoExpiryClaim = true;
        await page.screenshot({ path: resolve(qaDir, "phone-real-direct-player.png"), fullPage: true });
        report.step = "single-compatible-attachment-download";
        const marker = resolve(acceptance, "compatible-browser-download-consumed.json");
        try { await access(marker); throw new Error("兼容副本本轮完整下载已执行，禁止再次下载"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await writeFile(marker, JSON.stringify({ startedAt: new Date().toISOString(), videoId: ids.compatible, state: "reserved-one-browser-download" }), { encoding: "utf8", flag: "wx" });
        const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "下载原片", exact: true }).click(); const download = await downloadPromise;
        const output = resolve(acceptance, `compatible-browser-download-${Date.now()}-${randomUUID()}.mp4`); await download.saveAs(output);
        const bytes = await readFile(output); const sha = createHash("sha256").update(bytes).digest("hex"); if (bytes.length !== 460063 || sha !== expectedSha) throw new Error("兼容原片附件SHA或大小不一致");
        report.checks.compatibleDownload = { output, sizeBytes: bytes.length, sha256: sha, fileName: download.suggestedFilename() };
        await writeFile(marker, JSON.stringify({ startedAt: report.startedAt, completedAt: new Date().toISOString(), videoId: ids.compatible, state: "one-browser-download-sha-verified", output, sizeBytes: bytes.length, sha256: sha }, null, 2) + "\n", "utf8");
      } else {
        const firstLifetime = Date.parse(first.sourceExpiresAt!) - Date.parse(first.receivedAt); if (firstLifetime > 900000 || firstLifetime < 450000) throw new Error("短STS实际到期没有受剩余900秒限制");
        report.checks.shortStsBounds = { firstLifetimeMs: firstLifetime, renewBeforeMs: Date.parse(first.sourceExpiresAt!) - Date.parse(first.renewAfter!) };
        report.step = "wait-real-first-renewal"; await save(); console.log(`Real short-STS wait: first renewal at ${first.renewAfter}; report=${reportPath}`);
        const waitUntil = async (count: number, deadline: number) => {
          while (report.authorizations.length < count && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, Math.min(30000, Math.max(1000, deadline - Date.now())))); await save(); console.log(`Real short-STS progress: authorizations=${report.authorizations.length}, elapsedSeconds=${Math.floor((Date.now() - Date.parse(first.receivedAt)) / 1000)}`); }
          if (report.authorizations.length < count) throw new Error("实际续签等待期限内未得到新授权");
        };
        await waitUntil(2, Date.parse(first.renewAfter!) + 90000); await expect.poll(async () => (await video.getAttribute("src")) !== oldSource).toBe(true); await expect.poll(async () => (await inspect()).readyState).toBeGreaterThan(0); await expect.poll(async () => (await inspect()).seeking).toBe(false);
        const afterFirst = await inspect(); if (!afterFirst.paused || Math.abs(afterFirst.position - 2) > .7 || report.authorizations[1]!.id !== first.id) throw new Error("真实首次续签未保留位置/暂停/同会话"); report.checks.firstRealRenewal = { ...report.authorizations[1], media: afterFirst };
        report.step = "wait-real-role-refresh"; await save(); const next = report.authorizations[1]!; const intermediateSource = await video.getAttribute("src"); await waitUntil(3, Date.parse(next.renewAfter!) + 120000);
        await expect.poll(async () => (await video.getAttribute("src")) !== intermediateSource).toBe(true); await expect.poll(async () => (await inspect()).readyState).toBeGreaterThan(0); await expect.poll(async () => (await inspect()).seeking).toBe(false);
        const afterSecond = await inspect(); if (!afterSecond.paused || Math.abs(afterSecond.position - 2) > .7 || report.authorizations[2]!.id !== first.id || !report.authorizations[2]!.credentialTokenChanged) throw new Error("真实第二次续签未保留同会话/位置或角色刷新证据缺失"); report.checks.secondRealRenewal = { ...report.authorizations[2], media: afterSecond };
        await page.screenshot({ path: resolve(qaDir, "phone-real-short-sts-renewed.png"), fullPage: true });
        report.step = "logout-next-authorization-denied-old-link-boundary";
        // 第二次刷新后的链接仅留进程内；退出后只读一字节证明已发授权边界，绝不写入报告。
        const currentSource = await video.getAttribute("src"); await page.getByRole("button", { name: "退出登录", exact: true }).click(); await expect(page.getByRole("heading", { name: "安全登录", exact: true })).toBeVisible();
        const refused = await call(`/api/playback-sessions/${first.id}/source`, "POST", {}); if (refused.status !== 401) throw new Error("退出后仍可续签");
        if (!currentSource) throw new Error("退出前媒体源不存在"); const existing = await fetch(currentSource, { headers: { range: "bytes=0-0" }, redirect: "error" });
        if (existing.status !== 206 || (await existing.arrayBuffer()).byteLength !== 1) throw new Error("已发链接剩余有效期边界未得到实证"); report.checks.logoutBoundary = { renewalStatus: refused.status, oldSignedRangeStatus: existing.status, bytesRead: 1 };
      }
      if (selectedPhase === "baseline") { await page.getByRole("link", { name: "安全", exact: true }).click(); await expect(page.getByText("未知 · 尚未同步", { exact: true })).toBeVisible(); await page.screenshot({ path: resolve(qaDir, "phone-real-oss-usage.png"), fullPage: true }); report.checks.ossUnknownUsageUi = true; }
      const progress = selectedPhase === "short" ? null : await call<WatchProgress>(`/api/videos/${ids.compatible}/progress`); if (progress?.status === 200) report.checks.savedProgress = progress.data;
    }
    await Promise.allSettled(mediaHeaderTasks);
    if (report.media.some(entry => entry.siteCookieSent)) throw new Error("站点Cookie被发送到OSS");
    report.checks.siteCookieNeverSentToMedia = true; report.checks.corsScope = "native video未设置crossOrigin；只记录实际响应，不推断跨域fetch/HEAD规则";
    report.status = "passed"; report.completedAt = new Date().toISOString(); report.step = "completed"; await save();
    console.log(`Real OSS browser ${selectedPhase}: passed; safe report=${reportPath}; QA=${qaDir}`);
  } catch {
    if (page) { await page.screenshot({ path: resolve(qaDir, "controlled-failure.png"), fullPage: true }).catch(() => {}); report.checks.mediaErrorCode = await page.locator("video").evaluate(node => (node as HTMLVideoElement).error?.code ?? null).catch(() => null); }
    report.status = "failed"; report.completedAt = new Date().toISOString(); await save().catch(() => {});
    console.error(`Real OSS browser ${selectedPhase}: failed at safe step=${report.step}; report=${reportPath}`); process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await vite.close();
  }
}

if (phase === "baseline" || phase === "short" || phase === "resume" || phase === "diagnose") await runRealBrowser(phase);
else console.log("真实OSS浏览器入口未启用；仅具体授权并收到主控probe/short-ready交接后设置REAL_OSS_BROWSER_PHASE执行。");

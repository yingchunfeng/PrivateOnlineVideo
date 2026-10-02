import { CSRF_HEADER, ERROR_DEFINITIONS, isPartChecksum, PART_CHECKSUM_HEADER } from "@online-video/shared";
import type { ApplicationUsage, AuthSession, Category, CreateUploadRequest, ErrorCode, ImportPreview, LoginRequest, LoginSession, PlaybackSession, UploadTask, VideoDetail, UploadedPart } from "@online-video/shared";
import type { Transport } from "./client";

export const mockScenarios = { normal: "正常", empty: "空视频库", long: "长标题", offline: "网络中断", expired: "会话过期", limit: "流量已达上限", unconfigured: "限额未配置", unlimited: "显式不限额", storage: "存储不可用", uploadFailure: "分片失败一次", completeFailure: "完成失败一次", finalizing: "遗留完成中任务", unknownUsage: "未知统计来源", usageUnavailable: "用量不可用" } as const;
export type MockScenario = keyof typeof mockScenarios;
let scenario: MockScenario = "normal";
export function setMockScenario(value: MockScenario) { scenario = value; }
const csrf = "mock-csrf-not-a-real-credential";
const now = () => new Date().toISOString();
const expires = () => new Date(Date.now() + 3600000).toISOString();
const initialCategories: Category[] = [{ id: "cat-default", name: "未分类", sortOrder: 0 }, { id: "cat-travel", name: "旅行", sortOrder: 1 }, { id: "cat-life", name: "日常", sortOrder: 2 }];
const fixtureVideo = (id: string, title: string, categoryId: string, status: VideoDetail["status"] = "ready"): VideoDetail => ({ id, title, categoryId, durationSeconds: status === "ready" ? 12 : null, sizeBytes: 12 * 1048576, status, thumbnailUrl: null, createdAt: now(), codec: status === "ready" ? "VP8（开发样例）" : null, width: status === "ready" ? 640 : null, height: status === "ready" ? 360 : null, playable: status === "ready", lastPositionSeconds: 0 });
const initialVideos = [fixtureVideo("video-lake", "山间的一次散步", "cat-travel"), fixtureVideo("video-city", "傍晚，回家的路", "cat-life"), fixtureVideo("video-sun", "日光里的小片段", "cat-default"), fixtureVideo("video-processing", "正在整理的手机原片", "cat-default", "processing"), fixtureVideo("video-hevc", "HEVC 原片 · 需要兼容副本", "cat-default", "unsupported"), fixtureVideo("video-failed", "元数据处理失败的样例", "cat-default", "failed"), ...Array.from({ length: 8 }, (_, i) => fixtureVideo(`video-extra-${i}`, `旅途记录 ${i + 1}`, "cat-travel"))];
const portrait = initialVideos.find(video => video.id === "video-city")!; portrait.width = 360; portrait.height = 640;
interface MockState { categories: Category[]; videos: VideoDetail[]; uploads: Record<string, UploadTask>; uploadMeta: Record<string, { title: string; categoryId: string }> }
const stateKey = "ov.dev-mock.data.v1";
function loadState(): MockState {
    try { const raw = sessionStorage.getItem(stateKey); if (raw) { const loaded = JSON.parse(raw) as MockState; const vertical = loaded.videos.find(v => v.id === "video-city"); if (vertical) { vertical.width = 360; vertical.height = 640; } return loaded; } } catch { /* Mock 缓存不影响真实接口。 */ }
  return { categories: structuredClone(initialCategories), videos: structuredClone(initialVideos), uploads: {}, uploadMeta: {} };
}
const state = loadState();
const persist = () => { try { sessionStorage.setItem(stateKey, JSON.stringify(state)); } catch { /* 非敏感 Mock 数据缓存不可用时继续本页预览。 */ } };
const playback = new Map<string, PlaybackSession>();
export const inspectMockPlayback = () => [...playback.values()].map(session => ({ id: session.id, expiresAt: session.expiresAt }));
const previews = new Map<string, ImportPreview>();
const failedParts = new Set<string>();
const failedCompletions = new Set<string>();
let otherSession = true;
const loggedIn = () => document.cookie.split("; ").includes("ov_dev_mock_session=active");
const setLogin = (active: boolean) => { document.cookie = `ov_dev_mock_session=${active ? "active" : ""}; Path=/; SameSite=Strict${active ? "" : "; Max-Age=0"}`; };
const authSession = (): AuthSession => ({ user: { id: "mock-owner", displayName: "我的私人空间", totpEnabled: true }, csrfToken: csrf });
const ok = (data: unknown) => Response.json({ data });
const fail = (code: ErrorCode) => Response.json({ error: { code, message: ERROR_DEFINITIONS[code].message, requestId: `mock-${crypto.randomUUID()}` } }, { status: ERROR_DEFINITIONS[code].status });
const id = () => crypto.randomUUID();
const bodyOf = <T>(init?: RequestInit): T => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as T;

export function createMockTransport(): Transport {
  return async (input, init) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
      if (init?.signal?.aborted) { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }
    });
    if (scenario === "offline") throw new TypeError("mock offline");
    const url = new URL(input, window.location.origin);
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/auth/login" && method === "POST") {
      const body = bodyOf<LoginRequest>(init);
      if (body.password !== "demo-password" || body.totp !== "123456") return fail("AUTH_REQUIRED");
      setLogin(true); if (scenario === "expired") scenario = "normal";
      return ok(authSession());
    }
    if (path === "/api/health") return ok({ status: "ok" });
    if (!loggedIn() || scenario === "expired") { if (scenario === "expired") setLogin(false); return fail("SESSION_EXPIRED"); }
    if (!["GET", "HEAD"].includes(method) && new Headers(init?.headers).get(CSRF_HEADER) !== csrf) return fail("CSRF_REJECTED");
    if (path === "/api/auth/me") return ok(authSession());
    if (path === "/api/auth/logout") { setLogin(false); return ok({ success: true }); }
    if (path === "/api/auth/sessions") {
      const current: LoginSession = { id: "mock-current", createdAt: now(), lastSeenAt: now(), expiresAt: expires(), isCurrent: true };
      return ok(otherSession ? [current, { ...current, id: "mock-other", isCurrent: false }] : [current]);
    }
    if (/^\/api\/auth\/sessions\/[^/]+\/revoke$/.test(path)) { if (path.includes("mock-current")) setLogin(false); else otherSession = false; return ok({ success: true }); }
    if (path === "/api/categories") {
      if (method === "POST") { const body = bodyOf<{ name: string; sortOrder?: number }>(init); if (!body.name?.trim()) return fail("VALIDATION_ERROR"); const category = { id: id(), name: body.name.trim(), sortOrder: body.sortOrder ?? state.categories.length }; state.categories.push(category); persist(); return ok(category); }
      return ok(state.categories);
    }
    const categoryMatch = path.match(/^\/api\/categories\/([^/]+)$/);
    if (categoryMatch) { const category = state.categories.find(c => c.id === categoryMatch[1]); if (!category) return fail("NOT_FOUND"); const body = bodyOf<{ name?: string }>(init); if (body.name?.trim()) category.name = body.name.trim(); persist(); return ok(category); }
    if (path === "/api/videos") {
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1)); const pageSize = Math.max(1, Number(url.searchParams.get("pageSize") ?? 12));
      const query = (url.searchParams.get("q") ?? "").toLowerCase(); const category = url.searchParams.get("categoryId");
      const videos = scenario === "empty" ? [] : state.videos.map(v => scenario === "long" ? { ...v, title: `${v.title} · ${"很长的视频标题与旅行中的完整记录".repeat(9)}` } : v).filter(v => (!category || v.categoryId === category) && v.title.toLowerCase().includes(query)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return ok({ items: videos.slice((page - 1) * pageSize, page * pageSize), total: videos.length, page, pageSize });
    }
    const videoMatch = path.match(/^\/api\/videos\/([^/]+)(?:\/(progress|playback-sessions))?$/);
    if (videoMatch) {
      const video = state.videos.find(v => v.id === videoMatch[1]); if (!video) return fail("NOT_FOUND");
      if (videoMatch[2] === "progress") { if (method === "PUT") { const pos = bodyOf<{ positionSeconds: number }>(init).positionSeconds; if (!Number.isFinite(pos) || pos < 0 || (video.durationSeconds !== null && pos > video.durationSeconds)) return fail("VALIDATION_ERROR"); video.lastPositionSeconds = pos; persist(); } return ok({ videoId: video.id, positionSeconds: video.lastPositionSeconds, updatedAt: video.lastPositionSeconds === 0 ? null : now() }); }
      if (videoMatch[2] === "playback-sessions") {
        if (scenario === "storage") return fail("STORAGE_UNAVAILABLE"); if (scenario === "limit") return fail("TRANSFER_LIMIT_EXCEEDED"); if (scenario === "unconfigured") return fail("SERVICE_NOT_CONFIGURED"); if (!video.playable) return fail("UNSUPPORTED_MEDIA_TYPE");
        const sessionId = id(); const session: PlaybackSession = { id: sessionId, videoId: video.id, mode: "proxy", sourceUrl: `/api/videos/${video.id}/stream?playbackSessionId=${sessionId}&devMock=1`, expiresAt: expires() }; playback.set(sessionId, session); return ok(session);
      }
      if (method === "PATCH") { const body = bodyOf<{ title?: string; categoryId?: string }>(init); if (body.title !== undefined) video.title = body.title; if (body.categoryId) video.categoryId = body.categoryId; persist(); }
      return ok(scenario === "long" ? { ...video, title: `${video.title} · ${"完整保留的长标题".repeat(25)}` } : video);
    }
    const playbackMatch = path.match(/^\/api\/playback-sessions\/([^/]+)\/(heartbeat|close)$/);
    if (playbackMatch) { const session = playback.get(playbackMatch[1]!); if (!session) return fail("NOT_FOUND"); if (playbackMatch[2] === "close") { playback.delete(session.id); return ok({ success: true }); } if (scenario === "limit") return fail("TRANSFER_LIMIT_EXCEEDED"); const renewed = { ...session, expiresAt: expires() }; playback.set(session.id, renewed); return ok(renewed); }
    if (path === "/api/settings/usage") {
      if (scenario === "usageUnavailable") return fail("SERVICE_NOT_CONFIGURED");
      const start = new Date(); start.setUTCHours(0, 0, 0, 0);
      const base = { periodStart: start.toISOString(), periodEnd: new Date(start.getTime() + 86400000).toISOString(), timezone: "UTC", transferredBytes: scenario === "limit" ? 1073741824 : 256000000, activePlaybackSessions: playback.size, source: "application_proxy" as const };
      if (scenario === "unknownUsage") return ok({ ...base, source: "unknown", limitMode: "limited", limitBytes: 1073741824 });
      const usage: ApplicationUsage = scenario === "unconfigured" ? { ...base, limitMode: "unconfigured", limitBytes: null } : scenario === "unlimited" ? { ...base, limitMode: "unlimited", limitBytes: null } : { ...base, limitMode: "limited", limitBytes: 1073741824 };
      return ok(usage);
    }
    if (path === "/api/uploads" && method === "POST") {
      if (scenario === "storage") return fail("STORAGE_UNAVAILABLE");
      const body = bodyOf<CreateUploadRequest>(init);
      if (!Number.isSafeInteger(body.sizeBytes) || body.sizeBytes <= 0 || !body.fileName || !body.title || !state.categories.some(c => c.id === body.categoryId)) return fail("VALIDATION_ERROR");
      const task: UploadTask = { id: id(), videoId: null, fileName: body.fileName, sizeBytes: body.sizeBytes, partSizeBytes: 262144, status: "uploading", uploadedParts: [], createdAt: now() };
      state.uploads[task.id] = task; state.uploadMeta[task.id] = { title: body.title, categoryId: body.categoryId }; persist(); return ok(task);
    }
    const uploadMatch = path.match(/^\/api\/uploads\/([^/]+)(?:\/(parts\/([0-9]+)|complete))?$/);
    if (uploadMatch) {
      const task = state.uploads[uploadMatch[1]!]; if (!task) return fail("NOT_FOUND");
      if (!uploadMatch[2]) return ok(task);
      if (uploadMatch[2] === "complete") {
        if (task.status === "completed") { const video = state.videos.find(item => item.id === task.videoId); return video ? ok({ upload: task, video }) : fail("UPLOAD_STATE_CONFLICT"); }
        if (task.uploadedParts.length !== Math.ceil(task.sizeBytes / task.partSizeBytes)) return fail("UPLOAD_STATE_CONFLICT");
        if (["completeFailure", "finalizing"].includes(scenario) && !failedCompletions.has(task.id)) { failedCompletions.add(task.id); task.status = scenario === "finalizing" ? "finalizing" : "failed"; persist(); return fail("STORAGE_UNAVAILABLE"); }
        const meta = state.uploadMeta[task.id]!; const video = fixtureVideo(id(), meta.title, meta.categoryId, "processing"); video.sizeBytes = task.sizeBytes; state.videos.unshift(video); task.status = "completed"; task.videoId = video.id; persist(); return ok({ upload: task, video });
      }
      if (task.status !== "uploading") return fail("UPLOAD_STATE_CONFLICT");
      const partNumber = Number(uploadMatch[3]);
      const expected = Math.min(task.partSizeBytes, task.sizeBytes - (partNumber - 1) * task.partSizeBytes);
      const checksum = new Headers(init?.headers).get(PART_CHECKSUM_HEADER);
      if (!isPartChecksum(checksum) || partNumber < 1 || expected <= 0 || !(init?.body instanceof Blob) || init.body.size !== expected) return fail("VALIDATION_ERROR");
      if (scenario === "uploadFailure" && !failedParts.has(task.id)) { failedParts.add(task.id); return fail("STORAGE_UNAVAILABLE"); }
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await init.body.arrayBuffer())), n => n.toString(16).padStart(2, "0")).join("");
      if (checksum !== digest) return fail("FILE_MISMATCH");
      const existing = task.uploadedParts.find(p => p.partNumber === partNumber);
      if (existing && (existing.checksum !== checksum || existing.sizeBytes !== expected)) return fail("FILE_MISMATCH");
      const part: UploadedPart = { partNumber, sizeBytes: expected, checksum };
      if (!existing) task.uploadedParts.push(part); task.uploadedParts.sort((a, b) => a.partNumber - b.partNumber); persist(); return ok(part);
    }
    if (path === "/api/imports/preview") {
      if (scenario === "storage") return fail("STORAGE_UNAVAILABLE");
      const preview: ImportPreview = { id: id(), expiresAt: expires(), items: [{ id: id(), fileName: "已有视频样例.mp4", sizeBytes: 2097152, durationSeconds: null, codec: null }] }; previews.set(preview.id, preview); return ok(preview);
    }
    if (path === "/api/imports/commit") {
      const body = bodyOf<{ previewId: string; itemIds: string[]; categoryId: string }>(init); const preview = previews.get(body.previewId);
      if (!preview || Date.parse(preview.expiresAt) <= Date.now() || !state.categories.some(c => c.id === body.categoryId) || !body.itemIds.length || body.itemIds.some(item => !preview.items.some(p => p.id === item))) return fail("VALIDATION_ERROR");
      const videos = preview.items.filter(item => body.itemIds.includes(item.id)).map(item => ({ ...fixtureVideo(id(), item.fileName, body.categoryId, "processing"), sizeBytes: item.sizeBytes })); state.videos.unshift(...videos); previews.delete(preview.id); persist(); return ok({ videos });
    }
    return fail("NOT_FOUND");
  };
}

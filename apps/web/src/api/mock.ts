import { CSRF_HEADER, ERROR_DEFINITIONS, isPartChecksum, PART_CHECKSUM_HEADER } from "@online-video/shared";
import type { ApplicationUsage, AuthSession, Category, CreateUploadRequest, ErrorCode, ImportPreview, LibraryConfiguration, LibraryGroup, LoginRequest, LoginSession, PlaybackSession, SaveLibraryConfigurationRequest, Tag, UploadTask, VideoDetail, UploadedPart } from "@online-video/shared";
import type { Transport } from "./client";

export const mockScenarios = { normal: "正常", empty: "空视频库", long: "长标题", offline: "网络中断", expired: "会话过期", limit: "流量已达上限", unconfigured: "限额未配置", unlimited: "显式不限额", storage: "存储不可用", uploadFailure: "分片失败一次", completeFailure: "完成失败一次", finalizing: "遗留完成中任务", unknownUsage: "未知统计来源", usageUnavailable: "用量不可用" } as const;
export type MockScenario = keyof typeof mockScenarios;
let scenario: MockScenario = "normal";
export function setMockScenario(value: MockScenario) { scenario = value; }
const csrf = "mock-csrf-not-a-real-credential";
const now = () => new Date().toISOString();
const expires = () => new Date(Date.now() + 3600000).toISOString();
const initialCategories: Category[] = [{ id: "cat-default", name: "未分类", sortOrder: 0, isDefault: true, archivedAt: null }, { id: "cat-travel", name: "旅行", sortOrder: 1, archivedAt: null }, { id: "cat-life", name: "日常", sortOrder: 2, archivedAt: null }];
const initialGroups: LibraryGroup[] = [{ id: "group-travel", name: "2026旅行", description: "旅行记录", sortOrder: 0, createdAt: now(), updatedAt: now(), archivedAt: null }];
const initialTags: Tag[] = [{ id: "tag-outdoor", name: "户外", createdAt: now(), updatedAt: now(), archivedAt: null }];
const fixtureVideo = (id: string, title: string, categoryId: string, status: VideoDetail["status"] = "ready"): VideoDetail => ({ id, title, categoryId, groupIds: categoryId === "cat-travel" ? ["group-travel"] : [], tagIds: categoryId === "cat-travel" ? ["tag-outdoor"] : [], durationSeconds: status === "ready" ? 12 : null, sizeBytes: 12 * 1048576, status, thumbnailUrl: null, createdAt: now(), codec: status === "ready" ? "VP8（开发样例）" : null, width: status === "ready" ? 640 : null, height: status === "ready" ? 360 : null, playable: status === "ready", lastPositionSeconds: 0 });
const initialVideos = [fixtureVideo("video-lake", "山间的一次散步", "cat-travel"), fixtureVideo("video-city", "傍晚，回家的路", "cat-life"), fixtureVideo("video-sun", "日光里的小片段", "cat-default"), fixtureVideo("video-processing", "正在整理的手机原片", "cat-default", "processing"), fixtureVideo("video-hevc", "HEVC 原片 · 需要兼容副本", "cat-default", "unsupported"), fixtureVideo("video-failed", "元数据处理失败的样例", "cat-default", "failed"), ...Array.from({ length: 8 }, (_, i) => fixtureVideo(`video-extra-${i}`, `旅途记录 ${i + 1}`, "cat-travel"))];
const portrait = initialVideos.find(video => video.id === "video-city")!; portrait.width = 360; portrait.height = 640;
interface MockState { categories: Category[]; groups: LibraryGroup[]; tags: Tag[]; videos: VideoDetail[]; uploads: Record<string, UploadTask>; uploadMeta: Record<string, { title: string; categoryId: string; groupIds?: string[]; tagIds?: string[]; tags?: string[] }>; configurationVersion?: number; categoryTags?: Record<string, string[]> }
const stateKey = "ov.dev-mock.data.v1";
function loadState(): MockState {
    try { const raw = sessionStorage.getItem(stateKey); if (raw) { const loaded = JSON.parse(raw) as MockState; loaded.groups ??= structuredClone(initialGroups); loaded.tags ??= structuredClone(initialTags); for (const c of loaded.categories) c.isDefault = c.id === "cat-default"; const vertical = loaded.videos.find(v => v.id === "video-city"); if (vertical) { vertical.width = 360; vertical.height = 640; } return loaded; } } catch { /* Mock 缓存不影响真实接口。 */ }
  return { categories: structuredClone(initialCategories), groups: structuredClone(initialGroups), tags: structuredClone(initialTags), videos: structuredClone(initialVideos), uploads: {}, uploadMeta: {} };
}
const state = loadState();
const publicVideo = (video: VideoDetail): VideoDetail => ({ ...video, tags: video.tags ?? (video.tagIds ?? []).flatMap(id => { const tag = state.tags.find(item => item.id === id); return tag ? [tag.name] : []; }), objectKey: video.objectKey ?? `onlineVideo/mock/${video.id}.webm`, publicUrl: video.publicUrl ?? `https://oss.meetdawn.top/onlineVideo/mock/${video.id}.webm`, fileName: video.fileName ?? `${video.id}.webm` });
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
    if (path === "/api/library") return ok({ mediaBaseUrl: "https://oss.meetdawn.top", objectPrefix: "onlineVideo/", categories: state.categories.map(category => ({ id: category.id, name: category.name, tags: state.tags.filter(tag => !tag.archivedAt && (state.categoryTags?.[category.id] ?? state.tags.map(item => item.id)).includes(tag.id)).map(tag => tag.name), enabled: !category.archivedAt })) });
    if (path === "/api/library/configuration") {
      const configuration = (): LibraryConfiguration => ({ version: `mock-${state.configurationVersion ?? 0}`, writable: true, categories: state.categories.map(category => ({ id: category.id, name: category.name, enabled: !category.archivedAt, isDefault: !!category.isDefault, tagIds: state.categoryTags?.[category.id] ?? state.tags.map(tag => tag.id), videoCount: state.videos.filter(video => video.categoryId === category.id).length, uploadCount: Object.values(state.uploads).filter(task => task.categoryId === category.id).length })), tags: state.tags.map(tag => ({ id: tag.id, name: tag.name, enabled: !tag.archivedAt, categoryIds: state.categories.filter(category => (state.categoryTags?.[category.id] ?? state.tags.map(item => item.id)).includes(tag.id)).map(category => category.id), videoCount: state.videos.filter(video => video.tagIds?.includes(tag.id) || video.tags?.includes(tag.name)).length, uploadCount: Object.values(state.uploads).filter(task => task.tagIds?.includes(tag.id) || task.tags?.includes(tag.name)).length })) });
      if (method === "PUT") {
        const body = bodyOf<SaveLibraryConfigurationRequest>(init); if (body.version !== configuration().version) return fail("CONFIG_VERSION_CONFLICT");
        if (!Array.isArray(body.categories) || !Array.isArray(body.tags) || body.categories.some(category => !category.name.trim()) || body.tags.some(tag => !tag.name.trim())) return fail("VALIDATION_ERROR");
        const originalTags = state.tags;
        state.tags = body.tags.map(tag => ({ id: tag.id ?? id(), name: tag.name, createdAt: now(), updatedAt: now(), archivedAt: tag.enabled ? null : now() }));
        for (const previous of originalTags) { const current = state.tags.find(tag => tag.id === previous.id); if (current && current.name !== previous.name) { for (const video of state.videos) video.tags = video.tags?.map(name => name === previous.name ? current.name : name) ?? []; for (const task of Object.values(state.uploads)) task.tags = task.tags?.map(name => name === previous.name ? current.name : name) ?? []; } }
        const deletedIds = state.categories.filter(category => !category.archivedAt && body.categories.some(update => update.id === category.id && !update.enabled)).map(category => category.id);
        for (const video of state.videos) if (deletedIds.includes(video.categoryId)) video.categoryId = "cat-default";
        state.categoryTags = {};
        state.categories = body.categories.map((category, index) => { const categoryId = category.id ?? id(); state.categoryTags![categoryId] = category.tagIds; return { id: categoryId, name: category.name, sortOrder: index, isDefault: categoryId === "cat-default", archivedAt: category.enabled ? null : now() }; });
        state.configurationVersion = (state.configurationVersion ?? 0) + 1; persist();
      }
      return ok(configuration());
    }
    if (path === "/api/categories") {
      if (method === "POST") { const body = bodyOf<{ name: string; sortOrder?: number }>(init); if (!body.name?.trim()) return fail("VALIDATION_ERROR"); const category = { id: id(), name: body.name.trim(), sortOrder: body.sortOrder ?? state.categories.length }; state.categories.push(category); persist(); return ok(category); }
      return ok(state.categories.filter(item => url.searchParams.get("includeArchived") === "true" || !item.archivedAt));
    }
    const categoryMatch = path.match(/^\/api\/categories\/([^/]+)$/);
    if (categoryMatch) { const category = state.categories.find(c => c.id === categoryMatch[1]); if (!category) return fail("NOT_FOUND"); const body = bodyOf<{ name?: string; sortOrder?: number; archived?: boolean }>(init); if (category.isDefault) return fail("ORGANIZATION_CONFLICT"); if (body.name?.trim()) category.name = body.name.trim(); if (body.sortOrder !== undefined) category.sortOrder = body.sortOrder; if (body.archived !== undefined) category.archivedAt = body.archived ? now() : null; persist(); return ok(category); }
    const organizationMatch = path.match(/^\/api\/(groups|tags)(?:\/([^/]+))?$/);
    if (organizationMatch) {
      const kind = organizationMatch[1] as "groups" | "tags"; const items = state[kind]; const body = bodyOf<{ name?: string; description?: string; sortOrder?: number; archived?: boolean }>(init);
      const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase();
      if (method === "GET") return ok(items.filter(item => url.searchParams.get("includeArchived") === "true" || !item.archivedAt));
      if (body.name && items.some(item => item.id !== organizationMatch[2] && normalize(item.name) === normalize(body.name!))) return fail("ORGANIZATION_CONFLICT");
      if (method === "POST") { if (!body.name?.trim()) return fail("VALIDATION_ERROR"); const base: Tag = { id: id(), name: body.name.trim(), createdAt: now(), updatedAt: now(), archivedAt: null }; if (kind === "groups") state.groups.push({ ...base, description: body.description ?? "", sortOrder: body.sortOrder ?? items.length }); else state.tags.push(base); persist(); return ok(items.at(-1)); }
      const item = items.find(value => value.id === organizationMatch[2]); if (!item) return fail("NOT_FOUND"); if (body.name?.trim()) item.name = body.name.trim(); if (body.archived !== undefined) item.archivedAt = body.archived ? now() : null; item.updatedAt = now(); if ("description" in item && body.description !== undefined) item.description = body.description; if ("sortOrder" in item && body.sortOrder !== undefined) item.sortOrder = body.sortOrder; persist(); return ok(item);
    }
    if (path === "/api/videos") {
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1)); const pageSize = Math.max(1, Number(url.searchParams.get("pageSize") ?? 12));
      const query = (url.searchParams.get("q") ?? "").toLowerCase(); const category = url.searchParams.get("categoryId");
      const groupIds = url.searchParams.get("groupIds")?.split(",") ?? []; const tagIds = url.searchParams.get("tagIds")?.split(",") ?? [];
      let tags: string[]; try { tags = JSON.parse(url.searchParams.get("tags") ?? "[]") as string[]; if (!Array.isArray(tags) || tags.some(tag => typeof tag !== "string")) return fail("VALIDATION_ERROR"); } catch { return fail("VALIDATION_ERROR"); }
      const videos = scenario === "empty" ? [] : state.videos.map(publicVideo).map(v => scenario === "long" ? { ...v, title: `${v.title} · ${"很长的视频标题与旅行中的完整记录".repeat(9)}` } : v).filter(v => (!category || v.categoryId === category) && (v.title.toLowerCase().includes(query) || v.tags?.some(tag => tag.toLowerCase().includes(query))) && tags.every(tag => v.tags?.includes(tag)) && groupIds.every(id => v.groupIds?.includes(id)) && tagIds.every(id => v.tagIds?.includes(id))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return ok({ items: videos.slice((page - 1) * pageSize, page * pageSize), total: videos.length, page, pageSize });
    }
    if (path === "/api/videos/register-public" && method === "POST") {
      const body = bodyOf<{ publicUrl: string; title: string; categoryId: string; tags: string[] }>(init);
      let source: URL; try { source = new URL(body.publicUrl); } catch { return fail("VALIDATION_ERROR"); }
      if (source.origin !== "https://oss.meetdawn.top" || !source.pathname.startsWith("/onlineVideo/") || source.search || source.hash || !body.title?.trim() || !state.categories.some(category => category.id === body.categoryId && !category.archivedAt) || !Array.isArray(body.tags)) return fail("VALIDATION_ERROR");
      const video = { ...fixtureVideo(id(), body.title.trim(), body.categoryId, "processing"), tags: body.tags, objectKey: decodeURIComponent(source.pathname.slice(1)), publicUrl: source.href, fileName: decodeURIComponent(source.pathname.split("/").at(-1) ?? "video") }; state.videos.unshift(video); persist(); return ok(video);
    }
    const videoMatch = path.match(/^\/api\/videos\/([^/]+)(?:\/(progress|playback-sessions|cover))?$/);
    if (videoMatch) {
      const video = state.videos.find(v => v.id === videoMatch[1]); if (!video) return fail("NOT_FOUND");
      if (videoMatch[2] === "cover") { if (!(init?.body instanceof Blob) || init.body.size > 1048576 || init.body.type !== "image/jpeg") return fail("VALIDATION_ERROR"); video.coverObjectKey = `onlineVideo/${video.categoryId}/covers/mock-${video.id}.jpg`; video.coverUrl = `https://oss.meetdawn.top/${video.coverObjectKey}`; video.coverStatus = "saved"; persist(); return ok(publicVideo(video)); }
      if (videoMatch[2] === "progress") { if (method === "PUT") { const pos = bodyOf<{ positionSeconds: number }>(init).positionSeconds; if (!Number.isFinite(pos) || pos < 0 || (video.durationSeconds !== null && pos > video.durationSeconds)) return fail("VALIDATION_ERROR"); video.lastPositionSeconds = pos; persist(); } return ok({ videoId: video.id, positionSeconds: video.lastPositionSeconds, updatedAt: video.lastPositionSeconds === 0 ? null : now() }); }
      if (videoMatch[2] === "playback-sessions") {
        if (scenario === "storage") return fail("STORAGE_UNAVAILABLE"); if (scenario === "limit") return fail("TRANSFER_LIMIT_EXCEEDED"); if (scenario === "unconfigured") return fail("SERVICE_NOT_CONFIGURED"); if (!video.playable) return fail("UNSUPPORTED_MEDIA_TYPE");
        const sessionId = id(); const session: PlaybackSession = { id: sessionId, videoId: video.id, mode: "proxy", sourceUrl: `/api/videos/${video.id}/stream?playbackSessionId=${sessionId}`, expiresAt: expires() }; playback.set(sessionId, session); return ok(session);
      }
      if (method === "PATCH") { const body = bodyOf<{ title?: string; categoryId?: string; groupIds?: string[]; tagIds?: string[]; tags?: string[] }>(init); if (body.title !== undefined) video.title = body.title; if (body.categoryId) video.categoryId = body.categoryId; if (body.groupIds) video.groupIds = body.groupIds; if (body.tagIds) video.tagIds = body.tagIds; if (body.tags) video.tags = body.tags; persist(); }
      return ok(publicVideo(scenario === "long" ? { ...video, title: `${video.title} · ${"完整保留的长标题".repeat(25)}` } : video));
    }
    const playbackMatch = path.match(/^\/api\/playback-sessions\/([^/]+)\/(heartbeat|close)$/);
    if (playbackMatch) { const session = playback.get(playbackMatch[1]!); if (!session) return fail("NOT_FOUND"); if (playbackMatch[2] === "close") { playback.delete(session.id); return ok({ success: true }); } if (scenario === "limit") return fail("TRANSFER_LIMIT_EXCEEDED"); const renewed = { ...session, expiresAt: expires() }; playback.set(session.id, renewed); return ok(renewed); }
    if (path === "/api/settings/limits") return ok({ maxUploadBytes: 2147483648, partSizeBytes: 262144, maxUploadConcurrency: 1, maxPlaybackSessions: 3, maxAuthorizationsPerMinute: 12 });
    if (path === "/api/settings/usage") {
      if (scenario === "usageUnavailable") return fail("SERVICE_NOT_CONFIGURED");
      const start = new Date(); start.setUTCHours(0, 0, 0, 0);
      const base = { periodStart: start.toISOString(), periodEnd: new Date(start.getTime() + 86400000).toISOString(), timezone: "UTC", transferredBytes: scenario === "limit" ? 1073741824 : 256000000, activePlaybackSessions: playback.size, source: "application_proxy" as const };
      if (scenario === "unknownUsage") return ok({ ...base, source: "unknown", limitMode: "limited", limitBytes: 1073741824 });
      const usage: ApplicationUsage = scenario === "unconfigured" ? { ...base, limitMode: "unconfigured", limitBytes: null } : scenario === "unlimited" ? { ...base, limitMode: "unlimited", limitBytes: null } : { ...base, limitMode: "limited", limitBytes: 1073741824 };
      return ok(usage);
    }
    if (path === "/api/uploads" && method === "GET") {
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1)); const pageSize = Math.max(1, Number(url.searchParams.get("pageSize") ?? 20)); const status = url.searchParams.get("status");
      const tasks = Object.values(state.uploads).filter(task => !status || task.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(task => { const video = state.videos.find(video => video.id === task.videoId); return { ...task, uploadedBytes: task.uploadedParts.reduce((sum, part) => sum + part.sizeBytes, 0), ...(video ? { publicUrl: publicVideo(video).publicUrl!, coverObjectKey: video.coverObjectKey ?? null, coverUrl: video.coverUrl ?? null, coverStatus: video.coverStatus ?? "missing" } : {}) }; });
      return ok({ items: tasks.slice((page - 1) * pageSize, page * pageSize), total: tasks.length, page, pageSize });
    }
    if (path === "/api/uploads" && method === "POST") {
      if (scenario === "storage") return fail("STORAGE_UNAVAILABLE");
      const body = bodyOf<CreateUploadRequest>(init);
      if (body.clientRequestId) { const existing = Object.values(state.uploads).find(task => task.clientRequestId === body.clientRequestId); if (existing) return ok(existing); }
      if (!Number.isSafeInteger(body.sizeBytes) || body.sizeBytes <= 0 || !body.fileName || !body.title || !state.categories.some(c => c.id === body.categoryId)) return fail("VALIDATION_ERROR");
      const task: UploadTask = { id: id(), videoId: null, fileName: body.fileName, sizeBytes: body.sizeBytes, partSizeBytes: 262144, status: "uploading", uploadedParts: [], createdAt: now(), title: body.title, categoryId: body.categoryId, groupIds: body.groupIds ?? [], tagIds: body.tagIds ?? [], tags: body.tags ?? [], ...(body.clientRequestId ? { clientRequestId: body.clientRequestId } : {}) };
      state.uploads[task.id] = task; state.uploadMeta[task.id] = { title: body.title, categoryId: body.categoryId, groupIds: body.groupIds ?? [], tagIds: body.tagIds ?? [], tags: body.tags ?? [] }; persist(); return ok(task);
    }
    const uploadMatch = path.match(/^\/api\/uploads\/([^/]+)(?:\/(parts\/([0-9]+)|complete))?$/);
    if (uploadMatch) {
      const task = state.uploads[uploadMatch[1]!]; if (!task) return fail("NOT_FOUND");
      if (!uploadMatch[2]) return ok(task);
      if (uploadMatch[2] === "complete") {
        if (task.status === "completed") { const video = state.videos.find(item => item.id === task.videoId); return video ? ok({ upload: task, video: publicVideo(video) }) : fail("UPLOAD_STATE_CONFLICT"); }
        if (task.uploadedParts.length !== Math.ceil(task.sizeBytes / task.partSizeBytes)) return fail("UPLOAD_STATE_CONFLICT");
        if (["completeFailure", "finalizing"].includes(scenario) && !failedCompletions.has(task.id)) { failedCompletions.add(task.id); task.status = scenario === "finalizing" ? "finalizing" : "failed"; persist(); return fail("STORAGE_UNAVAILABLE"); }
        const meta = state.uploadMeta[task.id]!; const video = fixtureVideo(id(), meta.title, meta.categoryId, "processing"); video.sizeBytes = task.sizeBytes; video.groupIds = meta.groupIds ?? []; video.tagIds = meta.tagIds ?? []; video.tags = meta.tags ?? []; video.objectKey = `onlineVideo/${meta.categoryId}/${video.id}.${task.fileName.split(".").at(-1) ?? "mp4"}`; video.publicUrl = `https://oss.meetdawn.top/${video.objectKey}`; video.fileName = task.fileName; state.videos.unshift(video); task.status = "completed"; task.videoId = video.id; persist(); return ok({ upload: task, video: publicVideo(video) });
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
      const body = bodyOf<{ previewId: string; itemIds: string[]; categoryId: string; groupIds?: string[]; tagIds?: string[] }>(init); const preview = previews.get(body.previewId);
      if (!preview || Date.parse(preview.expiresAt) <= Date.now() || !state.categories.some(c => c.id === body.categoryId) || !body.itemIds.length || body.itemIds.some(item => !preview.items.some(p => p.id === item))) return fail("VALIDATION_ERROR");
      const videos = preview.items.filter(item => body.itemIds.includes(item.id)).map(item => ({ ...fixtureVideo(id(), item.fileName, body.categoryId, "processing"), groupIds: body.groupIds ?? [], tagIds: body.tagIds ?? [], sizeBytes: item.sizeBytes })); state.videos.unshift(...videos); previews.delete(preview.id); persist(); return ok({ videos });
    }
    return fail("NOT_FOUND");
  };
}

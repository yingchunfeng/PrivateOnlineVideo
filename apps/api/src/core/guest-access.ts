import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GuestAccess, GuestPermission } from "@online-video/shared";
import type { AuthPrincipal } from "./contracts/index.js";
import type { AuthService } from "../modules/auth/service.js";
import { HttpError } from "./errors.js";

interface RequestAccess { principal: AuthPrincipal; signal: AbortSignal; check: () => void; bind: (uploadId: string) => void; owns: (uploadId: string) => boolean; uploads: (page: number, pageSize: number, status?: string) => { ids: string[]; total: number } }
const accesses = new WeakMap<FastifyRequest, RequestAccess>();
export const guestRequestSignal = (request: FastifyRequest) => accesses.get(request)?.signal;
export function assertGuestRequest(request: FastifyRequest): void { accesses.get(request)?.check(); }
export function bindGuestUpload(request: FastifyRequest, uploadId: string): void { accesses.get(request)?.bind(uploadId); }
export function assertGuestUpload(request: FastifyRequest, uploadId: string): void {
  const access = accesses.get(request);
  if (access) { access.check(); if (!access.owns(uploadId)) throw new HttpError("NOT_FOUND"); }
}
export const guestUploadPage = (request: FastifyRequest, page: number, pageSize: number, status?: string) => accesses.get(request)?.uploads(page, pageSize, status);

function allowed(guest: GuestAccess, method: string, route: string, ownsVideo: boolean): boolean {
  const has = (...permissions: GuestPermission[]) => permissions.some(value => guest.permissions.includes(value));
  const read = method === "GET" || method === "HEAD";
  if (route === "/api/auth/me") return read;
  if (route === "/api/auth/logout") return method === "POST";
  if (route === "/api/library") return read && has("library", "upload", "tasks", "configuration", "video_edit", "video_delete");
  if (route === "/api/library/configuration") return (read || method === "PUT") && has("configuration");
  if (route === "/api/settings/homepage") return (read || method === "PUT") && has("configuration");
  if (/^\/api\/(categories|tags|groups)$/.test(route)) return read ? has("library", "upload", "tasks", "configuration", "video_edit") : method === "POST" && has("configuration");
  if (/^\/api\/(categories|tags|groups)\/:id$/.test(route)) return method === "PATCH" && has("configuration");
  if (route === "/api/settings/limits") return read && has("upload", "tasks");
  if (route === "/api/uploads") return read ? has("tasks") : method === "POST" && has("upload");
  if (route === "/api/uploads/:uploadId") return read && has("upload", "tasks");
  if (route === "/api/uploads/:uploadId/parts/:partNumber") return method === "PUT" && has("upload");
  if (route === "/api/uploads/:uploadId/complete") return method === "POST" && has("upload");
  if (route === "/api/videos/register-public" || route === "/api/imports/preview" || route === "/api/imports/commit") return method === "POST" && has("upload");
  if (route === "/api/videos") return read && has("library");
  if (route === "/api/videos/:videoId") return read ? has("library", "video_edit", "video_delete") || ownsVideo && has("upload", "tasks")
    : method === "DELETE" ? has("video_delete") : method === "PATCH" && has("video_edit");
  if (route === "/api/videos/:videoId/duration" || route === "/api/videos/:videoId/cover") return method === "PUT" && (has("video_edit") || ownsVideo && has("upload"));
  if (route === "/api/videos/:videoId/progress") return (read || method === "PUT") && has("library");
  if (/^\/api\/videos\/:videoId\/(stream|thumbnail)$/.test(route)) return read && has("library");
  if (/^\/api\/videos\/:videoId\/(playback-sessions|download-authorizations)$/.test(route) || /^\/api\/playback-sessions\/:sessionId\/(source|heartbeat|close)$/.test(route)) return method === "POST" && has("library");
  return false;
}

/** 路由级 onRequest 在 Cookie 解析后、请求体解析前执行；新增接口对访客默认拒绝。 */
export function registerGuestAccess(app: FastifyInstance, auth: AuthService, installationReady: () => boolean = () => true): void {
  const db = auth.database.client;
  const publicRoutes = new Set(["/api/health", "/api/auth/login", "/api/auth/login/code", "/api/auth/login/options", "/api/auth/guest/login", "/api/setup/status", "/api/setup/login", "/api/setup/password", "/api/setup/complete", "/api/setup/logout"]);
  app.addHook("onRoute", route => {
    if (!route.url.startsWith("/api/") || publicRoutes.has(route.url)) return;
    const gate = async (request: FastifyRequest) => {
      if (route.url.startsWith("/api/installation/") && !installationReady()) return;
      const principal = await auth.requireUser(request, { mutation: !["GET", "HEAD"].includes(request.method) });
      if (!principal.guest) return;
      const controller = new AbortController();
      const params = request.params as { uploadId?: string; videoId?: string };
      const ownsUpload = (id: string) => !!db.prepare("SELECT 1 FROM guest_uploads WHERE upload_id=? AND guest_id=?").get(id, principal.guest!.id);
      const ownsVideo = () => !!params.videoId && !!db.prepare("SELECT 1 FROM guest_uploads g JOIN upload_tasks u ON u.id=g.upload_id WHERE g.guest_id=? AND u.video_id=?").get(principal.guest!.id, params.videoId);
      const check = () => {
        const guest = auth.guests.accessForSession(principal.loginSessionId);
        if (!guest) throw new HttpError("GUEST_EXPIRED");
        if (!allowed(guest, request.method, route.url, ownsVideo())) throw new HttpError("FORBIDDEN");
        if (route.url === "/api/imports/commit" && (request.body as { existingVideoId?: unknown } | undefined)?.existingVideoId && !guest.permissions.includes("video_edit")) throw new HttpError("FORBIDDEN");
        if (params.uploadId && !ownsUpload(params.uploadId)) throw new HttpError("NOT_FOUND");
      };
      check();
      accesses.set(request, { principal, signal: controller.signal, check, owns: ownsUpload,
        bind: id => {
          check();
          const existing = db.prepare("SELECT guest_id FROM guest_uploads WHERE upload_id=?").get(id) as { guest_id: string } | undefined;
          if (existing && existing.guest_id !== principal.guest!.id) throw new HttpError("NOT_FOUND");
          db.prepare("INSERT OR IGNORE INTO guest_uploads(upload_id,guest_id) VALUES(?,?)").run(id, principal.guest!.id);
        },
        uploads: (page, pageSize, status) => {
          check(); const where = `g.guest_id=?${status ? " AND u.status=?" : ""}`;
          const values = status ? [principal.guest!.id, status] : [principal.guest!.id];
          const total = (db.prepare(`SELECT count(*) n FROM guest_uploads g JOIN upload_tasks u ON u.id=g.upload_id WHERE ${where}`).get(...values) as { n: number }).n;
          const rows = db.prepare(`SELECT u.id FROM guest_uploads g JOIN upload_tasks u ON u.id=g.upload_id WHERE ${where} ORDER BY u.created_at DESC,u.id DESC LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize) as { id: string }[];
          return { ids: rows.map(row => row.id), total };
        } });
      const validate = () => { try { check(); } catch { controller.abort(); } };
      const unsubscribe = auth.guests.onChange(id => { if (id === principal.guest!.id) validate(); });
      const timer = setInterval(validate, 200); timer.unref();
      const deadline = setTimeout(validate, Math.max(1, Math.min(2_147_483_647, Date.parse(principal.guest.expiresAt) - auth.now().getTime() + 1))); deadline.unref();
      request.raw.once("close", () => { if (request.raw.aborted) controller.abort(); });
      const finish = () => { clearInterval(timer); clearTimeout(deadline); unsubscribe(); };
      // 响应结束或客户端断开均释放监听，长流也持续检查撤销。
      request.raw.socket?.once("close", finish);
      (request as FastifyRequest & { guestFinish?: () => void }).guestFinish = () => { finish(); request.raw.socket?.removeListener("close", finish); };
    };
    const old = route.onRequest;
    route.onRequest = [gate, ...(Array.isArray(old) ? old : old ? [old] : [])];
  });
  app.addHook("onSend", async (request, reply, payload) => { if (reply.statusCode < 400 && request.routeOptions.url !== "/api/auth/logout") assertGuestRequest(request); return payload; });
  app.addHook("onResponse", async request => { (request as FastifyRequest & { guestFinish?: () => void }).guestFinish?.(); });
}

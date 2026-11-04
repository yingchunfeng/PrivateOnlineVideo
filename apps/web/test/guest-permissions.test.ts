import test from "node:test";
import assert from "node:assert/strict";
import { GUEST_DEFAULT_PERMISSIONS, GUEST_PERMISSION_LABELS } from "@online-video/shared";
import type { AuthSession } from "@online-video/shared";
import { hasPermission, landingPage } from "../src/authz";
import { validateAuthSession } from "../src/api/auth";
import { ApiClient, ApiError } from "../src/api/client";

const guest: AuthSession = { csrfToken: "isolated-csrf", user: { id: "shared-owner", displayName: "受限访客", role: "guest", authMethod: "password", totpEnabled: false, authVersion: 1, emailMasked: null, emailVerified: false },
  guest: { id: "guest-one", name: "受限访客", permissions: [...GUEST_DEFAULT_PERMISSIONS], expiresAt: "2026-11-03T12:00:00.000Z", serverTime: "2026-11-02T12:00:00.000Z" } };

test("访客默认权限、授权页落地及管理员兼容身份保持分离", () => {
  assert.deepEqual(GUEST_DEFAULT_PERMISSIONS, ["library", "upload", "pages"]);
  assert.equal(GUEST_PERMISSION_LABELS.library, "高光时刻");
  assert.equal(hasPermission(null, "library"), false); assert.equal(hasPermission(guest, "video_edit"), false); assert.equal(hasPermission(guest, "video_delete"), false);
  assert.equal(landingPage(guest), "/");
  assert.equal(landingPage({ ...guest, guest: { ...guest.guest!, permissions: ["pages"] } }), "/pages");
  assert.equal(landingPage({ ...guest, guest: { ...guest.guest!, permissions: ["upload"] } }), "/upload");
  assert.equal(landingPage({ ...guest, guest: { ...guest.guest!, permissions: ["tasks"] } }), "/tasks");
  const admin = { csrfToken: "isolated-admin", user: { ...guest.user, role: "admin" as const } };
  assert.equal(hasPermission(admin, "video_delete"), true); assert.equal(landingPage(admin), "/");
});

test("损坏访客身份不能降级为管理员或被当作有效认证响应", () => {
  assert.deepEqual(validateAuthSession(guest), guest);
  const noGuest = { csrfToken: guest.csrfToken, user: guest.user };
  for (const value of [noGuest, { ...guest, guest: { ...guest.guest, permissions: ["system"] } }, { ...guest, user: { ...guest.user, role: "admin" } }, { ...guest, guest: { ...guest.guest, expiresAt: "invalid" } }]) assert.throws(() => validateAuthSession(value as AuthSession), ApiError);
});

test("独立访客登录仅精确豁免CSRF；403保留会话，访客失效401清理会话", async () => {
  let calls = 0; let mode = "login"; let exited = 0;
  const client = new ApiClient(async (_path, init) => {
    calls++;
    if (mode === "login") { assert.equal(new Headers(init?.headers).has("x-csrf-token"), false); return Response.json({ data: guest }); }
    return Response.json({ error: { code: mode === "forbidden" ? "FORBIDDEN" : "GUEST_EXPIRED" } }, { status: mode === "forbidden" ? 403 : 401 });
  });
  client.onUnauthorized(() => exited++);
  await client.request("/api/auth/guest/login", { method: "POST", body: { password: "isolated-password" } });
  for (const path of ["/api/auth/guest/login/extra", "/api/auth/guest/login?bypass=true", "/api/guests"] as const) await assert.rejects(client.request(path, { method: "POST", body: {} }), (error: unknown) => error instanceof ApiError && error.code === "CSRF_REJECTED");
  assert.equal(calls, 1); client.setSession(guest.csrfToken); mode = "forbidden";
  await assert.rejects(client.request("/api/guests"), ApiError); assert.equal(exited, 0);
  mode = "expired"; await assert.rejects(client.request("/api/auth/me"), ApiError); assert.equal(exited, 1);
  await assert.rejects(client.request("/api/auth/logout", { method: "POST" }), (error: unknown) => error instanceof ApiError && error.code === "CSRF_REJECTED");
});

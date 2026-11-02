import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { FastifyRequest } from "fastify";
import type { AuthSession, GuestCredential, GuestList, GuestPermission, GuestRecord } from "@online-video/shared";
import { buildApp } from "../src/app.js";
import { migrationManifest, openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { AuthService } from "../src/modules/auth/service.js";
import { verifyPassword } from "../src/modules/auth/crypto.js";
import { GuestService } from "../src/modules/guests/service.js";
import { accountFixture } from "./helpers/account-email-fixture.js";

type Fixture = Awaited<ReturnType<typeof accountFixture>>;
const defaults: GuestPermission[] = ["library", "upload", "pages"];
const credential = async (f: Fixture, duration = 3_600_000, permissions = defaults): Promise<GuestCredential> =>
  f.ok<GuestCredential>("/api/guests", { name: "隔离访客", expiresAt: new Date(f.now().getTime() + duration).toISOString(), permissions });
const guestLogin = (f: Fixture, password: string) => f.call("/api/auth/guest/login", { password }, { origin: f.origin });
const guestHeaders = (f: Fixture, login: Awaited<ReturnType<typeof guestLogin>>) => ({ origin: f.origin,
  cookie: String(login.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": login.json<{ data: AuthSession }>().data.csrfToken });
const patch = (f: Fixture, guest: GuestRecord, changes: Record<string, unknown> = {}) => f.app.inject({ method: "PATCH", url: `/api/guests/${guest.id}`,
  headers: f.headers(), payload: { name: guest.name, expiresAt: guest.expiresAt, permissions: guest.permissions, version: guest.version, ...changes } });

test("访客密码安全生成/仅一次交付，真实Argon2id及独立Cookie会话，不回显管理员资料", async t => {
  const f = await accountFixture(); t.after(f.close); await f.loginTotp();
  const created = await credential(f); const second = await credential(f);
  assert.equal(created.password.length, 80); assert.notEqual(created.password, second.password);
  assert.ok(created.password.startsWith(`${created.guest.id}.`)); assert.deepEqual(created.guest.permissions, defaults);
  const row = f.database.client.prepare("SELECT password_hash FROM guests WHERE id=?").get(created.guest.id) as { password_hash: string };
  assert.match(row.password_hash, /^\$argon2id\$/); assert.ok(await verifyPassword(row.password_hash, created.password));
  const list = await f.call("/api/guests"); assert.equal(list.statusCode, 200);
  assert.ok(!list.body.includes(created.password)); assert.ok(!list.body.includes("password_hash")); assert.ok(!list.body.includes("passwordHash"));
  const login = await guestLogin(f, created.password); assert.equal(login.statusCode, 200, login.body);
  const session = login.json<{ data: AuthSession }>().data;
  assert.equal(session.user.role, "guest"); assert.equal(session.user.id, f.user().id); assert.equal(session.user.displayName, "隔离访客");
  assert.equal(session.user.authMethod, "password"); assert.equal(session.user.emailMasked, null); assert.equal(session.user.emailVerified, false);
  assert.equal(session.user.totpEnabled, false); assert.equal(session.guest?.id, created.guest.id);
  assert.match(String(login.headers["set-cookie"]), /HttpOnly/); assert.match(String(login.headers["set-cookie"]), /SameSite=Strict/);
  const stored = f.database.client.prepare("SELECT l.* FROM login_sessions l JOIN guest_sessions g ON g.login_session_id=l.id WHERE g.guest_id=?").get(created.guest.id) as { expires_at: string; token_hash: string };
  assert.equal(stored.expires_at, created.guest.expiresAt); assert.ok(!String(login.headers["set-cookie"]).includes(stored.token_hash));
  const me = await f.call("/api/auth/me", undefined, guestHeaders(f, login)); assert.equal(me.json().data.guest.id, created.guest.id);
  assert.equal((await f.call("/api/auth/guest/login", { password: created.password, email: "attacker@qq.com" }, { origin: f.origin })).statusCode, 400);
  assert.equal((await f.call("/api/auth/guest/login", { password: created.password }, { origin: "https://evil.invalid" })).statusCode, 403);
  assert.equal((await f.call("/api/guests", { name: "未带CSRF", expiresAt: created.guest.expiresAt, permissions: defaults }, { cookie: f.headers().cookie!, origin: f.origin })).statusCode, 403);
});

test("管理员邮箱/TOTP仍必需，访客入口不发送邮件且不能调用账户安全或撤销管理员会话", async t => {
  const f = await accountFixture(); t.after(f.close); await f.loginTotp(); const created = await credential(f);
  await f.bind(); await f.loginEmail(); const before = f.sender.messages.length;
  const guest = await guestLogin(f, created.password); assert.equal(guest.statusCode, 200, guest.body); assert.equal(f.sender.messages.length, before);
  assert.equal((await guestLogin(f, f.credentials.password)).statusCode, 401);
  assert.equal((await f.call("/api/auth/login", { authMethod: "password", password: f.credentials.password })).json().error.code, "AUTH_METHOD_MISMATCH");
  assert.equal((await f.call("/api/auth/login", { password: created.password, totp: f.token() })).statusCode, 401);
  const headers = guestHeaders(f, guest);
  for (const path of ["/api/auth/security", "/api/auth/sessions", "/api/guests"]) assert.equal((await f.call(path, undefined, headers)).statusCode, 403, path);
  assert.equal((await f.call("/api/auth/password/direct", { currentPassword: created.password, newPassword: "other-secure-password", confirmPassword: "other-secure-password" }, headers)).statusCode, 403);
  const cookieToken = headers.cookie.split("=")[1]!;
  const request = { headers, cookies: { [f.auth.cookieName]: cookieToken }, ip: "127.0.0.1" } as unknown as FastifyRequest;
  await assert.rejects(f.auth.security(request), (error: unknown) => (error as { code: string }).code === "FORBIDDEN");
  const adminSession = f.database.client.prepare("SELECT id FROM login_sessions WHERE id NOT IN (SELECT login_session_id FROM guest_sessions) AND revoked_at IS NULL").get() as { id: string };
  await assert.rejects(f.auth.revoke(request, adminSession.id), (error: unknown) => (error as { code: string }).code === "FORBIDDEN");
  assert.equal((await f.call("/api/auth/me")).statusCode, 200);
  assert.equal((await f.call("/api/auth/logout", {}, { cookie: headers.cookie, origin: f.origin })).statusCode, 403);
  assert.equal((await f.call("/api/auth/logout", {}, headers)).statusCode, 200);
  assert.equal((await f.call("/api/auth/me", undefined, headers)).statusCode, 401);
});

test("自然到期逐请求阻断全部访客会话、重新登录和刷新，服务实例重建不能恢复", async t => {
  const f = await accountFixture(); t.after(f.close); await f.loginTotp(); const created = await credential(f, 90_000);
  const a = await guestLogin(f, created.password); const b = await guestLogin(f, created.password);
  assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200); assert.notEqual(a.headers["set-cookie"], b.headers["set-cookie"]);
  f.advance(90_000);
  for (const session of [a, b]) assert.equal((await f.call("/api/auth/me", undefined, guestHeaders(f, session))).json().error.code, "GUEST_EXPIRED");
  assert.equal((await guestLogin(f, created.password)).statusCode, 401);
  assert.equal((await f.ok<GuestList>("/api/guests")).items.find(item => item.id === created.guest.id)?.status, "expired");
  const auth = new AuthService(f.database, f.key, f.settings, f.now, f.sender); const app = await buildApp({ config: f.config, logger: false, auth }); t.after(() => app.close());
  const restored = await app.inject({ url: "/api/auth/me", headers: guestHeaders(f, a) }); assert.equal(restored.json().error.code, "GUEST_EXPIRED");
  const revive = await patch(f, created.guest, { expiresAt: new Date(f.now().getTime() + 3_600_000).toISOString() }); assert.equal(revive.json().error.code, "GUEST_EXPIRED");
  assert.equal((await f.call(`/api/guests/${created.guest.id}/reset`, { version: created.guest.version })).json().error.code, "GUEST_EXPIRED");
});

test("权限编辑即时同步、版本冲突保留旧值，缩短凭证同步截断会话且延长不偷偷续会话", async t => {
  const f = await accountFixture(); t.after(f.close); await f.loginTotp(); const created = await credential(f); const login = await guestLogin(f, created.password);
  const headers = guestHeaders(f, login); const shortened = new Date(f.now().getTime() + 120_000).toISOString();
  const response = await patch(f, created.guest, { permissions: ["pages"], name: "只调个人外观", expiresAt: shortened }); assert.equal(response.statusCode, 200, response.body);
  const next = response.json<{ data: GuestRecord }>().data; assert.equal(next.version, 2);
  const me = await f.call("/api/auth/me", undefined, headers); assert.deepEqual(me.json().data.guest.permissions, ["pages"]); assert.equal(me.json().data.user.displayName, "只调个人外观");
  assert.equal((await patch(f, created.guest)).json().error.code, "GUEST_VERSION_CONFLICT");
  const session = f.database.client.prepare("SELECT l.id,l.expires_at FROM login_sessions l JOIN guest_sessions s ON s.login_session_id=l.id WHERE s.guest_id=?").get(created.guest.id) as { id: string; expires_at: string };
  assert.equal(session.expires_at, shortened);
  assert.equal((await patch(f, next, { expiresAt: created.guest.expiresAt })).statusCode, 200);
  assert.equal((f.database.client.prepare("SELECT expires_at FROM login_sessions WHERE id=?").get(session.id) as { expires_at: string }).expires_at, shortened);
  f.advance(120_000); assert.throws(() => f.auth.guests.accessForSession(session.id), (error: unknown) => (error as { code: string }).code === "GUEST_EXPIRED");
});

test("重置与提前失效撤销同凭证所有旧会话，通知在途检查且只交付一次新密码", async t => {
  const f = await accountFixture(); t.after(f.close); await f.loginTotp(); const created = await credential(f);
  const sessions = await Promise.all([guestLogin(f, created.password), guestLogin(f, created.password)]);
  const ids = (f.database.client.prepare("SELECT login_session_id FROM guest_sessions WHERE guest_id=?").all(created.guest.id) as { login_session_id: string }[]).map(row => row.login_session_id);
  const notified: string[] = []; const unsubscribe = f.auth.guests.onChange(id => notified.push(id)); t.after(unsubscribe);
  const reset = await f.call(`/api/guests/${created.guest.id}/reset`, { version: 1 }); assert.equal(reset.statusCode, 200, reset.body);
  const next = reset.json<{ data: GuestCredential }>().data; assert.notEqual(next.password, created.password); assert.equal(next.guest.version, 2);
  assert.deepEqual(notified, [created.guest.id]);
  for (const id of ids) assert.throws(() => f.auth.guests.accessForSession(id), (error: unknown) => (error as { code: string }).code === "GUEST_EXPIRED");
  for (const login of sessions) assert.equal((await f.call("/api/auth/me", undefined, guestHeaders(f, login))).statusCode, 401);
  assert.equal((await guestLogin(f, created.password)).statusCode, 401);
  const current = await guestLogin(f, next.password); assert.equal(current.statusCode, 200, current.body);
  const revoked = await f.call(`/api/guests/${created.guest.id}/revoke`, { version: next.guest.version }); assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().data.status, "expired"); assert.ok(revoked.json().data.revokedAt); assert.deepEqual(notified, [created.guest.id, created.guest.id]);
  assert.equal((await f.call("/api/auth/me", undefined, guestHeaders(f, current))).json().error.code, "GUEST_EXPIRED");
  assert.equal((await guestLogin(f, next.password)).statusCode, 401); assert.equal((await f.call(`/api/guests/${created.guest.id}/reset`, { version: 3 })).json().error.code, "GUEST_EXPIRED");
  const list = await f.call("/api/guests"); assert.ok(!list.body.includes(created.password)); assert.ok(!list.body.includes(next.password));
});

test("访客字段、权限依赖、危险扩权和无页面组合均被服务端拒绝", async t => {
  const f = await accountFixture(); t.after(f.close); await f.loginTotp(); const future = new Date(f.now().getTime() + 3_600_000).toISOString();
  const valid = { name: "验证边界", expiresAt: future, permissions: defaults };
  for (const changes of [{ name: " " }, { name: "bad\u0000name" }, { expiresAt: f.now().toISOString() }, { expiresAt: "invalid" }, { permissions: [] },
    { permissions: ["video_edit"] }, { permissions: ["pages", "video_delete"] }, { permissions: ["library", "library"] },
    { permissions: ["security"] }, { permissions: ["settings"] }, { permissions: ["guests"] }, { password: "chosen-weak-password" }, { role: "admin" }]) {
    const response = await f.call("/api/guests", { ...valid, ...changes }); assert.equal(response.statusCode, 400, response.body);
  }
  const created = await credential(f, 3_600_000, ["library", "video_edit", "video_delete", "configuration"]);
  assert.throws(() => f.auth.guests.update("wrong-owner", created.guest.id, { ...valid, version: 1 }), (error: unknown) => (error as { code: string }).code === "NOT_FOUND");
  const login = await guestLogin(f, created.password); assert.equal((await f.call("/api/guests", valid, guestHeaders(f, login))).statusCode, 403);
});

test("旧v5/v6/v7正常启动但访客只读降级，不自动创建访客表或执行迁移", async () => {
  for (const version of [5, 6, 7]) {
    const directory = resolve(WORKSPACE_ROOT, ".local/tests", `guest-legacy-v${version}-${randomUUID()}`); mkdirSync(directory, { recursive: true });
    const path = resolve(directory, "legacy.db"); const client = new Database(path);
    client.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)");
    for (const migration of migrationManifest().slice(0, version)) { client.exec(migration.sql); client.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migration.version, migration.checksum, "2026-10-01T00:00:00.000Z"); }
    client.close(); const database = openDatabase(path);
    try {
      const guests = new GuestService(database); assert.equal(guests.available(), false); assert.equal(guests.list("owner").persistenceAvailable, false);
      await assert.rejects(guests.create("owner", { name: "不得写入", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: defaults }, async () => {}), (error: unknown) => (error as { code: string }).code === "GUEST_UNAVAILABLE");
      assert.equal((database.client.prepare("SELECT count(*) n FROM schema_migrations").get() as { n: number }).n, version);
      assert.equal(database.client.prepare("SELECT name FROM sqlite_master WHERE name='guests'").get(), undefined);
    } finally { database.close(); }
  }
});

test("访客登录失败限流跨实例保持，且不占用管理员邮箱/TOTP失败桶", async t => {
  const f = await accountFixture({ settings: { AUTH_MAX_FAILURES: "3" } }); t.after(f.close); await f.loginTotp(); const created = await credential(f);
  for (let i = 0; i < 3; i++) assert.equal((await guestLogin(f, "invalid-password")).statusCode, 401);
  const auth = new AuthService(f.database, f.key, f.settings, f.now, f.sender); const app = await buildApp({ config: f.config, logger: false, auth }); t.after(() => app.close());
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/guest/login", headers: { origin: f.origin }, payload: { password: created.password } })).statusCode, 429);
  f.advance(30_001); assert.equal((await f.call("/api/auth/login", { password: f.credentials.password, totp: f.token() })).statusCode, 200);
  f.advance(f.settings.failureWindowMs + 1); assert.equal((await guestLogin(f, created.password)).statusCode, 200);
});

test("磁盘库关闭重开后过期与提前撤销仍有效，不影响原管理员会话", async t => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `guest-restart-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "isolated.db"); new Database(path).close();
  const f = await accountFixture({ path }); t.after(f.close); await f.loginTotp();
  const natural = await credential(f, 90_000); const revoked = await credential(f);
  const naturalLogin = await guestLogin(f, natural.password); const revokedLogin = await guestLogin(f, revoked.password);
  assert.equal((await f.call(`/api/guests/${revoked.guest.id}/revoke`, { version: 1 })).statusCode, 200);
  f.advance(90_000); const adminHeaders = f.headers();
  await f.app.close(); f.database.close();
  const database = openDatabase(path); const auth = new AuthService(database, f.key, f.settings, f.now, f.sender);
  const app = await buildApp({ config: f.config, logger: false, auth }); t.after(async () => { await app.close(); database.close(); });
  for (const login of [naturalLogin, revokedLogin]) {
    const response = await app.inject({ url: "/api/auth/me", headers: guestHeaders(f, login) }); assert.equal(response.json().error.code, "GUEST_EXPIRED");
  }
  for (const guest of [natural, revoked]) assert.equal((await app.inject({ method: "POST", url: "/api/auth/guest/login", headers: { origin: f.origin }, payload: { password: guest.password } })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/auth/me", headers: adminHeaders })).statusCode, 200);
  assert.deepEqual(database.client.pragma("foreign_key_check"), []); assert.equal(database.client.pragma("integrity_check", { simple: true }), "ok");
});

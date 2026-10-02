import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/core/config.js";
import { openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import * as s from "../src/db/schema.js";
import { AuthService, initializeAccount } from "../src/modules/auth/service.js";
import { readAuthSettings } from "../src/modules/auth/settings.js";
import { decryptSecret, totp, verifyPassword } from "../src/modules/auth/crypto.js";
import { createMediaModule, MockStorageAdapter } from "../src/modules/media/index.js";
import { UnavailableMetadataInspector } from "../src/modules/media/metadata/types.js";

const origin = "http://127.0.0.1:5173";
async function fixture(secure = false) {
  const database = openDatabase(":memory:", { initialize: true }); const key = randomBytes(32);
  const credentials = await initializeAccount(database, key);
  const clock = { at: new Date("2026-10-01T10:00:00.000Z") };
  const settings = secure ? readAuthSettings("production", { AUTH_ALLOWED_ORIGINS: "https://video.example" }) : readAuthSettings("test", {});
  const auth = new AuthService(database, key, settings, () => clock.at);
  const config = readConfig({ NODE_ENV: "test", TRANSFER_LIMIT_BYTES: "1000", MAX_PLAYBACK_SESSIONS: "1" });
  const app = await buildApp({ config, logger: false, auth });
  app.get("/test/protected", async request => ({ data: (await auth.requireUser(request, { mutation: false })).user }));
  const login = (password = credentials.password, token = totp(credentials.totpSecret).generate({ timestamp: clock.at.getTime() }), site = settings.allowedOrigins[0]!) =>
    app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: site }, payload: { password, totp: token } });
  return { database, key, credentials, clock, auth, config, app, login };
}
const cookieFrom = (header: string | string[] | number | undefined) => String(header).split(";")[0]!;

test("本地初始化 CLI 创建独立库与资料，密码不在输出，重复初始化拒绝且原数据保留", () => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `account-cli-${Date.now()}-${randomUUID()}`);
  const databasePath = resolve(directory, "test.db"); const keyFile = resolve(directory, "test.key"); const output = resolve(directory, "setup.json");
  const run = () => spawnSync(process.execPath, ["--import", "tsx", "apps/api/src/modules/auth/account-cli.ts", "init", "--output", output], {
    cwd: WORKSPACE_ROOT, windowsHide: true, encoding: "utf8", env: { ...process.env, NODE_ENV: "test", DATABASE_PATH: databasePath, AUTH_KEY_FILE: keyFile }
  });
  const created = run(); assert.equal(created.status, 0);
  const credentials = JSON.parse(readFileSync(output, "utf8")) as { password: string; totpSecret: string };
  assert.ok(!created.stdout.includes(credentials.password)); assert.ok(!created.stdout.includes(credentials.totpSecret));
  const bytes = readFileSync(output); assert.equal(run().status, 1); assert.deepEqual(readFileSync(output), bytes);
  const database = openDatabase(databasePath);
  try { assert.equal(database.orm.select().from(s.users).all().length, 1); }
  finally { database.close(); }
});

test("绑定资料写盘失败不产生无法取回的账号、不失效原验证器及恢复码", async () => {
  const database = openDatabase(":memory:", { initialize: true }); const key = randomBytes(32);
  const fail = async () => { throw new Error("simulated private file write failure"); };
  try {
    await assert.rejects(initializeAccount(database, key, "本人", fail));
    assert.equal(database.orm.select().from(s.users).all().length, 0);
    const initial = await initializeAccount(database, key);
    const service = new AuthService(database, key, readAuthSettings("test", {}));
    const before = database.orm.select().from(s.users).get()!.totpCipher;
    await assert.rejects(service.recover(initial.password, initial.recoveryCodes[0]!, fail));
    assert.equal(database.orm.select().from(s.users).get()!.totpCipher, before);
    assert.equal(database.orm.select().from(s.recoveryCodes).all().filter(code => code.usedAt).length, 0);
    await service.recover(initial.password, initial.recoveryCodes[0]!);
    assert.notEqual(database.orm.select().from(s.users).get()!.totpCipher, before);
  } finally { database.close(); }
});

test("真实 Argon2id/TOTP 登录、Cookie/CSRF、me/撤销/过期；数据库不保存明文凭证", async t => {
  const f = await fixture(); t.after(async () => { await f.app.close(); f.database.close(); });
  const user = f.database.orm.select().from(s.users).get()!;
  assert.ok(user.passwordHash.startsWith("$argon2id$")); assert.ok(await verifyPassword(user.passwordHash, f.credentials.password));
  assert.ok(!user.totpCipher.includes(f.credentials.totpSecret)); assert.equal(decryptSecret(user.totpCipher, f.key), f.credentials.totpSecret);
  assert.equal((await f.app.inject({ url: "/api/auth/me" })).statusCode, 401);
  assert.equal((await f.login(f.credentials.password, "000000", "https://evil.invalid")).statusCode, 403);
  assert.equal((await f.login("wrong-password")).statusCode, 401);
  const response = await f.login(); assert.equal(response.statusCode, 200);
  const cookie = cookieFrom(response.headers["set-cookie"]); const csrf = response.json().data.csrfToken;
  assert.match(String(response.headers["set-cookie"]), /HttpOnly/); assert.match(String(response.headers["set-cookie"]), /SameSite=Strict/i);
  assert.ok(!String(response.headers["set-cookie"]).includes("Secure"));
  const stored = f.database.orm.select().from(s.loginSessions).get()!; assert.ok(!cookie.includes(stored.tokenHash));
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie } })).json().data.user.displayName, "本人");
  const sessions = await f.app.inject({ url: "/api/auth/sessions", headers: { cookie } }); assert.equal(sessions.json().data[0].isCurrent, true);
  assert.ok(!sessions.body.includes("tokenHash")); assert.ok(!sessions.body.includes("totpSecret"));
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, origin } })).statusCode, 403);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, origin: "https://evil.invalid", "x-csrf-token": csrf } })).statusCode, 403);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/sessions/forged/revoke", headers: { cookie, origin, "x-csrf-token": csrf } })).statusCode, 404);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, origin, "x-csrf-token": csrf } })).statusCode, 200);
  assert.equal((await f.app.inject({ url: "/test/protected", headers: { cookie } })).statusCode, 401);
  f.clock.at = new Date(f.clock.at.getTime() + 30_000); const next = await f.login(); assert.equal(next.statusCode, 200);
  f.clock.at = new Date(f.clock.at.getTime() + f.auth.settings.sessionTtlMs + 1);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie: cookieFrom(next.headers["set-cookie"]) } })).json().error.code, "SESSION_EXPIRED");
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/register", payload: {} })).statusCode, 404);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/recover", payload: {} })).statusCode, 404);
});
test("验证码并发重放仅一次成功，失败限流重启后保留，不相信未配置转发头", async t => {
  const f = await fixture(); t.after(async () => { await f.app.close(); f.database.close(); });
  const results = await Promise.all([f.login(), f.login()]); assert.deepEqual(results.map(value => value.statusCode).sort(), [200, 401]);
  const recreated = new AuthService(f.database, f.key, f.auth.settings, () => f.clock.at);
  const app = await buildApp({ config: f.config, logger: false, auth: recreated }); t.after(() => app.close());
  assert.equal((await f.login()).statusCode, 401);
  for (let attempt = 0; attempt < 8; attempt++) await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, "x-forwarded-for": `192.0.2.${attempt}` }, payload: { password: "wrong", totp: "111111" } });
  f.clock.at = new Date(f.clock.at.getTime() + 30_000);
  assert.equal((await f.login()).statusCode, 429);
  f.clock.at = new Date(f.clock.at.getTime() + f.auth.settings.failureWindowMs + 1);
  assert.equal((await f.login()).statusCode, 200);
  for (const input of ["true", "*", "", "127.0.0.1/33"]) assert.throws(() => readConfig({ TRUSTED_PROXIES: input }));
  assert.deepEqual(readConfig({ TRUSTED_PROXIES: "127.0.0.1,::1/128" }).trustedProxies, ["127.0.0.1", "::1/128"]);
});
test("受保护本地恢复需要密码加一次性恢复码，更新TOTP并撤销会话；生产Cookie严格保护", async t => {
  const f = await fixture(true); t.after(async () => { await f.app.close(); f.database.close(); });
  const logged = await f.login(); assert.equal(logged.statusCode, 200);
  assert.match(String(logged.headers["set-cookie"]), /^__Host-ov_session=/); assert.match(String(logged.headers["set-cookie"]), /Secure/);
  await assert.rejects(f.auth.recover("wrong", f.credentials.recoveryCodes[0]!));
  await assert.rejects(f.auth.recover(f.credentials.password, "invalid-recovery"));
  const newFactor = await f.auth.recover(f.credentials.password, f.credentials.recoveryCodes[0]!);
  assert.notEqual(newFactor.totpSecret, f.credentials.totpSecret);
  assert.equal((await f.app.inject({ url: "/api/auth/me", headers: { cookie: cookieFrom(logged.headers["set-cookie"]) } })).statusCode, 401);
  await assert.rejects(f.auth.recover(f.credentials.password, f.credentials.recoveryCodes[0]!));
  const renewed = await f.login(f.credentials.password, totp(newFactor.totpSecret).generate({ timestamp: f.clock.at.getTime() })); assert.equal(renewed.statusCode, 200);
  assert.throws(() => readAuthSettings("production", { AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:5173" }));
  assert.throws(() => readAuthSettings("test", { AUTH_KEY_FILE: "E:/onlineVideo/sqlite-test.db" }));
  assert.throws(() => decryptSecret(f.database.orm.select().from(s.users).get()!.totpCipher, randomBytes(32)));
});
test("真实 AuthGuard + SQL Repository 注入媒体路由，撤销登录同步阻断播放及计量", async t => {
  const f = await fixture(); t.after(async () => { await f.app.close(); f.database.close(); });
  const repos = createRepositories(f.database, () => f.clock.at); const storage = new MockStorageAdapter(); const user = f.database.orm.select().from(s.users).get()!;
  const category = f.database.orm.select().from(s.categories).get()!; storage.seed("library/test.mp4", Buffer.from("test"));
  await repos.videos.register({ ownerId: user.id, originalObject: { key: "library/test.mp4" }, playbackObject: { key: "library/test.mp4" }, thumbnailObject: null,
    video: { id: "test-video", title: "已授权测试", categoryId: category.id, durationSeconds: null, sizeBytes: 4, status: "ready", thumbnailUrl: null,
      createdAt: f.clock.at.toISOString(), codec: "h264", width: 640, height: 360, playable: true, lastPositionSeconds: 0 } });
  const app = await buildApp({ config: f.config, auth: f.auth, logger: false, media: { dependencies: { ...repos, kind: "test", auth: f.auth, storage, config: f.config, now: () => f.clock.at },
    register: createMediaModule({ objectPrefix: "library/", partSizeBytes: 128 * 1024, maxUploadBytes: 1024 * 1024, maxUploadConcurrency: 1,
      playbackTtlMs: 120_000, requestsPerMinute: 100, previewTtlMs: 60_000, maxPreviews: 5, metadata: new UnavailableMetadataInspector() }) } });
  t.after(() => app.close());
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: f.credentials.password, totp: totp(f.credentials.totpSecret).generate({ timestamp: f.clock.at.getTime() }) } });
  assert.equal(login.statusCode, 200); const headers = { cookie: cookieFrom(login.headers["set-cookie"]), origin, "x-csrf-token": login.json().data.csrfToken };
  const session = await app.inject({ method: "POST", url: "/api/videos/test-video/playback-sessions", headers }); assert.equal(session.statusCode, 200);
  assert.equal((await app.inject({ url: session.json().data.sourceUrl })).statusCode, 401);
  assert.equal((await app.inject({ url: session.json().data.sourceUrl, headers })).body, "test");
  await app.inject({ method: "POST", url: "/api/auth/logout", headers });
  assert.equal((await app.inject({ url: session.json().data.sourceUrl, headers })).statusCode, 401);
  assert.ok(f.database.orm.select().from(s.playbackSessions).where(eq(s.playbackSessions.id, session.json().data.id)).get()!.closedAt);
});

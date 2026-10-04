import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { AccountMutationResult, EmailChallenge, EmailChangeAuthorization } from "@online-video/shared";
import { buildApp } from "../src/app.js";
import { migrateDatabase, migrationManifest, MIGRATIONS, openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { AuthService } from "../src/modules/auth/service.js";
import { verifyPassword } from "../src/modules/auth/crypto.js";
import { accountFixture } from "./helpers/account-email-fixture.js";

type Fixture = Awaited<ReturnType<typeof accountFixture>>;
async function error(f: Fixture, path: string, body: unknown, code: string, custom?: Record<string, string>) {
  const response = await f.call(path, body, custom);
  assert.notEqual(response.statusCode, 200, response.body); assert.equal(response.json().error.code, code, `${path}: ${response.body}`);
  return response;
}
const challengeRow = (f: Fixture, id: string) => f.database.client.prepare("SELECT * FROM email_challenges WHERE id=?").get(id) as Record<string, unknown>;
const snapshot = (f: Fixture) => JSON.stringify(["users", "recovery_codes", "login_sessions", "email_challenges", "account_operations"].map(table => f.database.client.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
async function emailFixture() { const f = await accountFixture(); await f.loginTotp(); await f.bind(); await f.loginEmail(); return f; }
const loginBody = (f: Fixture, challenge: EmailChallenge, code = f.sender.verification(challenge.challengeId).code) => ({ authMethod: "email", password: f.credentials.password, challengeId: challenge.challengeId, code });
const confirmPassword = (f: Fixture, challenge: EmailChallenge, password = "updated-isolated-password-123") => ({ currentPassword: f.credentials.password, newPassword: password, confirmPassword: password, operationId: challenge.operationId, challengeId: challenge.challengeId, code: f.sender.verification(challenge.challengeId).code });

test("0003 只追加迁移：旧账号、会话、恢复码与视频外键保持；启动不自动升级", () => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `account-migration-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "legacy.db"); const db = new Database(path); db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)");
  const manifest = migrationManifest(); assert.equal(manifest.length, MIGRATIONS.length);
  for (const migration of manifest.slice(0, 2)) { db.exec(migration.sql); db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migration.version, migration.checksum, "2026-10-01T00:00:00.000Z"); }
  db.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES(?,?,?,?,?)").run("preserved-owner", "原账号", "preserved-argon2-hash", "preserved-totp-cipher", "2026-10-01T00:00:00.000Z");
  db.prepare("INSERT INTO categories(id,owner_id,name,name_key,is_default,created_at) VALUES(?,?,?,?,1,?)").run("category", "preserved-owner", "默认", "默认", "2026-10-01T00:00:00.000Z");
  db.prepare("INSERT INTO videos(id,owner_id,title,category_id,size_bytes,status,created_at,playable,original_key,playback_key) VALUES(?,?,?,?,1,'ready',?,1,?,?)").run("video", "preserved-owner", "原视频", "category", "2026-10-01T00:00:00.000Z", "library/video.mp4", "library/video.mp4");
  db.prepare("INSERT INTO recovery_codes VALUES(?,?,?,NULL)").run("recovery", "preserved-owner", "preserved-recovery-digest");
  db.prepare("INSERT INTO login_sessions(id,owner_id,token_hash,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?)").run("session", "preserved-owner", "preserved-session-digest", "2026-10-01", "2026-10-01", "2026-10-02");
  const before = db.prepare("SELECT * FROM users").get() as Record<string, unknown>; db.close();
  assert.throws(() => openDatabase(path), /不会自动升级/);
  const migrating = new Database(path);
  try {
    migrateDatabase(migrating); const after = migrating.prepare("SELECT * FROM users").get() as Record<string, unknown>;
    for (const [key, value] of Object.entries(before)) assert.equal(after[key], value, key);
    assert.equal(after.auth_method, "totp"); assert.equal(after.auth_version, 1); assert.equal(after.email, null);
    assert.equal((migrating.prepare("SELECT auth_version FROM login_sessions").get() as { auth_version: number }).auth_version, 1);
    assert.equal((migrating.prepare("SELECT code_hash FROM recovery_codes").get() as { code_hash: string }).code_hash, "preserved-recovery-digest");
    assert.equal((migrating.prepare("SELECT owner_id FROM videos").get() as { owner_id: string }).owner_id, "preserved-owner");
    assert.deepEqual(migrating.pragma("foreign_key_check"), []); assert.equal(migrating.pragma("integrity_check", { simple: true }), "ok");
    assert.throws(() => migrating.prepare("UPDATE users SET auth_method='email'").run());
    for (const migration of manifest.slice(0, 2)) assert.equal((migrating.prepare("SELECT checksum FROM schema_migrations WHERE version=?").get(migration.version) as { checksum: string }).checksum, migration.checksum);
  } finally { migrating.close(); }
  const dist = resolve(WORKSPACE_ROOT, "apps/api/dist/db/migrations");
  if (existsSync(dist)) for (const name of MIGRATIONS) assert.equal(readFileSync(resolve(dist, name), "utf8"), readFileSync(resolve(WORKSPACE_ROOT, "apps/api/src/db/migrations", name), "utf8"), `${name} 生产迁移未同步`);
});

test("数据库真实 TOTP 无需 JSON；首次绑定完成前原方式有效，完成后撤销会话且邮箱成为唯一普通登录方式", async t => {
  const f = await accountFixture(); t.after(f.close); const before = f.user(); await f.loginTotp();
  assert.equal((await f.ok<{ authMethod: string }>("/api/auth/login/options")).authMethod, "totp");
  await error(f, "/api/auth/password/code", { currentPassword: f.credentials.password }, "EMAIL_REQUIRED");
  await error(f, "/api/auth/email/bind/code", { currentPassword: "wrong", totp: f.token(), email: "owner@qq.com" }, "SECONDARY_AUTH_FAILED"); assert.equal(f.sender.messages.length, 0);
  f.advance(30_001); const challenge = await f.ok<EmailChallenge>("/api/auth/email/bind/code", { currentPassword: f.credentials.password, totp: f.token(), email: "owner@qq.com" });
  assert.equal(f.user().auth_method, "totp"); assert.equal(f.user().email, null);
  f.advance(30_001); await f.loginTotp();
  await error(f, "/api/auth/email/bind/confirm", { currentPassword: f.credentials.password, totp: f.token(), operationId: challenge.operationId, challengeId: challenge.challengeId, code: f.sender.verification(challenge.challengeId).code }, "ACCOUNT_OPERATION_INVALID");
  f.advance(); const bound = await f.bind(); assert.ok(bound.operationId);
  assert.equal(f.user().auth_method, "email"); assert.equal(f.user().auth_version, 2); assert.equal(f.user().totp_cipher, before.totp_cipher); assert.equal(f.user().password_hash, before.password_hash); assert.equal(f.user().id, before.id);
  assert.equal((await f.call("/api/auth/me")).statusCode, 401);
  await error(f, "/api/auth/login", { password: f.credentials.password, totp: f.token() }, "AUTH_METHOD_MISMATCH");
  await f.loginEmail(); const me = await f.ok<{ user: { authMethod: string; emailMasked: string; totpEnabled: boolean } }>("/api/auth/me");
  assert.equal(me.user.authMethod, "email"); assert.equal(me.user.totpEnabled, true); assert.ok(me.user.emailMasked.includes("*"));
});

test("登录发码检查密码/精确参数/Origin；只发码无新会话且数据库保存绑定上下文的 HMAC", async t => {
  const f = await emailFixture(); t.after(f.close); f.advance();
  const before = f.sender.messages.length; await error(f, "/api/auth/login/code", { password: "wrong" }, "INVALID_CREDENTIALS"); assert.equal(f.sender.messages.length, before);
  await error(f, "/api/auth/login/code", { password: f.credentials.password, email: "attacker@example.invalid" }, "VALIDATION_ERROR");
  await error(f, "/api/auth/login/code", { password: f.credentials.password }, "CSRF_REJECTED", { origin: "https://evil.invalid" });
  const sessions = f.database.client.prepare("SELECT count(*) AS n FROM login_sessions").get() as { n: number };
  const challenge = await f.ok<EmailChallenge>("/api/auth/login/code", { password: f.credentials.password });
  assert.equal(f.sender.verification(challenge.challengeId).to, "owner@qq.com"); assert.equal(challenge.operationId, null);
  assert.equal(new Date(challenge.expiresAt).getTime() - new Date(challenge.serverTime).getTime(), 300_000); assert.equal(new Date(challenge.resendAt).getTime() - new Date(challenge.serverTime).getTime(), 60_000);
  assert.equal((f.database.client.prepare("SELECT count(*) AS n FROM login_sessions").get() as { n: number }).n, sessions.n);
  const row = challengeRow(f, challenge.challengeId); const code = f.sender.verification(challenge.challengeId).code; assert.match(code, /^\d{6}$/); assert.notEqual(row.code_digest, createHash("sha256").update(code).digest("hex")); assert.ok(!JSON.stringify(row).includes(`"${code}"`));
  await error(f, "/api/auth/password/code", { currentPassword: f.credentials.password }, "CSRF_REJECTED", { origin: f.origin, cookie: f.headers().cookie! });
});

test("验证码错误次数真正提交，重建服务仍保留；用途隔离、过期及重发旧码失效", async t => {
  const f = await emailFixture(); t.after(f.close); f.advance(); const challenge = await f.ok<EmailChallenge>("/api/auth/login/code", { password: f.credentials.password });
  const wrong = f.sender.verification(challenge.challengeId).code === "000000" ? "111111" : "000000";
  for (let i = 1; i <= 5; i++) { await error(f, "/api/auth/login", loginBody(f, challenge, wrong), i === 5 ? "EMAIL_CODE_ATTEMPTS_EXCEEDED" : "EMAIL_CODE_INVALID"); assert.equal(challengeRow(f, challenge.challengeId).error_count, i); }
  const restarted = new AuthService(f.database, f.key, f.settings, f.now, f.sender); const app = await buildApp({ config: f.config, logger: false, auth: restarted }); t.after(() => app.close());
  const rejected = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.origin }, payload: loginBody(f, challenge) }); assert.equal(rejected.json().error.code, "EMAIL_CODE_ATTEMPTS_EXCEEDED");
  f.advance(); const fresh = await f.ok<EmailChallenge>("/api/auth/login/code", { password: f.credentials.password });
  await error(f, "/api/auth/login/code", { password: f.credentials.password }, "EMAIL_SEND_COOLDOWN");
  const password = await f.ok<EmailChallenge>("/api/auth/password/code", { currentPassword: f.credentials.password }); await error(f, "/api/auth/login", loginBody(f, password), "EMAIL_CHALLENGE_EXPIRED");
  f.advance(); const resent = await f.ok<EmailChallenge>("/api/auth/login/code", { password: f.credentials.password });
  await error(f, "/api/auth/login", loginBody(f, fresh), "EMAIL_CHALLENGE_EXPIRED"); f.advance(300_001); await error(f, "/api/auth/login", loginBody(f, resent), "EMAIL_CHALLENGE_EXPIRED");
});

test("两连接并发发码共用持久冷却，正确挑战消费与会话创建只成功一次，重启保留额度", async t => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `account-concurrency-${randomUUID()}`); mkdirSync(directory, { recursive: true }); const path = resolve(directory, "isolated.db"); new Database(path).close();
  const f = await accountFixture({ path }); t.after(f.close); await f.loginTotp(); await f.bind(); f.advance();
  const secondDb = openDatabase(path); t.after(() => secondDb.close()); const second = new AuthService(secondDb, f.key, f.settings, f.now, f.sender); const app = await buildApp({ config: f.config, logger: false, auth: second }); t.after(() => app.close());
  const send = () => app.inject({ method: "POST", url: "/api/auth/login/code", headers: { origin: f.origin, "x-forwarded-for": "192.0.2.200" }, payload: { password: f.credentials.password } });
  const sent = await Promise.all([f.call("/api/auth/login/code", { password: f.credentials.password }), send()]); assert.deepEqual(sent.map(response => response.statusCode).sort(), [200, 429]);
  const challenge = sent.find(response => response.statusCode === 200)!.json().data as EmailChallenge;
  const logins = await Promise.all([f.call("/api/auth/login", loginBody(f, challenge)), app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.origin }, payload: loginBody(f, challenge) })]); assert.deepEqual(logins.map(response => response.statusCode).sort(), [200, 400]);
  assert.ok(challengeRow(f, challenge.challengeId).used_at); assert.equal((f.database.client.prepare("SELECT count(*) AS n FROM login_sessions WHERE revoked_at IS NULL").get() as { n: number }).n, 1);
  for (let i = 0; i < 8; i++) { f.advance(); assert.equal((await send()).statusCode, 200); }
  f.advance(); assert.equal((await send()).statusCode, 429);
  assert.equal((f.database.client.prepare("SELECT count(DISTINCT ip_hash) AS n FROM email_send_limits").get() as { n: number }).n, 1, "未经信任的 x-forwarded-for 不可绕过真实 IP 限额");
  const restarted = new AuthService(secondDb, f.key, f.settings, f.now, f.sender); const restartApp = await buildApp({ config: f.config, logger: false, auth: restarted }); t.after(() => restartApp.close());
  assert.equal((await restartApp.inject({ method: "POST", url: "/api/auth/login/code", headers: { origin: f.origin }, payload: { password: f.credentials.password } })).json().error.code, "RATE_LIMITED");
});

test("发送失败/超时不废弃旧有效码；pending 不可登录，发送期间恢复使晚完成挑战无效", async t => {
  const f = await emailFixture(); t.after(f.close); f.advance(); const old = await f.ok<EmailChallenge>("/api/auth/login/code", { password: f.credentials.password }); f.advance(); f.sender.failVerification = true;
  await error(f, "/api/auth/login/code", { password: f.credentials.password }, "MAIL_SEND_FAILED"); assert.equal(challengeRow(f, old.challengeId).invalidated_at, null);
  f.sender.failVerification = false; f.advance(); let release!: () => void; let started!: () => void; const startedPromise = new Promise<void>(resolve => { started = resolve; });
  f.sender.beforeSend = async message => { if (message.kind === "verification") { started(); await new Promise<void>(resolve => { release = resolve; }); } };
  const pending = f.call("/api/auth/login/code", { password: f.credentials.password }); await startedPromise; const message = f.sender.latest("login");
  await error(f, "/api/auth/login", { authMethod: "email", password: f.credentials.password, challengeId: message.challengeId, code: message.code }, "EMAIL_CHALLENGE_EXPIRED");
  assert.equal(f.database.client.inTransaction, false, "SMTP 等待不得占据 SQLite 写事务");
  await f.auth.recover(f.credentials.password, f.credentials.recoveryCodes[0]!); release(); assert.notEqual((await pending).statusCode, 200);
  assert.ok(challengeRow(f, message.challengeId).invalidated_at); assert.equal(f.user().auth_method, "totp");
  const timeout = await emailFixture(); t.after(timeout.close); timeout.auth.settings.mailTimeoutMs = 10; timeout.advance(); timeout.sender.beforeSend = async () => new Promise<void>(() => {});
  await error(timeout, "/api/auth/login/code", { password: timeout.credentials.password }, "MAIL_SEND_FAILED"); assert.equal(timeout.user().auth_method, "email");
});

test("改密码二次凭据错误保留会话；策略与原子消费、版本提升/全失效、通知失败仍明确成功", async t => {
  const f = await emailFixture(); t.after(f.close); const before = f.user();
  await error(f, "/api/auth/password/code", { currentPassword: "wrong" }, "SECONDARY_AUTH_FAILED"); assert.equal((await f.call("/api/auth/me")).statusCode, 200);
  const challenge = await f.ok<EmailChallenge>("/api/auth/password/code", { currentPassword: f.credentials.password }); const body = confirmPassword(f, challenge);
  await error(f, "/api/auth/password/confirm", { ...body, currentPassword: "wrong" }, "SECONDARY_AUTH_FAILED"); assert.equal((await f.call("/api/auth/me")).statusCode, 200);
  await error(f, "/api/auth/password/confirm", { ...body, newPassword: "short", confirmPassword: "short" }, "PASSWORD_POLICY_FAILED");
  await error(f, "/api/auth/password/confirm", { ...body, confirmPassword: "different-password" }, "PASSWORD_POLICY_FAILED");
  await error(f, "/api/auth/password/confirm", { ...body, newPassword: f.credentials.password, confirmPassword: f.credentials.password }, "PASSWORD_UNCHANGED");
  f.advance(); const oldLogin = await f.ok<EmailChallenge>("/api/auth/login/code", { password: f.credentials.password }); f.sender.failNotification = true;
  const changed = await f.ok<AccountMutationResult>("/api/auth/password/confirm", body); assert.equal(changed.success, true); assert.equal(changed.reloginRequired, true); assert.equal(changed.notificationStatus, "failed");
  assert.ok(await verifyPassword(String(f.user().password_hash), body.newPassword)); assert.equal(f.user().auth_version, Number(before.auth_version) + 1); assert.equal(f.user().totp_cipher, before.totp_cipher);
  assert.ok(challengeRow(f, challenge.challengeId).used_at); assert.ok(challengeRow(f, oldLogin.challengeId).invalidated_at);
  assert.equal((await f.call("/api/auth/me")).statusCode, 401);
  assert.equal((f.database.client.prepare("SELECT state FROM security_notifications").get() as { state: string }).state, "failed");
  assert.equal(f.sender.messages.find(message => message.kind === "notification")?.to, "owner@qq.com");
  await error(f, "/api/auth/login/code", { password: f.credentials.password }, "INVALID_CREDENTIALS"); f.advance(); await f.loginEmail(body.newPassword);
});

test("改邮箱必须验证旧邮箱和固定目标；跨会话授权拒绝，取消/失败保留原绑定，成功通知旧邮箱并全失效", async t => {
  const f = await emailFixture(); t.after(f.close); const original = f.user();
  await error(f, "/api/auth/email/change/old/code", { currentPassword: f.credentials.password, newEmail: "OWNER@QQ.COM" }, "EMAIL_UNCHANGED");
  const old = await f.ok<EmailChallenge>("/api/auth/email/change/old/code", { currentPassword: f.credentials.password, newEmail: "next@163.com" });
  await error(f, "/api/auth/email/change/new/code", { operationId: old.operationId }, "ACCOUNT_OPERATION_INVALID");
  const authorization = await f.ok<EmailChangeAuthorization>("/api/auth/email/change/old/verify", { currentPassword: f.credentials.password, operationId: old.operationId, challengeId: old.challengeId, code: f.sender.verification(old.challengeId).code });
  await error(f, "/api/auth/email/change/new/code", { operationId: authorization.operationId, newEmail: "different@example.invalid" }, "VALIDATION_ERROR");
  f.sender.failVerification = true; await error(f, "/api/auth/email/change/new/code", { operationId: authorization.operationId }, "MAIL_SEND_FAILED"); assert.equal(f.user().email, original.email); f.sender.failVerification = false;
  await f.ok("/api/auth/operations/cancel", { operationId: authorization.operationId }); await error(f, "/api/auth/email/change/new/code", { operationId: authorization.operationId }, "ACCOUNT_OPERATION_INVALID"); assert.equal(f.user().email, original.email);
  f.advance(); const nextOld = await f.ok<EmailChallenge>("/api/auth/email/change/old/code", { currentPassword: f.credentials.password, newEmail: "next@163.com" });
  await f.ok("/api/auth/email/change/old/verify", { currentPassword: f.credentials.password, operationId: nextOld.operationId, challengeId: nextOld.challengeId, code: f.sender.verification(nextOld.challengeId).code });
  const next = await f.ok<EmailChallenge>("/api/auth/email/change/new/code", { operationId: nextOld.operationId }); assert.equal(f.sender.verification(next.challengeId).to, "next@163.com"); assert.equal(f.user().email, original.email);
  const changed = await f.ok<AccountMutationResult>("/api/auth/email/change/confirm", { currentPassword: f.credentials.password, operationId: next.operationId, challengeId: next.challengeId, code: f.sender.verification(next.challengeId).code });
  assert.equal(changed.success, true); assert.equal(f.user().email, "next@163.com"); assert.equal(f.user().auth_version, Number(original.auth_version) + 1); assert.equal((await f.call("/api/auth/me")).statusCode, 401);
  assert.equal([...f.sender.messages].reverse().find(message => message.kind === "notification")?.to, "owner@qq.com"); f.advance(); await f.loginEmail(); assert.equal(f.sender.latest("login").to, "next@163.com");
});

test("本地恢复先保存资料：写失败不消费恢复码或改状态；成功回退 TOTP 并保留待验证邮箱", async t => {
  const f = await emailFixture(); t.after(f.close); f.advance(); await f.ok<EmailChallenge>("/api/auth/password/code", { currentPassword: f.credentials.password }); const before = snapshot(f);
  await assert.rejects(f.auth.recover(f.credentials.password, f.credentials.recoveryCodes[0]!, async () => { throw new Error("isolated recovery file failure"); })); assert.equal(snapshot(f), before);
  const recovery = await f.auth.recover(f.credentials.password, f.credentials.recoveryCodes[0]!);
  assert.equal(f.user().auth_method, "totp"); assert.equal(f.user().auth_version, 3); assert.equal(f.user().email, "owner@qq.com"); assert.equal(f.user().email_verified_at, null); assert.equal((await f.call("/api/auth/me")).statusCode, 401);
  assert.equal((f.database.client.prepare("SELECT count(*) AS n FROM email_challenges WHERE invalidated_at IS NULL AND used_at IS NULL").get() as { n: number }).n, 0);
  await f.loginTotp(recovery.totpSecret); await f.bind("renewed@qq.com", recovery.totpSecret); assert.equal(f.user().auth_method, "email"); assert.equal(f.user().email, "renewed@qq.com");
  await assert.rejects(f.auth.recover(f.credentials.password, f.credentials.recoveryCodes[0]!));
});

test("邮箱修改授权绑定原会话；B目标操作的验证码不能确认A操作", async t => {
  const f = await emailFixture(); t.after(f.close); const sessionA = f.headers();
  const oldA = await f.ok<EmailChallenge>("/api/auth/email/change/old/code", { currentPassword: f.credentials.password, newEmail: "target-a@163.com" });
  await f.ok("/api/auth/email/change/old/verify", { currentPassword: f.credentials.password, operationId: oldA.operationId, challengeId: oldA.challengeId, code: f.sender.verification(oldA.challengeId).code });
  f.advance(); await f.loginEmail(); const sessionB = f.headers(); assert.notEqual(sessionA.cookie, sessionB.cookie);
  await error(f, "/api/auth/email/change/new/code", { operationId: oldA.operationId }, "ACCOUNT_OPERATION_INVALID");
  const sentA = await f.call("/api/auth/email/change/new/code", { operationId: oldA.operationId }, sessionA); assert.equal(sentA.statusCode, 200); const newA = sentA.json().data as EmailChallenge;
  f.advance(); const oldB = await f.ok<EmailChallenge>("/api/auth/email/change/old/code", { currentPassword: f.credentials.password, newEmail: "target-b@163.com" });
  await f.ok("/api/auth/email/change/old/verify", { currentPassword: f.credentials.password, operationId: oldB.operationId, challengeId: oldB.challengeId, code: f.sender.verification(oldB.challengeId).code });
  const newB = await f.ok<EmailChallenge>("/api/auth/email/change/new/code", { operationId: oldB.operationId });
  await error(f, "/api/auth/email/change/confirm", { currentPassword: f.credentials.password, operationId: newA.operationId, challengeId: newB.challengeId, code: f.sender.verification(newB.challengeId).code }, "EMAIL_CHALLENGE_EXPIRED", sessionA);
  assert.equal(challengeRow(f, newB.challengeId).used_at, null); assert.equal(f.user().email, "owner@qq.com");
  await f.ok("/api/auth/email/change/confirm", { currentPassword: f.credentials.password, operationId: newB.operationId, challengeId: newB.challengeId, code: f.sender.verification(newB.challengeId).code });
  assert.equal(f.user().email, "target-b@163.com"); assert.equal((await f.call("/api/auth/me", undefined, sessionA)).statusCode, 401); assert.equal((await f.call("/api/auth/me", undefined, sessionB)).statusCode, 401);
});

test("登录邮件发送期间修改密码或邮箱：晚完成挑战不可登录并保持已提交修改", async t => {
  for (const mutation of ["password", "email"] as const) {
    await t.test(mutation, async t => {
      const f = await emailFixture(); t.after(f.close); let prepared: EmailChallenge;
      if (mutation === "password") prepared = await f.ok<EmailChallenge>("/api/auth/password/code", { currentPassword: f.credentials.password });
      else {
        const old = await f.ok<EmailChallenge>("/api/auth/email/change/old/code", { currentPassword: f.credentials.password, newEmail: "delayed-next@163.com" });
        await f.ok("/api/auth/email/change/old/verify", { currentPassword: f.credentials.password, operationId: old.operationId, challengeId: old.challengeId, code: f.sender.verification(old.challengeId).code });
        prepared = await f.ok<EmailChallenge>("/api/auth/email/change/new/code", { operationId: old.operationId });
      }
      f.advance(); let release!: () => void; let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
      f.sender.beforeSend = async message => { if (message.kind === "verification" && message.purpose === "login") { started(); await new Promise<void>(resolve => { release = resolve; }); } };
      const sending = f.call("/api/auth/login/code", { password: f.credentials.password }); await waiting; const pending = f.sender.latest("login");
      if (mutation === "password") await f.ok("/api/auth/password/confirm", confirmPassword(f, prepared));
      else await f.ok("/api/auth/email/change/confirm", { currentPassword: f.credentials.password, operationId: prepared.operationId, challengeId: prepared.challengeId, code: f.sender.verification(prepared.challengeId).code });
      release(); assert.equal((await sending).json().error.code, "ACCOUNT_VERSION_CONFLICT"); assert.ok(challengeRow(f, pending.challengeId).invalidated_at); assert.notEqual(challengeRow(f, pending.challengeId).send_state, "sent");
      const attempted = await f.call("/api/auth/login", { authMethod: "email", password: mutation === "password" ? "updated-isolated-password-123" : f.credentials.password, challengeId: pending.challengeId, code: pending.code }); assert.equal(attempted.json().error.code, "EMAIL_CHALLENGE_EXPIRED");
      assert.equal(f.user().auth_version, 3); if (mutation === "email") assert.equal(f.user().email, "delayed-next@163.com");
    });
  }
});

test("旧发送晚完成不能覆盖新发送；新发送失败仍保留最初有效验证码", async t => {
  for (const failNewer of [false, true]) {
    await t.test(failNewer ? "新发送失败" : "新发送成功", async t => {
      const f = await emailFixture(); t.after(f.close); f.advance(); const original = await f.ok<EmailChallenge>("/api/auth/login/code", { password: f.credentials.password });
      f.advance(); let firstId = ""; let release!: () => void; let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
      f.sender.beforeSend = async message => {
        if (message.kind !== "verification" || message.purpose !== "login") return;
        if (!firstId) { firstId = message.challengeId; started(); await new Promise<void>(resolve => { release = resolve; }); }
        else if (failNewer) throw new Error("isolated newer send failed");
      };
      const older = f.call("/api/auth/login/code", { password: f.credentials.password }); await waiting; f.advance(); const newer = await f.call("/api/auth/login/code", { password: f.credentials.password });
      const newestMessage = f.sender.latest("login"); assert.equal(newer.statusCode, failNewer ? 503 : 200); release(); assert.equal((await older).json().error.code, "ACCOUNT_VERSION_CONFLICT");
      assert.notEqual(challengeRow(f, firstId).send_state, "sent"); assert.equal(challengeRow(f, newestMessage.challengeId).send_state, failNewer ? "failed" : "sent");
      if (failNewer) { assert.equal(challengeRow(f, original.challengeId).invalidated_at, null); assert.equal((await f.call("/api/auth/login", loginBody(f, original))).statusCode, 200); }
      else { assert.ok(challengeRow(f, original.challengeId).invalidated_at); assert.equal((await f.call("/api/auth/login", loginBody(f, newer.json().data as EmailChallenge))).statusCode, 200); }
    });
  }
});

test("关闭所有 SQLite 连接后重新打开：验证码错误次数与小时发送额度保持", async t => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `account-restart-${randomUUID()}`); mkdirSync(directory, { recursive: true }); const path = resolve(directory, "isolated.db"); new Database(path).close();
  const f = await accountFixture({ path, settings: { AUTH_EMAIL_HOURLY_LIMIT: "3" } }); await f.loginTotp(); await f.bind(); await f.loginEmail(); f.advance(); const challenge = await f.ok<EmailChallenge>("/api/auth/login/code", { password: f.credentials.password });
  const wrong = f.sender.verification(challenge.challengeId).code === "000000" ? "111111" : "000000";
  await error(f, "/api/auth/login", loginBody(f, challenge, wrong), "EMAIL_CODE_INVALID"); await error(f, "/api/auth/login", loginBody(f, challenge, wrong), "EMAIL_CODE_INVALID");
  await f.close(); assert.equal(f.database.client.open, false); const database = openDatabase(path); const auth = new AuthService(database, f.key, f.settings, f.now, f.sender); const app = await buildApp({ config: f.config, auth, logger: false }); t.after(async () => { await app.close(); database.close(); });
  assert.equal((database.client.prepare("SELECT error_count FROM email_challenges WHERE id=?").get(challenge.challengeId) as { error_count: number }).error_count, 2);
  for (let i = 3; i <= 5; i++) { const response = await app.inject({ url: "/api/auth/login", method: "POST", headers: { origin: f.origin }, payload: loginBody(f, challenge, wrong) }); assert.equal(response.json().error.code, i === 5 ? "EMAIL_CODE_ATTEMPTS_EXCEEDED" : "EMAIL_CODE_INVALID"); }
  f.advance(); const blocked = await app.inject({ url: "/api/auth/login/code", method: "POST", headers: { origin: f.origin }, payload: { password: f.credentials.password } }); assert.equal(blocked.json().error.code, "RATE_LIMITED");
  assert.equal((database.client.prepare("SELECT count(*) AS n FROM email_send_limits").get() as { n: number }).n, 3);
});

test("绑定 TOTP 错误计数持久限流；恢复资料保存期间账号改变不得消费旧恢复码", async t => {
  const old = await accountFixture({ settings: { AUTH_MAX_FAILURES: "3" } }); t.after(old.close); await old.loginTotp(); old.advance(30_001);
  const badToken = old.token() === "000000" ? "111111" : "000000";
  for (let i = 0; i < 3; i++) await error(old, "/api/auth/email/bind/code", { currentPassword: old.credentials.password, totp: badToken, email: "owner@qq.com" }, "SECONDARY_AUTH_FAILED");
  await error(old, "/api/auth/email/bind/code", { currentPassword: old.credentials.password, totp: old.token(), email: "owner@qq.com" }, "RATE_LIMITED"); assert.equal(old.sender.messages.length, 0);
  const f = await emailFixture(); t.after(f.close); const beforeCipher = f.user().totp_cipher; const challenge = await f.ok<EmailChallenge>("/api/auth/password/code", { currentPassword: f.credentials.password });
  await assert.rejects(f.auth.recover(f.credentials.password, f.credentials.recoveryCodes[0]!, async () => { await f.ok("/api/auth/password/confirm", confirmPassword(f, challenge)); }));
  assert.equal(f.user().totp_cipher, beforeCipher); assert.equal(f.user().auth_method, "email"); assert.equal(f.user().auth_version, 3);
  assert.equal((f.database.client.prepare("SELECT used_at FROM recovery_codes WHERE code_hash=?").get(createHash("sha256").update(f.credentials.recoveryCodes[0]!).digest("hex")) as { used_at: string | null }).used_at, null);
});

test("邮箱账号受保护恢复 CLI 完整路径：隔离输入与资料、保存后回退 TOTP，不回显凭据", async t => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `account-cli-email-recovery-${randomUUID()}`); mkdirSync(directory, { recursive: true }); const path = resolve(directory, "isolated.db"); new Database(path).close();
  const f = await accountFixture({ path }); t.after(f.close); await f.loginTotp(); await f.bind(); await f.loginEmail();
  const keyFile = resolve(directory, "isolated.key"); const inputFile = resolve(directory, "isolated-recovery-input.json"); const historicalFile = resolve(directory, "isolated-offline-history.json");
  writeFileSync(keyFile, f.key, { flag: "wx" }); writeFileSync(inputFile, JSON.stringify({ password: f.credentials.password, recoveryCode: f.credentials.recoveryCodes[0] }), { encoding: "utf8", flag: "wx" });
  writeFileSync(historicalFile, JSON.stringify(f.credentials), { encoding: "utf8", flag: "wx" }); const historicalBytes = readFileSync(historicalFile);
  const result = spawnSync(process.execPath, ["--import", "tsx", "apps/api/src/modules/auth/account-cli.ts", "recover", "--input", inputFile], {
    cwd: WORKSPACE_ROOT, windowsHide: true, encoding: "utf8", env: { ...process.env, NODE_ENV: "test", DATABASE_PATH: path, AUTH_KEY_FILE: keyFile }
  });
  assert.equal(result.status, 0, result.stderr); assert.equal((result.stdout + result.stderr).includes(f.credentials.password), false); assert.equal((result.stdout + result.stderr).includes(f.credentials.recoveryCodes[0]!), false);
  const output = result.stdout.match(/新绑定资料：([^\r\n]+\.json)/)?.[1]; assert.ok(output, "CLI 未返回新的恢复资料路径");
  const material = JSON.parse(readFileSync(output, "utf8")) as { totpSecret: string; recoveryCodes: string[] };
  assert.notEqual(material.totpSecret, f.credentials.totpSecret); assert.equal(material.recoveryCodes.length, f.credentials.recoveryCodes.length); assert.deepEqual(readFileSync(historicalFile), historicalBytes);
  assert.equal(f.user().auth_method, "totp"); assert.equal(f.user().email, "owner@qq.com"); assert.equal(f.user().email_verified_at, null); assert.equal(f.user().auth_version, 3); assert.equal((await f.call("/api/auth/me")).statusCode, 401);
  assert.ok((f.database.client.prepare("SELECT used_at FROM recovery_codes WHERE code_hash=?").get(createHash("sha256").update(f.credentials.recoveryCodes[0]!).digest("hex")) as { used_at: string | null }).used_at);
  await f.loginTotp(material.totpSecret); assert.equal((await f.call("/api/auth/me")).statusCode, 200);
});

test("真实 runtime 仅以隔离数据库为准：无需 setup JSON；TOTP 与禁用TOTP的邮箱模式可启动，缺SMTP明确失败", async t => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `account-runtime-${randomUUID()}`); mkdirSync(directory, { recursive: true }); const path = resolve(directory, "isolated.db"); new Database(path).close();
  const f = await accountFixture({ path }); t.after(f.close); f.clock.at = new Date(Date.now() - 120_000); await f.loginTotp(); const keyFile = resolve(directory, "isolated.key"); writeFileSync(keyFile, f.key, { flag: "wx" });
  const script = `
    import { readFileSync } from 'node:fs';
    import { loadRuntimeAuth } from './apps/api/src/modules/auth/runtime.ts';
    import { readConfig } from './apps/api/src/core/config.ts';
    import { buildApp } from './apps/api/src/app.ts';
    import { decryptSecret,totp } from './apps/api/src/modules/auth/crypto.ts';
    const { password } = JSON.parse(readFileSync(0,'utf8'));
    const config = readConfig({NODE_ENV:'test'}); const runtime = await loadRuntimeAuth(config);
    const app = await buildApp({config,auth:runtime.service,logger:false});
    try {
      const user = runtime.database.client.prepare('SELECT * FROM users').get();
      const origin = runtime.service.settings.allowedOrigins[0];
      const token = totp(decryptSecret(user.totp_cipher,runtime.service.key)).generate();
      const login = await app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{password,totp:token}});
      const mail = user.auth_method === 'email' ? await app.inject({method:'POST',url:'/api/auth/login/code',headers:{origin},payload:{password}}) : null;
      console.log(JSON.stringify({authMethod:user.auth_method,totpEnabled:!!user.totp_enabled,loginStatus:login.statusCode,loginCode:login.json().error?.code,mailCode:mail?.json().error?.code,sessionCount:runtime.database.client.prepare('SELECT count(*) AS n FROM login_sessions').get().n}));
    } finally {await app.close();runtime.database.close();}
  `;
  const run = () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: WORKSPACE_ROOT, encoding: "utf8", windowsHide: true, input: JSON.stringify({ password: f.credentials.password }),
      env: { ...process.env, NODE_ENV: "test", DATABASE_PATH: path, AUTH_KEY_FILE: keyFile, AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:5173" } });
    assert.equal(result.status, 0, result.stderr); assert.equal((result.stdout + result.stderr).includes(f.credentials.password), false);
    return JSON.parse(result.stdout) as { authMethod: string; totpEnabled: boolean; loginStatus: number; loginCode?: string; mailCode?: string; sessionCount: number };
  };
  assert.equal(existsSync(resolve(directory, "account-setup.json")), false); const legacy = run(); assert.equal(legacy.authMethod, "totp"); assert.equal(legacy.loginStatus, 200);
  await f.bind(); f.database.client.prepare("UPDATE users SET totp_enabled=0").run(); await f.loginEmail(); assert.equal((await f.call("/api/auth/me")).statusCode, 200); const sessions = (f.database.client.prepare("SELECT count(*) AS n FROM login_sessions").get() as { n: number }).n;
  const email = run(); assert.equal(email.authMethod, "email"); assert.equal(email.totpEnabled, false); assert.equal(email.loginCode, "AUTH_METHOD_MISMATCH"); assert.equal(email.mailCode, "MAIL_NOT_CONFIGURED"); assert.equal(email.sessionCount, sessions); assert.equal(f.user().auth_method, "email");
  f.clock.at = new Date(Date.now()); f.advance(); await f.loginEmail();
  const me = await f.ok<{ user: { authMethod: string; totpEnabled: boolean } }>("/api/auth/me"); assert.equal(me.user.authMethod, "email"); assert.equal(me.user.totpEnabled, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { EmailChallenge } from "@online-video/shared";
import { registerErrorHandlers } from "../src/core/errors.js";
import { openDatabase, migrationManifest, WORKSPACE_ROOT } from "../src/db/database.js";
import * as schema from "../src/db/schema.js";
import { AuthService, initializeAccount } from "../src/modules/auth/service.js";
import { registerAuthModule } from "../src/modules/auth/routes.js";
import { readAuthSettings } from "../src/modules/auth/settings.js";
import { randomToken, tokenHash, totp, verifyPassword } from "../src/modules/auth/crypto.js";
import type { MailMessage, MailSender } from "../src/modules/auth/mail.js";
import { initializeInstallation, readInstallationState } from "../src/modules/setup/bootstrap.js";
import { SetupService } from "../src/modules/setup/service.js";
import { registerSetupModule } from "../src/modules/setup/routes.js";

const origin = "http://127.0.0.1:5173";
const strongPassword = "new-installation-password-123";
class FakeMail implements MailSender {
  messages: MailMessage[] = [];
  failure = false;
  pending?: () => Promise<void>;
  async send(message: MailMessage) { this.messages.push(message); if (this.pending) await this.pending(); if (this.failure) throw new Error("controlled send failure"); }
  code(id: string) { const message = this.messages.find(item => item.kind === "verification" && item.challengeId === id); if (!message || message.kind !== "verification") throw new Error("missing fake email"); return message.code; }
}
async function fixture() {
  const database = openDatabase(":memory:", { initialize: true }); const key = randomBytes(32); const installationCode = randomToken();
  let clock = Date.parse("2026-10-26T10:00:00.000Z"); const now = () => new Date(clock);
  database.client.prepare("INSERT INTO installation_state(id,stage,installation_code_hash,key_fingerprint,version,created_at) VALUES(1,'password',?,?,1,?)")
    .run(tokenHash(installationCode), tokenHash(key.toString("base64url")), now().toISOString());
  const settings = readAuthSettings("test", {}); const mail = new FakeMail(); const auth = new AuthService(database, key, settings, now, mail);
  const setup = new SetupService(database, key, settings, auth, now); const app = Fastify({ logger: false }); registerErrorHandlers(app);
  registerAuthModule(app, auth); let configurationValid = false; let validationHook: (() => Promise<void>) | undefined;
  registerSetupModule(app, setup, { validateConfiguration: async () => { if (!configurationValid) { const { HttpError } = await import("../src/core/errors.js"); throw new HttpError("OSS_CONFIG_REQUIRED"); } await validationHook?.(); } });
  app.get("/protected", async request => ({ data: await auth.requireUser(request, { mutation: false }) }));
  app.post("/configuration", async request => ({ data: await setup.requireConfigurationAccess(request, true) }));
  await app.ready(); const jar = new Map<string, string>(); let csrf = "";
  const call = async (url: string, payload?: unknown, headers: Record<string, string> = {}, update = true) => {
    const response = await app.inject({ method: payload === undefined ? "GET" : "POST", url, ...(payload === undefined ? {} : { payload: payload as object }),
      headers: { origin, cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "), "x-csrf-token": csrf, ...headers } });
    if (update) {
      for (const item of response.cookies) { if (!item.value) jar.delete(item.name); else jar.set(item.name, item.value); }
      const body = response.json(); if (body.data?.csrfToken) csrf = body.data.csrfToken;
    }
    return response;
  };
  const ok = async <T = Record<string, unknown>>(url: string, payload?: unknown) => { const r = await call(url, payload); assert.equal(r.statusCode, 200, r.body); return r.json().data as T; };
  const bootstrap = async () => { await ok("/api/setup/login", { password: "adminadmin", installationCode }); await ok("/api/setup/password", { newPassword: strongPassword, confirmPassword: strongPassword }); };
  const complete = async () => { configurationValid = true; await ok("/api/setup/complete", {}); await ok("/api/auth/login", { authMethod: "password", password: strongPassword }); };
  return { database, key, installationCode, auth, setup, app, mail, jar, call, ok, bootstrap, complete,
    advance: (ms = 60_001) => { clock += ms; }, allowConfiguration: () => { configurationValid = true; }, validation: (hook: () => Promise<void>) => { validationHook = hook; }, csrf: () => csrf,
    close: async () => { await app.close(); database.close(); } };
}

test("首次安装：默认密码和独立安装码双校验，受限Cookie不可访问业务或提前配置", async t => {
  const f = await fixture(); t.after(f.close);
  assert.deepEqual(await f.ok("/api/setup/status"), { stage: "password", authenticated: false, setupAvailable: true });
  assert.equal((await f.call("/api/setup/login", { password: "adminadmin" })).json().error.code, "INSTALLATION_CODE_INVALID");
  assert.equal((await f.call("/api/setup/login", { password: "adminadmin", installationCode: randomToken() })).json().error.code, "INSTALLATION_CODE_INVALID");
  assert.equal((await f.call("/api/setup/login", { password: "adminadmin", installationCode: f.installationCode }, { origin: "http://evil.invalid" })).json().error.code, "CSRF_REJECTED");
  const login = await f.ok("/api/setup/login", { password: "adminadmin", installationCode: f.installationCode });
  assert.equal(login.stage, "password"); assert.ok(f.jar.has("ov_setup")); assert.equal(f.jar.has("ov_session"), false);
  assert.equal((await f.call("/protected")).json().error.code, "SETUP_REQUIRED");
  assert.equal((await f.call("/configuration", {})).json().error.code, "SETUP_REQUIRED");
  assert.equal((await f.call("/api/auth/login", { authMethod: "password", password: "adminadmin" })).json().error.code, "SETUP_REQUIRED");
});

test("强制改密和安装状态持久：新密码策略、旧Cookie/安装码失效，配置未成功不进入ready", async t => {
  const f = await fixture(); t.after(f.close);
  await f.ok("/api/setup/login", { password: "adminadmin", installationCode: f.installationCode }); const oldCookie = f.jar.get("ov_setup")!; const oldCsrf = f.csrf();
  assert.equal((await f.call("/api/setup/password", { newPassword: "adminadmin", confirmPassword: "adminadmin" })).json().error.code, "PASSWORD_POLICY_FAILED");
  assert.equal((await f.call("/api/setup/password", { newPassword: strongPassword, confirmPassword: strongPassword }, { "x-csrf-token": "bad" })).json().error.code, "CSRF_REJECTED");
  const result = await f.ok("/api/setup/password", { newPassword: strongPassword, confirmPassword: strongPassword });
  assert.equal(result.stage, "configuration"); assert.notEqual(f.jar.get("ov_setup"), oldCookie);
  assert.equal((await f.call("/configuration", {}, { cookie: `ov_setup=${oldCookie}`, "x-csrf-token": oldCsrf }, false)).json().error.code, "SESSION_EXPIRED");
  const user = f.database.client.prepare("SELECT * FROM users").get() as { password_hash: string; totp_enabled: number };
  assert.ok(await verifyPassword(user.password_hash, strongPassword)); assert.equal(user.totp_enabled, 0);
  assert.equal(readInstallationState(f.database)!.installation_code_hash, "");
  assert.equal((await f.call("/api/setup/login", { password: "adminadmin", installationCode: f.installationCode })).json().error.code, "INVALID_CREDENTIALS");
  await f.ok("/api/setup/login", { password: strongPassword });
  await f.ok("/configuration", {});
  assert.equal((await f.call("/api/setup/complete", {})).json().error.code, "OSS_CONFIG_REQUIRED");
  assert.equal(readInstallationState(f.database)!.stage, "configuration");
  await f.complete(); assert.equal(readInstallationState(f.database)!.stage, "ready");
  assert.equal((await f.ok<{ user: { authMethod: string } }>("/api/auth/me")).user.authMethod, "password");
  assert.equal((await f.call("/api/setup/login", { password: "adminadmin", installationCode: f.installationCode })).json().error.code, "SETUP_ALREADY_COMPLETE");
  const restarted = new SetupService(f.database, f.key, f.auth.settings, f.auth); assert.equal(restarted.status().stage, "ready");
});

test("并发强制改密只有一个成功，创建唯一账号且失败请求不能覆盖赢家密码", async t => {
  const f = await fixture(); t.after(f.close); await f.ok("/api/setup/login", { password: "adminadmin", installationCode: f.installationCode });
  const responses = await Promise.all([strongPassword, "other-installation-password-123"].map(newPassword => f.call("/api/setup/password", { newPassword, confirmPassword: newPassword }, {}, false)));
  assert.equal(responses.filter(r => r.statusCode === 200).length, 1); assert.equal(responses.filter(r => r.statusCode === 409).length, 1);
  assert.equal((f.database.client.prepare("SELECT count(*) n FROM users").get() as { n: number }).n, 1);
  assert.deepEqual(f.database.client.pragma("foreign_key_check"), []);
});

test("密码登录可独立改密；启用邮箱验证前必须SMTP已测试并完成邮箱验证码确认", async t => {
  const f = await fixture(); t.after(f.close); await f.bootstrap(); await f.complete();
  const body = { currentPassword: strongPassword, enabled: true, email: "owner@qq.com" };
  assert.equal((await f.call("/api/auth/email-verification/code", body)).json().error.code, "MAIL_TEST_REQUIRED");
  f.auth.mailConfigurationTested = () => true;
  const challenge = await f.ok<EmailChallenge>("/api/auth/email-verification/code", body); const code = f.mail.code(challenge.challengeId);
  const wrong = code === "000000" ? "000001" : "000000";
  assert.equal((await f.call("/api/auth/email-verification/confirm", { ...body, challengeId: challenge.challengeId, code: wrong })).json().error.code, "EMAIL_CODE_INVALID");
  assert.equal((f.database.client.prepare("SELECT error_count FROM email_verification_challenges WHERE id=?").get(challenge.challengeId) as { error_count: number }).error_count, 1);
  await f.ok("/api/auth/email-verification/confirm", { ...body, challengeId: challenge.challengeId, code });
  assert.equal((await f.call("/api/auth/me")).statusCode, 401);
  assert.equal((await f.call("/api/auth/login", { authMethod: "password", password: strongPassword })).json().error.code, "AUTH_METHOD_MISMATCH");
  const login = await f.ok<EmailChallenge>("/api/auth/login/code", { password: strongPassword });
  await f.ok("/api/auth/login", { authMethod: "email", password: strongPassword, challengeId: login.challengeId, code: f.mail.code(login.challengeId) });
  assert.equal((await f.call("/api/auth/password/direct", { currentPassword: strongPassword, newPassword: "other-new-password-456", confirmPassword: "other-new-password-456" })).json().error.code, "AUTH_METHOD_MISMATCH");
  f.advance(); const disabled = await f.ok<EmailChallenge>("/api/auth/email-verification/code", { currentPassword: strongPassword, enabled: false });
  await f.ok("/api/auth/email-verification/confirm", { currentPassword: strongPassword, enabled: false, challengeId: disabled.challengeId, code: f.mail.code(disabled.challengeId) });
  await f.ok("/api/auth/login", { authMethod: "password", password: strongPassword });
  const changedPassword = "other-new-password-456";
  await f.ok("/api/auth/password/direct", { currentPassword: strongPassword, newPassword: changedPassword, confirmPassword: changedPassword });
  assert.equal((await f.call("/api/auth/login", { authMethod: "password", password: strongPassword })).json().error.code, "INVALID_CREDENTIALS");
  await f.ok("/api/auth/login", { authMethod: "password", password: changedPassword });
});

test("邮箱测试或发码失败不切换登录模式，验证码绑定会话与目标且错误次数持久", async t => {
  const f = await fixture(); t.after(f.close); await f.bootstrap(); await f.complete(); f.auth.mailConfigurationTested = () => true;
  const body = { currentPassword: strongPassword, enabled: true, email: "owner@qq.com" }; f.mail.failure = true;
  assert.equal((await f.call("/api/auth/email-verification/code", body)).json().error.code, "MAIL_SEND_FAILED");
  assert.equal((await f.ok("/api/auth/login/options")).authMethod, "password");
  f.mail.failure = false; f.advance(); const challenge = await f.ok<EmailChallenge>("/api/auth/email-verification/code", body);
  assert.equal((await f.call("/api/auth/email-verification/confirm", { ...body, email: "different@qq.com", challengeId: challenge.challengeId, code: f.mail.code(challenge.challengeId) })).json().error.code, "EMAIL_CHALLENGE_EXPIRED");
  await f.ok("/api/auth/login", { authMethod: "password", password: strongPassword });
  assert.equal((await f.call("/api/auth/email-verification/confirm", { ...body, challengeId: challenge.challengeId, code: f.mail.code(challenge.challengeId) })).json().error.code, "EMAIL_CHALLENGE_EXPIRED");
  assert.equal((await f.ok("/api/auth/login/options")).authMethod, "password");
});

test("安装码失败限流持久，重建SetupService不会重置计数", async t => {
  const f = await fixture(); t.after(f.close);
  for (let i = 0; i < f.auth.settings.maxFailures; i++) assert.equal((await f.call("/api/setup/login", { password: "bad", installationCode: randomToken() })).statusCode, 401);
  assert.equal((await f.call("/api/setup/login", { password: "adminadmin", installationCode: f.installationCode })).json().error.code, "RATE_LIMITED");
  assert.equal((f.database.client.prepare("SELECT failures FROM login_attempts WHERE key='installation'").get() as { failures: number }).failures, f.auth.settings.maxFailures);
});

test("启用前配置发生并发变化时拒绝完成，不将旧检查结果应用于新配置", async t => {
  const f = await fixture(); t.after(f.close); await f.bootstrap(); f.allowConfiguration();
  f.validation(async () => { f.database.client.prepare("INSERT INTO installation_settings(id,payload_cipher,version,updated_at) VALUES(1,'isolated',1,?)").run(new Date().toISOString()); });
  assert.equal((await f.call("/api/setup/complete", {})).json().error.code, "CONFIG_VERSION_CONFLICT");
  assert.equal(readInstallationState(f.database)!.stage, "configuration");
});

test("邮箱验证发码期间退出：晚发送完成不得恢复已撤销会话或切换登录方式", async t => {
  const f = await fixture(); t.after(f.close); await f.bootstrap(); await f.complete(); f.auth.mailConfigurationTested = () => true;
  let release!: () => void; let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
  f.mail.pending = async () => { started(); await wait; };
  const sending = f.call("/api/auth/email-verification/code", { currentPassword: strongPassword, enabled: true, email: "owner@qq.com" });
  await began; await f.ok("/api/auth/logout", {}); release();
  assert.equal((await sending).json().error.code, "ACCOUNT_VERSION_CONFLICT");
  assert.equal((await f.ok("/api/auth/login/options")).authMethod, "password");
  const row = f.database.client.prepare("SELECT invalidated_at FROM email_verification_challenges").get() as { invalidated_at: string | null };
  assert.ok(row.invalidated_at);
});

test("v5既有账号继续TOTP，不创建安装state或改变原账号认证方式", async t => {
  const client = new Database(":memory:"); client.pragma("foreign_keys=ON"); client.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)");
  for (const migration of migrationManifest().slice(0, 5)) { client.exec(migration.sql); client.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migration.version, migration.checksum, new Date().toISOString()); }
  const database = { client, orm: drizzle(client, { schema }), path: ":memory:", close: () => client.close() }; const key = randomBytes(32);
  const credentials = await initializeAccount(database, key); const settings = readAuthSettings("test", {}); const auth = new AuthService(database, key, settings);
  const app = Fastify({ logger: false }); registerErrorHandlers(app); registerAuthModule(app, auth); t.after(async () => { await app.close(); database.close(); });
  const setup = new SetupService(database, key, settings, auth); assert.deepEqual(setup.status(), { stage: "ready", authenticated: false, setupAvailable: false });
  const response = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: credentials.password, totp: totp(credentials.totpSecret).generate() } });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().data.user.authMethod, "totp");
  assert.equal((client.prepare("SELECT count(*) n FROM schema_migrations").get() as { n: number }).n, 5);
});

test("新空库生成独立安装码和主密钥；重启复用，密钥丢失不恢复默认安装", async t => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `onboarding-bootstrap-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "fresh.db"); new Database(path).close();
  let database = openDatabase(path, { initialize: true }); t.after(() => database.close());
  const settings = readAuthSettings("test", { DATABASE_PATH: path, AUTH_KEY_FILE: resolve(directory, "auth.key") });
  const result = await initializeInstallation(database, settings); assert.equal(result.key.length, 32);
  const text = readFileSync(result.installationCodeFile!, "utf8"); const code = text.split(/\r?\n/).find(line => /^[A-Za-z0-9_-]{43}$/.test(line))!;
  assert.equal(tokenHash(code), readInstallationState(database)!.installation_code_hash);
  database.close(); database = openDatabase(path);
  const repeated = await initializeInstallation(database, settings); assert.deepEqual(repeated.key, result.key); assert.equal(readFileSync(result.installationCodeFile!, "utf8"), text);
  const missingSettings = { ...settings, keyFile: resolve(directory, "not-created.key") };
  await assert.rejects(() => initializeInstallation(database, missingSettings), /不会重新生成/);
  const corruptedSettings = { ...settings, keyFile: resolve(directory, "wrong.key") }; writeFileSync(corruptedSettings.keyFile, randomBytes(32), { flag: "wx" });
  await assert.rejects(() => initializeInstallation(database, corruptedSettings), /不一致/);
});

test("无账号但有遗留审计或配置的库不能被当作全新安装，不生成或覆盖秘密文件", async t => {
  const database = openDatabase(":memory:", { initialize: true }); t.after(() => database.close());
  const path = resolve(WORKSPACE_ROOT, ".local/tests", `onboarding-dirty-${randomUUID()}.db`);
  const settings = readAuthSettings("test", { DATABASE_PATH: path, AUTH_KEY_FILE: `${path}.auth.key` });
  database.client.prepare("INSERT INTO audit_events(id,action,created_at) VALUES(?,?,?)").run(randomUUID(), "preserved-history", new Date().toISOString());
  await assert.rejects(() => initializeInstallation(database, settings), /已有资料/);
  assert.equal(existsSync(settings.keyFile), false); assert.equal(existsSync(`${path}.installation-code.txt`), false);
  assert.equal((database.client.prepare("SELECT count(*) n FROM audit_events").get() as { n: number }).n, 1);
  assert.equal(readInstallationState(database), undefined);
});

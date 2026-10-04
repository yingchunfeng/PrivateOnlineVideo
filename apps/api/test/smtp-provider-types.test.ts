import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import nodemailer from "nodemailer";
import type { EmailChallenge, EmailChangeAuthorization } from "@online-video/shared";
import { ConfigurationError } from "../src/core/config.js";
import { migrateDatabase, migrationManifest, openDatabase } from "../src/db/database.js";
import { encryptSecret } from "../src/modules/auth/crypto.js";
import { enabledEmailProviders, loadMailSender, saveSmtpConfiguration, validateSmtpConfiguration } from "../src/modules/auth/mail.js";
import { accountFixture } from "./helpers/account-email-fixture.js";

const qq = { host: "smtp.qq.com", port: 465, secure: true, user: "isolated-sender@qq.com", password: "fake-qq-authorization", from: "isolated-sender@qq.com", timeoutMs: 15000 };
const netease = { host: "smtp.163.com", port: 465, secure: true, user: "isolated-sender@163.com", password: "fake-163-authorization", from: "isolated-sender@163.com", timeoutMs: 15000 };
const message = { kind: "verification", purpose: "login", challengeId: "isolated", code: "123456", expiresAt: "2026-10-04T11:00:00.000Z" } as const;

test("0005 v4升级保留原SMTP密文与全部旧记录，QQ配置自动复制，多类型/主机/From/TLS受SQL约束", () => {
  const db = new Database(":memory:"); const key = randomBytes(32);
  try {
    db.pragma("foreign_keys=ON"); db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)");
    for (const migration of migrationManifest().slice(0, 4)) {
      db.exec(migration.sql); db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migration.version, migration.checksum, "2026-10-04");
    }
    const cipher = encryptSecret(qq.password, key, "smtp");
    db.prepare('INSERT INTO smtp_config VALUES(1,?,465,1,?,?,?,15000,?)').run(qq.host, qq.user, cipher, qq.from, "2026-10-04");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'schema_migrations' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const snapshot = () => tables.map(name => db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()); const before = snapshot();
    migrateDatabase(db); assert.deepEqual(snapshot(), before);
    const copied = db.prepare("SELECT * FROM smtp_provider_configs").get() as { provider_code: string; password_cipher: string };
    assert.equal(copied.provider_code, "qq"); assert.equal(copied.password_cipher, cipher);
    assert.equal((db.prepare("SELECT count(*) AS n FROM smtp_provider_types").get() as { n: number }).n, 2);
    migrateDatabase(db); assert.equal((db.prepare("SELECT count(*) AS n FROM smtp_provider_configs").get() as { n: number }).n, 1);
    for (const sql of ["UPDATE smtp_provider_types SET smtp_host='127.0.0.1' WHERE code='qq'", "UPDATE smtp_provider_types SET email_domain='qq.com.evil' WHERE code='qq'", "UPDATE smtp_provider_types SET name='' WHERE code='qq'", "UPDATE smtp_provider_configs SET provider_code=NULL", "UPDATE smtp_provider_configs SET host='smtp.163.com' WHERE provider_code='qq'", 'UPDATE smtp_provider_configs SET "from"=\'other@qq.com\'', "UPDATE smtp_provider_configs SET secure=0 WHERE port=465"]) assert.throws(() => db.exec(sql));
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok"); assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});

test("QQ和163独立保存并按收件域名发信，缺配置不跨类型回退，停用即时阻断发送", async t => {
  const db = openDatabase(":memory:", { initialize: true }); t.after(db.close); const key = randomBytes(32);
  const deliveries: { host: unknown; from: unknown; to: unknown }[] = [];
  t.mock.method(nodemailer, "createTransport", (options: Record<string, unknown>) => ({ sendMail: async (mail: Record<string, unknown>) => {
    deliveries.push({ host: options.host, from: mail.from, to: mail.to }); return { accepted: [mail.to], rejected: [] };
  } }));
  saveSmtpConfiguration(db, key, qq); const originalQq = db.client.prepare("SELECT * FROM smtp_provider_configs WHERE provider_code='qq'").get();
  const onlyQq = loadMailSender(db, key);
  await assert.rejects(onlyQq.send({ ...message, to: "owner@163.com" }), { code: "MAIL_NOT_CONFIGURED" }); assert.equal(deliveries.length, 0);
  saveSmtpConfiguration(db, key, netease); assert.deepEqual(db.client.prepare("SELECT * FROM smtp_provider_configs WHERE provider_code='qq'").get(), originalQq);
  assert.equal((db.client.prepare("SELECT count(*) AS n FROM smtp_provider_configs").get() as { n: number }).n, 2);
  const sender = loadMailSender(db, key); await sender.send({ ...message, to: " Owner@QQ.COM " }); await sender.send({ ...message, to: "owner@163.com" });
  await sender.send({ kind: "notification", to: "owner@qq.com", purpose: "email_changed", changedAt: "2026-10-04" });
  assert.deepEqual(deliveries.map(row => row.host), [qq.host, netease.host, qq.host]); assert.deepEqual(deliveries.map(row => row.from), [qq.from, netease.from, qq.from]);
  assert.equal(deliveries[0]!.to, "owner@qq.com");
  for (const to of ["owner@qq.com.evil", "owner@vip.qq.com", "owner@126.com"]) await assert.rejects(sender.send({ ...message, to }), { code: "EMAIL_PROVIDER_UNSUPPORTED" });
  db.client.prepare("UPDATE smtp_provider_types SET enabled=0 WHERE code='163'").run();
  await assert.rejects(sender.send({ ...message, to: "owner@163.com" }), { code: "EMAIL_PROVIDER_UNSUPPORTED" }); assert.equal(deliveries.length, 3);
});

test("配置校验拒绝未知类型、账号与主机错配、其他From及不安全TLS组合；不覆盖现有配置", () => {
  const db = openDatabase(":memory:", { initialize: true }); const key = randomBytes(32);
  try {
    saveSmtpConfiguration(db, key, qq); const before = db.client.prepare("SELECT * FROM smtp_provider_configs").all();
    for (const input of [{ ...qq, host: "127.0.0.1" }, { ...qq, host: "smtp.163.com" }, { ...qq, user: "owner@126.com", from: "owner@126.com" }, { ...qq, from: "another@qq.com" }, { ...qq, providerCode: "163" }, { ...qq, providerCode: "unknown" }, { ...qq, secure: false }, { ...qq, port: 587 }, { ...qq, port: 25, secure: false }]) {
      assert.throws(() => saveSmtpConfiguration(db, key, input), ConfigurationError); assert.deepEqual(db.client.prepare("SELECT * FROM smtp_provider_configs").all(), before);
    }
    assert.equal(validateSmtpConfiguration(netease).providerCode, "163"); assert.equal(validateSmtpConfiguration({ ...qq, port: 587, secure: false }).providerCode, "qq");
  } finally { db.close(); }
});

test("支持类型摘要只返回公开码表；不支持或停用邮箱在绑定前拒绝，不能消费已发挑战完成绑定", async t => {
  const f = await accountFixture(); t.after(f.close); await f.loginTotp(); f.advance(30_001);
  const options = (await f.call("/api/auth/login/options")).json().data;
  assert.deepEqual(options.emailProviders.map((row: { domain: string }) => row.domain), ["qq.com", "163.com"]);
  assert.equal(JSON.stringify(options).includes("smtp.qq.com"), false);
  for (const email of ["owner@qq.com.evil", "owner@vip.qq.com", "owner@126.com", "owner@gmail.com"]) {
    const response = await f.call("/api/auth/email/bind/code", { currentPassword: f.credentials.password, totp: f.token(), email });
    assert.equal(response.json().error.code, "EMAIL_PROVIDER_UNSUPPORTED");
  }
  assert.equal(f.sender.messages.length, 0); assert.equal((f.database.client.prepare("SELECT count(*) AS n FROM email_challenges").get() as { n: number }).n, 0);
  const challenge = await f.ok<EmailChallenge>("/api/auth/email/bind/code", { currentPassword: f.credentials.password, totp: f.token(), email: " Owner@QQ.COM " });
  f.database.client.prepare("UPDATE smtp_provider_types SET enabled=0 WHERE code='qq'").run();
  const failed = await f.call("/api/auth/email/bind/confirm", { currentPassword: f.credentials.password, totp: f.token(), operationId: challenge.operationId, challengeId: challenge.challengeId, code: f.sender.verification(challenge.challengeId).code });
  assert.equal(failed.json().error.code, "EMAIL_PROVIDER_UNSUPPORTED"); assert.equal(f.user().auth_method, "totp");
  assert.equal((f.database.client.prepare("SELECT used_at FROM email_challenges WHERE id=?").get(challenge.challengeId) as { used_at: string | null }).used_at, null);
  assert.deepEqual(enabledEmailProviders(f.database).map(row => row.code), ["163"]);
});

test("QQ改绑163必须双邮箱验证，目标类型停用后确认被拒绝且保留旧绑定与挑战", async t => {
  const f = await accountFixture(); t.after(f.close); await f.loginTotp(); await f.bind(); await f.loginEmail();
  const old = await f.ok<EmailChallenge>("/api/auth/email/change/old/code", { currentPassword: f.credentials.password, newEmail: "new-owner@163.com" });
  const authorization = await f.ok<EmailChangeAuthorization>("/api/auth/email/change/old/verify", { currentPassword: f.credentials.password, operationId: old.operationId, challengeId: old.challengeId, code: f.sender.verification(old.challengeId).code });
  const next = await f.ok<EmailChallenge>("/api/auth/email/change/new/code", { operationId: authorization.operationId });
  assert.equal(f.sender.verification(old.challengeId).to, "owner@qq.com"); assert.equal(f.sender.verification(next.challengeId).to, "new-owner@163.com");
  f.database.client.prepare("UPDATE smtp_provider_types SET enabled=0 WHERE code='163'").run();
  const failed = await f.call("/api/auth/email/change/confirm", { currentPassword: f.credentials.password, operationId: next.operationId, challengeId: next.challengeId, code: f.sender.verification(next.challengeId).code });
  assert.equal(failed.json().error.code, "EMAIL_PROVIDER_UNSUPPORTED"); assert.equal(f.user().email, "owner@qq.com");
  assert.equal((f.database.client.prepare("SELECT used_at FROM email_challenges WHERE id=?").get(next.challengeId) as { used_at: string | null }).used_at, null);
});

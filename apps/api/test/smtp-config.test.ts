import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import nodemailer from "nodemailer";
import { ConfigurationError, readConfig } from "../src/core/config.js";
import { migrateDatabase, migrationManifest, openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { decryptSecret, encryptSecret } from "../src/modules/auth/crypto.js";
import { loadMailSender, saveSmtpConfiguration, ProviderMailSender, validateSmtpConfiguration } from "../src/modules/auth/mail.js";
import { loadRuntimeAuth } from "../src/modules/auth/runtime.js";
import { initializeAccount } from "../src/modules/auth/service.js";

const input = { host: "smtp.qq.com", port: 465, secure: true, user: "isolated-sender@qq.com", password: "isolated-smtp-app-password", from: "isolated-sender@qq.com", timeoutMs: 15000 };
const message = { kind: "verification", to: "owner@qq.com", purpose: "login", challengeId: "isolated", code: "123456", expiresAt: "2026-10-04T11:00:00.000Z" } as const;

test("0004 从v3追加SMTP单条配置表，旧账号与全部旧表数据保留；旧版启动拒绝自动迁移", () => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `smtp-migration-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "v3.db"); const db = new Database(path);
  try {
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)");
    for (const migration of migrationManifest().slice(0, 3)) {
      db.exec(migration.sql); db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migration.version, migration.checksum, "2026-10-04");
    }
    db.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES('owner','原账号','preserved-hash','preserved-cipher','2026-10-04')").run();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const snapshot = () => tables.filter(name => name !== "schema_migrations").map(name => db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
    const before = snapshot(); const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    assert.throws(() => openDatabase(path), /不会自动升级/); migrateDatabase(db);
    assert.deepEqual(snapshot(), before); assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version<=3 ORDER BY version").all(), ledger);
    assert.equal((db.prepare("SELECT count(*) AS n FROM smtp_config").get() as { n: number }).n, 0);
    db.prepare('INSERT INTO smtp_config VALUES(1,?,465,1,?,?,?,15000,?)').run(input.host, input.user, "encrypted", input.from, "2026-10-04");
    assert.throws(() => db.prepare('INSERT INTO smtp_config VALUES(2,?,465,1,?,?,?,15000,?)').run(input.host, input.user, "encrypted", input.from, "2026-10-04"));
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok"); assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});

test("SMTP授权码随机加密持久化，错误密钥/篡改/跨用途密文拒绝读取，未配置仍明确失败", async () => {
  const db = openDatabase(":memory:", { initialize: true }); const key = randomBytes(32);
  try {
    await assert.rejects(loadMailSender(db, key).send(message), { code: "MAIL_NOT_CONFIGURED" });
    saveSmtpConfiguration(db, key, input);
    const first = db.client.prepare("SELECT * FROM smtp_provider_configs").get() as { password_cipher: string };
    assert.equal(JSON.stringify(first).includes(input.password), false);
    assert.equal(decryptSecret(first.password_cipher, key, "smtp"), input.password);
    assert.throws(() => decryptSecret(first.password_cipher, key), ConfigurationError);
    assert.ok(loadMailSender(db, key) instanceof ProviderMailSender);
    saveSmtpConfiguration(db, key, { ...input, port: 587, secure: false });
    const second = db.client.prepare("SELECT * FROM smtp_provider_configs").get() as { password_cipher: string; port: number; secure: number };
    assert.notEqual(second.password_cipher, first.password_cipher); assert.equal(second.port, 587); assert.equal(second.secure, 0);
    assert.equal((db.client.prepare("SELECT count(*) AS n FROM smtp_provider_configs").get() as { n: number }).n, 1);
    assert.throws(() => loadMailSender(db, randomBytes(32)), /数据库 SMTP 配置无法读取或解密/);
    for (const cipher of ["v1.invalid.invalid.invalid", encryptSecret(input.password, key)]) {
      db.client.prepare("UPDATE smtp_provider_configs SET password_cipher=?").run(cipher);
      assert.throws(() => loadMailSender(db, key), /数据库 SMTP 配置无法读取或解密/);
    }
  } finally { db.close(); }
});

test("SMTP字段校验拒绝无效值且不覆盖原配置", () => {
  const db = openDatabase(":memory:", { initialize: true }); const key = randomBytes(32);
  try {
    saveSmtpConfiguration(db, key, input); const before = db.client.prepare("SELECT * FROM smtp_provider_configs").get();
    for (const bad of [null, {}, { ...input, host: "bad host" }, { ...input, port: "465" }, { ...input, port: 0 }, { ...input, secure: "true" }, { ...input, user: "" }, { ...input, password: "" }, { ...input, from: "a\r\nb" }, { ...input, timeoutMs: 60001 }]) {
      assert.throws(() => saveSmtpConfiguration(db, key, bad), ConfigurationError);
      assert.deepEqual(db.client.prepare("SELECT * FROM smtp_provider_configs").get(), before);
    }
    const { timeoutMs: _timeout, ...withoutTimeout } = input; assert.equal(validateSmtpConfiguration(withoutTimeout).timeoutMs, 15000);
  } finally { db.close(); }
});

test("本地配置CLI要求明确apply/目标/匹配密钥；先备份再加密入库，重启runtime从数据库投递", async t => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `smtp-runtime-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "isolated.db"); new Database(path).close();
  const db = openDatabase(path, { initialize: true }); const key = randomBytes(32); await initializeAccount(db, key, "隔离SMTP账号"); db.close();
  const keyFile = resolve(directory, "isolated.key"); const wrongKeyFile = resolve(directory, "wrong.key");
  writeFileSync(keyFile, key, { flag: "wx", mode: 0o600 }); writeFileSync(wrongKeyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "apps/api/scripts/smtp-config.ts", ...args], { cwd: WORKSPACE_ROOT, encoding: "utf8", windowsHide: true, input: JSON.stringify(input) });
    assert.equal((result.stdout + result.stderr).includes(input.password), false); return result;
  };
  const args = ["--database", path, "--input", "-", "--key-file", keyFile];
  assert.equal(run(args).status, 1); assert.equal(run(["--database", path, "--input", "-", "--key-file", wrongKeyFile, "--apply"]).status, 1);
  const result = run([...args, "--apply"]); assert.equal(result.status, 0, result.stderr);
  const backupPath = result.stdout.match(/一致性备份：(.*)/)?.[1]?.trim(); assert.ok(backupPath);
  const backup = new Database(backupPath, { readonly: true });
  try { assert.equal((backup.prepare("SELECT count(*) AS n FROM smtp_provider_configs").get() as { n: number }).n, 0); assert.equal(backup.pragma("integrity_check", { simple: true }), "ok"); } finally { backup.close(); }
  for (const [name, value] of Object.entries({ NODE_ENV: "test", DATABASE_PATH: path, AUTH_KEY_FILE: keyFile, AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:5173", SMTP_CONFIG_FILE: "ignored-old-file.json" })) {
    const previous = process.env[name]; process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const deliveries: Record<string, unknown>[] = []; const transports: Record<string, unknown>[] = [];
  t.mock.method(nodemailer, "createTransport", (options: Record<string, unknown>) => {
    transports.push(options); return { sendMail: async (mail: Record<string, unknown>) => { deliveries.push(mail); return { accepted: [mail.to], rejected: [] }; } };
  });
  for (let restart = 0; restart < 2; restart++) {
    const runtime = await loadRuntimeAuth(readConfig({ NODE_ENV: "test" }));
    try { await runtime.service.mailSender.send(message); } finally { runtime.database.close(); }
  }
  assert.equal(deliveries.length, 2); assert.equal(deliveries[0]!.from, input.from);
  assert.ok(String(deliveries[0]!.text).includes(message.code));
  assert.deepEqual(transports[0]!.auth, { user: input.user, pass: input.password });
  assert.equal(transports[0]!.secure, true); assert.equal(transports[0]!.logger, false);
  const updated = openDatabase(path); try { saveSmtpConfiguration(updated, key, { ...input, port: 587, secure: false }); } finally { updated.close(); }
  const runtime = await loadRuntimeAuth(readConfig({ NODE_ENV: "test" }));
  try { assert.equal(transports[2]!.secure, false); assert.equal(transports[2]!.requireTLS, true); } finally { runtime.database.close(); }
});

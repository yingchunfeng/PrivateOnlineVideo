import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { MailMessage } from "../src/modules/auth/mail.js";
import { WORKSPACE_ROOT, openDatabase } from "../src/db/database.js";
import { readAuthSettings } from "../src/modules/auth/settings.js";
import { initializeInstallation } from "../src/modules/setup/bootstrap.js";
import { buildInstallationApp, readInstallationConfig } from "../src/core/installation-runtime.js";
import { MockStorageAdapter } from "../src/modules/media/storage/mock.js";

test("完整SQL新磁盘库→真实API安装→公共库上传→SMTP测试/邮箱开关→重启保留（云和邮件使用隔离替身）", async () => {
  const directory = await mkdtemp(join(WORKSPACE_ROOT, ".local", "installation-runtime-"));
  const path = join(directory, "new.db");
  const imported = new Database(path);
  try { imported.exec(await readFile(new URL("../../../docs/sql/NEW_INSTALL_FULL.sql", import.meta.url), "utf8")); } finally { imported.close(); }
  const settings = readAuthSettings("test", { DATABASE_PATH: path, AUTH_KEY_FILE: `${path}.auth.key`, AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:5173" });
  let database = openDatabase(path);
  const bootstrap = await initializeInstallation(database, settings);
  const installationCode = (await readFile(bootstrap.installationCodeFile!, "utf8")).trim().split(/\r?\n/).at(-1)!;
  const storage = new MockStorageAdapter("demo-videos/"); const sent: MailMessage[] = []; const testMail: string[] = [];
  const configuration = { storageFactory: async () => storage, mailSenderFactory: () => ({ send: async (message: MailMessage) => { sent.push(message); }, sendTest: async (to: string) => { testMail.push(to); } }) };
  const config = readInstallationConfig({ NODE_ENV: "test", API_PORT: "3000" });
  let runtime = await buildInstallationApp({ database, key: bootstrap.key, settings, config, settingsOptions: configuration, logger: false });
  let cookie = ""; let csrf = "";
  const request = (url: string, method: "GET" | "POST" | "PUT" = "GET", payload?: object) => runtime.app.inject({ method, url,
    headers: { origin: "http://127.0.0.1:5173", cookie, "x-csrf-token": csrf }, ...(payload ? { payload } : {}) });
  const absorb = (response: Awaited<ReturnType<typeof request>>, cookieName: string) => {
    const found = response.cookies.find(value => value.name === cookieName); if (found) cookie = `${cookieName}=${found.value}`;
    const data = response.json().data; if (data?.csrfToken) csrf = data.csrfToken;
  };
  const password = "new-install-password-2026";
  try {
    assert.equal((await request("/api/library")).statusCode, 409);
    assert.equal((await request("/api/auth/login", "POST", { authMethod: "password", password: "adminadmin" })).statusCode, 409);
    const login = await request("/api/setup/login", "POST", { password: "adminadmin", installationCode }); assert.equal(login.statusCode, 200, login.body); absorb(login, "ov_setup");
    assert.equal((await request("/api/installation/settings")).statusCode, 409);
    const changed = await request("/api/setup/password", "POST", { newPassword: password, confirmPassword: password }); assert.equal(changed.statusCode, 200, changed.body); absorb(changed, "ov_setup");
    assert.equal((await request("/api/setup/complete", "POST", {})).statusCode, 409);
    // 模拟上次完成步骤留下的空库配置；更新 OSS 后可安全重试，旧配置另存而非丢弃。
    const initialCategory = database.client.prepare("SELECT id,name FROM categories WHERE is_default=1").get() as { id: string; name: string };
    await writeFile(`${path}.library.json`, JSON.stringify({ mediaBaseUrl: "https://previous.example.com", objectPrefix: "previous/", categories: [{ ...initialCategory, tags: [] }] }), { encoding: "utf8", flag: "wx" });
    const saved = await request("/api/installation/oss", "PUT", { version: 0, accessKeyId: "isolated-access-key-id", accessKeySecret: "isolated-access-key-secret",
      bucket: "isolated-bucket", region: "eu-central-1", network: "public", allowPublicNetwork: true, mediaBaseUrl: "https://media.example.com", objectPrefix: "demo-videos/" });
    assert.equal(saved.statusCode, 200, saved.body); assert.ok(!saved.body.includes("isolated-access-key-secret"));
    assert.equal((await request("/api/installation/oss/test", "POST", { version: 1 })).statusCode, 200);
    const finish = await request("/api/setup/complete", "POST", {}); assert.equal(finish.statusCode, 200, finish.body);
    assert.equal((await readdir(directory)).filter(name => name.includes(".before-setup-")).length, 1);
    cookie = ""; csrf = "";
    const normal = await request("/api/auth/login", "POST", { authMethod: "password", password }); assert.equal(normal.statusCode, 200, normal.body); absorb(normal, "ov_session");
    assert.equal(normal.json().data.user.authMethod, "password");
    const library = await request("/api/library"); assert.equal(library.statusCode, 200, library.body); assert.equal(library.json().data.mediaBaseUrl, "https://media.example.com");
    const category = library.json().data.categories[0]; assert.ok(category.id);
    const upload = await request("/api/uploads", "POST", { fileName: "sample.mp4", sizeBytes: 1024, title: "隔离上传", categoryId: category.id, tags: [], clientRequestId: "isolated-runtime-upload" });
    assert.equal(upload.statusCode, 200, upload.body); assert.ok(upload.json().data.objectKey.startsWith("demo-videos/"));
    const mail = await request("/api/installation/mail", "PUT", { version: 1, providerCode: "qq", host: "smtp.qq.com", port: 465, secure: true,
      user: "example@qq.com", password: "isolated-mail-authorization", from: "example@qq.com" });
    assert.equal(mail.statusCode, 200, mail.body); assert.equal(testMail.length, 0);
    assert.equal((await request("/api/auth/email-verification/code", "POST", { currentPassword: password, enabled: true, email: "example@qq.com" })).statusCode, 409);
    const mailTest = await request("/api/installation/mail/test", "POST", { version: 2, providerCode: "qq", to: "example@qq.com" }); assert.equal(mailTest.statusCode, 200, mailTest.body); assert.equal(mailTest.json().data.delivery, "smtp-accepted");
    const challenge = await request("/api/auth/email-verification/code", "POST", { currentPassword: password, enabled: true, email: "example@qq.com" }); assert.equal(challenge.statusCode, 200, challenge.body);
    const message = sent.at(-1)!; assert.equal(message.kind, "verification"); if (message.kind !== "verification") throw new Error("missing verification");
    const enable = await request("/api/auth/email-verification/confirm", "POST", { currentPassword: password, enabled: true, email: "example@qq.com", challengeId: challenge.json().data.challengeId, code: message.code }); assert.equal(enable.statusCode, 200, enable.body);
    assert.equal((await request("/api/auth/me")).statusCode, 401);
    await runtime.app.close(); database.close(); database = openDatabase(path);
    const restored = await initializeInstallation(database, settings); assert.equal(restored.installationCodeFile, null);
    runtime = await buildInstallationApp({ database, key: restored.key, settings, config: readInstallationConfig({ NODE_ENV: "test" }), settingsOptions: configuration, logger: false });
    assert.equal((await request("/api/setup/status")).json().data.stage, "ready");
    assert.equal((await request("/api/auth/login/options")).json().data.authMethod, "email");
    assert.equal((await request("/api/setup/login", "POST", { password: "adminadmin", installationCode })).statusCode, 409);
    assert.equal(database.client.pragma("integrity_check", { simple: true }), "ok"); assert.deepEqual(database.client.pragma("foreign_key_check"), []);
    assert.equal((database.client.prepare("SELECT count(*) n FROM upload_tasks").get() as { n: number }).n, 1);
  } finally { await runtime.app.close(); if (database.client.open) database.close(); }
});

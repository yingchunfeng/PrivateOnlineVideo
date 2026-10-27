import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import OSS from "ali-oss";
import type { SaveOssSettingsRequest, SaveSmtpSettingsRequest } from "@online-video/shared";
import { openDatabase } from "../src/db/database.js";
import { HttpError, registerErrorHandlers } from "../src/core/errors.js";
import { validateLibraryConfig } from "../src/core/library-config.js";
import { decryptSecret } from "../src/modules/auth/crypto.js";
import { saveSmtpConfiguration } from "../src/modules/auth/mail.js";
import type { MailMessage, SmtpConfiguration } from "../src/modules/auth/mail.js";
import { InstallationSettingsService } from "../src/modules/installation-settings/service.js";
import { registerInstallationSettingsModule } from "../src/modules/installation-settings/routes.js";
import { MockStorageAdapter } from "../src/modules/media/storage/mock.js";
import { validateOssOptions } from "../src/modules/media/storage/oss.js";

const ossInput: SaveOssSettingsRequest = { version: 0, accessKeyId: "test-access-key-id", accessKeySecret: "test-access-key-secret",
  bucket: "isolated-video-bucket", region: "cn-beijing", network: "public", allowPublicNetwork: true,
  mediaBaseUrl: "https://media.example.com", objectPrefix: "videos/" };
const mailInput: SaveSmtpSettingsRequest = { version: 0, providerCode: "qq", host: "smtp.qq.com", port: 465,
  secure: true, user: "sender@qq.com", password: "test-mail-authorization", from: "sender@qq.com" };
function fixture() {
  const database = openDatabase(":memory:", { initialize: true }); const key = randomBytes(32);
  let at = Date.parse("2026-10-26T12:00:00.000Z"); let ready = false; let failMail = false; let failStorage = false;
  const deliveries: { configuration: SmtpConfiguration; to: string; test: boolean }[] = [];
  const lists: { prefix: string; limit: number; key: string }[] = [];
  const service = new InstallationSettingsService(database, key, { now: () => new Date(at), isReady: () => ready,
    mailSenderFactory: configuration => ({ async send(message: MailMessage) {
      if (failMail) throw new Error("sensitive provider failure"); deliveries.push({ configuration, to: message.to, test: false });
    }, async sendTest(to: string) {
      if (failMail) throw new Error("sensitive provider failure"); deliveries.push({ configuration, to, test: true });
    } }), storageFactory: async settings => {
      const storage = new MockStorageAdapter(settings.objectPrefix);
      storage.list = async input => { if (failStorage) throw new Error("secret signed URL"); lists.push({ prefix: input.prefix, limit: input.limit, key: settings.accessKeyId }); return { items: [], nextCursor: null }; };
      return storage;
    } });
  return { database, key, service, deliveries, lists, advance: (ms = 60_001) => { at += ms; }, markReady: () => { ready = true; },
    failMail: (value: boolean) => { failMail = value; }, failStorage: (value: boolean) => { failStorage = value; } };
}

test("网页OSS配置加密保存、返回脱敏字段、版本冲突和非法地址不写入", t => {
  const f = fixture(); t.after(f.database.close);
  assert.deepEqual(f.service.getSummary(), { version: 0, oss: null, mail: [], ossTest: null });
  const saved = f.service.saveOss(ossInput); assert.equal(saved.version, 1);
  assert.equal(saved.oss?.region, "cn-beijing"); assert.equal(saved.oss?.endpoint, "https://oss-cn-beijing.aliyuncs.com");
  assert.equal(saved.oss?.credentialMode, "direct");
  const output = JSON.stringify(saved); assert.equal(output.includes(ossInput.accessKeySecret!), false); assert.equal(output.includes(ossInput.accessKeyId!), false);
  const row = f.database.client.prepare("SELECT payload_cipher FROM installation_settings").get() as { payload_cipher: string };
  assert.equal(row.payload_cipher.includes(ossInput.accessKeySecret!), false);
  assert.equal(JSON.parse(decryptSecret(row.payload_cipher, f.key, "installation")).oss.accessKeySecret, ossInput.accessKeySecret);
  assert.throws(() => decryptSecret(row.payload_cipher, f.key, "smtp"));
  assert.throws(() => f.service.saveOss(ossInput), { code: "CONFIG_VERSION_CONFLICT" });
  for (const change of [{ mediaBaseUrl: "http://media.example.com" }, { mediaBaseUrl: "https://127.0.0.1" },
    { mediaBaseUrl: "https://media.example.com/private" }, { region: "cn-beijing.evil.example" }, { objectPrefix: "../videos/" },
    { objectPrefix: "videos/*/" }, { allowPublicNetwork: false }, { roleArn: "not-a-role" }, { accessKeyId: "changed-id", accessKeySecret: "" }]) {
    assert.throws(() => f.service.saveOss({ ...ossInput, version: 1, ...change }), { code: "VALIDATION_ERROR" });
    assert.equal(f.service.getSummary().version, 1);
  }
  assert.equal(f.lists.length, 0); assert.equal(f.deliveries.length, 0);
});

test("保存凭据后热读取，ready禁止改变旧对象定位，秘密留空保持原值", async t => {
  const f = fixture(); t.after(f.database.close); f.service.saveOss(ossInput);
  const adapter = f.service.createStorage(); const signal = new AbortController().signal;
  await adapter.list({ prefix: "videos/", limit: 1, signal });
  f.markReady(); const next = f.service.saveOss({ ...ossInput, version: 1, accessKeyId: "replacement-key-id", accessKeySecret: "replacement-secret" });
  assert.equal(next.version, 2); await adapter.list({ prefix: "videos/", limit: 1, signal });
  assert.deepEqual(f.lists.map(value => value.key), [ossInput.accessKeyId, "replacement-key-id"]);
  f.service.saveOss({ ...ossInput, version: 2, accessKeyId: "", accessKeySecret: "" });
  assert.equal(f.service.readOssSettings()?.accessKeySecret, "replacement-secret");
  for (const change of [{ bucket: "another-bucket" }, { region: "cn-hangzhou" }, { objectPrefix: "other/" }, { mediaBaseUrl: "https://other.example.com" }]) {
    assert.throws(() => f.service.saveOss({ ...ossInput, version: 3, ...change }), { code: "CONFIG_IMPACT_CONFIRMATION_REQUIRED" });
  }
});

test("OSS测试明确只列前缀，限流、失败和配置变更不冒报可上传", async t => {
  const f = fixture(); t.after(f.database.close); f.service.saveOss(ossInput);
  assert.equal(f.service.hasTestedOss(), false);
  const result = await f.service.testOss(1, "owner");
  assert.equal(result.scope, "list-prefix"); assert.equal(result.writePermissionVerified, false);
  assert.deepEqual(f.lists.map(({ prefix, limit }) => ({ prefix, limit })), [{ prefix: "videos/", limit: 1 }]);
  assert.equal(f.service.hasTestedOss(), true);
  await assert.rejects(f.service.testOss(1, "owner"), { code: "RATE_LIMITED" });
  f.advance(); f.failStorage(true); await assert.rejects(f.service.testOss(1, "owner"), { code: "STORAGE_UNAVAILABLE" });
  assert.equal(f.service.hasTestedOss(), false);
  f.service.saveOss({ ...ossInput, version: 1 }); assert.equal(f.service.hasTestedOss(), false);
});

test("SMTP保存不发信，测试只确认SMTP接受，动态配置和测试状态按版本生效", async t => {
  const f = fixture(); t.after(f.database.close);
  const sender = f.service.createMailSender();
  const message = { kind: "verification", to: "owner@qq.com", purpose: "login", challengeId: "challenge", code: "123456", expiresAt: "2026-10-26" } as const;
  await assert.rejects(sender.send(message), { code: "MAIL_NOT_CONFIGURED" });
  const saved = f.service.saveMail(mailInput); assert.equal(saved.version, 1); assert.equal(saved.mail[0]?.testedAt, null);
  assert.equal(JSON.stringify(saved).includes(mailInput.password!), false); assert.equal(f.deliveries.length, 0);
  const accepted = await f.service.testMail({ version: 1, providerCode: "qq", to: " Owner@QQ.COM " }, "owner");
  assert.equal(accepted.accepted, true); assert.equal(accepted.delivery, "smtp-accepted"); assert.equal(accepted.toMasked, "o***@qq.com");
  assert.equal(f.deliveries[0]?.test, true); assert.equal(f.service.hasTestedMail("owner@qq.com"), true);
  await assert.rejects(f.service.testMail({ version: 1, providerCode: "qq", to: "owner@qq.com" }, "owner"), { code: "RATE_LIMITED" });
  f.service.saveMail({ ...mailInput, version: 1, password: "new-authorization" });
  assert.equal(f.service.hasTestedMail("owner@qq.com"), false);
  await sender.send(message); assert.equal(f.deliveries.at(-1)?.configuration.password, "new-authorization");
  f.service.saveMail({ ...mailInput, version: 2, password: "" }); await sender.send(message);
  assert.equal(f.deliveries.at(-1)?.configuration.password, "new-authorization");
  f.advance(); f.failMail(true);
  await assert.rejects(f.service.testMail({ version: 3, providerCode: "qq", to: "owner@qq.com" }, "owner"), { code: "MAIL_SEND_FAILED" });
  assert.equal(f.service.hasTestedMail("owner@qq.com"), false);
  assert.throws(() => f.service.saveMail({ ...mailInput, version: 3, host: "127.0.0.1" }), { code: "VALIDATION_ERROR" });
  assert.equal(f.service.getSummary().version, 3);
});

test("异步SMTP结果不覆盖并发保存的新配置，重建service仍有配置但没有旧测试通行状态", async t => {
  const f = fixture(); t.after(f.database.close);
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const service = new InstallationSettingsService(f.database, f.key, { isReady: () => false,
    mailSenderFactory: () => ({ async send() {}, async sendTest() { await pending; } }) });
  service.saveMail(mailInput); const sending = service.testMail({ version: 1, providerCode: "qq", to: "owner@qq.com" }, "owner");
  service.saveMail({ ...mailInput, version: 1, password: "changed-during-send" }); release();
  await assert.rejects(sending, { code: "CONFIG_VERSION_CONFLICT" });
  const reopened = new InstallationSettingsService(f.database, f.key, { isReady: () => false });
  assert.equal(reopened.getSummary().version, 2); assert.equal(reopened.hasTestedMail("owner@qq.com"), false);
});

test("SMTP总超时不标记成功，晚到结果不覆盖状态；已有CLI配置也可首次测试", async t => {
  const f = fixture(); t.after(f.database.close);
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const service = new InstallationSettingsService(f.database, f.key, { isReady: () => false,
    mailSenderFactory: () => ({ async send() {}, async sendTest() { await pending; } }) });
  service.saveMail({ ...mailInput, timeoutMs: 5 });
  await assert.rejects(service.testMail({ version: 1, providerCode: "qq", to: "owner@qq.com" }, "owner"), { code: "MAIL_SEND_FAILED" });
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(service.hasTestedMail("owner@qq.com"), false);
  const other = fixture(); t.after(other.database.close);
  saveSmtpConfiguration(other.database, other.key, mailInput);
  assert.equal(other.service.getSummary().version, 0);
  await other.service.testMail({ version: 0, providerCode: "qq", to: "owner@qq.com" }, "owner");
  assert.equal(other.service.getSummary().version, 1); assert.equal(other.service.hasTestedMail("owner@qq.com"), true);
});

test("OSS测试完成前配置变更使旧结果失效，不覆盖新配置或标记通过", async t => {
  const f = fixture(); t.after(f.database.close);
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const service = new InstallationSettingsService(f.database, f.key, { isReady: () => false, storageFactory: async settings => {
    const storage = new MockStorageAdapter(settings.objectPrefix);
    storage.list = async () => { await pending; return { items: [], nextCursor: null }; }; return storage;
  } });
  service.saveOss(ossInput); const checking = service.testOss(1, "owner");
  service.saveOss({ ...ossInput, version: 1, accessKeySecret: "new-key-after-test-start" }); release();
  await assert.rejects(checking, { code: "CONFIG_VERSION_CONFLICT" });
  assert.equal(service.hasTestedOss(), false); assert.equal(service.getSummary().version, 2);
});

test("ARN确实调用AssumeRole并按用途缩权，失败不回退长期AK", async t => {
  const f = fixture(); t.after(f.database.close);
  let fail = false; const roleCalls: unknown[][] = []; let lists = 0;
  t.mock.method(OSS.STS.prototype, "assumeRole", async (...args: unknown[]) => {
    roleCalls.push(args); if (fail) throw new Error("raw AK/STS provider detail");
    return { credentials: { AccessKeyId: "sts-key", AccessKeySecret: "sts-secret", SecurityToken: "sts-token", Expiration: new Date(Date.now() + 3600_000).toISOString() } };
  });
  t.mock.method(OSS.prototype, "listV2", async () => { lists++; return { objects: [], isTruncated: false, res: { headers: {} } }; });
  const service = new InstallationSettingsService(f.database, f.key, { isReady: () => false });
  service.saveOss({ ...ossInput, roleArn: "acs:ram::123456789:role/video-upload" });
  await service.createStorage().list({ prefix: "videos/", limit: 1, signal: new AbortController().signal });
  assert.equal(roleCalls.length, 1); assert.equal(roleCalls[0]?.[0], "acs:ram::123456789:role/video-upload");
  assert.match(String(roleCalls[0]?.[1]), /oss:ListObjects/); assert.equal(lists, 1);
  service.saveOss({ ...ossInput, version: 1, roleArn: "acs:ram::123456789:role/other-role" }); fail = true;
  await assert.rejects(service.createStorage().list({ prefix: "videos/", limit: 1, signal: new AbortController().signal }), { code: "STORAGE_UNAVAILABLE" });
  assert.equal(lists, 1);
});

test("配置HTTP入口要求鉴权及修改授权，错误和摘要不泄露凭据", async t => {
  const f = fixture(); t.after(f.database.close); const app = Fastify({ logger: false }); t.after(() => app.close()); registerErrorHandlers(app);
  registerInstallationSettingsModule(app, f.service, async (request, mutation) => {
    if (request.headers.authorization !== "isolated-owner") throw new HttpError("AUTH_REQUIRED");
    if (mutation && request.headers["x-csrf-token"] !== "isolated-csrf") throw new HttpError("CSRF_REJECTED");
    return { ownerId: "owner", setup: true };
  });
  assert.equal((await app.inject({ method: "GET", url: "/api/installation/settings" })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url: "/api/installation/oss", headers: { authorization: "isolated-owner" }, payload: ossInput })).statusCode, 403);
  const response = await app.inject({ method: "PUT", url: "/api/installation/oss", headers: { authorization: "isolated-owner", "x-csrf-token": "isolated-csrf" }, payload: ossInput });
  assert.equal(response.statusCode, 200); assert.equal(response.body.includes(ossInput.accessKeySecret!), false);
  assert.equal(response.body.includes(ossInput.accessKeyId!), false);
});

test("公开媒体域名和地域可配置，但端点固定为对应阿里云域名", () => {
  const config = validateLibraryConfig({ mediaBaseUrl: "https://cdn.example.com", objectPrefix: "my-videos/", categories: [] });
  assert.equal(config.mediaBaseUrl, "https://cdn.example.com");
  validateOssOptions({ bucket: "test-bucket", region: "ap-southeast-1", endpoint: "https://oss-ap-southeast-1.aliyuncs.com", objectPrefix: "videos/", network: "public", allowPublicNetwork: true });
  assert.throws(() => validateOssOptions({ bucket: "test-bucket", region: "ap-southeast-1", endpoint: "https://127.0.0.1", objectPrefix: "videos/", network: "public", allowPublicNetwork: true }));
});

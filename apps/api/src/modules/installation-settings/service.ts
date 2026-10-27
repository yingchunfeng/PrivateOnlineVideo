import { createHash } from "node:crypto";
import type { EmailProviderCode, InstallationSettingsSummary, SaveOssSettingsRequest, SaveSmtpSettingsRequest,
  TestMailSettingsRequest, TestMailSettingsResult, TestOssSettingsResult } from "@online-video/shared";
import { normalizeEmailAddress } from "@online-video/shared";
import type { AppDatabase } from "../../db/database.js";
import type { StorageAdapter } from "../../core/contracts/storage.js";
import { HttpError } from "../../core/errors.js";
import { validateLibraryAddress } from "../../core/library-config.js";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import { createDynamicMailSender, requireSupportedEmailProvider, saveSmtpConfiguration, SmtpMailSender, validateSmtpConfiguration } from "../auth/mail.js";
import type { MailSender, SmtpConfiguration } from "../auth/mail.js";
import { OssStorageAdapter, validateOssOptions } from "../media/storage/oss.js";
import type { OssClient } from "../media/storage/oss.js";
import { StsCredentialCache } from "../media/storage/sts.js";
import { storageDiagnostic } from "../media/storage/diagnostics.js";

/** 服务端内部类型；完整凭据不得由任何路由直接返回。 */
export interface StoredOssSettings {
  accessKeyId: string; accessKeySecret: string; bucket: string; region: string; endpoint: string;
  network: "public" | "internal"; allowPublicNetwork: boolean; mediaBaseUrl: string; objectPrefix: string; roleArn?: string;
}
interface ConfigurationTest { fingerprint: string; checkedAt: string }
interface SettingsPayload { schemaVersion: 1; oss?: StoredOssSettings; ossTest?: ConfigurationTest; mailTests: Partial<Record<EmailProviderCode, ConfigurationTest>> }
interface SettingsRow { payload_cipher: string; version: number }
interface SmtpRow { provider_code: EmailProviderCode; host: string; port: number; secure: number; user: string;
  password_cipher: string; from: string; timeout_ms: number; updated_at: string }
interface TestMailer extends MailSender { sendTest(to: string): Promise<void> }
interface SettingsOptions {
  now?: () => Date;
  isReady?: () => boolean;
  storageFactory?: (settings: StoredOssSettings) => Promise<StorageAdapter>;
  mailSenderFactory?: (configuration: SmtpConfiguration) => TestMailer;
}
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mask = (value: string) => value.length < 9 ? "***" : `${value.slice(0, 4)}***${value.slice(-4)}`;
const maskedEmail = (value: string) => `${value.slice(0, 1)}***@${value.split("@")[1]}`;

function validatedOss(input: SaveOssSettingsRequest, previous?: StoredOssSettings): StoredOssSettings {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["version", "accessKeyId", "accessKeySecret", "bucket", "region", "network", "allowPublicNetwork", "mediaBaseUrl", "objectPrefix", "roleArn"].includes(key))) throw new Error();
    for (const key of ["accessKeyId", "accessKeySecret", "roleArn"] as const) if (input[key] !== undefined && typeof input[key] !== "string") throw new Error();
    const accessKeyId = input.accessKeyId || previous?.accessKeyId;
    const accessKeySecret = input.accessKeySecret || previous?.accessKeySecret;
    if (!accessKeyId || !accessKeySecret || accessKeyId.length > 512 || accessKeySecret.length > 2048 ||
      /[\s*\x00-\x1f\x7f]/.test(accessKeyId + accessKeySecret) ||
      (input.accessKeyId && previous && input.accessKeyId !== previous.accessKeyId && !input.accessKeySecret)) throw new Error();
    const address = validateLibraryAddress(input.mediaBaseUrl, input.objectPrefix);
    if (typeof input.region !== "string" || typeof input.bucket !== "string" || typeof input.allowPublicNetwork !== "boolean") throw new Error();
    const endpoint = `https://oss-${input.region}${input.network === "internal" ? "-internal" : ""}.aliyuncs.com`;
    const roleArn = input.roleArn || undefined;
    if (roleArn && (roleArn.length > 2048 || !/^acs:ram::\d+:role\/[A-Za-z0-9_./-]+$/.test(roleArn))) throw new Error();
    const result: StoredOssSettings = { accessKeyId, accessKeySecret, bucket: input.bucket, region: input.region, endpoint,
      network: input.network, allowPublicNetwork: input.allowPublicNetwork, ...address, ...(roleArn ? { roleArn } : {}) };
    validateOssOptions(result);
    return result;
  } catch { throw new HttpError("VALIDATION_ERROR"); }
}

async function defaultStorageFactory(settings: StoredOssSettings): Promise<StorageAdapter> {
  const { default: OSS } = await import("ali-oss");
  const options = { ...settings, publicUploads: true, diagnosticErrors: true };
  const { accessKeyId, accessKeySecret } = settings;
  if (!settings.roleArn) return new OssStorageAdapter(options, input => new OSS(input) as unknown as OssClient, async (_purpose, signal) => {
    signal.throwIfAborted(); return { accessKeyId, accessKeySecret };
  });
  const sts = new OSS.STS({ accessKeyId, accessKeySecret });
  const credentials = new StsCredentialCache({ roleArn: settings.roleArn, bucket: settings.bucket, objectPrefix: settings.objectPrefix,
    durationSeconds: 3600, refreshBeforeSeconds: 300, diagnosticErrors: true }, async request =>
    (await sts.assumeRole(request.roleArn, request.policy, request.durationSeconds, request.sessionName, { timeout: 15_000, ctx: undefined })).credentials);
  // AssumeRole 失败必须失败，不回退为长期 AK 访问。
  return new OssStorageAdapter(options, input => new OSS(input) as unknown as OssClient, (purpose, signal) => credentials.get({ purpose, signal }));
}

export class InstallationSettingsService {
  private readonly now: () => Date;
  private readonly storageFactory: (settings: StoredOssSettings) => Promise<StorageAdapter>;
  private readonly mailSenderFactory: (configuration: SmtpConfiguration) => TestMailer;
  private cachedStorage: { fingerprint: string; value: Promise<StorageAdapter> } | undefined;
  constructor(readonly database: AppDatabase, private readonly key: Buffer, private readonly options: SettingsOptions = {}) {
    if (key.length !== 32) throw new Error("invalid installation key");
    this.now = options.now ?? (() => new Date()); this.storageFactory = options.storageFactory ?? defaultStorageFactory;
    this.mailSenderFactory = options.mailSenderFactory ?? (configuration => new SmtpMailSender(configuration));
  }
  private available() { return !!this.database.client.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='installation_settings'").get(); }
  private read(): { version: number; payload: SettingsPayload } {
    if (!this.available()) return { version: 0, payload: { schemaVersion: 1, mailTests: {} } };
    const row = this.database.client.prepare("SELECT payload_cipher,version FROM installation_settings WHERE id=1").get() as SettingsRow | undefined;
    if (!row) return { version: 0, payload: { schemaVersion: 1, mailTests: {} } };
    try {
      const payload = JSON.parse(decryptSecret(row.payload_cipher, this.key, "installation")) as SettingsPayload;
      if (payload.schemaVersion !== 1 || !payload.mailTests || typeof payload.mailTests !== "object" || Array.isArray(payload.mailTests)) throw new Error();
      if (payload.oss) {
        const { endpoint: _endpoint, ...input } = payload.oss;
        payload.oss = validatedOss({ ...input, version: row.version });
      }
      return { version: row.version, payload };
    } catch { throw new HttpError("CONFIG_RECOVERY_REQUIRED"); }
  }
  private write(payload: SettingsPayload, version: number) {
    const cipher = encryptSecret(JSON.stringify(payload), this.key, "installation");
    this.database.client.prepare("INSERT INTO installation_settings(id,payload_cipher,version,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_cipher=excluded.payload_cipher,version=excluded.version,updated_at=excluded.updated_at")
      .run(cipher, version, this.now().toISOString());
  }
  private update(expectedVersion: number, change: (payload: SettingsPayload) => void, increment = true) {
    if (!this.available()) throw new HttpError("SERVICE_NOT_CONFIGURED");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new HttpError("VALIDATION_ERROR");
    try {
      this.database.client.transaction(() => {
        const current = this.read(); if (current.version !== expectedVersion) throw new HttpError("CONFIG_VERSION_CONFLICT");
        change(current.payload); this.write(current.payload, Math.max(1, current.version + (increment ? 1 : 0)));
      }).immediate();
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError("CONFIG_SAVE_FAILED"); }
  }
  private smtpRow(code: EmailProviderCode): SmtpRow | undefined {
    return this.database.client.prepare('SELECT provider_code,host,port,secure,user,password_cipher,"from",timeout_ms,updated_at FROM smtp_provider_configs WHERE provider_code=?').get(code) as SmtpRow | undefined;
  }
  private smtpConfiguration(row: SmtpRow): SmtpConfiguration {
    try { return validateSmtpConfiguration({ providerCode: row.provider_code, host: row.host, port: row.port, secure: row.secure === 1,
      user: row.user, password: decryptSecret(row.password_cipher, this.key, "smtp"), from: row.from, timeoutMs: row.timeout_ms }); }
    catch { throw new HttpError("MAIL_NOT_CONFIGURED"); }
  }
  private ready() {
    if (this.options.isReady) return this.options.isReady();
    if (!this.available()) return true;
    const row = this.database.client.prepare("SELECT stage FROM installation_state WHERE id=1").get() as { stage: string } | undefined;
    return !row || row.stage === "ready";
  }
  private reserveTest(kind: "mail" | "oss", ownerId: string) {
    const at = this.now().getTime();
    for (const [window, max, suffix] of [[60_000, 1, "minute"], [3_600_000, 10, "hour"]] as const) {
      const id = `installation-test:${kind}:${fingerprint(ownerId)}:${suffix}`;
      const row = this.database.client.prepare("SELECT window_start,failures FROM login_attempts WHERE key=?").get(id) as { window_start: number; failures: number } | undefined;
      const count = row && at - row.window_start < window ? row.failures : 0;
      if (count >= max) throw new HttpError("RATE_LIMITED");
      this.database.client.prepare("INSERT INTO login_attempts(key,window_start,failures) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,failures=excluded.failures")
        .run(id, count ? row!.window_start : at, count + 1);
    }
  }
  getSummary(): InstallationSettingsSummary {
    const { version, payload } = this.read(); const oss = payload.oss;
    const rows = this.database.client.prepare('SELECT provider_code,host,port,secure,user,password_cipher,"from",timeout_ms,updated_at FROM smtp_provider_configs ORDER BY provider_code').all() as SmtpRow[];
    return { version, oss: oss ? { accessKeyIdMasked: mask(oss.accessKeyId), secretConfigured: true, bucket: oss.bucket, region: oss.region,
      endpoint: oss.endpoint, network: oss.network, allowPublicNetwork: oss.allowPublicNetwork, mediaBaseUrl: oss.mediaBaseUrl, objectPrefix: oss.objectPrefix,
      ...(oss.roleArn ? { roleArn: oss.roleArn } : {}), credentialMode: oss.roleArn ? "role" : "direct" } : null,
      mail: rows.map(row => ({ providerCode: row.provider_code, host: row.host, port: row.port, secure: row.secure === 1, user: row.user,
        from: row.from, timeoutMs: row.timeout_ms, passwordConfigured: !!row.password_cipher,
        testedAt: payload.mailTests[row.provider_code]?.fingerprint === fingerprint(row) ? payload.mailTests[row.provider_code]!.checkedAt : null })),
      ossTest: oss && payload.ossTest?.fingerprint === fingerprint(oss) ? { checkedAt: payload.ossTest.checkedAt, scope: "list-prefix" } : null };
  }
  readOssSettings(): StoredOssSettings | null { return this.read().payload.oss ?? null; }
  hasTestedOss(): boolean { return this.getSummary().ossTest !== null; }
  hasTestedMail(email: string): boolean {
    try {
      const provider = requireSupportedEmailProvider(this.database, email); const row = this.smtpRow(provider.code);
      return !!row && this.read().payload.mailTests[provider.code]?.fingerprint === fingerprint(row);
    } catch { return false; }
  }
  saveOss(input: SaveOssSettingsRequest): InstallationSettingsSummary {
    this.update(input.version, payload => {
      const next = validatedOss(input, payload.oss);
      if (this.ready() && (!payload.oss || ["bucket", "region", "objectPrefix", "mediaBaseUrl"].some(key =>
        next[key as keyof StoredOssSettings] !== payload.oss![key as keyof StoredOssSettings]))) throw new HttpError("CONFIG_IMPACT_CONFIRMATION_REQUIRED");
      payload.oss = next; delete payload.ossTest;
    });
    return this.getSummary();
  }
  saveMail(input: SaveSmtpSettingsRequest): InstallationSettingsSummary {
    this.update(input.version, payload => {
      if (!input || Object.keys(input).some(key => !["version", "providerCode", "host", "port", "secure", "user", "password", "from", "timeoutMs"].includes(key)) ||
        !["qq", "163"].includes(input.providerCode) || (input.password !== undefined && typeof input.password !== "string")) throw new HttpError("VALIDATION_ERROR");
      const old = this.smtpRow(input.providerCode);
      let configuration: SmtpConfiguration;
      try { configuration = validateSmtpConfiguration({ ...input, password: input.password || (old ? decryptSecret(old.password_cipher, this.key, "smtp") : "") }); }
      catch { throw new HttpError("VALIDATION_ERROR"); }
      saveSmtpConfiguration(this.database, this.key, configuration); delete payload.mailTests[input.providerCode];
    });
    return this.getSummary();
  }
  private async storage(): Promise<StorageAdapter> {
    const settings = this.readOssSettings(); if (!settings) throw new HttpError("SERVICE_NOT_CONFIGURED");
    const key = fingerprint(settings);
    if (!this.cachedStorage || this.cachedStorage.fingerprint !== key) {
      const value = this.storageFactory(settings).catch(() => { if (this.cachedStorage?.fingerprint === key) this.cachedStorage = undefined; throw new HttpError("STORAGE_UNAVAILABLE"); });
      this.cachedStorage = { fingerprint: key, value };
    }
    return this.cachedStorage.value;
  }
  /** 稳定委托对象：每次操作核对当前凭据版本；已有流不被其他操作取消。 */
  createStorage(): StorageAdapter {
    return { driver: "oss", head: async input => (await this.storage()).head(input), openRead: async input => (await this.storage()).openRead(input),
      createMultipart: async input => (await this.storage()).createMultipart(input), uploadPart: async input => (await this.storage()).uploadPart(input),
      completeMultipart: async input => (await this.storage()).completeMultipart(input), list: async input => (await this.storage()).list(input),
      putImage: async input => { const storage = await this.storage(); if (!storage.putImage) throw new HttpError("SERVICE_NOT_CONFIGURED"); return storage.putImage(input); } };
  }
  createMailSender(): MailSender { return createDynamicMailSender(this.database, this.key, this.mailSenderFactory); }
  async testOss(version: number, ownerId: string): Promise<TestOssSettingsResult> {
    let selected: StoredOssSettings | undefined;
    this.update(version, payload => {
      if (!payload.oss) throw new HttpError("SERVICE_NOT_CONFIGURED");
      this.reserveTest("oss", ownerId); selected = payload.oss; delete payload.ossTest;
    }, false);
    try {
      const adapter = await this.storageFactory(selected!);
      await adapter.list({ prefix: selected!.objectPrefix, limit: 1, signal: AbortSignal.timeout(20_000) });
    } catch (error) { throw storageDiagnostic(error, "oss", "list"); }
    const checkedAt = this.now().toISOString();
    this.update(version, payload => { if (fingerprint(payload.oss) !== fingerprint(selected)) throw new HttpError("CONFIG_VERSION_CONFLICT");
      payload.ossTest = { checkedAt, fingerprint: fingerprint(selected) }; }, false);
    return { checkedAt, scope: "list-prefix", writePermissionVerified: false };
  }
  async testMail(input: TestMailSettingsRequest, ownerId: string): Promise<TestMailSettingsResult> {
    const to = normalizeEmailAddress(input.to); if (!to) throw new HttpError("VALIDATION_ERROR");
    const provider = requireSupportedEmailProvider(this.database, to); if (provider.code !== input.providerCode) throw new HttpError("VALIDATION_ERROR");
    let selected: SmtpRow | undefined;
    this.update(input.version, payload => {
      selected = this.smtpRow(input.providerCode); if (!selected) throw new HttpError("MAIL_NOT_CONFIGURED");
      this.reserveTest("mail", ownerId); delete payload.mailTests[input.providerCode];
    }, false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const configuration = this.smtpConfiguration(selected!);
      await Promise.race([this.mailSenderFactory(configuration).sendTest(to), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HttpError("MAIL_SEND_FAILED")), configuration.timeoutMs ?? 15_000);
      })]);
    } catch { throw new HttpError("MAIL_SEND_FAILED"); }
    finally { if (timer) clearTimeout(timer); }
    const testedAt = this.now().toISOString();
    this.update(Math.max(1, input.version), payload => {
      if (fingerprint(this.smtpRow(input.providerCode)) !== fingerprint(selected)) throw new HttpError("CONFIG_VERSION_CONFLICT");
      payload.mailTests[input.providerCode] = { checkedAt: testedAt, fingerprint: fingerprint(selected) };
    }, false);
    return { accepted: true, testedAt, toMasked: maskedEmail(to), delivery: "smtp-accepted" };
  }
}

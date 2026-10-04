import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { findEmailProvider, normalizeEmailAddress } from "@online-video/shared";
import type { EmailChallengePurpose, EmailProviderCode, EmailProviderType } from "@online-video/shared";
import { ConfigurationError } from "../../core/config.js";
import { HttpError } from "../../core/errors.js";
import type { AppDatabase } from "../../db/database.js";
import { smtpProviderConfigs, smtpProviderTypes } from "../../db/schema.js";
import { decryptSecret, encryptSecret } from "./crypto.js";

export type MailMessage =
  | { kind: "verification"; to: string; purpose: EmailChallengePurpose; challengeId: string; code: string; expiresAt: string }
  | { kind: "notification"; to: string; purpose: "password_changed" | "email_changed"; changedAt: string };
export interface MailSender { send(message: MailMessage): Promise<void> }
export class UnconfiguredMailSender implements MailSender {
  async send(_message: MailMessage): Promise<void> { throw new HttpError("MAIL_NOT_CONFIGURED"); }
}
export interface SmtpConfiguration { providerCode: EmailProviderCode; host: string; port: number; secure: boolean; user: string; password: string; from: string; timeoutMs?: number }
const hosts: Record<EmailProviderCode, string> = { qq: "smtp.qq.com", "163": "smtp.163.com" };

export function enabledEmailProviders(database: AppDatabase): EmailProviderType[] {
  return database.orm.select().from(smtpProviderTypes).where(eq(smtpProviderTypes.enabled, true)).all()
    .map(row => ({ code: row.code, name: row.name, domain: row.emailDomain })).sort((a, b) => a.code === b.code ? 0 : a.code === "qq" ? -1 : 1);
}

export function requireSupportedEmailProvider(database: AppDatabase, email: string): EmailProviderType {
  if (!normalizeEmailAddress(email)) throw new HttpError("VALIDATION_ERROR");
  const provider = findEmailProvider(email, enabledEmailProviders(database));
  if (!provider) throw new HttpError("EMAIL_PROVIDER_UNSUPPORTED");
  return provider;
}

export class ProviderMailSender implements MailSender {
  constructor(private readonly database: AppDatabase, private readonly senders: ReadonlyMap<EmailProviderCode, MailSender>) {}
  async send(message: MailMessage): Promise<void> {
    const provider = requireSupportedEmailProvider(this.database, message.to);
    const sender = this.senders.get(provider.code);
    if (!sender) throw new HttpError("MAIL_NOT_CONFIGURED");
    await sender.send({ ...message, to: normalizeEmailAddress(message.to)! });
  }
}

export class SmtpMailSender implements MailSender {
  private readonly transport;
  constructor(private readonly config: SmtpConfiguration) {
    this.transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure, requireTLS: !config.secure,
      auth: { user: config.user, pass: config.password }, connectionTimeout: config.timeoutMs ?? 15_000,
      greetingTimeout: config.timeoutMs ?? 15_000, socketTimeout: config.timeoutMs ?? 15_000, logger: false, debug: false });
  }
  async send(message: MailMessage): Promise<void> {
    const purposes: Record<EmailChallengePurpose, string> = { login: "登录", bind_email: "绑定邮箱", change_password: "修改密码", change_email_old: "验证原邮箱", change_email_new: "验证新邮箱" };
    const text = message.kind === "verification"
      ? `您正在${purposes[message.purpose]}，验证码是：${message.code}\n验证码有效期至 ${message.expiresAt}。请勿转发；若非本人操作，请忽略本邮件。`
      : `您的视频库账号${message.purpose === "password_changed" ? "密码" : "绑定邮箱"}已于 ${message.changedAt} 修改。全部站内登录会话已撤销。若非本人操作，请使用受保护的本地恢复流程。`;
    const result = await this.transport.sendMail({ from: this.config.from, to: message.to,
      subject: message.kind === "verification" ? "视频库账号邮箱验证码" : "视频库账号安全通知", text });
    if (!result.accepted?.length || result.rejected?.length) throw new HttpError("MAIL_SEND_FAILED");
  }
}
export function validateSmtpConfiguration(input: unknown): SmtpConfiguration {
  try {
    const value = input as SmtpConfiguration;
    if (!value || typeof value.host !== "string" || !value.host || value.host.length > 253 || /[\s\x00-\x1f]/.test(value.host) ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.secure !== "boolean" ||
      typeof value.user !== "string" || !value.user || value.user.length > 512 || /[\x00-\x1f]/.test(value.user) ||
      typeof value.password !== "string" || !value.password || value.password.length > 4096 ||
      typeof value.from !== "string" || !value.from || value.from.length > 512 || /[\x00-\x1f]/.test(value.from) ||
      (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 60_000))) throw new Error();
    const provider = findEmailProvider(value.user); const user = normalizeEmailAddress(value.user); const from = normalizeEmailAddress(value.from);
    if (!provider || !user || from !== user || value.host !== hosts[provider.code] ||
      (value.providerCode !== undefined && value.providerCode !== provider.code) ||
      !((value.port === 465 && value.secure) || (value.port === 587 && !value.secure))) throw new Error();
    return { providerCode: provider.code, host: value.host, port: value.port, secure: value.secure, user, password: value.password, from, timeoutMs: value.timeoutMs ?? 15_000 };
  } catch { throw new ConfigurationError("SMTP 配置无效：仅支持 QQ/163，账号、From、类型与服务地址须匹配；465 使用直接 TLS，587 使用 STARTTLS"); }
}

/** 仅供本地管理命令使用，不向前端暴露 SMTP 授权码。 */
export function saveSmtpConfiguration(database: AppDatabase, key: Buffer, input: unknown): void {
  const value = validateSmtpConfiguration(input);
  requireSupportedEmailProvider(database, value.user);
  const row = { providerCode: value.providerCode, host: value.host, port: value.port, secure: value.secure, user: value.user,
    passwordCipher: encryptSecret(value.password, key, "smtp"), from: value.from, timeoutMs: value.timeoutMs!, updatedAt: new Date().toISOString() };
  database.orm.insert(smtpProviderConfigs).values(row).onConflictDoUpdate({ target: smtpProviderConfigs.providerCode, set: row }).run();
}

/** 邮件配置只读取数据库；读取或解密失败时不输出凭证。 */
export function loadMailSender(database: AppDatabase, key: Buffer): MailSender {
  try {
    const senders = new Map<EmailProviderCode, MailSender>(); const enabled = enabledEmailProviders(database);
    for (const row of database.orm.select().from(smtpProviderConfigs).all()) {
      if (!enabled.some(provider => provider.code === row.providerCode)) continue;
      const value = validateSmtpConfiguration({ ...row, password: decryptSecret(row.passwordCipher, key, "smtp") });
      senders.set(value.providerCode, new SmtpMailSender(value));
    }
    return new ProviderMailSender(database, senders);
  } catch { throw new ConfigurationError("数据库 SMTP 配置无法读取或解密，请检查配置与匹配的账号安全密钥"); }
}

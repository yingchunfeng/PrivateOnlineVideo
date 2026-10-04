import { resolve, relative, isAbsolute, sep } from "node:path";
import type { Environment } from "../../core/config.js";
import { ConfigurationError } from "../../core/config.js";
import { DEFAULT_AUTH_KEY_PATH, DEFAULT_DATABASE_PATH, guardDatabasePath, guardLocalFile, WORKSPACE_ROOT } from "../../db/database.js";

export interface AuthSettings { databasePath: string; keyFile: string; allowedOrigins: string[]; sessionTtlMs: number; failureWindowMs: number; maxFailures: number; secureCookie: boolean;
  emailCodeTtlMs: number; emailResendMs: number; emailMaxErrors: number; emailHourlyLimit: number; mailTimeoutMs: number; operationTtlMs: number }
export function readAuthSettings(environment: Environment, env: Record<string, string | undefined> = process.env): AuthSettings {
  const positive = (name: string, fallback: number, max: number) => {
    const value = env[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw new ConfigurationError(`${name} 必须是有效的正整数`);
    return Number(value);
  };
  const databasePath = guardDatabasePath(env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH);
  const keyFile = guardLocalFile(env.AUTH_KEY_FILE ?? DEFAULT_AUTH_KEY_PATH); const keyRelative = relative(resolve(WORKSPACE_ROOT, ".local"), keyFile);
  if (!keyRelative || keyRelative === ".." || keyRelative.startsWith(`..${sep}`) || isAbsolute(keyRelative)) throw new ConfigurationError("AUTH_KEY_FILE 必须位于项目 .local 目录");
  const input = env.AUTH_ALLOWED_ORIGINS ?? (environment === "production" ? "" : "http://127.0.0.1:5173,http://127.0.0.1:3000");
  const allowedOrigins = input.split(",");
  for (const origin of allowedOrigins) {
    let url: URL; try { url = new URL(origin); } catch { throw new ConfigurationError("AUTH_ALLOWED_ORIGINS 需要明确的可信站点 Origin"); }
    if (url.origin !== origin || url.username || url.password || !["http:", "https:"].includes(url.protocol) ||
      (url.protocol === "http:" && (environment === "production" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
      throw new ConfigurationError("可信 Origin 必须精确匹配；本地 HTTP 仅限回环地址，生产必须 HTTPS");
    }
  }
  return { databasePath, keyFile, allowedOrigins, sessionTtlMs: positive("AUTH_SESSION_TTL_MS", 86_400_000, 7 * 86_400_000),
    failureWindowMs: positive("AUTH_FAILURE_WINDOW_MS", 900_000, 86_400_000), maxFailures: positive("AUTH_MAX_FAILURES", 5, 100),
    secureCookie: environment === "production" || allowedOrigins.every(origin => origin.startsWith("https://")),
    emailCodeTtlMs: positive("AUTH_EMAIL_CODE_TTL_MS", 300_000, 900_000), emailResendMs: positive("AUTH_EMAIL_RESEND_MS", 60_000, 300_000),
    emailMaxErrors: positive("AUTH_EMAIL_MAX_ERRORS", 5, 10), emailHourlyLimit: positive("AUTH_EMAIL_HOURLY_LIMIT", 10, 100),
    mailTimeoutMs: positive("AUTH_MAIL_TIMEOUT_MS", 15_000, 60_000), operationTtlMs: positive("AUTH_OPERATION_TTL_MS", 900_000, 1_800_000) };
}

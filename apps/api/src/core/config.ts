import { isIP } from "node:net";
import type { PlaybackMode, TransferPolicy } from "@online-video/shared";

export type Environment = "development" | "test" | "production";
export type StorageDriver = "mock" | "oss";
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
export interface AppConfig {
  readonly environment: Environment;
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly playbackMode: PlaybackMode;
  readonly storageDriver: StorageDriver;
  readonly usageTimezone: string;
  readonly transferPolicy: TransferPolicy;
  readonly maxPlaybackSessions: number | null;
  readonly trustedProxies: string[];
}
export class ConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigurationError"; }
}
type EnvironmentInput = Record<string, string | undefined>;
function value(env: EnvironmentInput, key: string, fallback?: string): string | undefined {
  const result = env[key] ?? fallback;
  if (result !== undefined && (result.trim() === "" || result !== result.trim())) {
    throw new ConfigurationError(`${key} 不能为空或带有首尾空格`);
  }
  return result;
}
function choice<T extends string>(input: string | undefined, key: string, choices: readonly T[]): T {
  if (!choices.includes(input as T)) throw new ConfigurationError(`${key} 只允许 ${choices.join("、")}`);
  return input as T;
}
function integer(input: string | undefined, key: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (input === undefined || !/^\d+$/.test(input)) throw new ConfigurationError(`${key} 必须是整数`);
  const parsed = Number(input);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigurationError(`${key} 必须介于 ${min} 和 ${max} 之间`);
  }
  return parsed;
}
export function readConfig(env: EnvironmentInput = process.env): AppConfig {
  const environment = choice(value(env, "NODE_ENV", "development"), "NODE_ENV", ["development", "test", "production"]);
  const host = value(env, "API_HOST", "127.0.0.1")!;
  if (!isIP(host)) throw new ConfigurationError("API_HOST 必须是明确的 IPv4 或 IPv6 地址");
  const port = integer(value(env, "API_PORT", "3000"), "API_PORT", 1, 65535);
  const logLevel = choice(value(env, "LOG_LEVEL", "info"), "LOG_LEVEL", ["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
  const playbackMode = choice(value(env, "PLAYBACK_MODE", "proxy"), "PLAYBACK_MODE", ["proxy"]);
  const storageDriver = choice(value(env, "STORAGE_DRIVER", "mock"), "STORAGE_DRIVER", ["mock", "oss"]);
  if (storageDriver === "oss") throw new ConfigurationError("STORAGE_DRIVER=oss 尚未实现；不会连接真实 OSS 或回退公网");
  if (environment === "production") throw new ConfigurationError("生产模块装配与真实存储尚待 CORE-06 接入，拒绝提前启动生产环境");
  const usageTimezone = value(env, "USAGE_TIMEZONE", "UTC")!;
  try { new Intl.DateTimeFormat("en", { timeZone: usageTimezone }).format(); }
  catch { throw new ConfigurationError("USAGE_TIMEZONE 必须是有效的 IANA 时区"); }
  const transfer = value(env, "TRANSFER_LIMIT_BYTES");
  const transferPolicy: TransferPolicy = transfer === undefined ? { kind: "unconfigured" }
    : transfer === "unlimited" ? { kind: "unlimited" }
    : { kind: "limited", limitBytes: integer(transfer, "TRANSFER_LIMIT_BYTES", 0) };
  const concurrency = value(env, "MAX_PLAYBACK_SESSIONS");
  const trustedProxies = env.TRUSTED_PROXIES === undefined ? [] : env.TRUSTED_PROXIES.split(",");
  if (trustedProxies.some(address => {
    const [host, prefix, extra] = address.split("/"); const family = isIP(host ?? "");
    return !family || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)));
  })) throw new ConfigurationError("TRUSTED_PROXIES 必须是明确 IP/CIDR 列表，不允许 true、通配符或空值");
  return {
    environment, host, port, logLevel, playbackMode, storageDriver, usageTimezone, transferPolicy, trustedProxies,
    maxPlaybackSessions: concurrency === undefined ? null : integer(concurrency, "MAX_PLAYBACK_SESSIONS", 1)
  };
}

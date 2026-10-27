import { isIP } from "node:net";
import type { LibraryConfig, PlaybackMode, TransferPolicy } from "@online-video/shared";
import { guardLocalFile } from "../db/database.js";

export type Environment = "development" | "test" | "production";
export type StorageDriver = "mock" | "oss";
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
export interface MediaConfig {
  objectPrefix: string; partSizeBytes: number; maxUploadBytes: number; maxUploadConcurrency: number;
  uploadObjectPrefix?: string;
  playbackTtlMs: number; requestsPerMinute: number; maxAuthorizationsPerMinute: number; previewTtlMs: number; maxPreviews: number;
  ffprobePath: string | null; probeTimeoutMs: number; probeMaxReadBytes: number; probeMaxConcurrent: number;
}
export interface OssConfig {
  bucket: string; region: string; endpoint: string; playbackEndpoint: string; network: "internal" | "public";
  allowPublicNetwork: boolean; credentialFile: string; roleArn?: string; roleArnFile?: string;
  stsDurationSeconds: number; stsRefreshBeforeSeconds: number; signedUrlTtlSeconds: number; clockSkewSeconds: number;
}
export interface AppConfig {
  readonly environment: Environment;
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly playbackMode: PlaybackMode;
  readonly storageDriver: StorageDriver;
  readonly libraryMode?: "public" | "legacy";
  /** 显式新部署入口；必须与真实 SetupService 和受限业务门禁共同使用。 */
  readonly installationMode?: boolean;
  library?: LibraryConfig;
  libraryConfigPath?: string;
  readonly usageTimezone: string;
  readonly transferPolicy: TransferPolicy;
  readonly maxPlaybackSessions: number | null;
  readonly trustedProxies: string[];
  readonly media?: MediaConfig | null;
  readonly oss?: OssConfig | null;
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
  const libraryMode = choice(value(env, "LIBRARY_MODE", "public"), "LIBRARY_MODE", ["public", "legacy"]);
  const playbackMode = choice(value(env, "PLAYBACK_MODE", "proxy"), "PLAYBACK_MODE", ["proxy", "oss"]);
  const storageDriver = choice(value(env, "STORAGE_DRIVER", "mock"), "STORAGE_DRIVER", ["mock", "oss"]);
  if (environment === "production" && storageDriver !== "oss") throw new ConfigurationError("生产拒绝 Mock 存储");
  if (playbackMode === "oss" && storageDriver !== "oss") throw new ConfigurationError("OSS直连模式必须明确选择OSS存储");
  const usageTimezone = value(env, "USAGE_TIMEZONE", "UTC")!;
  try { new Intl.DateTimeFormat("en", { timeZone: usageTimezone }).format(); }
  catch { throw new ConfigurationError("USAGE_TIMEZONE 必须是有效的 IANA 时区"); }
  const transfer = value(env, "TRANSFER_LIMIT_BYTES");
  const transferPolicy: TransferPolicy = transfer === undefined ? { kind: "unconfigured" }
    : transfer === "unlimited" ? { kind: "unlimited" }
    : { kind: "limited", limitBytes: integer(transfer, "TRANSFER_LIMIT_BYTES", 0) };
  const concurrency = value(env, "MAX_PLAYBACK_SESSIONS");
  let media: MediaConfig | null = null;
  if (env.MAX_UPLOAD_BYTES !== undefined || storageDriver === "oss" || environment === "production") {
    const required = (key: string, min: number, max?: number) => integer(value(env, key), key, min, max);
    const objectPrefix = value(env, "OSS_OBJECT_PREFIX", storageDriver === "mock" ? "library/" : libraryMode === "public" ? "onlineVideo/" : undefined)!;
    if (!objectPrefix || !objectPrefix.endsWith("/") || objectPrefix.startsWith("/") || /[\\%?#*\x00-\x1f]/.test(objectPrefix) || objectPrefix.split("/").some(part => part === "." || part === "..") || (storageDriver === "oss" && objectPrefix !== "onlineVideo/")) throw new ConfigurationError("OSS_OBJECT_PREFIX 必须是固定授权 onlineVideo/ 前缀");
    media = { objectPrefix, maxUploadBytes: required("MAX_UPLOAD_BYTES", 1), partSizeBytes: required("UPLOAD_PART_SIZE_BYTES", 102400, 16777216),
      maxUploadConcurrency: required("MAX_UPLOAD_CONCURRENCY", 1, 100), playbackTtlMs: integer(value(env, "PLAYBACK_SESSION_TTL_MS", libraryMode === "public" ? "120000" : undefined), "PLAYBACK_SESSION_TTL_MS", 1000, 3600000),
      requestsPerMinute: required("MEDIA_REQUESTS_PER_MINUTE", 1), maxAuthorizationsPerMinute: integer(value(env, "MAX_AUTHORIZATIONS_PER_MINUTE", libraryMode === "public" ? "12" : undefined), "MAX_AUTHORIZATIONS_PER_MINUTE", 1),
      previewTtlMs: integer(value(env, "IMPORT_PREVIEW_TTL_MS", libraryMode === "public" ? "600000" : undefined), "IMPORT_PREVIEW_TTL_MS", 1000),
      maxPreviews: integer(value(env, "MAX_IMPORT_PREVIEWS", libraryMode === "public" ? "16" : undefined), "MAX_IMPORT_PREVIEWS", 1), ffprobePath: value(env, "FFPROBE_PATH") ?? null,
      probeTimeoutMs: integer(value(env, "FFPROBE_TIMEOUT_MS", "15000"), "FFPROBE_TIMEOUT_MS", 1, 120000),
      probeMaxReadBytes: integer(value(env, "FFPROBE_MAX_READ_BYTES", "16777216"), "FFPROBE_MAX_READ_BYTES", 1),
      probeMaxConcurrent: integer(value(env, "FFPROBE_MAX_CONCURRENT", "1"), "FFPROBE_MAX_CONCURRENT", 1, 10) };
    const uploadObjectPrefix = value(env, "OSS_UPLOAD_OBJECT_PREFIX");
    if (uploadObjectPrefix !== undefined) {
      if (!uploadObjectPrefix.startsWith(objectPrefix) || uploadObjectPrefix === objectPrefix || !uploadObjectPrefix.endsWith("/") || /[\\%?#*\x00-\x1f]/.test(uploadObjectPrefix) || uploadObjectPrefix.split("/").some(part => part === "." || part === "..")) throw new ConfigurationError("OSS_UPLOAD_OBJECT_PREFIX必须是授权根下明确的子目录");
      media.uploadObjectPrefix = uploadObjectPrefix;
    }
    if (media.maxUploadBytes > media.partSizeBytes * 10000 || (libraryMode === "legacy" && (concurrency === undefined || env.USAGE_TIMEZONE === undefined))) throw new ConfigurationError("上传最多10000片；旧播放模式需明确 MAX_PLAYBACK_SESSIONS/USAGE_TIMEZONE");
  }
  let oss: OssConfig | null = null;
  if (storageDriver === "oss") {
    const region = choice(value(env, "OSS_REGION"), "OSS_REGION", ["cn-hangzhou"]);
    const bucket = value(env, "OSS_BUCKET")!;
    if (!bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new ConfigurationError("OSS_BUCKET 必须是明确合法的Bucket名称");
    const network = choice(value(env, "OSS_NETWORK"), "OSS_NETWORK", ["internal", "public"]);
    const allowPublicNetwork = env.OSS_ALLOW_PUBLIC_NETWORK === "true";
    if (env.OSS_ALLOW_PUBLIC_NETWORK !== undefined && !["true", "false"].includes(env.OSS_ALLOW_PUBLIC_NETWORK)) throw new ConfigurationError("OSS_ALLOW_PUBLIC_NETWORK 只允许true/false");
    const endpoint = value(env, "OSS_ENDPOINT")!; const playbackEndpoint = value(env, "OSS_PLAYBACK_ENDPOINT", libraryMode === "public" ? "https://oss.meetdawn.top" : undefined)!;
    const origin = (input: string, key: string) => { let url: URL; try { url = new URL(input); } catch { throw new ConfigurationError(`${key} 必须是HTTPS Origin`); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port) throw new ConfigurationError(`${key} 必须是HTTPS Origin`); return url; };
    const uploadUrl = origin(endpoint, "OSS_ENDPOINT"); origin(playbackEndpoint, "OSS_PLAYBACK_ENDPOINT");
    if (uploadUrl.hostname !== `oss-cn-hangzhou${network === "internal" ? "-internal" : ""}.aliyuncs.com` || (network === "public" && !allowPublicNetwork)) throw new ConfigurationError("上传Endpoint必须匹配网络，公网需显式确认");
    const credentialFile = value(env, "OSS_CREDENTIAL_FILE")!;
    if (!credentialFile) throw new ConfigurationError("缺少受保护OSS_CREDENTIAL_FILE");
    // 路径保护复用 .local 边界校验，不读取秘密。
    const roleArn = value(env, "OSS_ROLE_ARN"); const roleArnFile = value(env, "OSS_ROLE_ARN_FILE");
    if ((libraryMode === "legacy" && (!!roleArn === !!roleArnFile)) || (roleArn && !/^acs:ram::\d+:role\/[A-Za-z0-9_./-]+$/.test(roleArn))) throw new ConfigurationError("旧播放模式的角色ARN或受保护ARN文件必须二选一");
    guardLocalFile(credentialFile); if (roleArnFile) guardLocalFile(roleArnFile);
    oss = { bucket, region, endpoint, playbackEndpoint, network, allowPublicNetwork, credentialFile,
      ...(roleArn ? { roleArn } : {}), ...(roleArnFile ? { roleArnFile } : {}),
      stsDurationSeconds: integer(value(env, "OSS_STS_DURATION_SECONDS", libraryMode === "public" ? "3600" : undefined), "OSS_STS_DURATION_SECONDS", 900, 3600),
      stsRefreshBeforeSeconds: integer(value(env, "OSS_STS_REFRESH_BEFORE_SECONDS", libraryMode === "public" ? "300" : undefined), "OSS_STS_REFRESH_BEFORE_SECONDS", 1),
      signedUrlTtlSeconds: integer(value(env, "OSS_SIGNED_URL_TTL_SECONDS", libraryMode === "public" ? "3600" : undefined), "OSS_SIGNED_URL_TTL_SECONDS", 1, 3600),
      clockSkewSeconds: integer(value(env, "OSS_CLOCK_SKEW_SECONDS", libraryMode === "public" ? "30" : undefined), "OSS_CLOCK_SKEW_SECONDS", 1, 300) };
    if (oss.stsRefreshBeforeSeconds >= oss.stsDurationSeconds || oss.clockSkewSeconds >= oss.stsDurationSeconds) throw new ConfigurationError("STS刷新/安全余量必须小于凭证期限");
  }
  const trustedProxies = env.TRUSTED_PROXIES === undefined ? [] : env.TRUSTED_PROXIES.split(",");
  if (trustedProxies.some(address => {
    const [host, prefix, extra] = address.split("/"); const family = isIP(host ?? "");
    return !family || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)));
  })) throw new ConfigurationError("TRUSTED_PROXIES 必须是明确 IP/CIDR 列表，不允许 true、通配符或空值");
  return {
    environment, host, port, logLevel, playbackMode, storageDriver, libraryMode, usageTimezone, transferPolicy, trustedProxies,
    maxPlaybackSessions: concurrency === undefined ? null : integer(concurrency, "MAX_PLAYBACK_SESSIONS", 1), media, oss
  };
}

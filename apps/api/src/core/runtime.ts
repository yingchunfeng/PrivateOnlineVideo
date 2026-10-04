import type { AppConfig } from "./config.js";
import { ConfigurationError } from "./config.js";
import type { AuthService } from "../modules/auth/service.js";
import type { AppDatabase } from "../db/database.js";
import { createRepositories } from "../db/repositories.js";
import { createMediaModule, MockStorageAdapter, createStsCredentialCache, createOssStorageAdapter, createDirectOssStorageAdapter, createOssPresignedSourceProvider,
  FFprobeMetadataInspector, UnavailableMetadataInspector } from "../modules/media/index.js";
import type { BuildAppOptions } from "../app.js";
import { loadLibraryConfig } from "./library-config.js";
import { recoverLibraryConfiguration } from "./library-configuration.js";
import { resolve } from "node:path";
import { WORKSPACE_ROOT } from "../db/database.js";

/** 启动仅核验版本2，不执行迁移；公共上传使用服务端凭据，旧私有分支保留。 */
export async function runtimeModules(config: AppConfig, auth: AuthService, database: AppDatabase, now: () => Date = () => new Date()): Promise<Pick<BuildAppOptions, "backend" | "media">> {
  const limits = config.media;
  if (!limits || (config.libraryMode === "legacy" && config.maxPlaybackSessions === null)) throw new ConfigurationError("业务启动需要明确上传资源控制；旧播放模式还需会话限制，参见.env.example");
  if (config.libraryMode !== "legacy") {
    if (!config.library) { config.libraryConfigPath ??= resolve(WORKSPACE_ROOT, "config/library.json"); recoverLibraryConfiguration(database, config.libraryConfigPath); config.library = loadLibraryConfig(config.libraryConfigPath); }
    limits.objectPrefix = config.library.objectPrefix;
  }
  const repositories = createRepositories(database, now, config.library);
  const metadata = limits.ffprobePath ? new FFprobeMetadataInspector({ executable: limits.ffprobePath, timeoutMs: limits.probeTimeoutMs,
    maxReadBytes: limits.probeMaxReadBytes, maxConcurrent: limits.probeMaxConcurrent }) : new UnavailableMetadataInspector();
  const register = createMediaModule({ ...limits, metadata });
  const dependencies = { kind: config.environment === "production" ? "production" as const : "development" as const,
    config, auth, ...repositories, now };
  if (config.storageDriver === "mock") {
    if (config.environment === "production" || (!config.library && config.playbackMode !== "proxy")) throw new ConfigurationError("Mock仅允许显式开发模式");
    return { backend: { database, auth, config, now }, media: { register, dependencies: { ...dependencies, storage: new MockStorageAdapter(limits.objectPrefix) } } };
  }
  const oss = config.oss;
  if (!oss) throw new ConfigurationError("真实OSS配置缺失");
  if (config.library) {
    const storage = await createDirectOssStorageAdapter({ bucket: oss.bucket, region: oss.region, endpoint: oss.endpoint, objectPrefix: limits.objectPrefix,
      network: oss.network, allowPublicNetwork: oss.allowPublicNetwork, credentialFile: oss.credentialFile, publicUploads: true });
    return { backend: { database, auth, config, now }, media: { register, dependencies: { ...dependencies, storage } } };
  }
  const credentials = await createStsCredentialCache({ bucket: oss.bucket, objectPrefix: limits.objectPrefix, credentialFile: oss.credentialFile,
    ...(oss.roleArn ? { roleArn: oss.roleArn } : {}), ...(oss.roleArnFile ? { roleArnFile: oss.roleArnFile } : {}),
    durationSeconds: oss.stsDurationSeconds, refreshBeforeSeconds: oss.stsRefreshBeforeSeconds }, now);
  const storage = await createOssStorageAdapter({ bucket: oss.bucket, region: oss.region, endpoint: oss.endpoint, objectPrefix: limits.objectPrefix,
    network: oss.network, allowPublicNetwork: oss.allowPublicNetwork }, credentials);
  const sources = await createOssPresignedSourceProvider({ bucket: oss.bucket, region: oss.region, endpoint: oss.playbackEndpoint, objectPrefix: limits.objectPrefix,
    ttlSeconds: oss.signedUrlTtlSeconds, safetySeconds: oss.clockSkewSeconds, renewBeforeSeconds: oss.stsRefreshBeforeSeconds }, credentials, now);
  return { backend: { database, auth, config, now }, media: { register, dependencies: { ...dependencies, storage, sources } } };
}

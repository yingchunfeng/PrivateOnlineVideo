import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { ConfigurationError } from "../config.js";
import type { AuthGuard, OrganizationRepository, StorageObjectRepository, PlaybackRepository, UploadRepository, UsageRepository, VideoRepository } from "./repositories.js";
import type { StorageAdapter, PresignedSourceProvider } from "./storage.js";

export interface MediaDependencies {
  /** 测试依赖只能在 development/test 注入，生产装配必须明确声明 production。 */
  kind: "test" | "development" | "production";
  organizations?: OrganizationRepository;
  objects?: StorageObjectRepository;
  sources?: PresignedSourceProvider;
  auth: AuthGuard;
  videos: VideoRepository;
  uploads: UploadRepository;
  playback: PlaybackRepository;
  usage: UsageRepository;
  storage: StorageAdapter;
  config: AppConfig;
  now: () => Date;
}
/** 子代理 2 导出 registerMediaModule: MediaModule；路由写完整 /api 前缀。 */
export type MediaModule = (app: FastifyInstance, dependencies: MediaDependencies) => Promise<void>;
export interface MediaRegistration { register: MediaModule; dependencies: MediaDependencies }

export function assertMediaDependencies(config: AppConfig, registration: MediaRegistration): void {
  const dependencies = registration?.dependencies;
  if (typeof registration?.register !== "function" || !dependencies) {
    throw new ConfigurationError("媒体注册缺少 register 或 dependencies");
  }
  const requiredMethods = {
    auth: ["requireUser"], videos: ["assertCategoryOwned", "findOwned", "register", "updateMedia"],
    uploads: ["create", "findOwned", "savePart", "transition"],
    playback: ["create", "findActive", "heartbeat", "close"],
    usage: ["read", "reserve", "settle"],
    storage: ["head", "openRead", "createMultipart", "uploadPart", "completeMultipart", "list"]
  } as const;
  for (const [name, methods] of Object.entries(requiredMethods)) {
    const implementation = dependencies[name as keyof typeof requiredMethods] as unknown as Record<string, unknown> | undefined;
    if (!implementation || methods.some(method => typeof implementation[method] !== "function")) {
      throw new ConfigurationError(`媒体注册缺少 ${name} 的必要接口实现`);
    }
  }
  if (dependencies.config !== config || typeof dependencies.now !== "function") {
    throw new ConfigurationError("媒体注册必须使用应用同一份 config，并提供 now");
  }
  if (config.environment !== "test" && (!config.media || (!config.library && config.maxPlaybackSessions === null) || (config.storageDriver === "oss" && !config.oss && !config.installationMode))) {
    if (dependencies.kind !== "test") throw new ConfigurationError("完整业务装配缺少明确上传/授权控制配置");
  }
  if (!["test", "development", "production"].includes(dependencies.kind) || dependencies.storage.driver !== config.storageDriver) {
    throw new ConfigurationError("媒体依赖标记或存储驱动与应用配置不匹配");
  }
  if (!config.library && ((config.playbackMode === "proxy" && config.transferPolicy.kind === "unconfigured") || config.maxPlaybackSessions === null)) {
    throw new ConfigurationError("媒体注册前必须明确 TRANSFER_LIMIT_BYTES 和 MAX_PLAYBACK_SESSIONS");
  }
  if (config.library && (!dependencies.objects || !dependencies.organizations || typeof dependencies.organizations.normalizeSelection !== "function" ||
    typeof dependencies.uploads.attachMultipart !== "function" || typeof dependencies.uploads.finishRegistration !== "function")) {
    throw new ConfigurationError("公共上传缺少配置分类、对象和原子登记依赖");
  }
  if (!config.library && config.playbackMode === "oss" && (!dependencies.sources || !dependencies.objects || !dependencies.organizations ||
    typeof dependencies.sources.sign !== "function" || typeof dependencies.organizations.assertOwned !== "function" ||
    ["prepare", "verify", "recordOperation"].some(method => typeof (dependencies.objects as unknown as Record<string, unknown>)[method] !== "function") ||
    typeof dependencies.uploads.attachMultipart !== "function" || typeof dependencies.uploads.finishRegistration !== "function" || typeof dependencies.playback.authorize !== "function")) {
    throw new ConfigurationError("OSS模式缺少签名/对象/组织/原子登记/审计依赖");
  }
  if (config.environment === "production" && (dependencies.kind !== "production" || config.storageDriver === "mock")) {
    throw new ConfigurationError("生产媒体注册拒绝测试依赖和 Mock 存储");
  }
  if (config.environment === "production" && (!config.media || (!config.installationMode && (!config.oss || !config.oss.playbackEndpoint.startsWith("https://"))))) {
    throw new ConfigurationError("生产缺少真实OSS/HTTPS及资源控制配置");
  }
}

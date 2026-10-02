import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { ConfigurationError } from "../config.js";
import type { AuthGuard, PlaybackRepository, UploadRepository, UsageRepository, VideoRepository } from "./repositories.js";
import type { StorageAdapter } from "./storage.js";

export interface MediaDependencies {
  /** 测试依赖只能在 development/test 注入，生产装配必须明确声明 production。 */
  kind: "test" | "production";
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
  if (!["test", "production"].includes(dependencies.kind) || dependencies.storage.driver !== config.storageDriver) {
    throw new ConfigurationError("媒体依赖标记或存储驱动与应用配置不匹配");
  }
  if (config.transferPolicy.kind === "unconfigured" || config.maxPlaybackSessions === null) {
    throw new ConfigurationError("媒体注册前必须明确 TRANSFER_LIMIT_BYTES 和 MAX_PLAYBACK_SESSIONS");
  }
  if (config.environment === "production" && (dependencies.kind !== "production" || config.storageDriver === "mock")) {
    throw new ConfigurationError("生产媒体注册拒绝测试依赖和 Mock 存储");
  }
}

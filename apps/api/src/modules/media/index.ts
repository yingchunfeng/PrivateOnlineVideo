import { assertMediaDependencies } from "../../core/contracts/index.js";
import type { MediaModule } from "../../core/contracts/index.js";
import type { MediaOptions } from "./options.js";
import { validateOptions } from "./options.js";
import { ObjectScope } from "./storage/scope.js";
import { RequestLimiter } from "./limits/rate.js";
import { registerPlaybackRoutes } from "./playback/routes.js";
import { registerUploadRoutes } from "./upload/routes.js";
import { registerCoverRoutes } from "./cover/routes.js";
import { registerImportRoutes } from "./import/routes.js";
import { UnavailableMetadataInspector } from "./metadata/types.js";
import { HttpError } from "../../core/errors.js";

/** CORE-06 应显式提供用户确定的资源/请求限制及内容分析器。 */
export function createMediaModule(options: MediaOptions): MediaModule {
  validateOptions(options);
  const register: MediaModule = async (app, dependencies) => {
    assertMediaDependencies(dependencies.config, { register, dependencies });
    const context = { dependencies, options, get scope() { return new ObjectScope(dependencies.config.library?.objectPrefix ?? options.objectPrefix); }, limiter: new RequestLimiter(options.requestsPerMinute) };
    await app.register(async scoped => {
      // 鉴权发生在原始分片解析和媒体数据读取之前；生产依赖从不提供放行默认值。
      scoped.addHook("onRequest", async request => {
        const auth = await dependencies.auth.requireUser(request, { mutation: !["GET", "HEAD"].includes(request.method) });
        const group = request.routeOptions.url?.includes("/parts/") ? "upload" : request.routeOptions.url?.includes("/stream") ? "stream" : "management";
        context.limiter.check(auth.user.id, group, dependencies.now().getTime());
      });
      registerUploadRoutes(scoped, context);
      if (dependencies.config.library) registerCoverRoutes(scoped, context);
      if (!dependencies.config.library) {
        registerPlaybackRoutes(scoped, context);
        registerImportRoutes(scoped, context);
      }
    });
  };
  return register;
}

/** 安全本地边界：未知内容留 processing；生产装配需显式选择 FFprobe 与确定预算。 */
const localModule = createMediaModule({ objectPrefix: "library/", partSizeBytes: 1024 * 1024,
  maxUploadBytes: 8 * 1024 * 1024 * 1024, maxUploadConcurrency: 2, playbackTtlMs: 120_000,
  requestsPerMinute: 120, previewTtlMs: 600_000, maxPreviews: 16, metadata: new UnavailableMetadataInspector() });
export const registerMediaModule: MediaModule = async (app, dependencies) => {
  if (dependencies.kind !== "test" || dependencies.config.environment === "production") throw new HttpError("SERVICE_NOT_CONFIGURED");
  await localModule(app, dependencies);
};

export { MockStorageAdapter } from "./storage/mock.js";
export { createOssStorageAdapter, createDirectOssStorageAdapter } from "./storage/oss.js";
export { createStsCredentialCache, StsCredentialCache } from "./storage/sts.js";
export { createOssPresignedSourceProvider, OssPresignedSourceProvider } from "./storage/signing.js";
export { UnavailableMetadataInspector } from "./metadata/types.js";
export { FFprobeMetadataInspector } from "./metadata/ffprobe.js";
export type { MediaOptions } from "./options.js";

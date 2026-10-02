import type { AppConfig } from "../../src/core/config.js";
import type { MediaDependencies } from "../../src/core/contracts/index.js";
import { HttpError } from "../../src/core/errors.js";

/** 仅供测试替换；默认鉴权拒绝、仓储/存储失败，绝不伪造业务成功。 */
export function createTestMediaDependencies(config: AppConfig,
  overrides: Partial<Omit<MediaDependencies, "kind" | "config">> = {}): MediaDependencies {
  const unavailable = async (): Promise<never> => { throw new HttpError("SERVICE_NOT_CONFIGURED"); };
  const storageUnavailable = async (): Promise<never> => { throw new HttpError("STORAGE_UNAVAILABLE"); };
  return {
    kind: "test", config, now: () => new Date(),
    auth: { requireUser: async () => { throw new HttpError("AUTH_REQUIRED"); } },
    videos: { assertCategoryOwned: unavailable, findOwned: unavailable, register: unavailable, updateMedia: unavailable },
    uploads: { create: unavailable, findOwned: unavailable, savePart: unavailable, transition: unavailable },
    playback: { create: unavailable, findActive: unavailable, heartbeat: unavailable, close: unavailable },
    usage: { read: unavailable, reserve: unavailable, settle: unavailable },
    storage: { driver: "mock", head: storageUnavailable, openRead: storageUnavailable,
      createMultipart: storageUnavailable, uploadPart: storageUnavailable,
      completeMultipart: storageUnavailable, list: storageUnavailable },
    ...overrides
  };
}

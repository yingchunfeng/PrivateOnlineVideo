import { HttpError } from "../../core/errors.js";
import { ObjectScope } from "./storage/scope.js";
import type { MetadataInspector } from "./metadata/types.js";

export interface MediaOptions {
  objectPrefix: string;
  partSizeBytes: number;
  maxUploadBytes: number;
  maxUploadConcurrency: number;
  playbackTtlMs: number;
  requestsPerMinute: number;
  previewTtlMs: number;
  maxPreviews: number;
  metadata: MetadataInspector;
}

/** 显式传入资源限制；不把本地测试参数当成生产预算。 */
export function validateOptions(options: MediaOptions): void {
  new ObjectScope(options.objectPrefix);
  for (const value of [options.partSizeBytes, options.maxUploadBytes, options.maxUploadConcurrency,
    options.playbackTtlMs, options.requestsPerMinute, options.previewTtlMs, options.maxPreviews]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new HttpError("SERVICE_NOT_CONFIGURED");
  }
  if (options.partSizeBytes < 100 * 1024 || options.partSizeBytes > 16 * 1024 * 1024 ||
    options.maxUploadBytes > options.partSizeBytes * 10_000 || typeof options.metadata?.inspect !== "function") {
    throw new HttpError("SERVICE_NOT_CONFIGURED");
  }
}

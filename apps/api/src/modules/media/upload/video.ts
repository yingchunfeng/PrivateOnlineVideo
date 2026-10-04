import { randomUUID } from "node:crypto";
import type { VideoRecord, StorageObjectRef, MediaDependencies } from "../../../core/contracts/index.js";
import type { MediaMetadata } from "../metadata/types.js";
import { publicUrlFor } from "../../../core/library-config.js";

export function makeVideo(input: { ownerId: string; title: string; categoryId: string; object: StorageObjectRef;
  sizeBytes: number; metadata: MediaMetadata; dependencies: MediaDependencies; groupIds?: string[]; tagIds?: string[];
  tags?: string[]; fileName?: string }): VideoRecord {
  return { ownerId: input.ownerId, originalObject: input.object, playbackObject: input.object, thumbnailObject: null,
    video: { id: randomUUID(), title: input.title, categoryId: input.categoryId, groupIds: input.groupIds ?? [], tagIds: input.tagIds ?? [], sizeBytes: input.sizeBytes,
      createdAt: input.dependencies.now().toISOString(), thumbnailUrl: null, lastPositionSeconds: 0, ...input.metadata,
      ...(input.dependencies.config.library ? { tags: input.tags ?? [], fileName: input.fileName ?? input.object.key.split("/").at(-1)!,
        objectKey: input.object.key, publicUrl: publicUrlFor(input.dependencies.config.library, input.object.key) } : {}) } };
}

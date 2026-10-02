import { randomUUID } from "node:crypto";
import type { VideoRecord, StorageObjectRef, MediaDependencies } from "../../../core/contracts/index.js";
import type { MediaMetadata } from "../metadata/types.js";

export function makeVideo(input: { ownerId: string; title: string; categoryId: string; object: StorageObjectRef;
  sizeBytes: number; metadata: MediaMetadata; dependencies: MediaDependencies }): VideoRecord {
  return { ownerId: input.ownerId, originalObject: input.object, playbackObject: input.object, thumbnailObject: null,
    video: { id: randomUUID(), title: input.title, categoryId: input.categoryId, sizeBytes: input.sizeBytes,
      createdAt: input.dependencies.now().toISOString(), thumbnailUrl: null, lastPositionSeconds: 0, ...input.metadata } };
}

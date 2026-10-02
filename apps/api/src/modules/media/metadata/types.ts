import type { StorageAdapter, StorageObjectRef } from "../../../core/contracts/index.js";
import type { VideoStatus } from "@online-video/shared";

export interface MediaMetadata {
  status: VideoStatus;
  durationSeconds: number | null;
  codec: string | null;
  width: number | null;
  height: number | null;
  playable: boolean;
}
export interface MetadataInspector {
  inspect(input: { storage: StorageAdapter; object: StorageObjectRef; signal: AbortSignal }): Promise<MediaMetadata>;
}
export const unknownMetadata: MediaMetadata = { status: "processing", durationSeconds: null,
  codec: null, width: null, height: null, playable: false };
/** 工具未安装时保留明确待分析状态，绝不依据后缀宣称可播放。 */
export class UnavailableMetadataInspector implements MetadataInspector {
  async inspect(): Promise<MediaMetadata> { return { ...unknownMetadata }; }
}

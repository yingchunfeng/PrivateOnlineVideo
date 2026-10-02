import type { Readable } from "node:stream";
import type { PartChecksum } from "@online-video/shared";
import type { StorageObjectRef, StoredPart } from "./repositories.js";
import type { StorageDriver } from "../config.js";

/** 闭区间，start/end 为非负安全整数；由媒体模块解析和验证 HTTP Range。 */
export interface ByteRange { start: number; end: number }
export interface StorageMetadata { sizeBytes: number; contentType: string; etag: string }
export interface StorageRead {
  stream: Readable;
  metadata: StorageMetadata;
  range: ByteRange | null;
}
export interface StorageListItem { object: StorageObjectRef; fileName: string; metadata: StorageMetadata }
export interface StorageAdapter {
  readonly driver: StorageDriver;
  head(input: { object: StorageObjectRef; signal: AbortSignal }): Promise<StorageMetadata>;
  /** 背压与 AbortSignal 必须传给上游；不得读取整个视频后构造返回流。 */
  openRead(input: { object: StorageObjectRef; range?: ByteRange; signal: AbortSignal }): Promise<StorageRead>;
  createMultipart(input: { object: StorageObjectRef; contentType: string; signal: AbortSignal }): Promise<{ uploadId: string }>;
  /** 媒体层对实际分片字节计算 checksum；仅校验和存储均成功后可 savePart。
   * 流式写入后发现不匹配时，不登记成功、不 complete，不自动删除云端分片。
   */
  uploadPart(input: { object: StorageObjectRef; uploadId: string; partNumber: number;
    sizeBytes: number; checksum: PartChecksum; stream: Readable; signal: AbortSignal }): Promise<{ etag: string }>;
  completeMultipart(input: { object: StorageObjectRef; uploadId: string; parts: StoredPart[];
    signal: AbortSignal }): Promise<StorageMetadata>;
  /** prefix 必须是服务端配置授权范围的子范围；cursor 为服务端不透明游标。 */
  list(input: { prefix: string; cursor?: string; limit: number; signal: AbortSignal }): Promise<{
    items: StorageListItem[]; nextCursor: string | null;
  }>;
}

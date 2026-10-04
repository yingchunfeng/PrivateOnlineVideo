import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { StorageAdapter, StorageMetadata, StoredPart } from "../../../core/contracts/index.js";
import { HttpError } from "../../../core/errors.js";
import { ObjectScope, checkAborted } from "./scope.js";

/** 明确的有界内存测试存储；不是生产存储，也不适合大文件验收。 */
export class MockStorageAdapter implements StorageAdapter {
  readonly driver = "mock" as const;
  readonly scope: ObjectScope;
  readonly objects = new Map<string, { bytes: Buffer; metadata: StorageMetadata }>();
  readonly uploads = new Map<string, { key: string; contentType: string; parts: Map<number, { bytes: Buffer; etag: string }> }>();
  readonly reads: { key: string; range: { start: number; end: number } | null }[] = [];
  abortedReads = 0;
  constructor(prefix = "library/", readonly maxStoredBytes = 32 * 1024 * 1024) { this.scope = new ObjectScope(prefix); }
  private storedBytes(): number {
    return [...this.objects.values()].reduce((sum, entry) => sum + entry.bytes.length, 0) +
      [...this.uploads.values()].reduce((sum, upload) => sum + [...upload.parts.values()].reduce((partSum, part) => partSum + part.bytes.length, 0), 0);
  }
  seed(key: string, bytes: Buffer, contentType = "video/mp4"): void {
    this.scope.key({ key });
    if (this.storedBytes() - (this.objects.get(key)?.bytes.length ?? 0) + bytes.length > this.maxStoredBytes) throw new HttpError("PAYLOAD_TOO_LARGE");
    this.objects.set(key, { bytes: Buffer.from(bytes), metadata: { sizeBytes: bytes.length, contentType,
      etag: createHash("sha256").update(bytes).digest("hex") } });
  }
  async head(input: Parameters<StorageAdapter["head"]>[0]) {
    checkAborted(input.signal);
    const entry = this.objects.get(this.scope.key(input.object));
    if (!entry) throw new HttpError("NOT_FOUND");
    return { ...entry.metadata };
  }
  async openRead(input: Parameters<StorageAdapter["openRead"]>[0]) {
    const metadata = await this.head(input);
    const entry = this.objects.get(input.object.key)!;
    const range = input.range ?? null;
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
      range.start < 0 || range.end < range.start || range.end >= metadata.sizeBytes)) throw new HttpError("RANGE_NOT_SATISFIABLE");
    this.reads.push({ key: input.object.key, range });
    const bytes = range ? entry.bytes.subarray(range.start, range.end + 1) : entry.bytes;
    const stream = Readable.from((function* () { for (let offset = 0; offset < bytes.length; offset += 16_384) yield bytes.subarray(offset, offset + 16_384); })());
    const abort = () => { this.abortedReads++; stream.destroy(new Error("aborted")); };
    input.signal.addEventListener("abort", abort, { once: true });
    stream.once("close", () => input.signal.removeEventListener("abort", abort));
    return { stream, metadata, range };
  }
  async createMultipart(input: Parameters<StorageAdapter["createMultipart"]>[0]) {
    checkAborted(input.signal);
    const key = this.scope.key(input.object);
    if (this.objects.has(key)) throw new HttpError("UPLOAD_STATE_CONFLICT");
    const uploadId = randomUUID();
    this.uploads.set(uploadId, { key, contentType: input.contentType, parts: new Map() });
    return { uploadId };
  }
  async putImage(input: { object: import("../../../core/contracts/index.js").StorageObjectRef; bytes: Buffer; contentType: "image/jpeg"; signal: AbortSignal }): Promise<StorageMetadata> {
    checkAborted(input.signal);
    const key = this.scope.key(input.object);
    if (this.objects.has(key)) throw new HttpError("UPLOAD_STATE_CONFLICT");
    if (input.bytes.length < 1 || input.bytes.length > 1024 * 1024 || input.contentType !== "image/jpeg") throw new HttpError("VALIDATION_ERROR");
    this.seed(key, input.bytes, input.contentType);
    return this.head(input);
  }
  async uploadPart(input: Parameters<StorageAdapter["uploadPart"]>[0]) {
    checkAborted(input.signal);
    const entry = this.uploads.get(input.uploadId);
    if (!entry || entry.key !== this.scope.key(input.object)) throw new HttpError("NOT_FOUND");
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of input.stream) {
      checkAborted(input.signal); const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
      if (size > input.sizeBytes || size > this.maxStoredBytes) throw new HttpError("PAYLOAD_TOO_LARGE");
      chunks.push(bytes);
    }
    if (size !== input.sizeBytes) throw new HttpError("FILE_MISMATCH");
    if (this.storedBytes() - (entry.parts.get(input.partNumber)?.bytes.length ?? 0) + size > this.maxStoredBytes) throw new HttpError("PAYLOAD_TOO_LARGE");
    const bytes = Buffer.concat(chunks); const etag = createHash("md5").update(bytes).digest("hex");
    entry.parts.set(input.partNumber, { bytes, etag }); return { etag };
  }
  async completeMultipart(input: Parameters<StorageAdapter["completeMultipart"]>[0]) {
    checkAborted(input.signal);
    const entry = this.uploads.get(input.uploadId);
    if (!entry || entry.key !== this.scope.key(input.object)) throw new HttpError("NOT_FOUND");
    if (this.objects.has(entry.key)) throw new HttpError("UPLOAD_STATE_CONFLICT");
    const bytes = input.parts.map((part: StoredPart) => {
      const actual = entry.parts.get(part.partNumber);
      if (!actual || actual.etag !== part.etag || actual.bytes.length !== part.sizeBytes) throw new HttpError("FILE_MISMATCH");
      return actual.bytes;
    });
    if (bytes.reduce((sum, part) => sum + part.length, 0) > this.maxStoredBytes) throw new HttpError("PAYLOAD_TOO_LARGE");
    this.seed(entry.key, Buffer.concat(bytes), entry.contentType); return this.head(input);
  }
  async list(input: Parameters<StorageAdapter["list"]>[0]) {
    checkAborted(input.signal); const prefix = this.scope.subprefix(input.prefix);
    const keys = [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new HttpError("VALIDATION_ERROR");
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError("VALIDATION_ERROR");
    const slice = keys.slice(offset, offset + input.limit);
    return { items: slice.map(key => ({ object: { key }, fileName: key.split("/").at(-1)!, metadata: { ...this.objects.get(key)!.metadata } })),
      nextCursor: offset + slice.length < keys.length ? String(offset + slice.length) : null };
  }
}

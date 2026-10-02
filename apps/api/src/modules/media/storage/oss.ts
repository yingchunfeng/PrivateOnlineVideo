import { readFile } from "node:fs/promises";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Readable } from "node:stream";
import type { StorageAdapter, StorageMetadata } from "../../../core/contracts/index.js";
import { HttpError } from "../../../core/errors.js";
import { ObjectScope, checkAborted } from "./scope.js";

export interface OssCredentials { accessKeyId: string; accessKeySecret: string; stsToken?: string }
export interface OssOptions {
  bucket: string;
  region: "cn-hangzhou";
  endpoint: string;
  objectPrefix: string;
  network: "internal" | "public";
  /** 公网需显式确认；不会从内网失败自动回退。 */
  allowPublicNetwork?: boolean;
  credentialFile: string;
}
interface OssResponse { status?: number; headers: Record<string, string | number | undefined> }
export interface OssClient {
  head(key: string): Promise<{ res: OssResponse }>;
  getStream(key: string, options: { headers?: Record<string, string> }): Promise<{ stream: Readable; res: OssResponse }>;
  initMultipartUpload(key: string, options: { headers: Record<string, string> }): Promise<{ uploadId: string }>;
  uploadPart(key: string, uploadId: string, partNumber: number, stream: Readable, start: number, end: number): Promise<{ etag: string }>;
  completeMultipartUpload(key: string, uploadId: string, parts: { number: number; etag: string }[], options: { headers: Record<string, string> }): Promise<{ res: OssResponse }>;
  listV2(query: { prefix: string; "max-keys": number; "continuation-token"?: string }, options: object): Promise<{
    objects?: { name: string; size: number; etag: string }[]; nextContinuationToken?: string; isTruncated?: boolean;
  }>;
  cancel(): void;
}
export type OssClientFactory = (options: { region: string; bucket: string; endpoint: string; authorizationV4: true; timeout: number;
  agent: HttpAgent; httpsAgent: HttpsAgent } & OssCredentials) => OssClient;

export function validateOssOptions(options: OssOptions): void {
  new ObjectScope(options.objectPrefix);
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket) || options.region !== "cn-hangzhou" || !options.credentialFile) throw new HttpError("SERVICE_NOT_CONFIGURED");
  let url: URL; try { url = new URL(options.endpoint); } catch { throw new HttpError("SERVICE_NOT_CONFIGURED"); }
  const expected = options.network === "internal" ? "oss-cn-hangzhou-internal.aliyuncs.com" : "oss-cn-hangzhou.aliyuncs.com";
  if (!["internal", "public"].includes(options.network) || url.protocol !== "https:" || url.hostname !== expected || url.port ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash || (options.network === "public" && options.allowPublicNetwork !== true)) {
    throw new HttpError("SERVICE_NOT_CONFIGURED");
  }
}
function metadata(res: OssResponse): StorageMetadata {
  const sizeBytes = Number(res.headers["content-length"]);
  const etag = String(res.headers.etag ?? ""); const contentType = String(res.headers["content-type"] ?? "application/octet-stream");
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !etag) throw new HttpError("STORAGE_UNAVAILABLE");
  return { sizeBytes, etag, contentType };
}

/** 每个 I/O 独享 client：cancel 不会中止其他播放器、上传或探针。 */
export class OssStorageAdapter implements StorageAdapter {
  readonly driver = "oss" as const;
  readonly scope: ObjectScope;
  constructor(readonly options: OssOptions, readonly clientFactory: OssClientFactory,
    readonly credentials: () => Promise<OssCredentials>) { validateOssOptions(options); this.scope = new ObjectScope(options.objectPrefix); }
  private async client(signal: AbortSignal) {
    checkAborted(signal); const credentials = await this.credentials(); checkAborted(signal);
    if (!credentials.accessKeyId || !credentials.accessKeySecret) throw new HttpError("SERVICE_NOT_CONFIGURED");
    const agent = new HttpAgent({ keepAlive: false, maxSockets: 1 });
    const httpsAgent = new HttpsAgent({ keepAlive: false, maxSockets: 1 });
    const dispose = () => { agent.destroy(); httpsAgent.destroy(); };
    try {
      return { client: this.clientFactory({ ...credentials, bucket: this.options.bucket, region: this.options.region,
        endpoint: this.options.endpoint, authorizationV4: true, timeout: 60_000, agent, httpsAgent }), dispose };
    } catch { dispose(); throw new HttpError("SERVICE_NOT_CONFIGURED"); }
  }
  private async call<T>(signal: AbortSignal, operation: (client: OssClient) => Promise<T>): Promise<T> {
    const { client, dispose } = await this.client(signal);
    const abort = () => { client.cancel(); dispose(); }; signal.addEventListener("abort", abort, { once: true });
    let streaming = false;
    try {
      checkAborted(signal); const result = await operation(client); checkAborted(signal);
      const stream = (result as { stream?: Readable } | null)?.stream;
      if (stream) {
        streaming = true;
        stream.once("close", () => { signal.removeEventListener("abort", abort); dispose(); });
      }
      return result;
    }
    catch (error) {
      if (error instanceof HttpError) throw error;
      if ((error as { status?: number; code?: string }).status === 404 || (error as { code?: string }).code === "NoSuchKey") throw new HttpError("NOT_FOUND");
      throw new HttpError("STORAGE_UNAVAILABLE");
    } finally { if (!streaming) { signal.removeEventListener("abort", abort); dispose(); } }
  }
  async head(input: Parameters<StorageAdapter["head"]>[0]) {
    const key = this.scope.key(input.object); return this.call(input.signal, async client => metadata((await client.head(key)).res));
  }
  async openRead(input: Parameters<StorageAdapter["openRead"]>[0]) {
    const key = this.scope.key(input.object);
    return this.call(input.signal, async client => {
      const meta = metadata((await client.head(key)).res); const range = input.range ?? null;
      if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= meta.sizeBytes)) throw new HttpError("RANGE_NOT_SATISFIABLE");
      const result = await client.getStream(key, { ...(range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {}) });
      const expected = range ? range.end - range.start + 1 : meta.sizeBytes;
      if (Number(result.res.headers["content-length"]) !== expected || String(result.res.headers.etag) !== meta.etag ||
        (range && (result.res.status !== 206 || result.res.headers["content-range"] !== `bytes ${range.start}-${range.end}/${meta.sizeBytes}`))) {
        result.stream.destroy(); client.cancel(); throw new HttpError("STORAGE_UNAVAILABLE");
      }
      const abort = () => { client.cancel(); result.stream.destroy(new Error("aborted")); };
      input.signal.addEventListener("abort", abort, { once: true });
      result.stream.once("close", () => input.signal.removeEventListener("abort", abort));
      if (input.signal.aborted) abort();
      return { stream: result.stream, metadata: meta, range };
    });
  }
  async createMultipart(input: Parameters<StorageAdapter["createMultipart"]>[0]) {
    const key = this.scope.key(input.object);
    return this.call(input.signal, client => client.initMultipartUpload(key, { headers: { "Content-Type": input.contentType, "x-oss-forbid-overwrite": "true" } }));
  }
  async uploadPart(input: Parameters<StorageAdapter["uploadPart"]>[0]) {
    const key = this.scope.key(input.object);
    return this.call(input.signal, client => client.uploadPart(key, input.uploadId, input.partNumber, input.stream, 0, input.sizeBytes));
  }
  async completeMultipart(input: Parameters<StorageAdapter["completeMultipart"]>[0]) {
    const key = this.scope.key(input.object);
    return this.call(input.signal, async client => {
      await client.completeMultipartUpload(key, input.uploadId,
        [...input.parts].sort((a, b) => a.partNumber - b.partNumber).map(part => ({ number: part.partNumber, etag: part.etag })),
        { headers: { "x-oss-forbid-overwrite": "true" } });
      return metadata((await client.head(key)).res);
    });
  }
  async list(input: Parameters<StorageAdapter["list"]>[0]) {
    const prefix = this.scope.subprefix(input.prefix);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new HttpError("VALIDATION_ERROR");
    return this.call(input.signal, async client => {
      const result = await client.listV2({ prefix, "max-keys": input.limit,
        ...(input.cursor ? { "continuation-token": input.cursor } : {}) }, {});
      const items = (result.objects ?? []).map(object => {
        this.scope.key({ key: object.name }); if (!object.name.startsWith(prefix)) throw new HttpError("FORBIDDEN");
        if (!Number.isSafeInteger(object.size) || object.size < 0) throw new HttpError("STORAGE_UNAVAILABLE");
        return { object: { key: object.name }, fileName: object.name.split("/").at(-1)!,
          metadata: { sizeBytes: object.size, etag: object.etag, contentType: "application/octet-stream" } };
      });
      return { items, nextCursor: result.isTruncated ? result.nextContinuationToken ?? null : null };
    });
  }
}

/** 仅服务端运行时读 secret；函数调用才加载 SDK，不在模块导入时访问网络或凭证。 */
export async function createOssStorageAdapter(options: OssOptions): Promise<OssStorageAdapter> {
  validateOssOptions(options);
  const { default: OSS } = await import("ali-oss");
  return new OssStorageAdapter(options, input => new OSS(input) as unknown as OssClient, async () => {
    const bytes = await readFile(options.credentialFile);
    if (bytes.length > 16_384) throw new HttpError("SERVICE_NOT_CONFIGURED");
    try {
      const value = JSON.parse(bytes.toString("utf8")) as OssCredentials;
      if (typeof value.accessKeyId !== "string" || typeof value.accessKeySecret !== "string" ||
        (value.stsToken !== undefined && typeof value.stsToken !== "string")) throw new Error("invalid secret");
      return value;
    } catch { throw new HttpError("SERVICE_NOT_CONFIGURED"); }
  });
}

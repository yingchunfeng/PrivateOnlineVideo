import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { StorageAdapter, StorageMetadata, StorageObjectRef, StsCredentialProvider, CredentialPurpose } from "../../../core/contracts/index.js";
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
  credentialFile?: string;
  /** 简化公共播放仅对本次新上传对象设为公共读，服务端可使用已有长期凭据。 */
  publicUploads?: boolean;
  /** 仅隔离回归允许旧 key；真实 OSS 永远要求完整登记身份。 */
  allowLegacyTestObjects?: boolean;
}
interface OssResponse { status?: number; headers: Record<string, string | number | undefined> }
export interface OssClient {
  put?(key: string, bytes: Buffer, options: { headers: Record<string, string> }): Promise<{ res: OssResponse }>;
  head(key: string, options?: { versionId?: string }): Promise<{ res: OssResponse }>;
  getStream(key: string, options: { headers?: Record<string, string>; subres?: { versionId: string } }): Promise<{ stream: Readable; res: OssResponse }>;
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
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket) || options.region !== "cn-hangzhou") throw new HttpError("SERVICE_NOT_CONFIGURED");
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
  return { sizeBytes, etag, contentType, versionId: res.headers["x-oss-version-id"] ? String(res.headers["x-oss-version-id"]) : null };
}

/** 每个 I/O 独享 client：cancel 不会中止其他播放器、上传或探针。 */
export class OssStorageAdapter implements StorageAdapter {
  readonly driver = "oss" as const;
  readonly scope: ObjectScope;
  constructor(readonly options: OssOptions, readonly clientFactory: OssClientFactory,
    readonly credentials: (purpose: CredentialPurpose, signal: AbortSignal) => Promise<OssCredentials>) { validateOssOptions(options); this.scope = new ObjectScope(options.objectPrefix); }
  private object(object: StorageObjectRef): string {
    const key = this.scope.key(object);
    if (object.kind === "registered") {
      if (object.provider !== "oss" || object.bucket !== this.options.bucket || object.region !== this.options.region ||
        object.verificationStatus === "unavailable" || (object.versionId !== null && (!object.versionId || /[\x00-\x1f]/.test(object.versionId)))) throw new HttpError("FORBIDDEN");
    } else if (this.options.allowLegacyTestObjects !== true) throw new HttpError("SERVICE_NOT_CONFIGURED");
    return key;
  }
  private async client(signal: AbortSignal, purpose: CredentialPurpose) {
    checkAborted(signal); const credentials = await this.credentials(purpose, signal); checkAborted(signal);
    if (!credentials.accessKeyId || !credentials.accessKeySecret ||
      (!credentials.stsToken && !this.options.allowLegacyTestObjects && !this.options.publicUploads)) throw new HttpError("SERVICE_NOT_CONFIGURED");
    const agent = new HttpAgent({ keepAlive: false, maxSockets: 1 });
    const httpsAgent = new HttpsAgent({ keepAlive: false, maxSockets: 1 });
    const dispose = () => { agent.destroy(); httpsAgent.destroy(); };
    try {
      return { client: this.clientFactory({ ...credentials, bucket: this.options.bucket, region: `oss-${this.options.region}`,
        endpoint: this.options.endpoint, authorizationV4: true, timeout: 60_000, agent, httpsAgent }), dispose };
    } catch { dispose(); throw new HttpError("SERVICE_NOT_CONFIGURED"); }
  }
  private async call<T>(signal: AbortSignal, operation: (client: OssClient) => Promise<T>, purpose: CredentialPurpose = "upload"): Promise<T> {
    const { client, dispose } = await this.client(signal, purpose);
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
      if (this.options.publicUploads && ((error as { status?: number }).status === 403 ||
        ["AccessDenied", "AccessForbidden"].includes((error as { code?: string }).code ?? ""))) throw new HttpError("STORAGE_PERMISSION_DENIED");
      throw new HttpError("STORAGE_UNAVAILABLE");
    } finally { if (!streaming) { signal.removeEventListener("abort", abort); dispose(); } }
  }
  async head(input: Parameters<StorageAdapter["head"]>[0]) {
    const key = this.object(input.object); return this.call(input.signal, async client => {
      const result = metadata((await client.head(key, input.object.kind === "registered" && input.object.versionId ? { versionId: input.object.versionId } : {})).res);
      if (input.object.kind === "registered" && (input.object.verificationStatus === "verified" || input.object.versionId !== null) && input.object.versionId !== result.versionId) throw new HttpError("FILE_MISMATCH");
      return result;
    }, "read");
  }
  async openRead(input: Parameters<StorageAdapter["openRead"]>[0]) {
    const key = this.object(input.object);
    return this.call(input.signal, async client => {
      const versionId = input.object.kind === "registered" ? input.object.versionId : null;
      const meta = metadata((await client.head(key, versionId ? { versionId } : {})).res); const range = input.range ?? null;
      if (input.object.kind === "registered" && versionId !== meta.versionId) throw new HttpError("FILE_MISMATCH");
      if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= meta.sizeBytes)) throw new HttpError("RANGE_NOT_SATISFIABLE");
      const result = await client.getStream(key, { ...(versionId ? { subres: { versionId } } : {}), ...(range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {}) });
      const expected = range ? range.end - range.start + 1 : meta.sizeBytes;
      if (Number(result.res.headers["content-length"]) !== expected || String(result.res.headers.etag) !== meta.etag ||
        (input.object.kind === "registered" && (result.res.headers["x-oss-version-id"] ?? null) !== versionId) ||
        (range && (result.res.status !== 206 || result.res.headers["content-range"] !== `bytes ${range.start}-${range.end}/${meta.sizeBytes}`))) {
        result.stream.destroy(); client.cancel(); throw new HttpError("STORAGE_UNAVAILABLE");
      }
      const abort = () => { client.cancel(); result.stream.destroy(new Error("aborted")); };
      input.signal.addEventListener("abort", abort, { once: true });
      result.stream.once("close", () => input.signal.removeEventListener("abort", abort));
      if (input.signal.aborted) abort();
      return { stream: result.stream, metadata: meta, range };
    }, "read");
  }
  async createMultipart(input: Parameters<StorageAdapter["createMultipart"]>[0]) {
    const key = this.object(input.object);
    return this.call(input.signal, client => client.initMultipartUpload(key, { headers: { "Content-Type": input.contentType,
      "x-oss-forbid-overwrite": "true", ...(this.options.publicUploads ? { "x-oss-object-acl": "public-read" } : {}) } }));
  }
  /** 只创建新封面对象，拒绝覆盖已核验对象；不提供旧对象或 Bucket 权限修改入口。 */
  async putImage(input: { object: StorageObjectRef; bytes: Buffer; contentType: "image/jpeg"; signal: AbortSignal }): Promise<StorageMetadata> {
    const key = this.object(input.object);
    if (!this.options.publicUploads || input.object.kind !== "registered" || input.object.verificationStatus !== "pending" ||
      input.object.versionId !== null || input.contentType !== "image/jpeg" || input.bytes.length < 1 || input.bytes.length > 1024 * 1024) {
      throw new HttpError("UPLOAD_STATE_CONFLICT");
    }
    return this.call(input.signal, async client => {
      if (!client.put) throw new HttpError("SERVICE_NOT_CONFIGURED");
      await client.put(key, input.bytes, { headers: { "Content-Type": input.contentType,
        "x-oss-forbid-overwrite": "true", "x-oss-object-acl": "public-read" } });
      const result = metadata((await client.head(key)).res);
      if (result.sizeBytes !== input.bytes.length || result.contentType.split(";")[0] !== input.contentType) throw new HttpError("FILE_MISMATCH");
      return result;
    });
  }
  async uploadPart(input: Parameters<StorageAdapter["uploadPart"]>[0]) {
    const key = this.object(input.object);
    return this.call(input.signal, client => client.uploadPart(key, input.uploadId, input.partNumber, input.stream, 0, input.sizeBytes));
  }
  async completeMultipart(input: Parameters<StorageAdapter["completeMultipart"]>[0]) {
    const key = this.object(input.object);
    if (input.object.kind === "registered" && (input.object.verificationStatus !== "pending" || input.object.versionId !== null)) throw new HttpError("UPLOAD_STATE_CONFLICT");
    return this.call(input.signal, async client => {
      await client.completeMultipartUpload(key, input.uploadId,
        [...input.parts].sort((a, b) => a.partNumber - b.partNumber).map(part => ({ number: part.partNumber, etag: part.etag })),
        // ACL 仅作用于本次唯一新对象，旧对象、Bucket 和策略保持原值。
        { headers: { "x-oss-forbid-overwrite": "true", "x-oss-object-acl": this.options.publicUploads ? "public-read" : "private" } });
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
        return { object: { kind: "registered" as const, id: "", provider: "oss" as const, bucket: this.options.bucket,
          region: this.options.region, key: object.name, versionId: null, verificationStatus: "pending" as const }, fileName: object.name.split("/").at(-1)!,
          metadata: { sizeBytes: object.size, etag: object.etag, contentType: "application/octet-stream", versionId: null } };
      });
      return { items, nextCursor: result.isTruncated ? result.nextContinuationToken ?? null : null };
    }, "import");
  }
}

/** 仅服务端运行时读 secret；函数调用才加载 SDK，不在模块导入时访问网络或凭证。 */
export async function createOssStorageAdapter(options: OssOptions, credentials: StsCredentialProvider): Promise<OssStorageAdapter> {
  validateOssOptions(options);
  if (typeof credentials?.get !== "function" || options.allowLegacyTestObjects) throw new HttpError("SERVICE_NOT_CONFIGURED");
  const { default: OSS } = await import("ali-oss");
  return new OssStorageAdapter(options, input => new OSS(input) as unknown as OssClient,
    (purpose, signal) => credentials.get({ purpose, signal }));
}

/** 简化模式由服务端读取已有受保护 AK 文件，不调用 AssumeRole 或下发浏览器凭据。 */
export async function createDirectOssStorageAdapter(options: OssOptions): Promise<OssStorageAdapter> {
  validateOssOptions(options);
  if (!options.credentialFile || options.publicUploads !== true || options.allowLegacyTestObjects) throw new HttpError("SERVICE_NOT_CONFIGURED");
  let credentials: OssCredentials;
  try {
    const secret = await readFile(options.credentialFile);
    if (secret.length > 16_384) throw new Error("invalid secret");
    const parsed = JSON.parse(secret.toString("utf8")) as Partial<OssCredentials>;
    if (typeof parsed.accessKeyId !== "string" || typeof parsed.accessKeySecret !== "string" ||
      !parsed.accessKeyId || !parsed.accessKeySecret) throw new Error("invalid secret");
    credentials = { accessKeyId: parsed.accessKeyId, accessKeySecret: parsed.accessKeySecret };
  } catch { throw new HttpError("SERVICE_NOT_CONFIGURED"); }
  const { default: OSS } = await import("ali-oss");
  return new OssStorageAdapter(options, input => new OSS(input) as unknown as OssClient, async (_purpose, signal) => {
    checkAborted(signal); return { ...credentials };
  });
}

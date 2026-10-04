import type { PresignedSourceProvider, StsCredentialProvider, SignedSource } from "../../../core/contracts/index.js";
import { HttpError } from "../../../core/errors.js";
import { checkAborted, ObjectScope } from "./scope.js";

export interface OssSigningOptions {
  bucket: string; region: "cn-hangzhou"; endpoint: string; objectPrefix: string;
  ttlSeconds: number; safetySeconds: number; renewBeforeSeconds: number;
  /** 仅本地协议测试可使用回环 HTTP；正式配置永远 HTTPS。 */
  kind?: "test" | "production";
}
export interface OssSigningClient {
  signatureUrlV4(method: "GET", expires: number, request: { queries: Record<string, string> }, key: string): Promise<string>;
}
export type OssSigningClientFactory = (input: { bucket: string; region: string; endpoint: string; cname: true;
  authorizationV4: true; accessKeyId: string; accessKeySecret: string; stsToken: string }) => OssSigningClient;

export function safeDownloadFileName(value: string): string {
  const name = value.normalize("NFKC").replace(/[\\/\x00-\x1f\x7f:"<>|?*]/g, "_").trim().replace(/[. ]+$/g, "").slice(0, 180);
  return name && name !== "." && name !== ".." ? name : "video";
}
function validate(options: OssSigningOptions): URL {
  new ObjectScope(options.objectPrefix);
  let endpoint: URL; try { endpoint = new URL(options.endpoint); } catch { throw new HttpError("SERVICE_NOT_CONFIGURED"); }
  const test = options.kind === "test" && endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1";
  if ((!test && endpoint.protocol !== "https:") || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
    (!test && endpoint.port) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket) || options.region !== "cn-hangzhou" ||
    ![options.ttlSeconds, options.safetySeconds, options.renewBeforeSeconds].every(value => Number.isSafeInteger(value) && value > 0) ||
    options.ttlSeconds > 3600 || options.safetySeconds >= options.ttlSeconds || options.renewBeforeSeconds > 3600) throw new HttpError("SERVICE_NOT_CONFIGURED");
  return endpoint;
}

/** 与上传 Endpoint 完全独立，只用读取 STS、已核验对象、V4 GET 和固定 CNAME。 */
export class OssPresignedSourceProvider implements PresignedSourceProvider {
  private readonly endpoint: URL;
  private readonly scope: ObjectScope;
  constructor(readonly options: OssSigningOptions, private readonly credentials: StsCredentialProvider,
    private readonly factory: OssSigningClientFactory, private readonly now: () => Date = () => new Date()) {
    this.endpoint = validate(options); this.scope = new ObjectScope(options.objectPrefix);
  }
  async sign(input: Parameters<PresignedSourceProvider["sign"]>[0]): Promise<SignedSource> {
    checkAborted(input.signal); const key = this.scope.key(input.object);
    if (input.object.kind !== "registered" || input.object.provider !== "oss" || !input.object.id ||
      input.object.verificationStatus !== "verified" || input.object.bucket !== this.options.bucket || input.object.region !== this.options.region ||
      (input.object.versionId !== null && (!input.object.versionId || /[\x00-\x1f]/.test(input.object.versionId)))) throw new HttpError("FORBIDDEN");
    try {
      const credentials = await this.credentials.get({ purpose: "read", signal: input.signal }); checkAborted(input.signal);
      const now = this.now().getTime(); const expiration = Date.parse(credentials.expiration);
      const ttl = Math.min(this.options.ttlSeconds, Math.floor((expiration - now) / 1000) - this.options.safetySeconds);
      if (!credentials.stsToken || !credentials.accessKeyId || !credentials.accessKeySecret || !Number.isSafeInteger(ttl) || ttl < 2) throw new HttpError("STORAGE_UNAVAILABLE");
      const client = this.factory({ bucket: input.object.bucket, region: `oss-${input.object.region}`, endpoint: this.options.endpoint,
        cname: true, authorizationV4: true, accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret, stsToken: credentials.stsToken });
      const queries: Record<string, string> = {};
      if (input.object.versionId) queries.versionId = input.object.versionId;
      if (input.purpose === "download") {
        const name = safeDownloadFileName(input.fileName ?? "video");
        const encoded = encodeURIComponent(name).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
        queries["response-content-disposition"] = `attachment; filename="video"; filename*=UTF-8''${encoded}`;
      } else if (input.purpose === "playback") {
        // GetObject仅支持指定的响应头覆盖，Content-Type不能通过query改写。
        queries["response-content-disposition"] = "inline";
      } else throw new HttpError("VALIDATION_ERROR");
      const sourceUrl = await client.signatureUrlV4("GET", ttl, { queries }, key); checkAborted(input.signal);
      const url = new URL(sourceUrl);
      const date = url.searchParams.get("x-oss-date") ?? "";
      if (url.origin !== this.endpoint.origin || decodeURIComponent(url.pathname.slice(1)) !== key ||
        url.searchParams.get("x-oss-signature-version") !== "OSS4-HMAC-SHA256" || url.searchParams.get("x-oss-security-token") !== credentials.stsToken ||
        Number(url.searchParams.get("x-oss-expires")) !== ttl || !/^\d{8}T\d{6}Z$/.test(date)) throw new HttpError("STORAGE_UNAVAILABLE");
      const signedAt = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
      const expires = signedAt + ttl * 1000;
      if (Math.abs(signedAt - now) > 30_000 || expires <= now || expires > expiration - this.options.safetySeconds * 1000) throw new HttpError("STORAGE_UNAVAILABLE");
      const renew = expires - now > this.options.renewBeforeSeconds * 1000
        ? expires - this.options.renewBeforeSeconds * 1000 : now + Math.floor((expires - now) / 2);
      return { sourceUrl, sourceExpiresAt: new Date(expires).toISOString(), renewAfter: new Date(renew).toISOString() };
    } catch (error) { throw error instanceof HttpError ? error : new HttpError("STORAGE_UNAVAILABLE"); }
  }
}

export async function createOssPresignedSourceProvider(options: OssSigningOptions, credentials: StsCredentialProvider,
  now: () => Date = () => new Date()): Promise<OssPresignedSourceProvider> {
  if (options.kind === "test") throw new HttpError("SERVICE_NOT_CONFIGURED");
  const { default: OSS } = await import("ali-oss");
  return new OssPresignedSourceProvider(options, credentials, input => new OSS(input), now);
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { HttpError } from "../../../core/errors.js";
import { checkAborted } from "./scope.js";
import type { StsCredentialProvider } from "../../../core/contracts/index.js";
import { storageDiagnostic } from "./diagnostics.js";

export type OssCredentialPurpose = "upload" | "import" | "read";
export interface TemporaryOssCredentials {
  accessKeyId: string; accessKeySecret: string; stsToken: string; expiration: string;
}
export interface AssumeRoleResult {
  AccessKeyId: string; AccessKeySecret: string; SecurityToken: string; Expiration: string;
}
export interface StsCacheOptions {
  roleArn: string; bucket: string; objectPrefix: string;
  durationSeconds: number; refreshBeforeSeconds: number;
  diagnosticErrors?: boolean;
}
export type AssumeRole = (input: { roleArn: string; policy: string; durationSeconds: number;
  sessionName: string }) => Promise<AssumeRoleResult>;

/** 会话权限是已有角色权限的交集；本模块不创建角色或修改云端策略。 */
export function sessionPolicy(bucket: string, prefix: string, purpose: OssCredentialPurpose): string {
  const object = `acs:oss:*:*:${bucket}/${prefix}*`;
  // 已核验对象按 versionId 读取；角色与会话策略都必须允许版本读取。
  const actions = purpose === "upload" ? ["oss:GetObject", "oss:PutObject"]
    : purpose === "read" ? ["oss:GetObject", "oss:GetObjectVersion"] : ["oss:GetObject"];
  const Statement: object[] = [{ Effect: "Allow", Action: actions, Resource: [object] }];
  if (purpose === "import") Statement.push({ Effect: "Allow", Action: ["oss:ListObjects"],
    Resource: [`acs:oss:*:*:${bucket}`], Condition: { StringLike: { "oss:Prefix": [`${prefix}*`] } } });
  return JSON.stringify({ Version: "1", Statement });
}

/** 一个等待者取消只取消其等待，不取消其它请求共享的 AssumeRole 刷新。 */
async function waitFor<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  checkAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new HttpError("STORAGE_UNAVAILABLE"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export class StsCredentialCache implements StsCredentialProvider {
  private readonly cached = new Map<string, TemporaryOssCredentials>();
  private readonly pending = new Map<string, Promise<TemporaryOssCredentials>>();
  constructor(readonly options: StsCacheOptions, private readonly assumeRole: AssumeRole,
    private readonly now: () => Date = () => new Date()) {
    if (!/^acs:ram::\d+:role\/[A-Za-z0-9_./-]+$/.test(options.roleArn) ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket) ||
      !options.objectPrefix.endsWith("/") || !options.objectPrefix || /[\\%\x00-\x1f*?]/.test(options.objectPrefix) ||
      options.objectPrefix.split("/").some(part => part === "." || part === "..") ||
      !Number.isSafeInteger(options.durationSeconds) || options.durationSeconds < 900 || options.durationSeconds > 3600 ||
      !Number.isSafeInteger(options.refreshBeforeSeconds) || options.refreshBeforeSeconds < 1 || options.refreshBeforeSeconds >= options.durationSeconds) {
      throw new HttpError("SERVICE_NOT_CONFIGURED");
    }
  }
  async get(input: OssCredentialPurpose | { purpose: OssCredentialPurpose; signal: AbortSignal }, signal?: AbortSignal): Promise<TemporaryOssCredentials> {
    const purpose = typeof input === "string" ? input : input.purpose;
    signal = typeof input === "string" ? signal : input.signal;
    if (!["upload", "import", "read"].includes(purpose)) throw new HttpError("SERVICE_NOT_CONFIGURED");
    if (signal) checkAborted(signal);
    const policy = sessionPolicy(this.options.bucket, this.options.objectPrefix, purpose);
    const key = `${this.options.roleArn}:${purpose}:${createHash("sha256").update(policy).digest("hex")}`;
    const existing = this.cached.get(key);
    if (existing && Date.parse(existing.expiration) - this.now().getTime() > this.options.refreshBeforeSeconds * 1000) return { ...existing };
    let refresh = this.pending.get(key);
    if (!refresh) {
      refresh = (async () => {
        // pending.set 必须先发生；注入函数同步抛错也不能留下永久拒绝的缓存。
        await Promise.resolve();
        try {
          const result = await this.assumeRole({ roleArn: this.options.roleArn, policy,
            durationSeconds: this.options.durationSeconds, sessionName: `onlineVideo-${purpose}` });
          const expiry = Date.parse(result.Expiration);
          if (![result.AccessKeyId, result.AccessKeySecret, result.SecurityToken].every(value => typeof value === "string" && value.length > 0) ||
            !Number.isFinite(expiry) || expiry <= this.now().getTime() + 30_000) throw new HttpError("STORAGE_UNAVAILABLE");
          const credentials = { accessKeyId: result.AccessKeyId, accessKeySecret: result.AccessKeySecret,
            stsToken: result.SecurityToken, expiration: new Date(expiry).toISOString() };
          this.cached.set(key, credentials); return credentials;
        } catch (error) { throw this.options.diagnosticErrors ? storageDiagnostic(error, "sts") : new HttpError("STORAGE_UNAVAILABLE"); }
        finally { this.pending.delete(key); }
      })();
      this.pending.set(key, refresh);
    }
    try { return { ...await waitFor(refresh, signal) }; }
    catch (error) { if (this.options.diagnosticErrors && signal?.aborted) throw storageDiagnostic(signal.reason, "sts"); throw error; }
  }
}

/** 仅真实运行工厂调用时读服务端秘密；测试直接注入 AssumeRole，不接触本机 AK。 */
export async function createStsCredentialCache(input: Omit<StsCacheOptions, "roleArn"> & {
  credentialFile: string; roleArnFile?: string; roleArn?: string;
}, now: () => Date = () => new Date()): Promise<StsCredentialCache> {
  try {
    if (!!input.roleArn === !!input.roleArnFile) throw new Error("invalid role source");
    const [secret, arn] = await Promise.all([readFile(input.credentialFile), input.roleArnFile ? readFile(input.roleArnFile) : Promise.resolve(Buffer.from(input.roleArn!))]);
    if (secret.length > 16_384 || arn.length > 2048) throw new Error("invalid secret");
    const credentials = JSON.parse(secret.toString("utf8")) as { accessKeyId?: unknown; accessKeySecret?: unknown };
    if (typeof credentials.accessKeyId !== "string" || typeof credentials.accessKeySecret !== "string" ||
      !credentials.accessKeyId || !credentials.accessKeySecret) throw new Error("invalid secret");
    const { default: OSS } = await import("ali-oss");
    const sts = new OSS.STS({ accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret });
    return new StsCredentialCache({ ...input, roleArn: arn.toString("utf8").trim() }, async request =>
      (await sts.assumeRole(request.roleArn, request.policy, request.durationSeconds, request.sessionName)).credentials, now);
  } catch { throw new HttpError("SERVICE_NOT_CONFIGURED"); }
}

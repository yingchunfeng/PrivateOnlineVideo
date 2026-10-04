import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readConfig } from "../src/core/config.js";
import { StsCredentialCache } from "../src/modules/media/storage/sts.js";
import type { AssumeRole, OssCredentialPurpose } from "../src/modules/media/storage/sts.js";

// 真实调用必须有本轮具体授权；不打印SDK错误原文、凭据或签名请求参数。
process.env.DEBUG = "";
const directory = resolve(".local/acceptance/run-20261002-ces-private");
const reportFile = resolve(directory, `sts-preflight-${Date.now()}-${randomUUID()}.json`);
const safe = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : null;
let currentPurpose: OssCredentialPurpose | null = null;
let remoteError: { status: number | null; code: string | null; requestId: string | null } | null = null;
const results: object[] = [];
try {
  if (!process.argv.includes("--execute")) throw new Error("Explicit --execute required");
  const authorization = JSON.parse(await readFile(resolve(directory, "authorization.json"), "utf8"));
  const config = readConfig(); const oss = config.oss!;
  if (!authorization.cloudWrites || !authorization.newObjectPrivateAcl || authorization.bucket !== "xzlbucket" ||
    authorization.prefix !== "onlineVideo/acceptance/local/20261002-ces-private/" ||
    config.storageDriver !== "oss" || config.playbackMode !== "oss" || oss?.bucket !== authorization.bucket || oss.region !== "cn-hangzhou" ||
    !oss.allowPublicNetwork || oss.network !== "public" || oss.playbackEndpoint !== "https://oss.meetdawn.top" ||
    config.media?.uploadObjectPrefix !== authorization.prefix) throw new Error("Approved target does not match runtime");
  const bytes = await readFile(oss.credentialFile); if (bytes.length > 16384) throw new Error("Invalid credential file");
  const secret = JSON.parse(bytes.toString("utf8"));
  const roleArn = oss.roleArn ?? (await readFile(oss.roleArnFile!, "utf8")).trim();
  const { default: OSS } = await import("ali-oss");
  const sts = new OSS.STS({ accessKeyId: secret.accessKeyId, accessKeySecret: secret.accessKeySecret });
  const calls = new Map<string, number>();
  const assume: AssumeRole = async input => {
    try {
      calls.set(currentPurpose!, (calls.get(currentPurpose!) ?? 0) + 1);
      const result = await sts.assumeRole(input.roleArn, input.policy, input.durationSeconds, input.sessionName, { timeout: "30s" });
      return result.credentials;
    } catch (error) {
      const detail = error as { status?: number; code?: string; requestId?: string };
      remoteError = { status: Number.isInteger(detail.status) ? detail.status! : null, code: safe(detail.code), requestId: safe(detail.requestId) };
      throw new Error("STS request failed");
    }
  };
  const cache = new StsCredentialCache({ roleArn, bucket: oss.bucket, objectPrefix: authorization.prefix,
    durationSeconds: oss.stsDurationSeconds, refreshBeforeSeconds: oss.stsRefreshBeforeSeconds }, assume);
  for (const purpose of ["read", "upload", "import"] as const) {
    currentPurpose = purpose;
    const first = await cache.get({ purpose, signal: AbortSignal.timeout(35000) });
    const second = await cache.get({ purpose, signal: AbortSignal.timeout(35000) });
    results.push({ purpose, expiration: first.expiration, requestedSeconds: oss.stsDurationSeconds,
      calls: calls.get(purpose), cacheReused: first.accessKeyId === second.accessKeyId && first.expiration === second.expiration,
      remainingSeconds: Math.floor((Date.parse(first.expiration) - Date.now()) / 1000) });
  }
  const report = { state: "sts-preflight-passed", at: new Date().toISOString(), bucket: oss.bucket, prefix: authorization.prefix,
    purposeResults: results, objectWrites: 0, permissionChanges: 0 };
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportFile }));
} catch {
  const report = { state: "sts-preflight-failed", at: new Date().toISOString(), purpose: currentPurpose, remoteError,
    purposeResults: results, objectWrites: 0, permissionChanges: 0 };
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportFile })); process.exitCode = 1;
}

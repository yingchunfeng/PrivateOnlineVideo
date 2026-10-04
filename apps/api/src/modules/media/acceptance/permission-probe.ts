import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { guardLocalFile } from "../../../db/database.js";
import { readConfig } from "../../../core/config.js";
import { createStsCredentialCache, sessionPolicy } from "../storage/sts.js";

const PREFIX = "onlineVideo/acceptance/local/20261002-ces-private/";
interface Authorization {
  approvedAt: string; userMessage: string; plan: string; bucket: string; region: string; prefix: string;
  maximumVideoObjects: number; maximumProbeBytes: number; cloudWrites: boolean; databaseWrites: boolean;
  publicEgress: boolean; privateObjectRead: boolean; newObjectPrivateAcl: boolean; retainObjects: boolean;
}
interface ProbeResult { code: string; status: number | null; requestId: string | null; targetKey: string;
  bytes: number; readPolicyHash: string; readExpiration: string }
function safeError(error: unknown): { code: string; status: number | null; requestId: string | null } {
  const value = error as { code?: unknown; status?: unknown; requestId?: unknown } | null;
  return { code: typeof value?.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.code) ? value.code : "PROBE_FAILED",
    status: typeof value?.status === "number" && Number.isInteger(value.status) ? value.status : null,
    requestId: typeof value?.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.requestId) ? value.requestId : null };
}
export function validatePermissionAuthorization(value: Authorization): void {
  if (value.bucket !== "xzlbucket" || value.region !== "cn-hangzhou" || value.prefix !== PREFIX || value.maximumVideoObjects !== 2 ||
    value.maximumProbeBytes !== 1 || value.plan !== "docs/STAGE2_CLOUD_ACCEPTANCE_PLAN.md" || !value.userMessage?.trim() ||
    !Number.isFinite(Date.parse(value.approvedAt)) || [value.cloudWrites, value.databaseWrites, value.publicEgress,
      value.privateObjectRead, value.newObjectPrivateAcl, value.retainObjects].some(item => item !== true)) throw Object.assign(new Error(), { code: "AUTHORIZATION_SCOPE_REJECTED" });
}
async function optionalJson(path: string): Promise<any | null> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error; }
}
const policyHash = (purpose: "read" | "import") => createHash("sha256").update(sessionPolicy("xzlbucket", PREFIX, purpose)).digest("hex");

export async function runPermissionProbe(authorizationPath: string, execute: boolean): Promise<object> {
  process.env.DEBUG = "";
  const path = guardLocalFile(authorizationPath);
  const directory = dirname(path);
  if (resolve(path) !== resolve(directory, "authorization.json") || !directory.endsWith("run-20261002-ces-private")) throw Object.assign(new Error(), { code: "AUTHORIZATION_TARGET_REJECTED" });
  const authorization = JSON.parse(await readFile(path, "utf8")) as Authorization; validatePermissionAuthorization(authorization);
  if (!execute) return { code: "PREPARED", targetKey: `${PREFIX}read-only-put-probe-<unique>.bin`, bytes: 1,
    readPolicyHash: policyHash("read"), importPolicyHash: policyHash("import"), listPrefix: PREFIX, maximumListedItems: 10 };
  const finalPath = resolve(directory, "permission-result.json"); const priorFinal = await optionalJson(finalPath);
  if (priorFinal) return priorFinal;
  const config = readConfig(); const options = config.oss;
  if (!options || config.storageDriver !== "oss" || options.bucket !== authorization.bucket || options.region !== authorization.region ||
    options.network !== "public" || !options.allowPublicNetwork || options.endpoint !== "https://oss-cn-hangzhou.aliyuncs.com") throw Object.assign(new Error(), { code: "CONFIG_SCOPE_REJECTED" });
  const cache = await createStsCredentialCache({ bucket: options.bucket, objectPrefix: PREFIX, credentialFile: options.credentialFile,
    ...(options.roleArn ? { roleArn: options.roleArn } : {}), ...(options.roleArnFile ? { roleArnFile: options.roleArnFile } : {}),
    durationSeconds: options.stsDurationSeconds, refreshBeforeSeconds: options.stsRefreshBeforeSeconds });
  const { default: OSS } = await import("ali-oss");
  const client = async (purpose: "read" | "import") => {
    const credentials = await cache.get(purpose);
    const configuration = { ...credentials, bucket: options.bucket, region: `oss-${options.region}`, endpoint: options.endpoint,
      authorizationV4: true, timeout: 30_000, retryMax: 0, refreshSTSTokenInterval: 300_000,
      refreshSTSToken: async () => cache.get(purpose) };
    return { sdk: new OSS(configuration), expiration: credentials.expiration };
  };
  const intentPath = resolve(directory, "read-only-probe-intent.json"); const probePath = resolve(directory, "read-only-probe-result.json");
  const priorIntent = await optionalJson(intentPath); let probe = await optionalJson(probePath) as ProbeResult | null;
  if (priorIntent) {
    // 一旦已预留就禁止重复Put；只有已证明403的结果可继续未完成的只读List。
    if (!probe || probe.code !== "READ_STS_PUT_DENIED" || probe.status !== 403 || probe.targetKey !== priorIntent.targetKey) throw Object.assign(new Error(), { code: "PROBE_ALREADY_RESERVED_STOPPED" });
  } else {
    const read = await client("read"); const targetKey = `${PREFIX}read-only-put-probe-${randomUUID()}.bin`;
    await writeFile(intentPath, JSON.stringify({ targetKey, bytes: 1, reservedAt: new Date().toISOString(),
      authorizationReference: path, readPolicyHash: policyHash("read") }, null, 2), { encoding: "utf8", flag: "wx" });
    try {
      const response = await read.sdk.put(targetKey, Buffer.from([0]), { headers: { "Content-Type": "application/octet-stream",
        "x-oss-forbid-overwrite": "true", "x-oss-object-acl": "private" } });
      const headers = response.res.headers as Record<string, unknown>;
      probe = { code: "READ_STS_UNEXPECTED_PUT_SUCCESS", status: response.res.status, requestId: typeof headers["x-oss-request-id"] === "string" ? headers["x-oss-request-id"] as string : null,
        targetKey, bytes: 1, readPolicyHash: policyHash("read"), readExpiration: read.expiration };
    } catch (error) {
      const failure = safeError(error);
      probe = { ...failure, code: failure.status === 403 ? "READ_STS_PUT_DENIED" : failure.code,
        targetKey, bytes: 1, readPolicyHash: policyHash("read"), readExpiration: read.expiration };
    }
    await writeFile(probePath, JSON.stringify(probe, null, 2), { encoding: "utf8", flag: "wx" });
    if (probe.code !== "READ_STS_PUT_DENIED") return probe; // 意外成功/未知立即停止，不发List或清理。
  }
  const importing = await client("import");
  const listed = await importing.sdk.listV2({ prefix: PREFIX, "max-keys": 10 }, {});
  const objects = (listed.objects ?? []).map(object => {
    if (!object.name.startsWith(PREFIX) || !Number.isSafeInteger(object.size) || object.size < 0) throw Object.assign(new Error(), { code: "LIST_SCOPE_REJECTED" });
    return { key: object.name, sizeBytes: object.size };
  });
  if (listed.isTruncated) throw Object.assign(new Error(), { code: "LIST_TRUNCATED_STOPPED" });
  const result = { code: "PERMISSION_PROBE_COMPLETED", testedAt: new Date().toISOString(), probe,
    list: { status: listed.res.status, requestId: String((listed.res.headers as Record<string, unknown>)["x-oss-request-id"] ?? "") || null,
      prefix: PREFIX, objectCount: objects.length, totalSizeBytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0), objects,
      importPolicyHash: policyHash("import"), importExpiration: importing.expiration } };
  await writeFile(finalPath, JSON.stringify(result, null, 2), { encoding: "utf8", flag: "wx" }); return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const path = process.argv[2]; if (!path) throw Object.assign(new Error(), { code: "AUTHORIZATION_FILE_REQUIRED" });
    const result = await runPermissionProbe(path, process.argv.includes("--execute")) as { code?: string };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.code && !["PREPARED", "PERMISSION_PROBE_COMPLETED"].includes(result.code)) process.exitCode = 2;
  } catch (error) { process.stdout.write(`${JSON.stringify(safeError(error))}\n`); process.exitCode = 1; }
}

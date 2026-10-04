import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface AcceptanceManifest {
  apiOrigin: string; browserOrigin: string; mediaOrigin: string; authorizationReference: string;
  databaseFile: string; verifiedSchemaVersion: number; databaseBackupReference: string;
  sessionFile: string; sampleFile: string; sampleSha256: string; privateVideoId?: string;
  /** 与 privateVideoId 互斥；仅核验本轮授权上传的新唯一对象。 */
  verifyUploadedObjectPrivate?: boolean;
  categoryId: string; groupIds: string[]; tagIds: string[];
  uploadObjectPrefix: string;
  authorization: { cloudWrites: boolean; databaseWrites: boolean; publicEgress: boolean; privateObjectRead: boolean; retainObjects: boolean; newObjectPrivateAcl: boolean };
}
const MAX_SAMPLE_BYTES = 16 * 1024 * 1024;
/** 缺具体授权或目标不执行请求；不接受任意服务器、媒体域名或隐式真实库写入。 */
export function validateAcceptanceManifest(input: AcceptanceManifest): void {
  if (input.apiOrigin !== "http://127.0.0.1:3000" || input.browserOrigin !== "http://127.0.0.1:5173" ||
    input.mediaOrigin !== "https://oss.meetdawn.top" || !input.authorizationReference?.trim() ||
    !input.databaseFile || input.verifiedSchemaVersion !== 2 || !input.databaseBackupReference?.trim() ||
    !input.sessionFile || !input.sampleFile || !/^[a-f0-9]{64}$/.test(input.sampleSha256) || !input.categoryId ||
    (input.privateVideoId !== undefined && (typeof input.privateVideoId !== "string" || !input.privateVideoId.trim())) ||
    (input.verifyUploadedObjectPrivate !== undefined && typeof input.verifyUploadedObjectPrivate !== "boolean") ||
    (!!input.privateVideoId === (input.verifyUploadedObjectPrivate === true)) ||
    !/^onlineVideo\/acceptance\/local\/[A-Za-z0-9_-]+\/$/.test(input.uploadObjectPrefix) ||
    !Array.isArray(input.groupIds) || !Array.isArray(input.tagIds) || [input.groupIds, input.tagIds].some(ids =>
      ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id)) ||
    !input.authorization || ["cloudWrites", "databaseWrites", "publicEgress", "privateObjectRead", "retainObjects", "newObjectPrivateAcl"].some(key =>
      input.authorization[key as keyof AcceptanceManifest["authorization"]] !== true)) throw new Error("缺少具体目标/授权；未执行实云请求");
}
async function digestFile(path: string, start?: number, end?: number): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) })) hash.update(chunk);
  return hash.digest("hex");
}

export async function runAcceptance(manifest: AcceptanceManifest, execute: boolean): Promise<object> {
  validateAcceptanceManifest(manifest);
  if (!execute) return { state: "prepared", apiOrigin: manifest.apiOrigin, mediaOrigin: manifest.mediaOrigin,
    maximumSampleBytes: MAX_SAMPLE_BYTES, authorizationReference: manifest.authorizationReference,
    privateVerification: manifest.verifyUploadedObjectPrivate ? "本次新唯一对象" : "既有私有对象及本次新对象",
    actions: ["唯一新对象private ACL分片上传/登记", "私有对象匿名拒绝/签名Range", "播放/同会话续签/下载", "保留全部对象和任务"] };
  const file = resolve(manifest.sampleFile); const info = await stat(file);
  if (!info.isFile() || info.size < 1 || info.size > MAX_SAMPLE_BYTES || await digestFile(file) !== manifest.sampleSha256) throw new Error("样例大小或SHA-256与授权材料不一致；未执行请求");
  const sessionBytes = await readFile(manifest.sessionFile);
  if (sessionBytes.length > 16_384) throw new Error("会话文件不合法");
  const session = JSON.parse(sessionBytes.toString("utf8")) as { cookie?: unknown; csrfToken?: unknown };
  if (typeof session.cookie !== "string" || typeof session.csrfToken !== "string" || !session.cookie || !session.csrfToken || /[\r\n]/.test(session.cookie + session.csrfToken)) throw new Error("会话文件不合法");
  const headers = { cookie: session.cookie, "x-csrf-token": session.csrfToken, origin: manifest.browserOrigin };
  async function api(path: string, body?: object): Promise<any> {
    const response = await fetch(`${manifest.apiOrigin}${path}`, { method: body ? "POST" : "GET", headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(90_000) });
    const value = await response.json() as { data?: unknown; error?: { code?: string } };
    if (!response.ok || !value.data) throw new Error(`API验收失败：${response.status} ${value.error?.code ?? "INVALID_RESPONSE"}`);
    return value.data;
  }
  function source(value: { sourceUrl: string; sourceExpiresAt: string }): URL {
    const url = new URL(value.sourceUrl);
    if (url.origin !== manifest.mediaOrigin || !url.pathname.startsWith("/onlineVideo/") || url.username || url.password || url.hash ||
      url.searchParams.get("x-oss-signature-version") !== "OSS4-HMAC-SHA256" || !url.searchParams.get("x-oss-security-token") ||
      !Number.isFinite(Date.parse(value.sourceExpiresAt)) || Date.parse(value.sourceExpiresAt) <= Date.now() || Date.parse(value.sourceExpiresAt) - Date.now() > 3600_000) throw new Error("媒体授权目标或有效期异常");
    return url;
  }
  async function verifyPrivate(url: URL): Promise<number> {
    const anonymous = new URL(url); anonymous.search = "";
    const denied = await fetch(anonymous, { headers: { range: "bytes=0-0" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    const status = denied.status; await denied.body?.cancel();
    if (![401, 403].includes(status)) throw new Error(`私有对象匿名访问未拒绝：${status}；停止后续验收，保留已产生对象/记录`);
    const signed = await fetch(url, { headers: { range: "bytes=0-0" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (signed.status !== 206) { await signed.body?.cancel(); throw new Error("私有对象签名Range未通过；停止后续验收，保留对象/记录"); }
    if ((await signed.arrayBuffer()).byteLength !== 1) throw new Error("私有对象签名Range未通过；停止后续验收，保留对象/记录");
    return status;
  }
  const account = await api("/api/auth/me");
  const limits = await api("/api/settings/limits");
  if (limits.uploadObjectPrefix !== manifest.uploadObjectPrefix) throw new Error("API验收失败：上传目录与具体授权不一致；未发云请求");
  let existingAnonymousStatus: number | null = null;
  if (manifest.privateVideoId) {
    const privateAuthorization = await api(`/api/videos/${encodeURIComponent(manifest.privateVideoId)}/download-authorizations`, {});
    existingAnonymousStatus = await verifyPrivate(source(privateAuthorization));
  }
  const sampleName = file.split(/[\\/]/).at(-1)!;
  const task = await api("/api/uploads", { fileName: sampleName, title: `本机OSS验收 ${new Date().toISOString()}`, sizeBytes: info.size,
    categoryId: manifest.categoryId, groupIds: manifest.groupIds, tagIds: manifest.tagIds });
  if (!task.id || !Number.isSafeInteger(task.partSizeBytes) || task.partSizeBytes < 102400 || task.partSizeBytes > MAX_SAMPLE_BYTES) throw new Error("上传任务参数异常");
  for (let number = 1; (number - 1) * task.partSizeBytes < info.size; number++) {
    const start = (number - 1) * task.partSizeBytes; const end = Math.min(start + task.partSizeBytes, info.size) - 1;
    const checksum = await digestFile(file, start, end);
    const response = await fetch(`${manifest.apiOrigin}/api/uploads/${encodeURIComponent(task.id)}/parts/${number}`, {
      method: "PUT", headers: { ...headers, "content-type": "application/octet-stream", "content-length": String(end - start + 1), "x-part-checksum": checksum },
      body: createReadStream(file, { start, end }), duplex: "half", redirect: "error", signal: AbortSignal.timeout(90_000)
    } as RequestInit);
    await response.body?.cancel(); if (!response.ok) throw new Error(`分片${number}失败：${response.status}；保留任务/云分片`);
  }
  const done = await api(`/api/uploads/${encodeURIComponent(task.id)}/complete`, {});
  const repeated = await api(`/api/uploads/${encodeURIComponent(task.id)}/complete`, {});
  if (done.upload.status !== "completed" || done.video.id !== repeated.video.id || done.video.sizeBytes !== info.size ||
    done.video.categoryId !== manifest.categoryId || JSON.stringify([...done.video.groupIds].sort()) !== JSON.stringify([...manifest.groupIds].sort()) ||
    JSON.stringify([...done.video.tagIds].sort()) !== JSON.stringify([...manifest.tagIds].sort())) throw new Error("登记幂等/组织快照未通过；保留对象");
  const videoId = encodeURIComponent(done.video.id);
  const download = await api(`/api/videos/${videoId}/download-authorizations`, {}); const downloadUrl = source(download);
  if (!decodeURIComponent(downloadUrl.pathname.slice(1)).startsWith(manifest.uploadObjectPrefix)) throw new Error("媒体授权目标异常：新对象不在授权验收前缀");
  const anonymousStatus = await verifyPrivate(downloadUrl);
  const original = await fetch(downloadUrl, { redirect: "error", signal: AbortSignal.timeout(90_000) });
  if (!original.ok || !original.headers.get("content-disposition")?.startsWith("attachment;")) throw new Error("下载授权未通过");
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of original.body!) { bytes += chunk.length; if (bytes > info.size) throw new Error("下载大小超出授权样例"); hash.update(chunk); }
  if (bytes !== info.size || hash.digest("hex") !== manifest.sampleSha256) throw new Error("下载原片完整性未通过");
  let playback = `${done.video.status}：未进入可播状态`;
  if (done.video.status === "ready" && done.video.playable) {
    const playing = await api(`/api/videos/${videoId}/playback-sessions`, {});
    try {
      const url = source(playing); const range = await fetch(url, { headers: { range: "bytes=0-0" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (range.status !== 206 || !["video/mp4", "application/octet-stream"].includes(range.headers.get("content-type") ?? "") ||
        (await range.arrayBuffer()).byteLength !== 1) throw new Error("播放Range未通过");
      const renewed = await api(`/api/playback-sessions/${encodeURIComponent(playing.id)}/source`, {}); source(renewed);
      if (renewed.id !== playing.id) throw new Error("续签未复用会话"); playback = "已验证签发/Range/同会话续签，真实浏览器播放另验";
    } finally { await api(`/api/playback-sessions/${encodeURIComponent(playing.id)}/close`, {}); }
  }
  const usage = await api("/api/settings/usage"); if (usage.source !== "oss_direct" || usage.transferredBytes !== null) throw new Error("直连用量语义异常");
  return { state: "cloud-script-completed", testedAt: new Date().toISOString(), authorizationReference: manifest.authorizationReference,
    userId: account.user.id, uploadId: task.id, videoId: done.video.id, retainedObjectKey: decodeURIComponent(downloadUrl.pathname.slice(1)),
    sampleBytes: info.size, anonymousStatus, existingAnonymousStatus, uploadedObjectPrivateVerified: true, downloadVerified: true, playback, actualDirectBytes: "unknown",
    remaining: ["浏览器Network/CORS/换源保留位置", "撤销后新签发拒绝与旧URL边界", "应用重启/正式库一致性", "读取STS不能Put权限实效"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const manifestPath = process.argv[2]; if (!manifestPath) throw new Error("用法：node --import tsx src/modules/media/acceptance/run.ts <本地授权清单.json> [--execute]");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as AcceptanceManifest;
    process.stdout.write(`${JSON.stringify(await runAcceptance(manifest, process.argv.includes("--execute")), null, 2)}\n`);
  } catch (error) {
    // 只输出受控本地错误；fetch/SDK原文可能含完整URL，不能写日志。
    process.stderr.write(error instanceof Error && /^(缺少|样例|会话|API验收|媒体授权|私有对象|上传任务|分片|登记|下载|播放|续签|直连用量|用法)/.test(error.message) ? `${error.message}\n` : "验收失败；保留全部数据，请查看受控请求状态\n");
    process.exitCode = 1;
  }
}

import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import Database from "better-sqlite3";

const directory = resolve(".local/acceptance/run-20261002-ces-private");
const reportFile = resolve(directory, `upload-report-${Date.now()}-${randomUUID()}.json`);
const prefix = "onlineVideo/acceptance/local/20261002-ces-private/";
const apiOrigin = "http://127.0.0.1:3000"; const browserOrigin = "http://127.0.0.1:5173";
const results: object[] = []; let stage = "authorization";
try {
  if (!process.argv.includes("--execute")) throw new Error("EXPLICIT_EXECUTION_REQUIRED");
  const authorization = JSON.parse(await readFile(resolve(directory, "authorization.json"), "utf8"));
  if (authorization.bucket !== "xzlbucket" || authorization.prefix !== prefix ||
    ["cloudWrites", "databaseWrites", "publicEgress", "newObjectPrivateAcl", "retainObjects"].some(key => authorization[key] !== true)) throw new Error("AUTHORIZATION_MISMATCH");
  const session = JSON.parse(await readFile(resolve(directory, "session.json"), "utf8"));
  const headers = { origin: browserOrigin, cookie: session.cookie, "x-csrf-token": session.csrfToken };
  async function api(path: string, method = "GET", payload?: object) {
    const response = await fetch(`${apiOrigin}${path}`, { method, headers: { ...headers, ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}), redirect: "error", signal: AbortSignal.timeout(120000) });
    const value = await response.json() as { data?: any; error?: { code?: string } };
    if (!response.ok || !value.data) throw new Error(`API_${response.status}_${value.error?.code ?? "INVALID_RESPONSE"}`);
    return value.data;
  }
  stage = "me/limits"; const me = await api("/api/auth/me"); const limits = await api("/api/settings/limits");
  if (me.user.id !== session.userId || limits.uploadObjectPrefix !== prefix || limits.maxUploadBytes !== 2147483648) throw new Error("RUNTIME_SCOPE_MISMATCH");
  const categories = await api("/api/categories"); const categoryId = categories.find((item: { isDefault: boolean }) => item.isDefault)?.id;
  if (!categoryId) throw new Error("DEFAULT_CATEGORY_MISSING");
  async function entity(path: string, name: string) {
    const list = await api(path); const current = list.find((item: { name: string }) => item.name === name);
    return current ?? await api(path, "POST", { name });
  }
  stage = "organization";
  const group = await entity("/api/groups", "OSS本地验收20261002");
  const originalTag = await entity("/api/tags", "验收原片20261002");
  const compatibleTag = await entity("/api/tags", "验收兼容20261002");
  const samples = [
    { kind: "original", path: resolve("docs/ces.mp4"), sha256: "dcda48cac1f42ff40775c03200af183a41c2fd067af08f3b4b3722df7fafba2a", size: 329035, tagId: originalTag.id, status: "unsupported" },
    { kind: "compatible", path: resolve(".local/acceptance/samples/ces-h264-aac-20261002.mp4"), sha256: "f7083ce3ecc34bf2639622d4144f545022570e9601f5f9fc447257fc459d12a4", size: 460063, tagId: compatibleTag.id, status: "ready" }
  ];
  for (const sample of samples) {
    stage = `${sample.kind}:sample-check`;
    const info = await stat(sample.path); if (info.size !== sample.size) throw new Error("SAMPLE_SIZE_CHANGED");
    const bytes = await readFile(sample.path); if (createHash("sha256").update(bytes).digest("hex") !== sample.sha256) throw new Error("SAMPLE_HASH_CHANGED");
    const fileName = sample.path.split(/[\\/]/).at(-1)!;
    const database = new Database(resolve(".local/data/video-library.db"), { readonly: true, fileMustExist: true });
    let previous: { id: string } | undefined;
    try {
      previous = database.prepare("SELECT id FROM upload_tasks WHERE owner_id=? AND file_name=? AND object_key LIKE ? ORDER BY created_at LIMIT 1").get(session.userId, fileName, `${prefix}%`) as { id: string } | undefined;
      const count = (database.prepare("SELECT count(*) n FROM upload_tasks WHERE object_key LIKE ?").get(`${prefix}%`) as { n: number }).n;
      if (!previous && count >= 2) throw new Error("APPROVED_VIDEO_OBJECT_LIMIT");
    } finally { database.close(); }
    stage = `${sample.kind}:create-task`;
    const task = previous ? await api(`/api/uploads/${previous.id}`) : await api("/api/uploads", "POST", {
      fileName, sizeBytes: bytes.length, title: sample.kind === "original" ? "OSS验收原片20261002" : "OSS验收兼容20261002",
      categoryId, groupIds: [group.id], tagIds: [sample.tagId] });
    if (task.sizeBytes !== sample.size || task.partSizeBytes !== 8388608) throw new Error("UPLOAD_PARAMETERS_CHANGED");
    if (task.status === "uploading" && !task.uploadedParts.some((part: { partNumber: number }) => part.partNumber === 1)) {
      stage = `${sample.kind}:upload-part`;
      const response = await fetch(`${apiOrigin}/api/uploads/${task.id}/parts/1`, { method: "PUT", headers: { ...headers,
        "content-type": "application/octet-stream", "x-part-checksum": sample.sha256 }, body: new Uint8Array(bytes),
        redirect: "error", signal: AbortSignal.timeout(120000) });
      const value = await response.json() as { error?: { code: string } };
      if (!response.ok) throw new Error(`PART_${response.status}_${value.error?.code ?? "FAILED"}`);
    }
    stage = `${sample.kind}:complete`;
    const done = await api(`/api/uploads/${task.id}/complete`, "POST", {});
    const repeated = await api(`/api/uploads/${task.id}/complete`, "POST", {});
    if (done.video.id !== repeated.video.id || done.video.status !== sample.status || done.video.categoryId !== categoryId ||
      done.video.sizeBytes !== sample.size || !done.video.groupIds.includes(group.id) || !done.video.tagIds.includes(sample.tagId)) throw new Error("REGISTRATION_VERIFICATION_FAILED");
    stage = `${sample.kind}:private-access`;
    const download = await api(`/api/videos/${done.video.id}/download-authorizations`, "POST", {});
    const signedUrl = new URL(download.sourceUrl);
    if (signedUrl.origin !== "https://oss.meetdawn.top" || !decodeURIComponent(signedUrl.pathname.slice(1)).startsWith(prefix) ||
      signedUrl.searchParams.get("x-oss-signature-version") !== "OSS4-HMAC-SHA256") throw new Error("SOURCE_SCOPE_MISMATCH");
    const unsigned = new URL(signedUrl); unsigned.search = "";
    const anonymous = await fetch(unsigned, { headers: { range: "bytes=0-0" }, redirect: "error", signal: AbortSignal.timeout(30000) });
    const anonymousStatus = anonymous.status; await anonymous.body?.cancel();
    if (![401,403].includes(anonymousStatus)) throw new Error(`ANONYMOUS_NOT_DENIED_${anonymousStatus}`);
    const range = await fetch(signedUrl, { headers: { range: "bytes=0-0" }, redirect: "error", signal: AbortSignal.timeout(30000) });
    if (range.status !== 206 || range.headers.get("content-range") !== `bytes 0-0/${sample.size}` || (await range.arrayBuffer()).byteLength !== 1) throw new Error("SIGNED_RANGE_FAILED");
    let downloadVerified = false;
    // 原片在Node校验唯一完整下载；兼容副本留给真实浏览器附件下载校验。
    if (sample.kind === "original") {
      stage = `${sample.kind}:download`;
      const response = await fetch(signedUrl, { redirect: "error", signal: AbortSignal.timeout(60000) });
      if (response.status !== 200 || !response.headers.get("content-disposition")?.startsWith("attachment;")) throw new Error("DOWNLOAD_HEADERS_FAILED");
      const hash = createHash("sha256"); let size = 0;
      for await (const part of response.body!) { size += part.length; if (size > sample.size) throw new Error("DOWNLOAD_SIZE_LIMIT"); hash.update(part); }
      if (size !== sample.size || hash.digest("hex") !== sample.sha256) throw new Error("DOWNLOAD_HASH_FAILED");
      downloadVerified = true;
    }
    results.push({ kind: sample.kind, uploadId: task.id, videoId: done.video.id, status: done.video.status, codec: done.video.codec,
      durationSeconds: done.video.durationSeconds, sizeBytes: sample.size, retainedObjectKey: decodeURIComponent(signedUrl.pathname.slice(1)),
      anonymousStatus, signedRangeStatus: range.status, contentRange: `bytes 0-0/${sample.size}`, downloadVerified,
      browserDownloadPending: sample.kind === "compatible", categoryId, groupIds: done.video.groupIds, tagIds: done.video.tagIds });
    await writeFile(resolve(directory, `${sample.kind}-result.json`), `${JSON.stringify(results.at(-1), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  const usage = await api("/api/settings/usage"); if (usage.source !== "oss_direct" || usage.transferredBytes !== null) throw new Error("USAGE_SEMANTICS_FAILED");
  const report = { state: "two-samples-private-upload-passed", at: new Date().toISOString(), results, usage };
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportFile }));
} catch (error) {
  const message = error instanceof Error && /^[A-Z0-9_:]+$/.test(error.message) ? error.message : "CONTROLLED_OPERATION_FAILED";
  const report = { state: "real-upload-stopped", at: new Date().toISOString(), stage, publicCode: message, results, retainedAllData: true };
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportFile })); process.exitCode = 1;
}

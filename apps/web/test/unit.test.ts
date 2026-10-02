import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, ApiError, isSiteApiPath } from "../src/api/client";
import { checksum, completeTask, uploadFile, validateTask, verifyFile } from "../src/upload";
import type { UploadTask, VideoDetail } from "@online-video/shared";
import { presentUsage } from "../src/usage";
import type { ApplicationUsage } from "@online-video/shared";

test("同源 API、Cookie、CSRF 与原始分片请求使用契约头", async () => {
  const calls: { input: string; init?: RequestInit }[] = [];
  const client = new ApiClient(async (input, init) => { calls.push({ input, ...(init ? { init } : {}) }); return Response.json({ data: { ok: true } }); });
  client.setSession("csrf");
  await client.request("/api/videos/v", { method: "PATCH", body: { title: "标题" } });
  await client.part("/api/uploads/u/parts/1", new Blob(["abc"]), "a".repeat(64));
  assert.equal(calls[0]?.init?.credentials, "same-origin");
  assert.equal(new Headers(calls[0]?.init?.headers).get("x-csrf-token"), "csrf");
  assert.equal(new Headers(calls[1]?.init?.headers).get("x-part-checksum"), "a".repeat(64));
  assert.equal(new Headers(calls[1]?.init?.headers).get("content-type"), "application/octet-stream");
  for (const path of ["https://bucket.example/video", "//evil/api/a", "/api/\\evil", "/api//evil", "/api/../secrets", "/api/%2e%2e/secrets", "/api/%5cevil"]) assert.equal(isSiteApiPath(path), false);
});

test("会话失效回调、清除 CSRF、拒绝无会话写入", async () => {
  let expired = 0;
  const client = new ApiClient(async () => Response.json({ error: { code: "SESSION_EXPIRED", message: "secret internal message", requestId: "req-1" } }, { status: 401 }));
  client.setSession("csrf"); client.onUnauthorized(() => expired++);
  await assert.rejects(() => client.request("/api/auth/me"), (e: unknown) => e instanceof ApiError && e.message === "登录会话已失效" && e.requestId === "req-1");
  assert.equal(expired, 1);
  await assert.rejects(() => client.request("/api/auth/logout", { method: "POST" }), (e: unknown) => e instanceof ApiError && e.code === "CSRF_REJECTED");
});

test("未知响应与网络异常均安全可见，不输出服务端异常正文", async () => {
  const bad = new ApiClient(async () => new Response("internal stack", { status: 500 }));
  await assert.rejects(() => bad.request("/api/health"), (e: unknown) => e instanceof ApiError && e.code === "INVALID_RESPONSE");
  const network = new ApiClient(async () => { throw new Error("network secret"); });
  await assert.rejects(() => network.request("/api/health"), (e: unknown) => e instanceof ApiError && e.code === "NETWORK_ERROR");
});

test("畸形 401 必须清会话，原型属性不能充当错误码", async () => {
  let expired = 0;
  const unauthorized = new ApiClient(async () => new Response("not json", { status: 401 }));
  unauthorized.setSession("csrf"); unauthorized.onUnauthorized(() => expired++);
  await assert.rejects(() => unauthorized.request("/api/auth/me"), ApiError);
  assert.equal(expired, 1);
  await assert.rejects(() => unauthorized.request("/api/auth/logout", { method: "POST" }), (e: unknown) => e instanceof ApiError && e.code === "CSRF_REJECTED");
  for (const code of ["toString", "__proto__", "constructor"]) {
    const client = new ApiClient(async () => Response.json({ error: { code } }, { status: 500 }));
    await assert.rejects(() => client.request("/api/health"), (e: unknown) => e instanceof ApiError && e.code === "INVALID_RESPONSE");
  }
});

const taskFixture = (): UploadTask => ({ id: "upload-a", videoId: null, fileName: "a.mp4", sizeBytes: 9, partSizeBytes: 4, status: "uploading", uploadedParts: [], createdAt: "2026-10-01T00:00:00.000Z" });
const videoFixture = (): VideoDetail => ({ id: "video-a", title: "视频", categoryId: "default", durationSeconds: null, sizeBytes: 9, status: "processing", thumbnailUrl: null, createdAt: "2026-10-01T00:00:00.000Z", codec: null, width: null, height: null, playable: false, lastPositionSeconds: 0 });
test("逐片 SHA-256，核对已完成片后只上传缺失片，禁止读取整文件", async () => {
  class SlicedFile extends File { override async arrayBuffer(): Promise<ArrayBuffer> { throw new Error("whole file read forbidden"); } }
  const file = new SlicedFile(["abcdefghi"], "a.mp4");
  const task = taskFixture();
  task.uploadedParts.push({ partNumber: 1, sizeBytes: 4, checksum: await checksum(file.slice(0, 4)) });
  const numbers: number[] = [];
  const client = new ApiClient(async (path, init) => {
    if (path.endsWith("/complete")) return Response.json({ data: { upload: { ...task, status: "completed", videoId: "video-a" }, video: videoFixture() } });
    const match = path.match(/parts\/(\d+)$/);
    if (match) {
      const blob = init?.body as Blob; const partNumber = Number(match[1]); const digest = await checksum(blob);
      assert.equal(new Headers(init?.headers).get("x-part-checksum"), digest); assert.ok(blob.size <= 4);
      numbers.push(partNumber); const part = { partNumber, sizeBytes: blob.size, checksum: digest }; task.uploadedParts.push(part);
      return Response.json({ data: part });
    }
    return Response.json({ data: task });
  });
  client.setSession("csrf");
  const result = await uploadFile(client, file, task, new AbortController().signal, () => {});
  assert.deepEqual(numbers, [2, 3]); assert.equal(result.upload.status, "completed");
  assert.equal(await checksum(new Blob(["abc"])), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("同名同大小错误文件拒绝恢复，重复分片和已暂停任务拒绝写入", async () => {
  const task = taskFixture(); task.uploadedParts.push({ partNumber: 1, sizeBytes: 4, checksum: await checksum(new Blob(["abcd"])) });
  await assert.rejects(() => verifyFile(new File(["XXXXXXXXX"], "a.mp4"), task, new AbortController().signal), (e: unknown) => e instanceof ApiError && e.code === "FILE_MISMATCH");
  assert.throws(() => validateTask({ ...task, uploadedParts: [...task.uploadedParts, ...task.uploadedParts] }), ApiError);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(() => verifyFile(new File(["abcdefghi"], "a.mp4"), task, abort.signal), (e: unknown) => e instanceof DOMException && e.name === "AbortError");
});

test("failed/finalizing/completed 已齐片可完成恢复，未齐片和假完成拒绝", async () => {
  const task = taskFixture();
  for (let part = 1; part <= 3; part++) task.uploadedParts.push({ partNumber: part, sizeBytes: part === 3 ? 1 : 4, checksum: "a".repeat(64) });
  for (const status of ["failed", "finalizing", "completed"] as const) {
    task.status = status; let puts = 0;
    const client = new ApiClient(async (path, init) => { if (init?.method === "PUT") puts++; return Response.json({ data: path.endsWith("/complete") ? { upload: { ...task, status: "completed", videoId: "video-a" }, video: videoFixture() } : task }); });
    client.setSession("csrf"); assert.equal((await completeTask(client, task)).video.id, "video-a"); assert.equal(puts, 0);
  }
  const incomplete = new ApiClient(async () => Response.json({ data: { ...task, uploadedParts: task.uploadedParts.slice(0, 1) } }));
  incomplete.setSession("csrf"); await assert.rejects(() => completeTask(incomplete, task), (e: unknown) => e instanceof ApiError && e.code === "UPLOAD_STATE_CONFLICT");
  const bad = new ApiClient(async path => Response.json({ data: path.endsWith("/complete") ? { upload: { ...task, status: "finalizing", videoId: null }, video: videoFixture() } : task }));
  bad.setSession("csrf"); await assert.rejects(() => completeTask(bad, task), (e: unknown) => e instanceof ApiError && e.code === "INVALID_RESPONSE");
});

test("应用用量三态、零限额、到达限额与未知来源不混淆", () => {
  const base = { periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-10-02T00:00:00.000Z", timezone: "UTC", transferredBytes: 12, activePlaybackSessions: 0, source: "application_proxy" as const };
  assert.deepEqual(presentUsage({ ...base, limitMode: "limited", limitBytes: 0 }), { kind: "limited", remaining: 0, reached: true, ratio: 1 });
  assert.deepEqual(presentUsage({ ...base, limitMode: "limited", limitBytes: 100 }), { kind: "limited", remaining: 88, reached: false, ratio: .12 });
  assert.deepEqual(presentUsage({ ...base, limitMode: "unconfigured", limitBytes: null }), { kind: "unconfigured" });
  assert.deepEqual(presentUsage({ ...base, limitMode: "unlimited", limitBytes: null }), { kind: "unlimited" });
  assert.throws(() => presentUsage({ ...base, source: "unknown", limitMode: "limited", limitBytes: 100 } as unknown as ApplicationUsage), ApiError);
  assert.throws(() => presentUsage({ ...base, limitMode: "unlimited", limitBytes: 0 } as unknown as ApplicationUsage), ApiError);
});

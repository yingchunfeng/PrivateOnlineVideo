import { test } from "node:test";
import assert from "node:assert/strict";
import type { ApplicationLimits, UploadTask, VideoDetail } from "@online-video/shared";
import { ApiClient } from "../src/api/client";
import { coverFrameTime, coverIntervalTimes, extractEmbeddedCover } from "../src/cover";
import type { LocalCover } from "../src/cover";
import { UploadQueue } from "../src/upload-queue";
import { checksum } from "../src/upload";

const limits: ApplicationLimits = { maxUploadBytes: 1048576, partSizeBytes: 4, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 };
const eventually = async (condition: () => boolean) => { const start = Date.now(); while (!condition()) { if (Date.now() - start > 4000) throw new Error("等待隔离执行器状态超时"); await new Promise(resolve => setTimeout(resolve, 10)); } };
const box = (kind: string, bytes: Uint8Array) => { const buffer = Buffer.alloc(8 + bytes.length); buffer.writeUInt32BE(buffer.length); buffer.write(kind, 4, "latin1"); buffer.set(bytes, 8); return buffer; };
test("有边界 covr 解析跳过媒体正文，损坏或未知图片不冒充封面", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
  const flags = Buffer.alloc(8); flags.writeUInt32BE(13);
  const covr = box("covr", box("data", Buffer.concat([flags, jpeg])));
  const metadata = box("moov", box("udta", box("meta", Buffer.concat([Buffer.alloc(4), box("ilst", covr)]))));
  const sizes: number[] = [];
  class BoundedFile extends Blob { override arrayBuffer(): Promise<ArrayBuffer> { throw new Error("禁止整文件读取"); } override slice(start?: number, end?: number, type?: string) { sizes.push((end ?? this.size) - (start ?? 0)); return super.slice(start, end, type); } }
  const file = new BoundedFile([box("ftyp", Buffer.from("isom0000")), box("mdat", Buffer.alloc(1048576)), metadata]);
  const found = await extractEmbeddedCover(file); assert.ok(found); assert.equal(found.type, "image/jpeg"); assert.deepEqual(Buffer.from(await found.arrayBuffer()), jpeg);
  assert.ok(sizes.every(size => size <= 16));
  assert.equal(await extractEmbeddedCover(new Blob([box("mdat", Buffer.alloc(32))])), undefined);
  const broken = Buffer.from(metadata); broken.writeUInt32BE(0xffffffff); assert.equal(await extractEmbeddedCover(new Blob([broken])), undefined);
});
test("逐项校验、稳定clientId和编辑隔离，批量元数据保持各自标题", () => {
  const queue = new UploadQueue(new ApiClient(async () => { throw new Error("不应发请求"); }), async () => { throw new Error("隔离测试不解析视频"); });
  const ids = queue.add([new File(["1234"], "same.mp4"), new File(["12345"], "same.mp4"), new File(["bad"], "bad.txt")], limits, "cat-a");
  assert.equal(new Set(ids).size, 3); assert.ok(queue.snapshot()[2]?.validationError);
  queue.edit(ids[0]!, { title: "第一个", categoryId: "cat-b", tags: ["tag"] }); queue.edit(ids[1]!, { title: "第二个" });
  assert.equal(queue.snapshot()[1]?.categoryId, "cat-a"); queue.applyMetadata(ids[0]!);
  assert.equal(queue.snapshot()[1]?.title, "第二个"); assert.equal(queue.snapshot()[1]?.categoryId, "cat-b");
  queue.remove(ids[2]!); assert.equal(queue.snapshot().length, 2); queue.stop();
});
test("创建响应丢失幂等恢复、独立失败继续排队、视频与封面失败分开且只补封面", async () => {
  const tasks = new Map<string, UploadTask>(); const bodies: Record<string, unknown>[] = []; const order: string[] = []; const coverAttempts = new Map<string, number>();
  let lostOnce = true; let failComplete = true; let parts = 0;
  const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
  const client = new ApiClient(async (path, init) => {
    if (path === "/api/uploads" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; bodies.push(body); const id = String(body.clientRequestId);
      let task = tasks.get(id); if (!task) { task = { id, videoId: null, fileName: String(body.fileName), sizeBytes: Number(body.sizeBytes), partSizeBytes: 4, status: "uploading", uploadedParts: [], createdAt: "2026-10-03T00:00:00.000Z", title: String(body.title), categoryId: String(body.categoryId) }; tasks.set(id, task); }
      if (String(body.title) === "lost" && lostOnce) { lostOnce = false; throw new Error("响应丢失，但服务端已经创建"); } return response(task);
    }
    const cover = path.match(/^\/api\/videos\/([^/]+)\/cover$/);
    if (cover) { const id = cover[1]!; const attempts = (coverAttempts.get(id) ?? 0) + 1; coverAttempts.set(id, attempts); if (attempts === 1) return new Response(JSON.stringify({ error: { code: "COVER_REGISTRATION_FAILED" } }), { status: 503 }); const task = tasks.get(id)!; return response({ id, title: task.title, publicUrl: `https://oss.meetdawn.top/onlineVideo/cat/${id}.mp4`, coverUrl: `https://oss.meetdawn.top/onlineVideo/cat/covers/${id}.jpg`, coverObjectKey: `onlineVideo/cat/covers/${id}.jpg`, coverStatus: "saved" }); }
    const match = path.match(/^\/api\/uploads\/([^/]+)(?:\/parts\/(\d+)|\/(complete))?$/); assert.ok(match); const task = tasks.get(match[1]!)!;
    if (match[2]) { parts++; task.uploadedParts.push({ partNumber: Number(match[2]), sizeBytes: (init!.body as Blob).size, checksum: new Headers(init?.headers).get("x-part-checksum")! }); return response(task.uploadedParts.at(-1)); }
    if (match[3]) { order.push(task.title!); if (task.title === "fail" && failComplete) { failComplete = false; task.status = "failed"; return new Response(JSON.stringify({ error: { code: "UPLOAD_REGISTRATION_FAILED" } }), { status: 503 }); } task.status = "completed"; task.videoId = task.id; const video: Partial<VideoDetail> = { id: task.id, title: task.title!, publicUrl: `https://oss.meetdawn.top/onlineVideo/cat/${task.id}.mp4`, coverStatus: "missing" }; return response({ upload: task, video }); }
    return response(task);
  }); client.setSession("fixture");
  const queue = new UploadQueue(client, async () => { const blob = new Blob(["jpeg"], { type: "image/jpeg" }); return { blob, source: "frame", url: URL.createObjectURL(blob) }; });
  const ids = queue.add([new File(["abcdefgh"], "fail.mp4"), new File(["abcdefgh"], "ok.mp4"), new File(["abcd"], "lost.mp4")], limits, "cat");
  await queue.submit(ids); await eventually(() => queue.snapshot()[1]?.state === "completed" && !!queue.snapshot()[1]?.error);
  assert.equal(queue.snapshot()[0]?.state, "failed"); assert.equal(queue.snapshot()[2]?.state, "createFailed"); assert.ok(order.includes("ok"));
  const initialParts = parts; await queue.retryCover(ids[1]!); assert.equal(parts, initialParts); assert.equal(queue.snapshot()[1]?.video?.coverStatus, "saved");
  queue.retry(ids[0]!); queue.retry(ids[2]!); await eventually(() => queue.snapshot()[0]?.state === "completed" && queue.snapshot()[2]?.state === "completed");
  assert.equal(tasks.size, 3); assert.equal(bodies.filter(body => body.title === "lost").length, 2); assert.equal(new Set(bodies.filter(body => body.title === "lost").map(body => body.clientRequestId)).size, 1);
  assert.equal(parts, initialParts + 1); queue.stop();
});
test("刷新补选按大小和已确认SHA256比对，同名同大小错误内容不能续传", async () => {
  const task: UploadTask = { id: "existing", fileName: "same.mp4", videoId: null, sizeBytes: 8, partSizeBytes: 4, status: "uploading", uploadedParts: [{ partNumber: 1, sizeBytes: 4, checksum: await checksum(new Blob(["abcd"])) }], createdAt: "2026-10-03T00:00:00.000Z" };
  const queue = new UploadQueue(new ApiClient(async () => { throw new Error("校验前不应上传"); }), async () => { throw new Error("隔离测试不解析视频"); });
  await assert.rejects(queue.attach(task, new File(["WRONG!!!"], "same.mp4")), /不能续传/); assert.equal(queue.snapshot().length, 0);
  await queue.attach(task, new File(["abcdefgh"], "different-name.mp4")); assert.equal(queue.snapshot()[0]?.task?.id, "existing"); assert.match(queue.snapshot()[0]?.notice ?? "", /SHA-256 已匹配/); queue.stop();
});

const fixtureCover = (content: string, source: LocalCover["source"] = "manual"): LocalCover => {
  const blob = new Blob([content], { type: "image/jpeg" }); return { blob, source, url: URL.createObjectURL(blob) };
};
test("手动封面：每秒时间区间、短视频和末尾有效定位", () => {
  assert.deepEqual(coverIntervalTimes(23.5, 0), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(coverIntervalTimes(23.5, 2), [20, 21, 22, 23]);
  assert.deepEqual(coverIntervalTimes(20, 2), []); assert.deepEqual(coverIntervalTimes(.8, 0), [0]);
  assert.deepEqual(coverIntervalTimes(Infinity, 0), []);
  assert.equal(coverFrameTime(-1, .8), 0); assert.equal(coverFrameTime(.8, .8), .799);
  assert.equal(coverFrameTime(99, 2), 1.999); assert.throws(() => coverFrameTime(1, NaN), /时长暂不可用/);
});
test("手动封面隔离：忽略不响应取消的旧自动成功和失败，恢复清除时间", async () => {
  for (const rejectOld of [false, true]) {
    let finish!: (value: LocalCover) => void; let fail!: (error: Error) => void;
    let calls = 0; let automaticSignal: AbortSignal | undefined;
    const queue = new UploadQueue(new ApiClient(async () => { throw new Error("不应联网"); }), (_file, signal) => {
      calls++; if (calls > 1) return Promise.resolve(fixtureCover("second-auto", "frame"));
      automaticSignal = signal; return new Promise<LocalCover>((resolve, reject) => { finish = resolve; fail = reject; });
    });
    const ids = queue.add([new File(["1234"], "first.mp4"), new File(["1234"], "second.mp4")], limits, "cat");
    const manual = fixtureCover("first-manual"); assert.equal(queue.setCover(ids[0]!, manual, 3.2), true); assert.equal(automaticSignal?.aborted, true);
    const stale = fixtureCover("stale", "frame"); if (rejectOld) { URL.revokeObjectURL(stale.url); fail(new Error("旧自动采集失败")); } else finish(stale);
    await eventually(() => queue.snapshot()[1]?.coverState === "ready");
    assert.equal(queue.snapshot()[0]?.cover, manual); assert.equal(queue.snapshot()[0]?.manualCoverTime, 3.2);
    assert.equal(queue.snapshot()[0]?.coverState, "ready"); assert.equal(queue.snapshot()[0]?.coverError, undefined);
    if (!rejectOld) await assert.rejects(fetch(stale.url));
    const restored = fixtureCover("restored", "embedded"); assert.equal(queue.setCover(ids[0]!, restored), true);
    assert.equal(queue.snapshot()[0]?.manualCoverTime, undefined); assert.equal(await queue.snapshot()[1]?.cover?.blob.text(), "second-auto");
    await assert.rejects(fetch(manual.url)); queue.stop();
  }
});
test("视频移出或退出后晚返回的自动图片释放，拒绝已失效视频的手动封面", async () => {
  for (const stop of [false, true]) {
    let finish!: (cover: LocalCover) => void;
    const queue = new UploadQueue(new ApiClient(async () => { throw new Error("不应联网"); }), () => new Promise(resolve => { finish = resolve; }));
    const [id] = queue.add([new File(["1234"], "first.mp4")], limits, "cat");
    if (stop) queue.stop(); else queue.remove(id!);
    const stale = fixtureCover("stale", "frame"); finish(stale); await eventually(() => queue.snapshot().length === 0);
    await new Promise(resolve => setTimeout(resolve, 0)); await assert.rejects(fetch(stale.url));
    const manual = fixtureCover("manual"); assert.equal(queue.setCover(id!, manual, 1), false); URL.revokeObjectURL(manual.url); queue.stop();
  }
});

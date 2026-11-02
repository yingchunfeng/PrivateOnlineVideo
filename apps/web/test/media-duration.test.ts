import test from "node:test";
import assert from "node:assert/strict";
import type { ApplicationLimits, UploadTask, VideoDetail } from "@online-video/shared";
import { ApiClient } from "../src/api/client";
import { isVideoDuration, MAX_VIDEO_DURATION_SECONDS, saveMediaDuration } from "../src/media-duration";
import { duration, videoDuration } from "../src/ui";
import { UploadQueue } from "../src/upload-queue";

const video = (): VideoDetail => ({ id: "isolated-video", title: "真实媒体测试", categoryId: "category", durationSeconds: null, objectKey: "onlineVideo/category/one.mp4", publicUrl: "https://isolated.test/onlineVideo/category/one.mp4", sizeBytes: 10, status: "processing", thumbnailUrl: null, createdAt: "2026-11-02T00:00:00.000Z", codec: null, width: null, height: null, playable: false, lastPositionSeconds: 0 });
const response = (data: unknown) => Response.json({ data });

test("真实时长边界：有限正数且最多31天，不将未知/异常值当00:00保存", () => {
  for (const value of [null, undefined, 0, -1, NaN, Infinity, -Infinity, "12", MAX_VIDEO_DURATION_SECONDS + .1]) assert.equal(isVideoDuration(value), false);
  for (const value of [.001, .8, 3601, MAX_VIDEO_DURATION_SECONDS]) assert.equal(isVideoDuration(value), true);
});

test("视频总时长与观看位置格式分离，超过一小时明确显示小时", () => {
  assert.equal(videoDuration(3661.5), "1:01:01"); assert.equal(videoDuration(59.9), "0:59"); assert.equal(duration(0), "0:00");
  for (const value of [null, 0, NaN, Infinity, -1]) assert.equal(videoDuration(value), "时长待采集");
});

test("时长只绑定对应媒体身份写入，合并同一视频的并发请求，优先已存可信值", async () => {
  const body: unknown[] = []; let complete!: () => void;
  const client = new ApiClient(async (path, init) => { assert.equal(path, "/api/videos/isolated-video/duration"); assert.equal(init?.method, "PUT"); body.push(JSON.parse(String(init?.body))); await new Promise<void>(resolve => { complete = resolve; }); return response({ ...video(), durationSeconds: 23.5 }); }); client.setSession("isolated-csrf");
  const first = saveMediaDuration(client, video(), 23.5); const second = saveMediaDuration(client, video(), 24); assert.equal(first, second); complete();
  assert.equal((await first).durationSeconds, 23.5); assert.deepEqual(body, [{ durationSeconds: 23.5, expectedObjectKey: "onlineVideo/category/one.mp4" }]);
  const known = { ...video(), durationSeconds: 3601 }; assert.equal(await saveMediaDuration(client, known, 99), known); assert.equal(body.length, 1);
});

test("时长API失败/媒体身份不一致后释放请求锁，重试可以成功", async () => {
  let calls = 0; const client = new ApiClient(async () => response({ ...video(), objectKey: ++calls === 1 ? "onlineVideo/wrong.mp4" : video().objectKey, durationSeconds: 23.5 })); client.setSession("fixture");
  await assert.rejects(saveMediaDuration(client, video(), 23.5), /同一视频/); assert.equal((await saveMediaDuration(client, video(), 23.5)).durationSeconds, 23.5);
  await assert.rejects(saveMediaDuration(client, video(), Infinity), /有效的总时长/); await assert.rejects(saveMediaDuration(client, { ...video(), objectKey: "" }, 10), /媒体身份/);
});

test("时长保存网络悬挂有界超时且可重试，不依赖transport响应取消", async () => {
  let calls = 0; const client = new ApiClient(async () => { if (++calls === 1) return new Promise<Response>(() => {}); return response({ ...video(), durationSeconds: 23.5 }); }); client.setSession("fixture");
  await assert.rejects(saveMediaDuration(client, video(), 23.5, undefined, 25), /保存超时/); assert.equal((await saveMediaDuration(client, video(), 23.5)).durationSeconds, 23.5);
});

test("时长保存继承调用方取消，过期响应不能继续广播或占用后续请求", async () => {
  const client = new ApiClient(async () => new Promise<Response>(() => {})); client.setSession("fixture");
  const controller = new AbortController(); const pending = saveMediaDuration(client, video(), 23.5, controller.signal); controller.abort();
  await assert.rejects(pending, error => error instanceof DOMException && error.name === "AbortError");
  await assert.rejects(saveMediaDuration(client, video(), 23.5, controller.signal), error => error instanceof DOMException && error.name === "AbortError");
});

test("删除视频解除本机队列引用，忽略完成确认/时长/封面的晚回调且不重新登记", async () => {
  const waitFor = async (condition: () => boolean) => { const at = Date.now(); while (!condition()) { if (Date.now() - at > 3000) throw new Error("队列回调未到达可控挂起点"); await new Promise(resolve => setTimeout(resolve, 5)); } };
  const limits: ApplicationLimits = { maxUploadBytes: 100, partSizeBytes: 4, maxUploadConcurrency: 1, maxPlaybackSessions: 0, maxAuthorizationsPerMinute: 0 };
  for (const mode of ["complete", "duration", "cover"] as const) {
    let release: (() => void) | undefined; const calls: string[] = [];
    const task: UploadTask = { id: `isolated-${mode}`, videoId: null, fileName: "local.mp4", sizeBytes: 4, partSizeBytes: 4, status: "uploading", uploadedParts: [], createdAt: "2026-11-02T00:00:00.000Z" };
    const stored = { ...video(), id: `deleted-${mode}`, durationSeconds: mode === "duration" ? null : 23.5 };
    const pending = () => new Promise<void>(resolve => { release = resolve; });
    const client = new ApiClient(async (path, init) => {
      calls.push(`${init?.method} ${path}`);
      if (path === "/api/uploads") return response(task);
      if (path.endsWith("/parts/1")) { task.uploadedParts = [{ partNumber: 1, sizeBytes: 4, checksum: new Headers(init?.headers).get("x-part-checksum")! }]; return response(task.uploadedParts[0]); }
      if (path.endsWith("/complete")) { task.status = "completed"; task.videoId = stored.id; if (mode === "complete") await pending(); return response({ upload: task, video: stored }); }
      if (path.endsWith("/cover")) { assert.equal(mode, "cover"); await pending(); return response({ ...stored, coverUrl: "https://isolated.test/onlineVideo/cover.jpg", coverStatus: "saved" }); }
      if (path.endsWith("/duration")) throw new Error("删除后不能继续写入时长");
      return response(task);
    }); client.setSession("fixture");
    const queue = new UploadQueue(client, async () => { const blob = new Blob(["jpeg"], { type: "image/jpeg" }); return { blob, source: "frame", url: URL.createObjectURL(blob) }; }, async () => { if (mode === "duration") await pending(); return 23.5; });
    const file = new File(["abcd"], "local.mp4"); const [id] = queue.add([file], limits, "category"); await queue.submit([id!]); await waitFor(() => !!release);
    queue.detachVideo(stored.id); const before = calls.length; release!(); await new Promise(resolve => setTimeout(resolve, 25));
    const entry = queue.snapshot()[0]!; assert.equal(entry.state, "completed", mode); assert.equal(entry.task?.videoId, null, mode); assert.equal(entry.video, undefined, mode); assert.equal(entry.file, file, mode); assert.equal(entry.durationError, undefined, mode);
    queue.retry(id!); await queue.retryCover(id!); await queue.retryDuration(id!); assert.equal(calls.length, before, mode);
    await assert.rejects(queue.attach({ ...task, videoId: null }, file), /视频记录已删除/); queue.stop();
  }
});

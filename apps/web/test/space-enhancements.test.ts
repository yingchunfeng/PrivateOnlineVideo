import test from "node:test";
import assert from "node:assert/strict";
import type { UploadTask } from "@online-video/shared";
import { TaskCompletionEffects } from "../src/space-enhancement-state";
import { ApiClient } from "../src/api/client";
import { UploadQueue } from "../src/upload-queue";

const task = (id: string, status: UploadTask["status"] = "finalizing"): UploadTask => ({ id, fileName: `${id}.mp4`, sizeBytes: 4, partSizeBytes: 4, uploadedParts: [{ partNumber: 1, sizeBytes: 4, checksum: "a".repeat(64) }], status, videoId: status === "completed" ? `video-${id}` : null, createdAt: "2026-10-28T00:00:00.000Z" });

test("完成光环只接受新登记成功，历史、失败、100%与错误关联均不可触发", () => {
  let now = 0;
  const effects = new TaskCompletionEffects(() => now);
  const full = task("new");
  assert.equal(effects.confirm("uploading", full, { id: "video-new" }), false);
  assert.equal(effects.confirm("finalizing", { ...full, status: "failed" }, { id: "video-new" }), false);
  const completed = task("new", "completed");
  assert.equal(effects.confirm("completed", completed, { id: "video-new" }), false);
  assert.equal(effects.confirm("finalizing", completed, { id: "wrong" }), false);
  assert.equal(effects.consume("new"), false);
  now = 100;
  assert.equal(effects.confirm("finalizing", completed, { id: "video-new" }), true);
  assert.equal(effects.confirmedAt("new"), 100);
  assert.equal(effects.consume("new"), true);
  assert.equal(effects.consume("new"), false);
  assert.equal(effects.confirm("finalizing", completed, { id: "video-new" }), false);
});

test("各任务独立消费；离开页面后的过期成功、时间回退不会补播", () => {
  let now = 0;
  const effects = new TaskCompletionEffects(() => now);
  for (const id of ["a", "b", "expired", "clock"]) effects.confirm("finalizing", task(id, "completed"), { id: `video-${id}` });
  assert.equal(effects.consume("a"), true);
  assert.equal(effects.consume("b"), true);
  now = 1501;
  assert.equal(effects.consume("expired"), false);
  now = 0;
  assert.equal(effects.consume("expired"), false);
  now = -1;
  assert.equal(effects.consume("clock"), false);
});

function state(queue: UploadQueue, expected: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Missing queue state: ${expected}`)); }, 1500);
    const check = () => { if (queue.snapshot()[0]?.state === expected) { clearTimeout(timer); unsubscribe(); resolve(); } };
    const unsubscribe = queue.subscribe(check);
    check();
  });
}

test("真实执行器仅在complete成功后记录，确认失败及历史恢复不重复", async () => {
  const full = task("queue");
  let succeeded = false;
  let release: (() => void) | undefined;
  const client = new ApiClient(async path => {
    if (path === "/api/uploads/queue") return Response.json({ data: full });
    if (path === "/api/uploads/queue/complete") {
      if (!succeeded) return Response.json({ error: { code: "UPLOAD_REGISTRATION_FAILED" } }, { status: 503 });
      await new Promise<void>(resolve => { release = resolve; });
      return Response.json({ data: { upload: task("queue", "completed"), video: { id: "video-queue" } } });
    }
    if (path === "/api/videos/video-queue") return Response.json({ data: { id: "video-queue" } });
    throw new Error(`Unexpected isolated call: ${path}`);
  });
  client.setSession("fixture");
  const queue = new UploadQueue(client);
  queue.recover(full);
  await state(queue, "failed");
  assert.equal(queue.completionEffects.confirmedAt(full.id), undefined);
  succeeded = true;
  queue.retry("task-queue");
  await state(queue, "confirming");
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(queue.completionEffects.consume(full.id), false, "100%字节仍等待后端登记");
  release();
  await state(queue, "completed");
  assert.equal(queue.completionEffects.consume(full.id), true);
  queue.recover(task("queue", "completed"));
  await state(queue, "completed");
  assert.equal(queue.completionEffects.consume(full.id), false);
  queue.stop();

  const history = new UploadQueue(client);
  history.recover(task("queue", "completed"));
  await state(history, "completed");
  assert.equal(history.completionEffects.confirmedAt(full.id), undefined);
  history.stop();
});

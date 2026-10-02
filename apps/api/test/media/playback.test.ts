import assert from "node:assert/strict";
import test from "node:test";
import { get } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/core/config.js";
import { createMediaModule } from "../../src/modules/media/index.js";
import { parseRange } from "../../src/modules/media/playback/range.js";
import { fakeDependencies, headers, options } from "./fakes.js";

export async function fixture(limit = "unlimited", maximum = "2") {
  const config = readConfig({ NODE_ENV: "test", TRANSFER_LIMIT_BYTES: limit, MAX_PLAYBACK_SESSIONS: maximum });
  const fakes = fakeDependencies(config); fakes.seedVideo();
  const app = await buildApp({ config, logger: false, media: { register: createMediaModule(options), dependencies: fakes.dependencies } });
  return { app, ...fakes };
}
export async function createSession(app: Awaited<ReturnType<typeof fixture>>["app"], videoId = "video") {
  const response = await app.inject({ method: "POST", url: `/api/videos/${videoId}/playback-sessions`, headers });
  assert.equal(response.statusCode, 200, response.body); return response.json().data as { id: string; sourceUrl: string };
}

test("Range 解析覆盖开放/后缀/截断，拒绝非法、多范围、溢出和零长", () => {
  assert.deepEqual(parseRange("bytes=2-4", 10), { start: 2, end: 4 });
  assert.deepEqual(parseRange("bytes=2-", 10), { start: 2, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=0-100", 10), { start: 0, end: 9 });
  for (const range of ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=-", "items=1-2", "bytes=1-2,4-5", "bytes=9007199254740992-"]) assert.throws(() => parseRange(range, 10));
  assert.throws(() => parseRange("bytes=0-1", 0));
});

test("播放 Cookie/CSRF/归属/登录会话绑定，HEAD 无体、Range 精确及封面保护", async t => {
  const f = await fixture(); t.after(() => f.app.close()); const session = await createSession(f.app);
  assert.ok(session.sourceUrl.startsWith("/api/")); assert.ok(!session.sourceUrl.includes("aliyuncs"));
  assert.equal((await f.app.inject({ url: session.sourceUrl })).statusCode, 401);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/videos/video/playback-sessions", headers: { cookie: headers.cookie } })).statusCode, 403);
  assert.equal((await f.app.inject({ url: session.sourceUrl, headers: { ...headers, "x-test-session": "another-login" } })).statusCode, 403);
  f.seedVideo("other", Buffer.from("x"), "different-owner");
  assert.equal((await f.app.inject({ method: "POST", url: "/api/videos/other/playback-sessions", headers })).statusCode, 404);
  const before = f.storage.reads.length;
  const head = await f.app.inject({ method: "HEAD", url: session.sourceUrl, headers });
  assert.equal(head.statusCode, 200); assert.equal(head.body, ""); assert.equal(head.headers["content-length"], "10"); assert.equal(f.storage.reads.length, before);
  const range = await f.app.inject({ url: session.sourceUrl, headers: { ...headers, range: "bytes=2-4" } });
  assert.equal(range.statusCode, 206); assert.equal(range.body, "234"); assert.equal(range.headers["content-range"], "bytes 2-4/10");
  assert.equal(range.headers["content-length"], "3"); assert.equal(range.headers["accept-ranges"], "bytes");
  assert.deepEqual(f.storage.reads.at(-1)?.range, { start: 2, end: 4 });
  const invalid = await f.app.inject({ url: session.sourceUrl, headers: { ...headers, range: "bytes=12-20" } });
  assert.equal(invalid.statusCode, 416); assert.equal(invalid.headers["content-range"], "bytes */10");
  const video = f.videos.get("video")!; video.thumbnailObject = { key: "library/cover.jpg" }; f.storage.seed(video.thumbnailObject.key, Buffer.from("jpg"), "image/jpeg");
  assert.equal((await f.app.inject({ url: "/api/videos/video/thumbnail" })).statusCode, 401);
  assert.equal((await f.app.inject({ url: "/api/videos/video/thumbnail", headers })).body, "jpg");
  assert.equal((await f.app.inject({ method: "POST", url: `/api/playback-sessions/${session.id}/heartbeat`, headers })).statusCode, 200);
  await f.app.inject({ method: "POST", url: `/api/playback-sessions/${session.id}/close`, headers });
  assert.equal((await f.app.inject({ url: session.sourceUrl, headers })).statusCode, 403);
});

test("真实 HTTP 客户端断开销毁持续上游，释放在途额度，保留实际输出计数", async t => {
  const f = await fixture(); const size = 4 * 1024 * 1024; f.seedVideo("large", Buffer.alloc(size));
  let produced = 0; let destroyed = false; let timer: NodeJS.Timeout | undefined;
  const head = await f.storage.head({ object: { key: "library/large.mp4" }, signal: new AbortController().signal });
  f.dependencies.storage.openRead = async input => {
    const stream = new Readable({ read() {
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; produced += 4096; this.push(Buffer.alloc(4096)); }, 10);
    }, destroy(error, callback) { destroyed = true; if (timer) clearTimeout(timer); callback(error); } });
    input.signal.addEventListener("abort", () => stream.destroy(), { once: true });
    return { stream, metadata: head, range: null };
  };
  const session = await createSession(f.app, "large");
  await f.app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => f.app.close());
  const address = f.app.server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    const client = get(`http://127.0.0.1:${address.port}${session.sourceUrl}`, { headers }, response => {
      response.once("data", () => { response.destroy(); client.destroy(); resolve(); });
    }); client.once("error", reject);
  });
  for (let attempt = 0; attempt < 30 && (!destroyed || [...f.reservations.values()].some(value => !value.settled)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(destroyed, true); assert.ok(produced < size);
  assert.equal([...f.periods.values()].reduce((sum, value) => sum + value.reserved, 0), 0);
  assert.ok([...f.periods.values()].reduce((sum, value) => sum + value.bytes, 0) >= 4096);
});

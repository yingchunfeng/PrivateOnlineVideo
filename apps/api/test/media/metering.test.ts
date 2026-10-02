import assert from "node:assert/strict";
import test from "node:test";
import { get } from "node:http";
import { Readable } from "node:stream";
import { fixture, createSession } from "./playback.test.js";
import { headers } from "./fakes.js";
import { usagePeriod } from "../../src/modules/media/metering/period.js";
import { RequestLimiter } from "../../src/modules/media/limits/rate.js";

test("统计日支持 IANA 时区及 DST，请求限流和播放并发按会话原子控制", async t => {
  const spring = usagePeriod(new Date("2026-03-29T12:00:00Z"), "Europe/Amsterdam");
  assert.equal(new Date(spring.end).getTime() - new Date(spring.start).getTime(), 23 * 3600_000);
  const autumn = usagePeriod(new Date("2026-10-25T12:00:00Z"), "Europe/Amsterdam");
  assert.equal(new Date(autumn.end).getTime() - new Date(autumn.start).getTime(), 25 * 3600_000);
  assert.deepEqual(usagePeriod(new Date("2026-10-01T00:00:00Z"), "Asia/Shanghai"), {
    start: "2026-09-30T16:00:00.000Z", end: "2026-10-01T16:00:00.000Z", timezone: "Asia/Shanghai" });
  const limiter = new RequestLimiter(2); limiter.check("owner", "stream", 0); limiter.check("owner", "stream", 0);
  assert.throws(() => limiter.check("owner", "stream", 0)); limiter.check("owner", "stream", 60_000);
  const f = await fixture("unlimited", "1"); t.after(() => f.app.close());
  const results = await Promise.all([f.app.inject({ method: "POST", url: "/api/videos/video/playback-sessions", headers }),
    f.app.inject({ method: "POST", url: "/api/videos/video/playback-sessions", headers })]);
  assert.deepEqual(results.map(response => response.statusCode).sort(), [200, 429]);
  const session = results.find(response => response.statusCode === 200)!.json().data;
  const ranges = await Promise.all([f.app.inject({ url: session.sourceUrl, headers: { ...headers, range: "bytes=0-2" } }),
    f.app.inject({ url: session.sourceUrl, headers: { ...headers, range: "bytes=3-5" } })]);
  assert.deepEqual(ranges.map(response => response.statusCode), [206, 206]);
  assert.equal(f.sessions.size, 1);
  f.clock.time = new Date(f.clock.time.getTime() + 121_000);
  assert.equal((await f.app.inject({ url: session.sourceUrl, headers })).statusCode, 403);
  await createSession(f.app);
});

test("原子预留覆盖并发 Range/重试：从不放行超额度，耗尽前拒绝新存储读取", async t => {
  const f = await fixture("6"); t.after(() => f.app.close()); const session = await createSession(f.app);
  const results = await Promise.all([0, 1, 2].map(() => f.app.inject({ url: session.sourceUrl, headers: { ...headers, range: "bytes=0-2" } })));
  assert.deepEqual(results.map(response => response.statusCode).sort(), [206, 206, 429]);
  assert.equal(results.filter(response => response.statusCode === 206).reduce((total, response) => total + response.rawPayload.length, 0), 6);
  const totals = [...f.periods.values()]; assert.equal(totals.reduce((sum, period) => sum + period.bytes, 0), 6);
  assert.equal(totals.reduce((sum, period) => sum + period.reserved, 0), 0);
  const before = f.storage.reads.length;
  const denied = await f.app.inject({ url: session.sourceUrl, headers });
  assert.equal(denied.statusCode, 429); assert.equal(denied.json().error.code, "TRANSFER_LIMIT_EXCEEDED"); assert.equal(f.storage.reads.length, before);
  const zero = await fixture("0"); t.after(() => zero.app.close());
  assert.equal((await zero.app.inject({ method: "POST", url: "/api/videos/video/playback-sessions", headers })).statusCode, 429);
});

test("持续流跨额度实际截断、取消上游并释放预留，不向视频追加 JSON", async t => {
  const f = await fixture("70000"); const size = 256 * 1024; f.seedVideo("large", Buffer.alloc(size, 7));
  const meta = await f.storage.head({ object: { key: "library/large.mp4" }, signal: new AbortController().signal });
  let destroyed = false;
  f.dependencies.storage.openRead = async input => {
    const stream = Readable.from((function* () { for (let position = 0; position < size; position += 4096) yield Buffer.alloc(4096, 7); })());
    stream.once("close", () => { destroyed = true; }); input.signal.addEventListener("abort", () => stream.destroy(), { once: true });
    return { stream, metadata: meta, range: null };
  };
  const session = await createSession(f.app, "large"); await f.app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => f.app.close());
  const address = f.app.server.address(); assert.ok(address && typeof address !== "string");
  const body = await new Promise<Buffer>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${address.port}${session.sourceUrl}`, { headers }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk));
      response.once("end", () => resolve(Buffer.concat(chunks))); response.once("close", () => resolve(Buffer.concat(chunks)));
      response.once("error", () => resolve(Buffer.concat(chunks)));
    }); request.once("error", reject);
  });
  for (let attempt = 0; attempt < 30 && [...f.reservations.values()].some(value => !value.settled); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(body.length <= 70000); assert.ok(body.every(byte => byte === 7)); assert.equal(destroyed, true);
  assert.equal([...f.periods.values()].reduce((sum, value) => sum + value.bytes, 0), 70000);
  assert.equal([...f.periods.values()].reduce((sum, value) => sum + value.reserved, 0), 0);
});

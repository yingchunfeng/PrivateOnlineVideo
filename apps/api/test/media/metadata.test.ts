import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FFprobeMetadataInspector, parseProbe } from "../../src/modules/media/metadata/ffprobe.js";
import { UnavailableMetadataInspector } from "../../src/modules/media/metadata/types.js";
import { MockStorageAdapter } from "../../src/modules/media/storage/mock.js";

const sample = { format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.5", tags: { major_brand: "isom" } },
  streams: [{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", profile: "High", width: 1920, height: 1080 }, { codec_type: "audio", codec_name: "aac" }] };

test("内容元数据区分 MP4/H264/AAC、HEVC、MOV、10-bit、未知；从不凭扩展名宣称可播", async () => {
  const compatible = parseProbe(sample); assert.equal(compatible.status, "ready"); assert.equal(compatible.durationSeconds, 12.5); assert.equal(compatible.codec, "h264/aac");
  for (const streams of [[{ ...sample.streams[0], codec_name: "hevc" }], [{ ...sample.streams[0], pix_fmt: "yuv420p10le", profile: "High 10" }]]) {
    assert.equal(parseProbe({ ...sample, streams }).status, "unsupported");
  }
  assert.equal(parseProbe({ ...sample, format: { ...sample.format, tags: { major_brand: "qt  " } } }).status, "unsupported");
  assert.equal(parseProbe({ ...sample, streams: [{ codec_type: "video", codec_name: "h264" }] }).status, "processing");
  const unknown = await new UnavailableMetadataInspector().inspect(); assert.equal(unknown.status, "processing"); assert.equal(unknown.durationSeconds, null); assert.equal(unknown.playable, false);
});

test("受控子进程通过一次性 loopback Range 探针读取，缺失/失败/超时/读取限额均清理且不伪造字段", async () => {
  const storage = new MockStorageAdapter(); storage.seed("library/sample.mp4", Buffer.from("0123456789"));
  const input = { storage, object: { key: "library/sample.mp4" }, signal: new AbortController().signal };
  const config = { executable: process.execPath, prefixArgs: [fileURLToPath(new URL("./probe-fixture.mjs", import.meta.url))], timeoutMs: 3000, maxReadBytes: 64, maxConcurrent: 1 };
  const inspector = new FFprobeMetadataInspector(config);
  const result = await inspector.inspect(input); assert.equal(result.status, "ready"); assert.deepEqual(storage.reads.at(-1)?.range, { start: 0, end: 7 });
  const missing = await new FFprobeMetadataInspector({ ...config, executable: "definitely-missing-ffprobe-test" }).inspect(input);
  assert.equal(missing.status, "processing"); assert.equal(missing.codec, null);
  const limited = await new FFprobeMetadataInspector({ ...config, maxReadBytes: 4 }).inspect(input);
  assert.equal(limited.status, "failed"); assert.equal(limited.durationSeconds, null);
  process.env.MEDIA_PROBE_FIXTURE_MODE = "timeout";
  try {
    const timeout = new FFprobeMetadataInspector({ ...config, timeoutMs: 100 }); const started = Date.now();
    const pending = timeout.inspect(input); const parallel = await timeout.inspect(input);
    assert.equal(parallel.status, "processing"); const ended = await pending;
    assert.equal(ended.status, "failed"); assert.ok(Date.now() - started < 2000);
  } finally { delete process.env.MEDIA_PROBE_FIXTURE_MODE; }
  process.env.MEDIA_PROBE_FIXTURE_MODE = "error";
  try { const failed = await inspector.inspect(input); assert.equal(failed.status, "failed"); assert.equal(failed.width, null); }
  finally { delete process.env.MEDIA_PROBE_FIXTURE_MODE; }
});

import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./playback.test.js";
import { headers } from "./fakes.js";
import { HttpError } from "../../src/core/errors.js";

const preview = (f: Awaited<ReturnType<typeof fixture>>, prefix = "library/existing/") => f.app.inject({
  method: "POST", url: "/api/imports/preview", headers, payload: { prefix } });
const commit = (f: Awaited<ReturnType<typeof fixture>>, previewId: string, itemIds: string[], categoryId = "category") => f.app.inject({
  method: "POST", url: "/api/imports/commit", headers, payload: { previewId, itemIds, categoryId } });

test("选择导入前缀/CSRF/条目ID/登录归属校验，重复登记与跨预览幂等，不暴露对象 key", async t => {
  const f = await fixture(); t.after(() => f.app.close());
  f.storage.seed("library/existing/a.mp4", Buffer.from("aaaa")); f.storage.seed("library/existing/b.mp4", Buffer.from("bbbb"));
  f.storage.seed("library/other/outside.mp4", Buffer.from("xxxx"));
  assert.equal((await preview(f, "outside/")).statusCode, 403); assert.equal((await preview(f, "library/../" )).statusCode, 403);
  const csrf = await f.app.inject({ method: "POST", url: "/api/imports/preview", headers: { cookie: headers.cookie }, payload: { prefix: "library/" } }); assert.equal(csrf.statusCode, 403);
  const response = await preview(f); assert.equal(response.statusCode, 200); const dto = response.json().data;
  const root = await preview(f, ""); assert.equal(root.statusCode, 200); assert.equal(root.json().data.items.length, 4);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/imports/preview", headers, payload: {} })).statusCode, 400);
  assert.equal(dto.items.length, 2); assert.equal(dto.items[0].codec, null); assert.ok(!response.body.includes("library/"));
  assert.equal((await commit(f, dto.id, ["forged-id"])).statusCode, 403);
  assert.equal((await commit(f, dto.id, [dto.items[0].id], "forged-category")).statusCode, 404);
  const unauthorized = await f.app.inject({ method: "POST", url: "/api/imports/commit", headers: { ...headers, "x-test-session": "different" },
    payload: { previewId: dto.id, itemIds: [dto.items[0].id], categoryId: "category" } }); assert.equal(unauthorized.statusCode, 404);
  const imported = await commit(f, dto.id, [dto.items[0].id]); assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json().data.videos.length, 1); assert.equal(f.videos.size, 2); assert.ok(!imported.body.includes("library/"));
  const firstId = imported.json().data.videos[0].id;
  const repeat = await commit(f, dto.id, [dto.items[0].id]); assert.equal(repeat.json().data.videos[0].id, firstId);
  const next = (await preview(f)).json().data; const again = await commit(f, next.id, [next.items[0].id]);
  assert.equal(again.json().data.videos[0].id, firstId); assert.equal(f.videos.size, 2);
  assert.equal(f.storage.objects.size, 4); // 视频原片和全部已有对象仍保留。
  f.clock.time = new Date(f.clock.time.getTime() + 60_001); assert.equal((await commit(f, dto.id, [dto.items[1].id])).statusCode, 404);
});

test("对象替换/不存在/存储失败及恶意列表不会错误登记，预先复核全部选中项", async t => {
  const f = await fixture(); t.after(() => f.app.close());
  f.storage.seed("library/existing/a.mp4", Buffer.from("aaaa")); f.storage.seed("library/existing/b.mp4", Buffer.from("bbbb"));
  const dto = (await preview(f)).json().data;
  f.storage.seed("library/existing/b.mp4", Buffer.from("changed"));
  assert.equal((await commit(f, dto.id, dto.items.map((item: { id: string }) => item.id))).statusCode, 409); assert.equal(f.videos.size, 1);
  const current = (await preview(f)).json().data; const head = f.storage.head.bind(f.storage);
  f.storage.head = async input => { if (input.object.key.endsWith("b.mp4")) throw new HttpError("NOT_FOUND"); return head(input); };
  assert.equal((await commit(f, current.id, current.items.map((item: { id: string }) => item.id))).statusCode, 404); assert.equal(f.videos.size, 1);
  f.storage.head = head;
  f.storage.list = async () => ({ items: [{ object: { key: "outside/a.mp4" }, fileName: "a.mp4", metadata: { sizeBytes: 1, etag: "x", contentType: "video/mp4" } }], nextCursor: null });
  assert.equal((await preview(f)).statusCode, 403); assert.equal(f.videos.size, 1);
  f.storage.list = async () => { throw new Error("internal credentials must not echo"); };
  const failed = await preview(f); assert.equal(failed.statusCode, 503); assert.ok(!failed.body.includes("credentials"));
});

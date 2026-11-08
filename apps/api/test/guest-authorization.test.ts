import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { encode } from "jpeg-js";
import type { GuestCredential, GuestPermission } from "@online-video/shared";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/core/config.js";
import { validateLibraryConfig } from "../src/core/library-config.js";
import { runtimeModules } from "../src/core/runtime.js";
import { openDatabase } from "../src/db/database.js";
import { AuthService, initializeAccount } from "../src/modules/auth/service.js";
import { readAuthSettings } from "../src/modules/auth/settings.js";
import { totp } from "../src/modules/auth/crypto.js";
import type { MockStorageAdapter } from "../src/modules/media/storage/mock.js";

type Headers = Record<string, string>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
async function fixture() {
  let at = new Date("2026-11-02T12:00:00.000Z"); const now = () => at;
  const database = openDatabase(":memory:", { initialize: true }); const key = randomBytes(32);
  const credentials = await initializeAccount(database, key, "访客权限集成管理员");
  database.client.prepare("UPDATE categories SET id='default'").run();
  const config = { ...readConfig({ NODE_ENV: "test", MAX_UPLOAD_BYTES: "1048576", UPLOAD_PART_SIZE_BYTES: "262144", MAX_UPLOAD_CONCURRENCY: "2", MEDIA_REQUESTS_PER_MINUTE: "1000" }),
    library: validateLibraryConfig({ mediaBaseUrl: "https://isolated-guest.invalid", objectPrefix: "onlineVideo/", categories: [{ id: "default", name: "未分类", tags: [] }] }) };
  const auth = new AuthService(database, key, readAuthSettings("test", { AUTH_MAX_FAILURES: "100" }), now);
  const modules = await runtimeModules(config, auth, database, now);
  const app = await buildApp({ config, auth, ...modules, logger: false });
  app.get("/api/future-admin-operation", async () => ({ data: { secret: "must not reach guest" } }));
  const headersFor = (response: { headers: { [key: string]: unknown }; json(): { data: { csrfToken: string } } }): Headers => ({
    origin: "http://127.0.0.1:5173", cookie: String(response.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": response.json().data.csrfToken
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "http://127.0.0.1:5173" }, payload: { password: credentials.password, totp: totp(credentials.totpSecret).generate({ timestamp: at.getTime() }) } });
  assert.equal(login.statusCode, 200, login.body); const admin = headersFor(login);
  const request = (headers: Headers, url: string, method: Method = "GET", payload?: object) => app.inject({ headers, url, method, ...(payload ? { payload } : {}) });
  const guest = async (permissions: GuestPermission[] = ["library", "upload", "pages"], seconds = 3600) => {
    const created = await request(admin, "/api/guests", "POST", { name: "受限访客", expiresAt: new Date(at.getTime() + seconds * 1000).toISOString(), permissions });
    assert.equal(created.statusCode, 200, created.body); const credential = created.json().data as GuestCredential;
    const loginGuest = async () => {
      const response = await app.inject({ method: "POST", url: "/api/auth/guest/login", headers: { origin: admin.origin! }, payload: { password: credential.password } });
      assert.equal(response.statusCode, 200, response.body); return headersFor(response);
    };
    return { ...credential, headers: await loginGuest(), login: loginGuest };
  };
  const uploadInput = { fileName: "guest.mp4", title: "访客独立上传", categoryId: "default", tags: [], sizeBytes: 8, clientRequestId: "guest-owned-request" };
  const createUpload = async (headers: Headers, id: string) => { const response = await request(headers, "/api/uploads", "POST", { ...uploadInput, clientRequestId: id }); assert.equal(response.statusCode, 200, response.body); return response.json().data; };
  const register = async () => { const response = await request(admin, "/api/videos/register-public", "POST", { publicUrl: "https://isolated-guest.invalid/onlineVideo/default/admin.mp4", title: "管理员视频", categoryId: "default", tags: [] }); assert.equal(response.statusCode, 200, response.body); return response.json().data; };
  return { database, app, auth, config, admin, request, guest, createUpload, register, uploadInput,
    storage: modules.media!.dependencies.storage as MockStorageAdapter, advance: (ms: number) => { at = new Date(at.getTime() + ms); }, close: async () => { await app.close(); database.close(); } };
}

test("访客旧业务接口矩阵：默认无编辑/删除/全站设置/账户权限；后续新增接口默认拒绝", async () => {
  const f = await fixture();
  try {
    const v = await f.register(); const g = await f.guest();
    for (const url of ["/api/videos", `/api/videos/${v.id}`, "/api/library"]) assert.equal((await f.request(g.headers, url)).statusCode, 200, url);
    const forbidden: [Method, string, object?][] = [
      ["GET", "/api/guests"], ["POST", "/api/guests", {}], ["GET", "/api/auth/sessions"], ["GET", "/api/auth/security"],
      ["POST", "/api/auth/password/direct", {}], ["POST", "/api/auth/email-verification/code", {}], ["GET", "/api/settings/site"],
      ["PATCH", "/api/settings/site", { version: 0, defaultTheme: "dark" }], ["PUT", "/api/library/configuration", {}],
      ["POST", "/api/categories", { name: "无权限" }], ["PATCH", "/api/tags/id", { name: "无权限" }], ["GET", "/api/uploads"],
      ["PATCH", `/api/videos/${v.id}`, { title: "不应保存" }], ["DELETE", `/api/videos/${v.id}`, { confirm: true }],
      ["PUT", `/api/videos/${v.id}/duration`, { durationSeconds: 10, expectedObjectKey: v.objectKey }], ["PUT", `/api/videos/${v.id}/cover`, {}],
      ["GET", "/api/future-admin-operation"]
    ];
    for (const [method, url, body] of forbidden) { const response = await f.request(g.headers, url, method, body); assert.equal(response.statusCode, 403, `${method} ${url}: ${response.body}`); }
    const readOnly = await f.guest(["pages"]);
    for (const [method, url, body] of [["GET", "/api/videos"], ["POST", "/api/uploads", f.uploadInput], ["POST", "/api/videos/register-public", {}], ["PUT", `/api/videos/${v.id}/progress`, { positionSeconds: 1 }]] as [Method, string, object?][]) assert.equal((await f.request(readOnly.headers, url, method, body)).statusCode, 403, url);
    assert.equal((await f.request(g.headers, `/api/videos/${v.id}`)).json().data.title, "管理员视频");
  } finally { await f.close(); }
});

test("任务按访客持久隔离，不能接管管理员/其他访客任务或借clientRequestId重试认领", async () => {
  const f = await fixture();
  try {
    const g = await f.guest(["upload", "tasks"]); const other = await f.guest(["upload", "tasks"]);
    const adminTask = await f.createUpload(f.admin, "admin-private-request");
    const own = await f.createUpload(g.headers, "guest-private-request"); const another = await f.createUpload(other.headers, "other-private-request");
    for (const task of [adminTask, another]) {
      for (const suffix of ["", "/complete"]) assert.equal((await f.request(g.headers, `/api/uploads/${task.id}${suffix}`, suffix ? "POST" : "GET")).statusCode, 404);
    }
    assert.equal((await f.request(g.headers, "/api/uploads", "POST", { ...f.uploadInput, clientRequestId: "admin-private-request" })).statusCode, 404);
    const page = (await f.request(g.headers, "/api/uploads?page=1&pageSize=1")).json().data;
    assert.equal(page.total, 1); assert.deepEqual(page.items.map((item: { id: string }) => item.id), [own.id]);
    assert.equal((await f.request(await g.login(), `/api/uploads/${own.id}`)).statusCode, 200);
    const adminPage = (await f.request(f.admin, "/api/uploads")).json().data; assert.equal(adminPage.total, 3);
    assert.equal((await f.request(g.headers, "/api/uploads", "POST", { ...f.uploadInput, clientRequestId: "guest-private-request" })).json().data.id, own.id);
  } finally { await f.close(); }
});

test("上传权限只补齐本人上传的封面/时长，编辑与仅删记录为独立授权；管理员权限不退化", async () => {
  const f = await fixture();
  try {
    const g = await f.guest(["library", "upload", "tasks"]); const v = await f.register(); const upload = await f.createUpload(g.headers, "guest-complete-request");
    const bytes = Buffer.alloc(8, 7);
    const part = await f.app.inject({ method: "PUT", url: `/api/uploads/${upload.id}/parts/1`, headers: { ...g.headers, "content-type": "application/octet-stream", "x-part-checksum": createHash("sha256").update(bytes).digest("hex") }, payload: bytes }); assert.equal(part.statusCode, 200, part.body);
    const completed = await f.request(g.headers, `/api/uploads/${upload.id}/complete`, "POST"); assert.equal(completed.statusCode, 200, completed.body); const ownVideo = completed.json().data.video;
    assert.equal((await f.request(g.headers, `/api/videos/${ownVideo.id}/duration`, "PUT", { durationSeconds: 23.4, expectedObjectKey: ownVideo.objectKey })).statusCode, 200);
    assert.equal((await f.request(g.headers, `/api/videos/${v.id}/duration`, "PUT", { durationSeconds: 10, expectedObjectKey: v.objectKey })).statusCode, 403);
    const image = (color: number) => encode({ width: 16, height: 12, data: Buffer.alloc(16 * 12 * 4, color) }, 80).data;
    const cover = await f.app.inject({ method: "PUT", url: `/api/videos/${ownVideo.id}/cover`, headers: { ...g.headers, "content-type": "image/jpeg" }, payload: image(100) });
    assert.equal(cover.statusCode, 200, cover.body);
    const coverCount = f.storage.objects.size;
    const replace = await f.app.inject({ method: "PUT", url: `/api/videos/${ownVideo.id}/cover`, headers: { ...g.headers, "content-type": "image/jpeg" }, payload: image(150) });
    assert.equal(replace.statusCode, 403, replace.body); assert.equal(f.storage.objects.size, coverCount);
    const edit = await f.guest(["library", "video_edit"]);
    assert.equal((await f.request(edit.headers, `/api/videos/${v.id}`, "PATCH", { title: "获授权编辑" })).statusCode, 200);
    assert.equal((await f.request(edit.headers, `/api/videos/${v.id}`, "DELETE", { confirm: true })).statusCode, 403);
    const remove = await f.guest(["library", "video_delete"]);
    assert.equal((await f.request(remove.headers, `/api/videos/${v.id}`, "PATCH", { title: "不应编辑" })).statusCode, 403);
    const before = f.storage.objects.size; const deleted = await f.request(remove.headers, `/api/videos/${v.id}`, "DELETE", { confirm: true }); assert.equal(deleted.statusCode, 200, deleted.body); assert.equal(f.storage.objects.size, before);
    assert.equal((await f.request(f.admin, "/api/settings/site", "PATCH", { version: 0, defaultTheme: "dark" })).statusCode, 200);
    assert.equal((await f.request(g.headers, "/api/auth/logout", "POST")).statusCode, 200);
  } finally { await f.close(); }
});

test("首页排序：真实路由鉴权/CSRF，配置权限可授权，普通访客不可读写", async () => {
  const f = await fixture();
  try {
    const plain = await f.guest(["library"]); const editor = await f.guest(["configuration"]);
    const data = (await f.request(f.admin, "/api/settings/homepage")).json().data;
    const body = { version: data.version, categoryRandomEnabled: false, videoOrder: data.videoOrder };
    assert.equal((await f.app.inject({ url: "/api/settings/homepage" })).statusCode, 401);
    for (const method of ["GET", "PUT"] as const) assert.equal((await f.request(plain.headers, "/api/settings/homepage", method, method === "PUT" ? body : undefined)).statusCode, 403);
    assert.equal((await f.request(editor.headers, "/api/settings/homepage")).statusCode, 200);
    assert.equal((await f.app.inject({ method: "PUT", url: "/api/settings/homepage", headers: { cookie: f.admin.cookie!, origin: f.admin.origin! }, payload: body })).statusCode, 403);
    const saved = await f.request(editor.headers, "/api/settings/homepage", "PUT", body);
    assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().data.categoryRandomEnabled, false);
    assert.equal((await f.request(f.admin, "/api/settings/homepage", "PUT", body)).json().error.code, "CONFIG_VERSION_CONFLICT");
    assert.equal((await f.request(f.admin, "/api/settings/homepage")).json().data.version, data.version + 1);
  } finally { await f.close(); }
});

test("权限更新即时约束既有全部会话，配置可授权但全站设置不可授权；自然到期逐请求拒绝", async () => {
  const f = await fixture();
  try {
    const g = await f.guest(["library", "upload", "tasks", "configuration"], 60); const second = await g.login();
    assert.equal((await f.request(g.headers, "/api/library/configuration")).statusCode, 200);
    const changed = await f.request(f.admin, `/api/guests/${g.guest.id}`, "PATCH", { name: "只读", expiresAt: g.guest.expiresAt, permissions: ["pages"], version: 1 }); assert.equal(changed.statusCode, 200, changed.body);
    for (const headers of [g.headers, second]) {
      assert.equal((await f.request(headers, "/api/videos")).statusCode, 403);
      assert.deepEqual((await f.request(headers, "/api/auth/me")).json().data.guest.permissions, ["pages"]);
    }
    f.advance(60001);
    for (const headers of [g.headers, second]) assert.equal((await f.request(headers, "/api/auth/me")).statusCode, 401);
    assert.equal((await f.request(f.admin, "/api/guests")).json().data.items[0].status, "expired");
  } finally { await f.close(); }
});

for (const mode of ["revoke", "reset", "expire", "permission"] as const) test(`在途分片${mode}会取消上游，晚回调不能确认分片或登记视频`, async () => {
  const f = await fixture();
  try {
    const g = await f.guest(["upload", "tasks"], 60); const upload = await f.createUpload(g.headers, `inflight-${mode}-request`);
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let aborted = false;
    f.storage.uploadPart = async input => {
      for await (const _chunk of input.stream) { /* 测试适配器消费输入后挂起，验证撤销也能取消已经收完的请求。 */ }
      entered(); await new Promise<void>(resolve => { if (input.signal.aborted) { aborted = true; resolve(); } else input.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }); });
      return { etag: "late-untrusted-result" };
    };
    const bytes = Buffer.alloc(8, 1); const pending = f.app.inject({ method: "PUT", url: `/api/uploads/${upload.id}/parts/1`, headers: { ...g.headers, "content-type": "application/octet-stream", "x-part-checksum": createHash("sha256").update(bytes).digest("hex") }, payload: bytes });
    const response = pending.then(value => value); await started;
    if (mode === "expire") f.advance(60001);
    else if (mode === "permission") assert.equal((await f.request(f.admin, `/api/guests/${g.guest.id}`, "PATCH", { name: "已收回上传", expiresAt: g.guest.expiresAt, permissions: ["pages"], version: 1 })).statusCode, 200);
    else assert.equal((await f.request(f.admin, `/api/guests/${g.guest.id}/${mode}`, "POST", { version: 1 })).statusCode, 200);
    const result = await Promise.race([response, delay(3000).then(() => { throw new Error("访客失效后在途分片未中止"); })]);
    assert.ok(result.statusCode >= 400, result.body); assert.equal(aborted, true);
    assert.equal((f.database.client.prepare("SELECT count(*) n FROM upload_parts WHERE upload_id=?").get(upload.id) as { n: number }).n, 0);
    assert.equal((await f.request(g.headers, `/api/uploads/${upload.id}/complete`, "POST")).statusCode, mode === "permission" ? 403 : 401);
    assert.equal((f.database.client.prepare("SELECT count(*) n FROM videos").get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

for (const mode of ["complete", "cover"] as const) test(`在途${mode}撤销后不登记视频或关联封面，已经产生的OSS替身对象保留`, async () => {
  const f = await fixture();
  try {
    const g = await f.guest(["upload", "tasks"]); const upload = await f.createUpload(g.headers, `late-${mode}-request`);
    const bytes = Buffer.alloc(8, 2);
    const part = await f.app.inject({ method: "PUT", url: `/api/uploads/${upload.id}/parts/1`, headers: { ...g.headers, "content-type": "application/octet-stream", "x-part-checksum": createHash("sha256").update(bytes).digest("hex") }, payload: bytes });
    assert.equal(part.statusCode, 200, part.body);
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let aborted = false;
    const waitForRevoke = async (signal: AbortSignal) => { entered(); await new Promise<void>(resolve => { signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }); }); };
    let videoId: string | undefined;
    let pending;
    if (mode === "complete") {
      const original = f.storage.completeMultipart.bind(f.storage);
      f.storage.completeMultipart = async input => { const result = await original(input); await waitForRevoke(input.signal); return result; };
      pending = f.request(g.headers, `/api/uploads/${upload.id}/complete`, "POST").then(response => response);
    } else {
      const completed = await f.request(g.headers, `/api/uploads/${upload.id}/complete`, "POST"); assert.equal(completed.statusCode, 200, completed.body); videoId = completed.json().data.video.id;
      const original = f.storage.putImage.bind(f.storage);
      f.storage.putImage = async input => { const result = await original(input); await waitForRevoke(input.signal); return result; };
      const image = encode({ width: 16, height: 12, data: Buffer.alloc(16 * 12 * 4, 100) }, 80).data;
      pending = f.app.inject({ method: "PUT", url: `/api/videos/${videoId}/cover`, headers: { ...g.headers, "content-type": "image/jpeg" }, payload: image }).then(response => response);
    }
    await started;
    const revoked = await f.request(f.admin, `/api/guests/${g.guest.id}/revoke`, "POST", { version: 1 }); assert.equal(revoked.statusCode, 200, revoked.body);
    const response = await Promise.race([pending, delay(3000).then(() => { throw new Error("在途完成/封面撤销未中止"); })]);
    assert.ok(response.statusCode >= 400, response.body); assert.equal(aborted, true);
    assert.equal(f.storage.objects.size, mode === "complete" ? 1 : 2);
    if (mode === "complete") assert.equal((f.database.client.prepare("SELECT count(*) n FROM videos").get() as { n: number }).n, 0);
    else assert.equal((f.database.client.prepare("SELECT thumbnail_key FROM videos WHERE id=?").get(videoId) as { thumbnail_key: string | null }).thumbnail_key, null);
    assert.deepEqual(f.database.client.pragma("foreign_key_check"), []);
  } finally { await f.close(); }
});

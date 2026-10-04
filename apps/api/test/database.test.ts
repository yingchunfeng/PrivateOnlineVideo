import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { guardDatabasePath, migrateDatabase, openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import * as s from "../src/db/schema.js";
import type { AuthPrincipal, VideoRecord } from "../src/core/contracts/index.js";

function fixture(path = ":memory:", initialize = true) {
  if (path !== ":memory:" && initialize) new Database(path).close();
  const database = openDatabase(path, { initialize });
  const clock = { at: new Date("2026-10-01T10:00:00.000Z") };
  if (initialize) {
    database.orm.insert(s.users).values({ id: "owner", displayName: "测试", passwordHash: "test-placeholder", totpCipher: "test-placeholder", createdAt: clock.at.toISOString() }).run();
    database.orm.insert(s.categories).values({ id: "category", ownerId: "owner", name: "未分类", isDefault: true, createdAt: clock.at.toISOString() }).run();
    database.orm.insert(s.loginSessions).values({ id: "login", ownerId: "owner", tokenHash: "test-hash", createdAt: clock.at.toISOString(), lastSeenAt: clock.at.toISOString(), expiresAt: "2026-10-02T10:00:00.000Z" }).run();
  }
  const repos = createRepositories(database, () => clock.at);
  const principal: AuthPrincipal = { user: { id: "owner", displayName: "测试", totpEnabled: true }, loginSessionId: "login" };
  const video: VideoRecord = { ownerId: "owner", originalObject: { key: "library/video.mp4" }, playbackObject: { key: "library/video.mp4" }, thumbnailObject: null,
    video: { id: "video", title: "原视频", categoryId: "category", durationSeconds: null, sizeBytes: 8, status: "ready", thumbnailUrl: null,
      createdAt: clock.at.toISOString(), codec: "h264/aac", width: 640, height: 360, playable: true, lastPositionSeconds: 0 } };
  return { database, repos, principal, video, clock };
}
test("迁移版本/校验、单人和安全路径：拒绝测试库与未知数据库，不自动重建", () => {
  assert.throws(() => guardDatabasePath(resolve(WORKSPACE_ROOT, "sqlite-test.db")));
  assert.throws(() => guardDatabasePath(resolve(WORKSPACE_ROOT, "outside.db")));
  const f = fixture();
  try {
    migrateDatabase(f.database.client);
    assert.equal((f.database.client.prepare("SELECT count(*) count FROM schema_migrations").get() as { count: number }).count, 2);
    assert.throws(() => f.database.orm.insert(s.users).values({ id: "another", displayName: "用户2", passwordHash: "x", totpCipher: "x", createdAt: f.clock.at.toISOString() }).run());
    f.database.client.prepare("UPDATE schema_migrations SET checksum='changed'").run();
    assert.throws(() => migrateDatabase(f.database.client));
    assert.equal(f.database.orm.select().from(s.users).all().length, 1);
  } finally { f.database.close(); }
  const unknown = new Database(":memory:"); unknown.exec("CREATE TABLE user_data(id INTEGER)");
  try { assert.throws(() => migrateDatabase(unknown)); assert.ok(unknown.prepare("SELECT name FROM sqlite_master WHERE name='user_data'").get()); }
  finally { unknown.close(); }
});
test("真实 Repository 所有权/对象幂等、分片校验及 CAS，失败不丢失既有数据", async () => {
  const f = fixture();
  try {
    const { videos, uploads } = f.repos;
    await assert.rejects(videos.assertCategoryOwned("other", "category"));
    await videos.register(f.video);
    const repeated = await Promise.all(Array.from({ length: 3 }, () => videos.register({ ...f.video, video: { ...f.video.video, id: randomUUID(), title: "禁止覆盖" } })));
    assert.ok(repeated.every(record => record.video.id === "video" && record.video.title === "原视频"));
    assert.equal(await videos.findOwned("other", "video"), null);
    const upload = await uploads.create({ ownerId: "owner", request: { fileName: "a.mp4", sizeBytes: 8, title: "视频", categoryId: "category" },
      object: { key: "library/new.mp4" }, storageUploadId: "oss-test", partSizeBytes: 4 });
    const part = { partNumber: 1, sizeBytes: 4, checksum: "a".repeat(64), etag: "etag1" };
    await uploads.savePart("owner", upload.task.id, part); await uploads.savePart("owner", upload.task.id, { ...part, etag: "different" });
    await assert.rejects(uploads.savePart("owner", upload.task.id, { ...part, checksum: "b".repeat(64) }));
    assert.equal((await uploads.findOwned("owner", upload.task.id))!.parts[0]!.etag, "etag1");
    assert.equal(await uploads.findOwned("other", upload.task.id), null);
    await uploads.transition("owner", upload.task.id, "uploading", "finalizing");
    await assert.rejects(uploads.transition("owner", upload.task.id, "uploading", "finalizing"));
    await uploads.transition("owner", upload.task.id, "finalizing", "failed");
    assert.equal((await uploads.findOwned("owner", upload.task.id))!.parts.length, 1);
  } finally { f.database.close(); }
});
test("两个真实 SQLite 连接竞争播放并发和字节预留，重启后状态持久化且结算幂等", async () => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `repository-${Date.now()}-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "test.db"); const f = fixture(path); const other = fixture(path, false);
  try {
    await f.repos.videos.register(f.video);
    const input = { principal: f.principal, videoId: "video", expiresAt: "2026-10-01T10:02:00.000Z", maxActiveSessions: 1, now: f.clock.at.toISOString() };
    const competing = await Promise.allSettled([f.repos.playback.create(input), other.repos.playback.create(input)]);
    assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
    const session = competing.find(result => result.status === "fulfilled")!;
    assert.ok(session.status === "fulfilled");
    const request = { ownerId: "owner", playbackSessionId: session.value.session.id, requestedBytes: 7,
      period: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-02T00:00:00.000Z", timezone: "UTC" }, policy: { kind: "limited", limitBytes: 10 } as const };
    const reserved = await Promise.all([f.repos.usage.reserve(request), other.repos.usage.reserve(request)]);
    assert.equal(reserved.reduce((sum, value) => sum + value.grantedBytes, 0), 10);
    await assert.rejects(f.repos.usage.reserve(request));
    for (const value of reserved) { await f.repos.usage.settle({ ownerId: "owner", reservationId: value.id, transferredBytes: value.grantedBytes }); await other.repos.usage.settle({ ownerId: "owner", reservationId: value.id, transferredBytes: value.grantedBytes }); }
    assert.equal((await f.repos.usage.read("owner", request.period, request.policy)).transferredBytes, 10);
    await assert.rejects(other.repos.usage.settle({ ownerId: "other", reservationId: reserved[0]!.id, transferredBytes: 0 }));
    other.database.orm.update(s.loginSessions).set({ revokedAt: f.clock.at.toISOString() }).where(eq(s.loginSessions.id, "login")).run();
    assert.equal(await f.repos.playback.findActive({ principal: f.principal, sessionId: session.value.session.id, videoId: "video", now: f.clock.at.toISOString() }), null);
  } finally { f.database.close(); other.database.close(); }
  const reopened = fixture(path, false);
  try { assert.equal((await reopened.repos.videos.findOwned("owner", "video"))!.video.sizeBytes, 8);
    assert.equal(reopened.database.orm.select().from(s.transferReservations).all().length, 2); }
  finally { reopened.database.close(); }
});

test("SQLite 一致性备份可作为新目标恢复，迁移与用户数据保留且原库不覆盖", async () => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `backup-${Date.now()}-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const f = fixture(); const backup = resolve(directory, "snapshot.db");
  try {
    await f.repos.videos.register(f.video); await f.database.client.backup(backup);
    const restored = openDatabase(backup);
    try {
      assert.equal(restored.client.pragma("integrity_check", { simple: true }), "ok");
      assert.equal((await createRepositories(restored).videos.findOwned("owner", "video"))!.video.title, "原视频");
      assert.equal(restored.orm.select().from(s.users).all().length, 1);
    } finally { restored.close(); }
    assert.equal((await f.repos.videos.findOwned("owner", "video"))!.video.title, "原视频");
  } finally { f.database.close(); }
});

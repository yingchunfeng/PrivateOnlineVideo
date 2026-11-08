import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { homepageUpgradeSql } from "../scripts/export-full-sql.js";
import { migrateDatabase, migrationManifest } from "../src/db/database.js";

const at = "2026-11-08T10:00:00.000Z";
function source(version = 8) {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON");
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of migrationManifest().slice(0, version)) { db.exec(migration.sql); db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migration.version, migration.checksum, at); }
  db.prepare("INSERT INTO users(id,display_name,password_hash,totp_cipher,created_at) VALUES('fixture-owner','fixture','test-only-hash','test-only-cipher',?)").run(at);
  db.prepare("INSERT INTO categories(id,owner_id,name,name_key,created_at) VALUES('fixture-category','fixture-owner','fixture','fixture',?)").run(at);
  db.prepare("INSERT INTO videos(id,owner_id,title,category_id,size_bytes,status,created_at,playable,original_key,playback_key) VALUES('fixture-video','fixture-owner','fixture','fixture-category',1,'ready',?,1,'videos/fixture.webm','videos/fixture.webm')").run(at);
  db.prepare("INSERT INTO site_settings VALUES(1,'dark',1073741824,3,?)").run(at);
  return db;
}
const structure = (db: Database.Database) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const snapshot = (db: Database.Database) => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all() as { name: string }[])
  .map(row => [row.name, db.prepare(`SELECT * FROM "${row.name.replace(/"/g, '""')}"`).all()]));
function refused(db: Database.Database, sql = homepageUpgradeSql()) {
  const before = snapshot(db); const schema = structure(db);
  const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  assert.throws(() => db.exec(sql)); if (db.inTransaction) db.exec("ROLLBACK");
  assert.deepEqual(snapshot(db), before); assert.deepEqual(structure(db), schema);
  assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), ledger);
}

test("v8→v9 增量 SQL 与生成器逐字节一致，保持全部旧表数据及前8条账本", () => {
  const sql = readFileSync(new URL("../../../docs/sql/UPGRADE_V8_TO_V9.sql", import.meta.url), "utf8");
  assert.equal(sql, homepageUpgradeSql());
  const db = source(); const expected = new Database(":memory:");
  try {
    const before = snapshot(db); const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    db.exec(sql); migrateDatabase(expected);
    assert.deepEqual(structure(db), structure(expected));
    const after = snapshot(db); assert.deepEqual(after.homepage_settings, []);
    for (const [table, rows] of Object.entries(before)) assert.deepEqual(after[table], rows, table);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version<9 ORDER BY version").all(), ledger);
    assert.equal((db.prepare("SELECT checksum FROM schema_migrations WHERE version=9").get() as { checksum: string }).checksum, migrationManifest()[8]!.checksum);
    assert.deepEqual(db.pragma("foreign_key_check"), []); assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  } finally { db.close(); expected.close(); }
});

test("v8→v9 增量 SQL 拒绝 v7/v9、篡改账本和已存在未登记的同名表", () => {
  for (const version of [7, 9]) { const db = source(version); try { refused(db); } finally { db.close(); } }
  const mismatch = source();
  try { mismatch.prepare("UPDATE schema_migrations SET checksum='test-only-invalid' WHERE version=8").run(); refused(mismatch); } finally { mismatch.close(); }
  const partial = source();
  try { partial.exec("CREATE TABLE homepage_settings(keep TEXT); INSERT INTO homepage_settings VALUES('keep')"); refused(partial); } finally { partial.close(); }
});

test("v8→v9 增量 SQL 中途失败回滚新增结构，空库拒绝且不初始化账号", () => {
  const db = source(); const empty = new Database(":memory:");
  try {
    db.exec("CREATE TRIGGER refuse_fixture_v9 BEFORE INSERT ON schema_migrations WHEN NEW.version=9 BEGIN SELECT RAISE(ABORT,'test-only-failure'); END");
    refused(db);
    assert.throws(() => empty.exec(homepageUpgradeSql())); if (empty.inTransaction) empty.exec("ROLLBACK");
    assert.equal((empty.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get() as { n: number }).n, 0);
  } finally { db.close(); empty.close(); }
});

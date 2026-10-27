import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { fullInstallSql } from "../scripts/export-full-sql.js";
import { migrateDatabase, migrationManifest } from "../src/db/database.js";

test("完整安装 SQL 与最新迁移最终结构/种子/ledger 一致，且无个人数据", () => {
  const generated = fullInstallSql();
  const shipped = readFileSync(new URL("../../../docs/sql/NEW_INSTALL_FULL.sql", import.meta.url), "utf8");
  assert.equal(shipped, generated);
  const expected = new Database(":memory:"); const imported = new Database(":memory:");
  try {
    migrateDatabase(expected); imported.exec(shipped);
    const structure = (db: Database.Database) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.deepEqual(structure(imported), structure(expected));
    assert.deepEqual(imported.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all(), migrationManifest().map(row => ({ version: row.version, checksum: row.checksum })));
    assert.equal(imported.pragma("integrity_check", { simple: true }), "ok"); assert.deepEqual(imported.pragma("foreign_key_check"), []);
    for (const table of ["users", "installation_state", "installation_settings", "login_sessions", "smtp_provider_configs", "videos"])
      assert.equal((imported.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
    assert.equal((imported.prepare("SELECT count(*) n FROM smtp_provider_types").get() as { n: number }).n, 2);
    assert.throws(() => imported.exec(shipped)); if (imported.inTransaction) imported.exec("ROLLBACK");
    assert.deepEqual(structure(imported), structure(expected));
  } finally { imported.close(); expected.close(); }
});

test("完整安装 SQL 拒绝包含无关用户表的非空库，保留原数据", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE personal_data(value TEXT); INSERT INTO personal_data VALUES('keep')");
    assert.throws(() => db.exec(fullInstallSql()), /CHECK constraint failed/);
    if (db.inTransaction) db.exec("ROLLBACK");
    assert.deepEqual(db.prepare("SELECT value FROM personal_data").all(), [{ value: "keep" }]);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='users'").get(), undefined);
  } finally { db.close(); }
});

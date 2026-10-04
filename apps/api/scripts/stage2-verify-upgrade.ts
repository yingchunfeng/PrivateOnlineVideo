import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_DATABASE_PATH, WORKSPACE_ROOT, migrateDatabase, migrationManifest } from "../src/db/database.js";

// 源库始终只读；只升级唯一新副本，保留迁移前备份与报告，不打印业务数据或秘密。
const directory = resolve(WORKSPACE_ROOT, ".local/tests", `stage2-upgrade-${Date.now()}-${randomUUID()}`);
const backupPath = resolve(directory, "before-migration.db");
const upgradedPath = resolve(directory, "upgraded-copy.db");
const reportPath = resolve(directory, "report.json");
mkdirSync(directory, { recursive: true });
const original = new Database(DEFAULT_DATABASE_PATH, { readonly: true, fileMustExist: true });
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const snapshot = (db: Database.Database, tables: string[]) => Object.fromEntries(tables.map(table => [table,
  { count: (db.prepare(`SELECT count(*) n FROM "${table}"`).get() as { n: number }).n,
    hash: fingerprint(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()) }]));
try {
  const tables = (original.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  assert.ok(tables.every(name => /^[a-z_]+$/.test(name)));
  const before = snapshot(original, tables);
  const ledgerBefore = original.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all();
  assert.equal(original.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(original.pragma("foreign_key_check"), []);
  assert.equal(existsSync(backupPath), false); await original.backup(backupPath);
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try { assert.deepEqual(snapshot(backup, tables), before); await backup.backup(upgradedPath); }
  finally { backup.close(); }
  const copy = new Database(upgradedPath, { fileMustExist: true });
  try {
    copy.pragma("foreign_keys=ON"); migrateDatabase(copy);
    // 旧表逐列比较：categories/playback_sessions只比较迁移前列，新增列不影响旧值。
    const afterOld = Object.fromEntries(tables.map(table => {
      const columns = (original.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(row => row.name);
      assert.ok(columns.every(name => /^[a-z_]+$/.test(name)));
      const rows = copy.prepare(`SELECT ${columns.map(name => `"${name}"`).join(",")} FROM "${table}" ORDER BY rowid`).all();
      return [table, { count: rows.length, hash: fingerprint(rows) }];
    }));
    assert.deepEqual(afterOld, before);
    assert.equal(copy.pragma("integrity_check", { simple: true }), "ok"); assert.deepEqual(copy.pragma("foreign_key_check"), []);
    const ledger = copy.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all();
    assert.deepEqual(ledger, migrationManifest().map(({ version, checksum }) => ({ version, checksum })));
    migrateDatabase(copy); assert.deepEqual(copy.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all(), ledger);
    assert.deepEqual(snapshot(original, tables), before); assert.deepEqual(original.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all(), ledgerBefore);
    const report = { source: DEFAULT_DATABASE_PATH, sourceReadOnly: true, backupPath, upgradedPath, createdAt: new Date().toISOString(),
      originalLedger: ledgerBefore, upgradedLedger: ledger, originalDataUnchanged: true, copyOldColumnsUnchanged: true, repeatUpgradeIdempotent: true,
      integrityCheck: "ok", foreignKeyViolations: 0, counts: Object.fromEntries(Object.entries(before).map(([name, value]) => [name, value.count])) };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({ sourceReadOnly: true, sourceVersion: 1, copyVersion: 2, oldDataUnchanged: true, integrityCheck: "ok", backupPath, upgradedPath, reportPath }));
  } finally { copy.close(); }
} finally { original.close(); }

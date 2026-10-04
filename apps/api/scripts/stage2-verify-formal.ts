import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_DATABASE_PATH, guardDatabasePath, migrationManifest } from "../src/db/database.js";

const backupPath = guardDatabasePath(process.argv[2] ?? "");
const reportPath = resolve(dirname(backupPath), `${backupPath.split(/[\\/]/).at(-1)}.verification.json`);
const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
const formal = new Database(DEFAULT_DATABASE_PATH, { readonly: true, fileMustExist: true });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
try {
  const tables = (backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  const counts: Record<string, number> = {};
  for (const table of tables) {
    assert.match(table, /^[a-z_]+$/);
    const columns = (backup.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(row => row.name);
    assert.ok(columns.every(name => /^[a-z_]+$/.test(name)));
    const query = `SELECT ${columns.map(name => `"${name}"`).join(",")} FROM "${table}" ORDER BY rowid`;
    const before = backup.prepare(query).all(); const after = formal.prepare(query).all();
    assert.equal(hash(after), hash(before), `${table} 原列数据应保留`); counts[table] = after.length;
  }
  const ledger = formal.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all();
  assert.deepEqual(ledger, migrationManifest().map(({ version, checksum }) => ({ version, checksum })));
  assert.equal(formal.pragma("integrity_check", { simple: true }), "ok"); assert.deepEqual(formal.pragma("foreign_key_check"), []);
  const manual = new Database(resolve(dirname(DEFAULT_DATABASE_PATH), "../../sqlite-test.db"), { readonly: true, fileMustExist: true });
  try {
    assert.equal((manual.prepare("SELECT count(*) n FROM users").get() as { n: number }).n, 0);
    assert.equal((manual.prepare("SELECT count(*) n FROM schema_migrations").get() as { n: number }).n, 0);
  } finally { manual.close(); }
  const report = { verifiedAt: new Date().toISOString(), databasePath: DEFAULT_DATABASE_PATH, backupPath, formalVersion: 2,
    oldColumnsUnchanged: true, counts, ledger, integrityCheck: "ok", foreignKeyViolations: 0, manualDatabasePreserved: true };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ formalVersion: 2, users: counts.users, oldColumnsUnchanged: true, integrityCheck: "ok", manualDatabasePreserved: true, reportPath }));
} finally { backup.close(); formal.close(); }

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { readDeploymentTarget } from "../apps/api/dist/core/deployment-config.js";
import { migrationManifest, WORKSPACE_ROOT } from "../apps/api/dist/db/database.js";

const sqlPath = fileURLToPath(new URL("../docs/sql/NEW_INSTALL_FULL.sql", import.meta.url));

function pathExists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export function initializeFreshDatabase(args = []) {
  const target = readDeploymentTarget(args);
  const { databasePath, keyFile, reuseExistingKey } = target;
  const protectedPaths = [databasePath, ...["-wal", "-shm", "-journal", ".library.json", ".installation-code.txt"].map(suffix => `${databasePath}${suffix}`)];
  if (!reuseExistingKey) protectedPaths.push(keyFile);
  if (protectedPaths.some(pathExists)) {
    throw new Error("Refusing initialization: database or companion files already exist. Nothing was overwritten.");
  }
  if (reuseExistingKey && (!existsSync(keyFile) || readFileSync(keyFile).length !== 32)) {
    throw new Error("Explicit authKeyFile must be an existing 32-byte key. No replacement key was generated.");
  }

  const sql = readFileSync(sqlPath, "utf8");
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  // Exclusive creation also rejects a concurrent initializer and dangling links.
  closeSync(openSync(databasePath, "wx", 0o600));
  let database;
  try {
    database = new Database(databasePath, { fileMustExist: true });
    database.exec(sql);
    const integrity = database.pragma("integrity_check", { simple: true });
    const violations = database.pragma("foreign_key_check");
    const ledger = database.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all();
    const expected = migrationManifest();
    const users = database.prepare("SELECT count(*) AS count FROM users").get().count;
    if (integrity !== "ok" || violations.length || users !== 0 || ledger.length !== expected.length ||
        ledger.some((row, index) => row.version !== expected[index].version || row.checksum !== expected[index].checksum)) {
      throw new Error("New database validation failed; preserve the file and investigate before proceeding.");
    }
    return { databasePath, migrations: ledger.length, integrity };
  } catch (error) {
    if (database?.inTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database?.close();
  }
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  try {
    const result = initializeFreshDatabase(process.argv.slice(2));
    console.log(`Database initialized: ${result.databasePath}; migrations=${result.migrations}; integrity=${result.integrity}.`);
    console.log("Start the API to generate the master key and installation code; do not run initialization again.");
  } catch (error) {
    console.error(`Database initialization refused or failed: ${error.message}`);
    console.error(`Existing files are preserved. Paths are resolved relative to ${WORKSPACE_ROOT}.`);
    process.exitCode = 1;
  }
}

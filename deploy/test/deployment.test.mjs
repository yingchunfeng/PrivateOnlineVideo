import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeFreshDatabase } from "../init-db.mjs";
import { openDatabase, WORKSPACE_ROOT } from "../../apps/api/dist/db/database.js";
import { buildInstallationApp, readInstallationConfig } from "../../apps/api/dist/core/installation-runtime.js";
import { readAuthSettings } from "../../apps/api/dist/modules/auth/settings.js";
import { initializeInstallation } from "../../apps/api/dist/modules/setup/bootstrap.js";

function fixture(extra = {}) {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `docker-deployment-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const databasePath = resolve(directory, "new-install.db");
  const config = resolve(directory, "deployment.json");
  const options = typeof extra === "function" ? extra(directory) : extra;
  writeFileSync(config, JSON.stringify({ databasePath, ...options }), { encoding: "utf8", flag: "wx" });
  return { directory, databasePath, config, args: ["--config", config] };
}

test("fresh initialization imports the full schema without generating secrets", () => {
  const item = fixture();
  const result = initializeFreshDatabase(item.args);
  assert.equal(result.integrity, "ok");
  assert.equal(result.migrations, 6);
  const database = openDatabase(item.databasePath);
  try {
    assert.equal(database.client.prepare("SELECT count(*) n FROM users").get().n, 0);
    assert.equal(database.client.prepare("SELECT count(*) n FROM installation_state").get().n, 0);
    assert.equal(database.client.prepare("SELECT count(*) n FROM smtp_provider_types").get().n, 2);
  } finally { database.close(); }
  assert.equal(existsSync(`${item.databasePath}.auth.key`), false);
  assert.equal(existsSync(`${item.databasePath}.installation-code.txt`), false);
});

test("first API initialization creates a key and restart reuses it", async () => {
  const item = fixture();
  initializeFreshDatabase(item.args);
  const database = openDatabase(item.databasePath);
  try {
    const settings = readAuthSettings("production", { DATABASE_PATH: item.databasePath,
      AUTH_KEY_FILE: `${item.databasePath}.auth.key`, AUTH_ALLOWED_ORIGINS: "https://video.example.com" });
    const first = await initializeInstallation(database, settings);
    const code = readFileSync(first.installationCodeFile);
    assert.equal(first.key.length, 32);
    const second = await initializeInstallation(database, settings);
    assert.deepEqual(second.key, first.key);
    assert.deepEqual(readFileSync(second.installationCodeFile), code);
  } finally { database.close(); }
  const before = readFileSync(item.databasePath);
  assert.throws(() => initializeFreshDatabase(item.args), /already exist/);
  assert.deepEqual(readFileSync(item.databasePath), before);
});

test("the compiled production runtime boots against the initialized database", async () => {
  const item = fixture();
  initializeFreshDatabase(item.args);
  const database = openDatabase(item.databasePath);
  let app;
  try {
    const settings = readAuthSettings("production", { DATABASE_PATH: item.databasePath,
      AUTH_KEY_FILE: `${item.databasePath}.auth.key`, AUTH_ALLOWED_ORIGINS: "https://video.example.com" });
    const { key } = await initializeInstallation(database, settings);
    const config = readInstallationConfig({ NODE_ENV: "production", API_HOST: "0.0.0.0" });
    ({ app } = await buildInstallationApp({ database, key, settings, config, logger: false }));
    const response = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { data: { status: "ok" } });
  } finally {
    if (app) await app.close();
    database.close();
  }
});

test("an existing empty database is refused and preserved", () => {
  const item = fixture();
  writeFileSync(item.databasePath, "", { flag: "wx" });
  assert.throws(() => initializeFreshDatabase(item.args), /already exist/);
  assert.equal(readFileSync(item.databasePath).length, 0);
});

for (const suffix of ["-wal", "-shm", "-journal", ".auth.key", ".library.json", ".installation-code.txt"]) {
  test(`companion ${suffix} prevents initialization without altering it`, () => {
    const item = fixture();
    const path = `${item.databasePath}${suffix}`;
    writeFileSync(path, "preserve-this-file", { flag: "wx" });
    assert.throws(() => initializeFreshDatabase(item.args), /already exist/);
    assert.equal(existsSync(item.databasePath), false);
    assert.equal(readFileSync(path, "utf8"), "preserve-this-file");
  });
}

test("an explicit missing or invalid key is refused before database creation", () => {
  for (const invalid of [false, true]) {
    const item = fixture(directory => ({ authKeyFile: resolve(directory, "selected.auth.key") }));
    const keyPath = resolve(item.directory, "selected.auth.key");
    if (invalid) writeFileSync(keyPath, "invalid", { flag: "wx" });
    assert.throws(() => initializeFreshDatabase(item.args), /existing 32-byte key/);
    assert.equal(existsSync(item.databasePath), false);
    assert.equal(existsSync(keyPath), invalid);
  }
});

test("explicit valid shared keys are preserved for a new independent database", async () => {
  const item = fixture(directory => ({ authKeyFile: resolve(directory, "shared.auth.key") }));
  const keyPath = resolve(item.directory, "shared.auth.key");
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { flag: "wx", mode: 0o600 });
  initializeFreshDatabase(item.args);
  const database = openDatabase(item.databasePath);
  try {
    const settings = readAuthSettings("test", { DATABASE_PATH: item.databasePath, AUTH_KEY_FILE: keyPath });
    const initialized = await initializeInstallation(database, settings, { reuseExistingKey: true });
    assert.deepEqual(initialized.key, key);
    assert.deepEqual(readFileSync(keyPath), key);
    assert.equal(existsSync(`${item.databasePath}.auth.key`), false);
  } finally { database.close(); }
});

test("paths outside .local are rejected before creating a database", () => {
  const item = fixture({ databasePath: "outside-deployment-test.db" });
  assert.throws(() => initializeFreshDatabase(item.args), /\.local/);
  assert.equal(existsSync(resolve(WORKSPACE_ROOT, "outside-deployment-test.db")), false);
});

test("relative CLI config paths resolve from workspace root, not current directory", () => {
  const item = fixture();
  const result = spawnSync(process.execPath, [resolve(WORKSPACE_ROOT, "deploy/init-db.mjs"),
    "--config", relative(WORKSPACE_ROOT, item.config)], { cwd: resolve(WORKSPACE_ROOT, "apps/api"), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /integrity=ok/);
  const database = new Database(item.databasePath, { readonly: true, fileMustExist: true });
  try { assert.equal(database.prepare("SELECT count(*) n FROM schema_migrations").get().n, 6); }
  finally { database.close(); }
  const refused = spawnSync(process.execPath, [resolve(WORKSPACE_ROOT, "deploy/init-db.mjs"), ...item.args], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exist/);
});

test("new-deployment template omits authKeyFile and uses the mounted data directory", () => {
  const value = JSON.parse(readFileSync(resolve(WORKSPACE_ROOT, "deploy/deployment.json.example"), "utf8"));
  assert.deepEqual(value, { databasePath: ".local/data/new-install.db" });
});

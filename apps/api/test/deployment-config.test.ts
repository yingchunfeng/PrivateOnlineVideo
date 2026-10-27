import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { parseDeploymentConfig, readDeploymentConfig, readDeploymentTarget } from "../src/core/deployment-config.js";
import { openDatabase, WORKSPACE_ROOT } from "../src/db/database.js";
import { readAuthSettings } from "../src/modules/auth/settings.js";
import { initializeInstallation, readInstallationState } from "../src/modules/setup/bootstrap.js";
import { InstallationSettingsService } from "../src/modules/installation-settings/service.js";
import { MockStorageAdapter } from "../src/modules/media/storage/mock.js";

function directory() {
  const path = resolve(WORKSPACE_ROOT, ".local/tests", `deployment-${randomUUID()}`);
  mkdirSync(path, { recursive: true }); return path;
}
function fresh(path: string) { new Database(path).close(); return openDatabase(path, { initialize: true }); }
const settingsFor = (databasePath: string, keyFile: string) => readAuthSettings("test", { DATABASE_PATH: databasePath, AUTH_KEY_FILE: keyFile });

test("启动配置相对项目根解析；显式密钥复用，省略时沿用数据库伴随密钥", () => {
  const path = resolve(WORKSPACE_ROOT, ".local/tests/isolated.db");
  assert.deepEqual(parseDeploymentConfig({ databasePath: ".local/tests/isolated.db" }),
    { databasePath: path, keyFile: `${path}.auth.key`, reuseExistingKey: false });
  assert.deepEqual(parseDeploymentConfig({ databasePath: path, authKeyFile: ".local/tests/shared.auth.key" }),
    { databasePath: path, keyFile: resolve(WORKSPACE_ROOT, ".local/tests/shared.auth.key"), reuseExistingKey: true });
  for (const input of [null, [], {}, { databasePath: "" }, { databasePath: 1 }, { databasePath: ":memory:" },
    { databasePath: "sqlite-test.db" }, { databasePath: ".local/../outside.db" }, { databasePath: path, authKeyFile: "" },
    { databasePath: path, authKeyFile: null }, { databasePath: path, authKeyFile: "../outside.key" },
    { databasePath: path, authKeyFile: path }, { databasePath: path, accessKeySecret: "must-not-be-in-config" }]) {
    assert.throws(() => parseDeploymentConfig(input));
  }
});

test("默认配置文件与显式CLI入口互不混用；缺失或损坏不回退.env", () => {
  const root = directory(); const path = resolve(root, "deployment.json");
  const input = { databasePath: resolve(root, "selected.db"), authKeyFile: resolve(root, "shared.auth.key") };
  writeFileSync(path, JSON.stringify(input), { encoding: "utf8", flag: "wx" });
  assert.deepEqual(readDeploymentTarget([], path), parseDeploymentConfig(input));
  assert.deepEqual(readDeploymentTarget(["--config", relative(WORKSPACE_ROOT, path)]), parseDeploymentConfig(input));
  const explicit = resolve(root, "explicit.db");
  assert.deepEqual(readDeploymentTarget(["--database", explicit], path), parseDeploymentConfig({ databasePath: explicit }));
  assert.deepEqual(readDeploymentTarget(["--database", explicit, "--key-file", input.authKeyFile], path),
    parseDeploymentConfig({ databasePath: explicit, authKeyFile: input.authKeyFile }));
  const missing = resolve(root, "missing.json");
  assert.throws(() => readDeploymentTarget([], missing), /不会回退读取 .env/);
  assert.equal(readDeploymentTarget(["--database", explicit], missing).databasePath, explicit);
  const invalid = resolve(root, "invalid.json"); writeFileSync(invalid, "not json", { flag: "wx" });
  assert.throws(() => readDeploymentConfig(invalid), /不会回退读取 .env/);
  for (const args of [["--database"], ["--key-file", input.authKeyFile], ["--config", path, "--database", explicit],
    ["--database", explicit, "--unknown", "x"], ["--database", explicit, "--database", explicit]]) {
    assert.throws(() => readDeploymentTarget(args, path));
  }
});

test("默认npm开发/生产入口不加载.env；从API工作目录运行帮助无数据库副作用", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  for (const name of ["dev", "start", "dev:setup", "start:setup"]) {
    assert.match(pkg.scripts[name]!, /setup-server/); assert.doesNotMatch(pkg.scripts[name]!, /env-file/);
  }
  assert.match(pkg.scripts["dev:legacy"]!, /env-file-if-exists/);
  const help = spawnSync(process.execPath, ["--import", "tsx", "src/setup-server.ts", "--help"], {
    cwd: resolve(WORKSPACE_ROOT, "apps/api"), encoding: "utf8", timeout: 15_000 });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /config\/deployment.json/);
  assert.match(help.stdout, /--key-file/); assert.match(help.stdout, /不读取 .env/);
});

test("两个独立新库显式共用主密钥，重启读取各自OSS配置且不覆盖主密钥或安装码", async () => {
  const root = directory(); const keyFile = resolve(root, "shared.auth.key"); const buckets: string[] = [];
  let sharedKey: Buffer | undefined; const codes: string[] = [];
  for (const name of ["alpha", "beta"]) {
    const path = resolve(root, `${name}.db`); let database = fresh(path);
    const settings = settingsFor(path, keyFile);
    try {
      if (name === "beta") {
        await assert.rejects(initializeInstallation(database, settings), /拒绝覆盖/);
        assert.equal(readInstallationState(database), undefined); assert.equal(existsSync(`${path}.installation-code.txt`), false);
      }
      const initialized = await initializeInstallation(database, settings, { reuseExistingKey: name === "beta" });
      if (!sharedKey) sharedKey = initialized.key;
      assert.deepEqual(initialized.key, sharedKey); assert.deepEqual(readFileSync(keyFile), sharedKey);
      codes.push(readFileSync(initialized.installationCodeFile!, "utf8"));
      const service = new InstallationSettingsService(database, sharedKey, { isReady: () => false });
      service.saveOss({ version: 0, accessKeyId: `isolated-${name}-id`, accessKeySecret: `isolated-${name}-secret`,
        bucket: `isolated-${name}-bucket`, region: "cn-hangzhou", network: "public", allowPublicNetwork: true,
        mediaBaseUrl: `https://${name}.example.com`, objectPrefix: `${name}/` });
      database.close(); database = openDatabase(path);
      const restored = await initializeInstallation(database, settings, { reuseExistingKey: true });
      assert.deepEqual(restored.key, sharedKey); assert.equal(readFileSync(restored.installationCodeFile!, "utf8"), codes.at(-1));
      const reloaded = new InstallationSettingsService(database, restored.key, { storageFactory: async selected => {
        buckets.push(selected.bucket); return new MockStorageAdapter(selected.objectPrefix);
      } });
      assert.equal(reloaded.readOssSettings()!.bucket, `isolated-${name}-bucket`);
      await reloaded.createStorage().list({ prefix: `${name}/`, limit: 1, signal: new AbortController().signal });
      const wrongKey = resolve(root, `${name}-wrong.auth.key`); writeFileSync(wrongKey, randomBytes(32), { flag: "wx" });
      const before = readInstallationState(database);
      await assert.rejects(initializeInstallation(database, settingsFor(path, wrongKey), { reuseExistingKey: true }), /不一致/);
      assert.deepEqual(readInstallationState(database), before); assert.deepEqual(readFileSync(keyFile), sharedKey);
      assert.equal(reloaded.readOssSettings()!.bucket, `isolated-${name}-bucket`);
    } finally { database.close(); }
  }
  assert.notEqual(codes[0], codes[1]); assert.deepEqual(buckets, ["isolated-alpha-bucket", "isolated-beta-bucket"]);
});

test("新空库复用不存在或损坏的主密钥必须失败，不生成安装码或替代密钥", async () => {
  const root = directory(); const path = resolve(root, "new.db"); const database = fresh(path);
  try {
    for (const invalid of [false, true]) {
      const keyFile = resolve(root, invalid ? "invalid.auth.key" : "missing.auth.key");
      if (invalid) writeFileSync(keyFile, "invalid", { flag: "wx" });
      await assert.rejects(initializeInstallation(database, settingsFor(path, keyFile), { reuseExistingKey: true }), /不会重新生成/);
      assert.equal(readInstallationState(database), undefined); assert.equal(existsSync(`${path}.installation-code.txt`), false);
      assert.equal(existsSync(keyFile), invalid);
      if (invalid) assert.equal(readFileSync(keyFile, "utf8"), "invalid");
    }
    const shared = resolve(root, "valid.auth.key"); const key = randomBytes(32); writeFileSync(shared, key, { flag: "wx" });
    const codeFile = `${path}.installation-code.txt`; writeFileSync(codeFile, "preserved", { flag: "wx" });
    await assert.rejects(initializeInstallation(database, settingsFor(path, shared), { reuseExistingKey: true }), /拒绝覆盖/);
    assert.equal(readFileSync(codeFile, "utf8"), "preserved"); assert.deepEqual(readFileSync(shared), key);
    assert.equal(readInstallationState(database), undefined);
  } finally { database.close(); }
});

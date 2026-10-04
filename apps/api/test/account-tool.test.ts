import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { cryptoAction, loginMaterial } from "../scripts/account-tool.js";
import { WORKSPACE_ROOT } from "../src/db/database.js";
import { decryptSecret, encryptSecret, totp } from "../src/modules/auth/crypto.js";

test("独立工具密码哈希复用Argon2id参数，随机盐不影响校验；密码不能解密", async () => {
  const first = await cryptoAction("hash-password", { password: "isolated-password" }) as { hash: string };
  const second = await cryptoAction("hash-password", { password: "isolated-password" }) as { hash: string };
  assert.match(first.hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.notEqual(first.hash, second.hash);
  assert.deepEqual(await cryptoAction("verify-password", { hash: first.hash, password: "isolated-password" }), { matches: true });
  assert.deepEqual(await cryptoAction("verify-password", { hash: first.hash, password: "wrong-password" }), { matches: false });
  await assert.rejects(cryptoAction("verify-password", { hash: "not-a-hash", password: "isolated-password" }));
});

test("独立工具AES密文与网站双向兼容；随机IV、错误密钥和篡改认证", async () => {
  const key = randomBytes(32); const secret = "isolated-secret-测试";
  const first = await cryptoAction("encrypt-secret", { secret }, key) as { ciphertext: string };
  const second = await cryptoAction("encrypt-secret", { secret }, key) as { ciphertext: string };
  assert.notEqual(first.ciphertext, second.ciphertext); assert.equal(decryptSecret(first.ciphertext, key), secret);
  assert.deepEqual(await cryptoAction("decrypt-secret", { ciphertext: encryptSecret(secret, key) }, key), { secret });
  await assert.rejects(cryptoAction("decrypt-secret", { ciphertext: first.ciphertext }, randomBytes(32)));
  const parts = first.ciphertext.split("."); const bytes = Buffer.from(parts[3]!, "base64url"); bytes[0] = bytes[0]! ^ 1; parts[3] = bytes.toString("base64url");
  await assert.rejects(cryptoAction("decrypt-secret", { ciphertext: parts.join(".") }, key));
});

test("本地登录工具只读原账户，不消费TOTP；使用库中当前密钥并拒绝过时初始密码", async () => {
  const directory = resolve(WORKSPACE_ROOT, ".local/tests", `account-tool-${randomUUID()}`); mkdirSync(directory, { recursive: true });
  const databasePath = resolve(directory, "isolated.db"); const keyFile = resolve(directory, "fake-auth.key"); const setupFile = resolve(directory, "setup.json");
  const key = randomBytes(32); const secret = totp().secret.base32; const password = "isolated-local-password";
  const hashed = await cryptoAction("hash-password", { password }) as { hash: string };
  writeFileSync(keyFile, key, { flag: "wx" });
  writeFileSync(setupFile, JSON.stringify({ password, totpSecret: "stale-not-used" }), { encoding: "utf8", flag: "wx" });
  const db = new Database(databasePath);
  db.exec("CREATE TABLE users(singleton INTEGER, display_name TEXT, password_hash TEXT, totp_cipher TEXT, last_totp_counter INTEGER)");
  db.prepare("INSERT INTO users VALUES(1,?,?,?,-1)").run("隔离账户", hashed.hash, encryptSecret(secret, key)); db.close();
  const env = { DATABASE_PATH: databasePath, AUTH_KEY_FILE: keyFile };
  const digest = () => createHash("sha256").update(readFileSync(databasePath)).digest("hex"); const before = digest();
  const shown = await loginMaterial(true, setupFile, env, 150000);
  assert.equal(shown.password, password); assert.equal(shown.totp, totp(secret).generate({ timestamp: 150000 })); assert.equal(shown.alreadyUsed, false);
  const codeOnly = await loginMaterial(false, undefined, env, 150000);
  assert.equal("password" in codeOnly, false); assert.equal("secret" in codeOnly, false); assert.equal(digest(), before, "生成验证码不得写库或消费验证码");
  const changed = new Database(databasePath); changed.prepare("UPDATE users SET last_totp_counter=5").run(); changed.close();
  assert.equal((await loginMaterial(false, undefined, env, 150000)).alreadyUsed, true);
  const stale = resolve(directory, "stale-setup.json"); writeFileSync(stale, JSON.stringify({ password: "old-password" }), { encoding: "utf8", flag: "wx" });
  await assert.rejects(loginMaterial(true, stale, env, 150000), /密码已与当前账号不同/);
});

test("工具可直接启动，帮助无需服务或OSS；输入错误不回显秘密", () => {
  const file = resolve(WORKSPACE_ROOT, "apps/api/scripts/account-tool.ts");
  const help = spawnSync(process.execPath, ["--import", "tsx", file, "--help"], { cwd: WORKSPACE_ROOT, encoding: "utf8", windowsHide: true });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /无需启动 API 或 Web/);
  const invalid = spawnSync(process.execPath, ["--import", "tsx", file, "hash-password", "--password", "never-print-test-secret"], { cwd: WORKSPACE_ROOT, encoding: "utf8", windowsHide: true });
  assert.equal(invalid.status, 1); assert.equal((invalid.stdout + invalid.stderr).includes("never-print-test-secret"), false);
});

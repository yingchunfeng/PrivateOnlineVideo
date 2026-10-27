import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppDatabase } from "../../db/database.js";
import { guardLocalFile } from "../../db/database.js";
import { ConfigurationError } from "../../core/config.js";
import type { AuthSettings } from "../auth/settings.js";
import { readMasterKey, randomToken, tokenHash } from "../auth/crypto.js";
import { hasOnboardingSchema } from "../auth/login-mode.js";

export interface InstallationState { id: number; stage: "password" | "configuration" | "ready"; installation_code_hash: string;
  key_fingerprint: string; owner_id: string | null; version: number; created_at: string; completed_at: string | null }

export function readInstallationState(database: AppDatabase): InstallationState | undefined {
  return hasOnboardingSchema(database) ? database.client.prepare("SELECT * FROM installation_state WHERE id=1").get() as InstallationState | undefined : undefined;
}

async function writeNewSecret(path: string, value: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true }); const file = await open(path, "wx", 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
}

/** 仅供显式新部署启动：只接收已执行完整 SQL 的空 v6 库，不创建/升级现有数据库。 */
export async function initializeInstallation(database: AppDatabase, settings: AuthSettings,
  options: { reuseExistingKey?: boolean } = {}): Promise<{ key: Buffer; installationCodeFile: string | null }> {
  const state = readInstallationState(database);
  const count = (database.client.prepare("SELECT count(*) n FROM users").get() as { n: number }).n;
  if (!hasOnboardingSchema(database) || (!state && count > 0)) return { key: await readMasterKey(settings.keyFile), installationCodeFile: null };
  const keyFile = guardLocalFile(settings.keyFile);
  const installationCodeFile = guardLocalFile(`${settings.databasePath}.installation-code.txt`);
  if (state) {
    const key = await readMasterKey(keyFile);
    if (tokenHash(key.toString("base64url")) !== state.key_fingerprint || (state.stage === "password" ? count !== 0 : count !== 1))
      throw new ConfigurationError("安装状态、账号或安全密钥不一致；拒绝恢复默认密码，请核查原数据");
    if (state.stage === "password") {
      try {
        const raw = await readFile(installationCodeFile, "utf8");
        const code = raw.length < 1024 ? raw.split(/\r?\n/).find(line => /^[A-Za-z0-9_-]{43}$/.test(line)) : undefined;
        if (!code || tokenHash(code) !== state.installation_code_hash) throw new Error("invalid installation material");
      } catch { throw new ConfigurationError("安装码文件缺失或与新库不匹配；保留现状，不自动重新生成安装码"); }
    } else if (!database.client.prepare("SELECT 1 FROM users WHERE id=?").get(state.owner_id)) {
      throw new ConfigurationError("安装状态关联的管理员不存在；拒绝重新初始化");
    }
    return { key, installationCodeFile: state.stage === "password" ? installationCodeFile : null };
  }
  // 新库必须没有任何旧资料；不能只检查账号/视频而遗漏 SMTP 密文或审计记录。
  const tables = database.client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name } of tables) {
    if (["schema_migrations", "smtp_provider_types"].includes(name)) continue;
    if (database.client.prepare(`SELECT 1 FROM "${name.replace(/"/g, '""')}" LIMIT 1`).get()) throw new ConfigurationError("数据库包含已有资料，不是可初始化的新空库");
  }
  if ((!options.reuseExistingKey && existsSync(keyFile)) || existsSync(installationCodeFile)) throw new ConfigurationError("发现已有安装密钥或安装码，拒绝覆盖；请为新库使用独立路径或核查中断状态");
  // 只有显式指定的已有主密钥可供新空库复用；缺失或损坏时不生成替代密钥。
  const key = options.reuseExistingKey ? await readMasterKey(keyFile) : randomBytes(32); const code = randomToken();
  try {
    if (!options.reuseExistingKey) await writeNewSecret(keyFile, key);
    await writeNewSecret(installationCodeFile, `首次安装码（仅服务器管理员可读，改密后失效）：\n${code}\n`);
    database.client.transaction(() => {
      if (readInstallationState(database) || (database.client.prepare("SELECT count(*) n FROM users").get() as { n: number }).n) throw new Error("concurrent installation");
      database.client.prepare("INSERT INTO installation_state(id,stage,installation_code_hash,key_fingerprint,version,created_at) VALUES(1,'password',?,?,1,?)")
        .run(tokenHash(code), tokenHash(key.toString("base64url")), new Date().toISOString());
    }).immediate();
  } catch { throw new ConfigurationError("创建首次安装资料失败；保留已有文件和数据库，不覆盖或自动重置，请核查独立路径"); }
  return { key, installationCodeFile };
}

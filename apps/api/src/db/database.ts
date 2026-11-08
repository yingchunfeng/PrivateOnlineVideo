import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";
import { ConfigurationError } from "../core/config.js";

export const WORKSPACE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const DEFAULT_DATABASE_PATH = resolve(WORKSPACE_ROOT, ".local/data/video-library.db");
export const DEFAULT_AUTH_KEY_PATH = resolve(WORKSPACE_ROOT, ".local/secrets/auth.key");
export function guardLocalFile(path: string): string {
  const result = resolve(path);
  const localRoot = resolve(WORKSPACE_ROOT, ".local");
  const within = (base: string, target: string) => { const rel = relative(base, target); return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel); };
  if (!within(localRoot, result)) throw new ConfigurationError("本地数据/凭证必须位于项目 .local 目录，禁止接入用户测试库");
  let parent = dirname(result); while (!existsSync(parent)) parent = dirname(parent);
  const actual = realpathSync(parent);
  const root = realpathSync(WORKSPACE_ROOT);
  if (actual !== root && !within(root, actual)) throw new ConfigurationError("本地数据父目录越过项目边界");
  if (existsSync(localRoot)) {
    const base = realpathSync(localRoot);
    if (!within(root, base) || (actual !== base && !within(base, actual)) || (existsSync(result) && !within(base, realpathSync(result)))) {
      throw new ConfigurationError("本地数据路径通过链接越过 .local 边界");
    }
  }
  return result;
}
export function guardDatabasePath(path: string): string {
  const result = guardLocalFile(path);
  if (!result.endsWith(".db")) throw new ConfigurationError("数据库必须是 .local 内的独立 .db 文件");
  return result;
}
export const MIGRATIONS = ["0001-initial.sql", "0002-library-organizing.sql", "0003-account-email.sql", "0004-smtp-config.sql", "0005-smtp-providers.sql", "0006-onboarding.sql", "0007-site-settings.sql", "0008-guests.sql", "0009-homepage-settings.sql"] as const;
export function migrationManifest() {
  return MIGRATIONS.map((name, index) => {
    const sql = readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    return { version: index + 1, name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}
function validateLedger(client: Database.Database, latest: boolean) {
  const recorded = client.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all() as { version: number; checksum: string }[];
  const expected = migrationManifest();
  // 旧版继续启动；新功能写入需另行授权迁移，不在启动时升级。
  if (!recorded.length || recorded.length > expected.length || (latest && ![5, 6, 7, 8, expected.length].includes(recorded.length)) ||
    recorded.some((row, index) => row.version !== expected[index]?.version || row.checksum !== expected[index]?.checksum)) {
    throw new ConfigurationError("数据库迁移版本/顺序/校验与当前源码不一致；需明确目标并授权迁移，不会自动升级");
  }
  return recorded.length;
}
export function migrateDatabase(client: Database.Database): void {
  const migrations = migrationManifest();
  const hasLedger = client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (hasLedger) validateLedger(client, false);
  if (!hasLedger && (client.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { count: number }).count) {
    throw new ConfigurationError("拒绝对未知既有数据库初始化；请先人工核查及备份");
  }
  client.transaction(() => {
    client.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const count = hasLedger ? validateLedger(client, false) : 0;
    for (const migration of migrations.slice(count)) {
      client.exec(migration.sql);
      if (migration.version === 2) {
        // Unicode 名称规范化在迁移事务内完成；冲突直接回滚，不清理用户数据。
        const rows = client.prepare("SELECT id,name FROM categories").all() as { id: string; name: string }[];
        for (const row of rows) client.prepare("UPDATE categories SET name_key=? WHERE id=?").run(row.name.normalize("NFKC").trim().toLocaleLowerCase("und"), row.id);
      }
      client.prepare("INSERT INTO schema_migrations VALUES (?,?,?)").run(migration.version, migration.checksum, new Date().toISOString());
    }
    if ((client.pragma("foreign_key_check") as unknown[]).length || client.pragma("integrity_check", { simple: true }) !== "ok") throw new ConfigurationError("迁移一致性检查失败，事务已回滚");
  }).immediate();
}
export function openDatabase(path: string, options: { initialize?: boolean } = {}) {
  if (path !== ":memory:") { guardDatabasePath(path); if (!existsSync(path)) throw new ConfigurationError("正式数据库不存在，请先执行 account:init；服务启动不会自动创建数据库"); }
  const client = new Database(path, { fileMustExist: path !== ":memory:" });
  try {
    client.pragma("foreign_keys = ON"); client.pragma("busy_timeout = 5000");
    if (options.initialize) migrateDatabase(client);
    else {
      validateLedger(client, true);
    }
    if (path !== ":memory:") client.pragma("journal_mode = WAL");
    return { client, orm: drizzle(client, { schema }), path, close: () => client.close() };
  } catch (error) { client.close(); throw error; }
}
export type AppDatabase = ReturnType<typeof openDatabase>;

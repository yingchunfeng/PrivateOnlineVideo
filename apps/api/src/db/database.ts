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
const migrationSql = () => readFileSync(new URL("./migrations/0001-initial.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
export function migrateDatabase(client: Database.Database): void {
  const sql = migrationSql(); const checksum = createHash("sha256").update(sql).digest("hex");
  const hasLedger = client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (hasLedger && (client.prepare("SELECT MAX(version) version FROM schema_migrations").get() as { version: number | null }).version! > 1) {
    throw new ConfigurationError("数据库版本高于当前源码，拒绝回退");
  }
  if (!hasLedger && (client.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { count: number }).count) {
    throw new ConfigurationError("拒绝对未知既有数据库初始化；请先人工核查及备份");
  }
  client.transaction(() => {
    client.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const existing = client.prepare("SELECT checksum FROM schema_migrations WHERE version=1").get() as { checksum: string } | undefined;
    if (existing && existing.checksum !== checksum) throw new ConfigurationError("迁移 0001 校验不一致，拒绝修改已执行迁移");
    if (!existing) { client.exec(sql); client.prepare("INSERT INTO schema_migrations VALUES (1,?,?)").run(checksum, new Date().toISOString()); }
  }).immediate();
}
export function openDatabase(path: string, options: { initialize?: boolean } = {}) {
  if (path !== ":memory:") { guardDatabasePath(path); if (!existsSync(path)) throw new ConfigurationError("正式数据库不存在，请先执行 account:init；服务启动不会自动创建数据库"); }
  const client = new Database(path, { fileMustExist: path !== ":memory:" });
  try {
    client.pragma("foreign_keys = ON"); client.pragma("busy_timeout = 5000");
    if (options.initialize) migrateDatabase(client);
    else {
      const recorded = client.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all() as { version: number; checksum: string }[];
      const expected = createHash("sha256").update(migrationSql()).digest("hex");
      if (recorded.length !== 1 || recorded[0]?.version !== 1 || recorded[0]?.checksum !== expected) throw new ConfigurationError("数据库迁移版本与当前源码不一致");
    }
    if (path !== ":memory:") client.pragma("journal_mode = WAL");
    return { client, orm: drizzle(client, { schema }), path, close: () => client.close() };
  } catch (error) { client.close(); throw error; }
}
export type AppDatabase = ReturnType<typeof openDatabase>;

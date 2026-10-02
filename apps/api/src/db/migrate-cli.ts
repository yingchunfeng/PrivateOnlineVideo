import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { guardDatabasePath, migrateDatabase, WORKSPACE_ROOT } from "./database.js";
import { ConfigurationError } from "../core/config.js";

// 此命令只在用户明确指定目标及 --apply 时执行，不由 API 启动调用。
const args = process.argv.slice(2); const index = args.indexOf("--database");
try {
  if (index < 0 || !args[index + 1] || !args.includes("--apply")) throw new ConfigurationError("需要 --database <项目 .local 内的数据库> --apply；现有数据库会先做 SQLite 一致性备份");
  const path = guardDatabasePath(args[index + 1]!); const client = new Database(path, { fileMustExist: true });
  try {
    client.pragma("foreign_keys=ON"); client.pragma("busy_timeout=5000");
    const directory = resolve(WORKSPACE_ROOT, ".local/backups"); await mkdir(directory, { recursive: true });
    const backup = resolve(directory, `before-migration-${Date.now()}-${crypto.randomUUID()}.db`);
    await client.backup(backup); migrateDatabase(client);
    console.log(`迁移版本检查/执行完成；一致性备份：${backup}`);
  } finally { client.close(); }
} catch (error) { console.error(error instanceof ConfigurationError ? error.message : "迁移失败；原库与备份保留，请人工核查"); process.exitCode = 1; }

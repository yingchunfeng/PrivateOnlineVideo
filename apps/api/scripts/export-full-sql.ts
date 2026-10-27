import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { migrateDatabase, migrationManifest } from "../src/db/database.js";

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** 从迁移后的内存空库导出最终结构，发布 SQL 不包含个人数据或逐次 ALTER 脚本。 */
export function fullInstallSql(): string {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON"); migrateDatabase(database);
    const rows = database.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid")
      .all() as { type: string; name: string; sql: string }[];
    const providers = database.prepare("SELECT code,name,email_domain,smtp_host,enabled FROM smtp_provider_types ORDER BY code").all() as
      { code: string; name: string; email_domain: string; smtp_host: string; enabled: number }[];
    return [
      "-- 云影匣：新部署完整 SQLite 结构（v6）。UTF-8，无 BOM。",
      "-- 仅在新的空 .db 中整份执行；绝不能在现有正式库或旧测试库执行。",
      "-- 数据库工具必须遇错停止；若报错，在同一连接 ROLLBACK 后核查，不要继续执行或删除旧数据。",
      "-- 本文件由当前迁移结构生成，含真实版本校验记录；不要再叠加执行历史 SQL。",
      "-- 不包含账号、默认密码哈希、安装码、密钥或 OSS/SMTP 凭据。首次启动新部署入口时生成独立安装资料。",
      "PRAGMA foreign_keys = ON;", "BEGIN IMMEDIATE;",
      "CREATE TEMP TABLE __online_video_empty_database_guard (object_count INTEGER NOT NULL CHECK(object_count=0));",
      "INSERT INTO __online_video_empty_database_guard SELECT count(*) FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%';",
      ...rows.map(row => `\n-- ${row.type}: ${row.name}\n${row.sql};`),
      "\n-- 内置支持的邮箱类型；无发信账号和授权码。",
      ...providers.map(row => `INSERT INTO smtp_provider_types(code,name,email_domain,smtp_host,enabled) VALUES(${[row.code, row.name, row.email_domain, row.smtp_host].map(literal).join(",")},${row.enabled});`),
      "\n-- 对应 0001～0006 的结构来源校验；应用会核对版本、顺序和 SHA-256。",
      ...migrationManifest().map(row => `INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(${row.version},${literal(row.checksum)},strftime('%Y-%m-%dT%H:%M:%fZ','now'));`),
      "COMMIT;", "PRAGMA foreign_key_check;", "PRAGMA integrity_check;", ""
    ].join("\n");
  } finally { database.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2); const sql = fullInstallSql();
    if (!args.length) process.stdout.write(sql);
    else if (args.length === 2 && args[0] === "--output" && args[1]) {
      writeFileSync(resolve(args[1]), sql, { encoding: "utf8", flag: "wx" }); console.log("完整 SQL 已写入新文件（未连接任何磁盘数据库）。");
    } else throw new Error("参数不正确");
  } catch { console.error("SQL 导出失败；用法：db:export-full [--output <不存在的新.sql>]；不会覆盖已有文件。"); process.exitCode = 1; }
}

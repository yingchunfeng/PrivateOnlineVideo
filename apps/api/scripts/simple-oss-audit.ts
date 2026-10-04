import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// 只读记录旧数据摘要；不打印账号秘密、不执行迁移或清理。
const path = resolve(".local/data/video-library.db");
const database = new Database(path, { readonly: true, fileMustExist: true });
const digest = (row: unknown) => createHash("sha256").update(JSON.stringify(row)).digest("hex");
try {
  const protectedTables = ["categories", "library_groups", "tags", "videos", "upload_tasks", "upload_parts",
    "video_group_links", "video_tag_links", "upload_group_links", "upload_tag_links", "storage_objects",
    "video_assets", "upload_storage_objects", "storage_operations", "schema_migrations"];
  const snapshot: Record<string, { identity: string; digest: string }[]> = {};
  const categoryRows = new Map<string, Record<string, unknown>>();
  for (const table of protectedTables) {
    const rows = database.prepare(`SELECT rowid AS audit_rowid,* FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
    snapshot[table] = rows.map(row => ({ identity: String(row.audit_rowid), digest: digest(row) }));
    if (table === "categories") rows.forEach(row => categoryRows.set(String(row.audit_rowid), row));
  }
  snapshot.users = database.prepare("SELECT id,singleton,display_name,password_hash,totp_cipher,totp_enabled,created_at FROM users ORDER BY id").all()
    .map(row => ({ identity: String((row as { id: string }).id), digest: digest(row) }));
  if (database.pragma("integrity_check", { simple: true }) !== "ok" || (database.pragma("foreign_key_check") as unknown[]).length) throw new Error("DATABASE_INTEGRITY_FAILED");
  const baselineArg = process.argv.indexOf("--compare");
  if (baselineArg >= 0) {
    const acceptedNameUpdates: string[] = [];
    const baseline = JSON.parse(await readFile(resolve(process.argv[baselineArg + 1]!), "utf8")) as typeof snapshot;
    for (const [table, oldRows] of Object.entries(baseline)) {
      const current = new Map(snapshot[table]!.map(row => [row.identity, row.digest]));
      for (const row of oldRows) {
        if (current.get(row.identity) === row.digest) continue;
        const category = table === "categories" ? categoryRows.get(row.identity) : undefined;
        // 仅对应用户明确确认保留“未分类”的一行；重建原名称后完整摘要必须精确匹配。
        if (process.argv.includes("--accept-default-name") && category?.id === "02b8c985-63e2-4107-bd6e-e8ec7f317802" && category.name === "未分类" && category.name_key === "未分类" && digest({ ...category, name: "未分的", name_key: "未分的" }) === row.digest) {
          acceptedNameUpdates.push(String(category.id)); continue;
        }
        throw new Error(`OLD_DATA_CHANGED:${table}`);
      }
    }
    console.log(JSON.stringify({ oldRowsPreserved: acceptedNameUpdates.length === 0, otherOldRowsPreserved: true, acceptedNameUpdates, integrity: "ok", counts: Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.length])) }));
  } else {
    const directory = resolve(".local/acceptance"); await mkdir(directory, { recursive: true });
    const file = resolve(directory, `simple-oss-baseline-${Date.now()}-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify(snapshot, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({ baseline: file, integrity: "ok", counts: Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.length])) }));
  }
} finally { database.close(); }

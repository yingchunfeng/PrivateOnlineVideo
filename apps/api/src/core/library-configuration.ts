import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, copyFileSync, constants, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LibraryConfig, LibraryConfiguration, SaveLibraryConfigurationRequest } from "@online-video/shared";
import type { AppDatabase } from "../db/database.js";
import { HttpError } from "./errors.js";
import { assertLibraryAvailable, markLibraryUnavailable, validateLibraryConfig } from "./library-config.js";

const JOURNAL = "library.configuration.v1:";
const blockedPaths = new Set<string>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const nameKey = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("und");
interface Journal { path: string; state: "pending" | "committed" | "rolled_back"; oldRaw: string; newRaw: string }
function writeUnique(path: string, raw: string) {
  const fd = openSync(path, "wx");
  try { writeFileSync(fd, raw, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
}
function replaceFile(path: string, raw: string, suffix: string) {
  const temporary = `${path}.${suffix}.${randomUUID()}.tmp`;
  writeUnique(temporary, raw); renameSync(temporary, path);
}

/** 日志先独立提交。文件已切换而最终 SQL 未提交时恢复旧文件；未知外部修改拒绝猜测。 */
export function recoverLibraryConfiguration(database: AppDatabase, path: string): void {
  try {
    database.client.transaction(() => {
      const rows = database.client.prepare("SELECT id,action FROM audit_events WHERE action LIKE ? ORDER BY created_at,id").all(`${JOURNAL}%`) as { id: string; action: string }[];
      for (const row of rows) {
        const journal = JSON.parse(row.action.slice(JOURNAL.length)) as Journal;
        if (journal.path !== path || journal.state !== "pending") continue;
        const raw = readFileSync(path, "utf8");
        if (digest(raw) !== digest(journal.oldRaw) && digest(raw) !== digest(journal.newRaw)) throw new Error("configuration externally changed");
        if (raw !== journal.oldRaw) replaceFile(path, journal.oldRaw, "recovery");
        database.client.prepare("UPDATE audit_events SET action=? WHERE id=?").run(JOURNAL + JSON.stringify({ ...journal, state: "rolled_back" }), row.id);
      }
    }).immediate();
    blockedPaths.delete(path);
  } catch { blockedPaths.add(path); throw new HttpError("CONFIG_RECOVERY_REQUIRED"); }
}

export function createLibraryConfiguration(database: AppDatabase, config: LibraryConfig, path?: string, now: () => Date = () => new Date()) {
  const db = database.client;
  const ensureAvailable = () => { assertLibraryAvailable(config); if (path && blockedPaths.has(path)) throw new HttpError("CONFIG_RECOVERY_REQUIRED"); };
  const writable = () => { if (!path) return false; try { accessSync(path, constants.R_OK | constants.W_OK); accessSync(dirname(path), constants.W_OK); return true; } catch { return false; } };
  const readVersion = () => {
    if (!path) return digest(JSON.stringify(config));
    const raw = readFileSync(path, "utf8");
    if (JSON.stringify(validateLibraryConfig(JSON.parse(raw))) !== JSON.stringify(validateLibraryConfig(config))) throw new HttpError("CONFIG_VERSION_CONFLICT");
    return digest(raw);
  };
  const count = (sql: string, ...params: string[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  const view = (ownerId: string): LibraryConfiguration => {
    ensureAvailable();
    const sqlTags = db.prepare("SELECT id,name,archived_at FROM tags WHERE owner_id=? ORDER BY created_at,id").all(ownerId) as { id: string; name: string; archived_at: string | null }[];
    const definitions = new Map((config.tagDefinitions ?? []).map(tag => [tag.id, { id: tag.id, name: tag.name, enabled: tag.enabled !== false }]));
    for (const category of config.categories) for (const tagName of category.tags) {
      if ([...definitions.values()].some(tag => nameKey(tag.name) === nameKey(tagName))) continue;
      const existing = sqlTags.find(tag => nameKey(tag.name) === nameKey(tagName));
      const id = existing?.id ?? `tag-${digest(`${ownerId}:${nameKey(tagName)}`).slice(0, 32)}`;
      definitions.set(id, { id, name: tagName, enabled: existing?.archived_at == null });
    }
    for (const tag of sqlTags) if (!definitions.has(tag.id)) definitions.set(tag.id, { id: tag.id, name: tag.name, enabled: false });
    const categories = config.categories.map(category => {
      const sqlCategory = db.prepare("SELECT is_default FROM categories WHERE owner_id=? AND id=?").get(ownerId, category.id) as { is_default: number } | undefined;
      return { id: category.id, name: category.name, enabled: category.enabled !== false, tagIds: category.tagIds ?? category.tags.map(tagName => [...definitions.values()].find(tag => nameKey(tag.name) === nameKey(tagName))!.id), isDefault: !!sqlCategory?.is_default,
        videoCount: count("SELECT count(*) n FROM videos WHERE owner_id=? AND category_id=?", ownerId, category.id), uploadCount: count("SELECT count(*) n FROM upload_tasks WHERE owner_id=? AND category_id=?", ownerId, category.id) };
    });
    return { version: readVersion(), writable: writable(), categories, tags: [...definitions.values()].map(tag => ({ ...tag, categoryIds: categories.filter(category => category.tagIds.includes(tag.id)).map(category => category.id),
      videoCount: count("SELECT count(*) n FROM video_tag_links WHERE owner_id=? AND tag_id=? AND removed_at IS NULL", ownerId, tag.id), uploadCount: count("SELECT count(*) n FROM upload_tag_links WHERE owner_id=? AND tag_id=? AND removed_at IS NULL", ownerId, tag.id) })) };
  };
  const save = (ownerId: string, input: SaveLibraryConfigurationRequest): LibraryConfiguration => {
    ensureAvailable(); if (!path || !writable()) throw new HttpError("CONFIG_READ_ONLY");
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["version", "categories", "tags", "confirmImpact"].includes(key)) || typeof input.version !== "string" || !Array.isArray(input.categories) || !Array.isArray(input.tags) || input.categories.length > 500 || input.tags.length > 1000 || (input.confirmImpact !== undefined && typeof input.confirmImpact !== "boolean")) throw new HttpError("VALIDATION_ERROR");
    let journalId = ""; let journal: Journal | undefined; let next: LibraryConfig | undefined; let previousView: LibraryConfiguration | undefined;
    // 旧 JSON 与 SQL 可能已有名称/排序差异。只同步本次相对管理视图显式变更的列，
    // 不借新增其他项目的保存隐式覆盖历史 SQL 行；新项目正常完整登记。
    const sqlValues = (table: "categories" | "tags", item: { id: string; name: string; enabled?: boolean }, index: number, at: string) => {
      const prior = db.prepare(`SELECT * FROM ${table} WHERE owner_id=? AND id=?`).get(ownerId, item.id) as { name: string; name_key: string; archived_at: string | null; sort_order?: number } | undefined;
      const previous = (table === "categories" ? previousView!.categories : previousView!.tags).find(value => value.id === item.id);
      const renamed = !prior || !previous || previous.name !== item.name;
      const changedEnabled = !prior || !previous || previous.enabled !== (item.enabled !== false);
      return { prior, name: renamed ? item.name : prior.name, nameKey: renamed ? nameKey(item.name) : prior.name_key,
        archivedAt: changedEnabled ? item.enabled === false ? prior?.archived_at ?? at : null : prior.archived_at,
        sortOrder: !prior || previousView!.categories.findIndex(value => value.id === item.id) !== index ? index : prior.sort_order };
    };
    try {
      // SQLite immediate 锁串行化多实例；pending 日志构成跨事务的持久更新锁。
      db.transaction(() => {
        if ((db.prepare("SELECT action FROM audit_events WHERE action LIKE ?").all(`${JOURNAL}%`) as { action: string }[]).some(row => { const j = JSON.parse(row.action.slice(JOURNAL.length)) as Journal; return j.path === path && j.state === "pending"; })) throw new HttpError("CONFIG_RECOVERY_REQUIRED");
        const oldRaw = readFileSync(path, "utf8");
        if (digest(oldRaw) !== input.version) throw new HttpError("CONFIG_VERSION_CONFLICT");
        const current = view(ownerId); previousView = current;
        const normalizeName = (value: unknown) => { if (typeof value !== "string") throw new HttpError("VALIDATION_ERROR"); const result = value.normalize("NFKC").trim(); if (!result || result.length > 100) throw new HttpError("VALIDATION_ERROR"); return result; };
        const knownCategoryIds = new Set(current.categories.map(item => item.id)); const knownTagIds = new Set(current.tags.map(item => item.id));
        const tags = input.tags.map(item => {
          if (!item || typeof item !== "object" || Object.keys(item).some(key => !["id", "name", "enabled"].includes(key)) || typeof item.enabled !== "boolean" || (item.id !== undefined && !knownTagIds.has(item.id))) throw new HttpError("VALIDATION_ERROR");
          return { id: item.id ?? randomUUID(), name: normalizeName(item.name), enabled: item.enabled };
        });
        const categories = input.categories.map(item => {
          if (!item || typeof item !== "object" || Object.keys(item).some(key => !["id", "name", "enabled", "tagIds"].includes(key)) || typeof item.enabled !== "boolean" || !Array.isArray(item.tagIds) || item.tagIds.length > 1000 || new Set(item.tagIds).size !== item.tagIds.length || item.tagIds.some(id => !tags.some(tag => tag.id === id)) || (item.id !== undefined && !knownCategoryIds.has(item.id))) throw new HttpError("VALIDATION_ERROR");
          if (item.enabled === false && current.categories.find(category => category.id === item.id)?.isDefault) throw new HttpError("ORGANIZATION_CONFLICT");
          // 新增标签直接可用于全部启用分类；新分类默认可用全部有效标签。
          // 既有分类手动配置的范围继续保留，无需通过二次保存绑定新标签。
          const defaults = tags.filter(tag => tag.enabled && (item.id === undefined || item.enabled && !knownTagIds.has(tag.id))).map(tag => tag.id);
          const tagIds = [...new Set([...item.tagIds, ...defaults])];
          return { id: item.id ?? randomUUID(), name: normalizeName(item.name), enabled: item.enabled, tagIds, tags: tagIds.map(id => tags.find(tag => tag.id === id)!.name) };
        });
        if (new Set(tags.map(tag => tag.id)).size !== tags.length || new Set(categories.map(category => category.id)).size !== categories.length || current.tags.some(tag => !tags.some(item => item.id === tag.id)) || current.categories.some(category => !categories.some(item => item.id === category.id))) throw new HttpError("VALIDATION_ERROR");
        const impacts = current.categories.some(old => categories.find(item => item.id === old.id)!.enabled === false && old.enabled && (old.videoCount + old.uploadCount > 0)) || current.tags.some(old => {
          const updated = tags.find(item => item.id === old.id)!; const removedScope = old.categoryIds.some(id => !categories.find(item => item.id === id)?.tagIds.includes(old.id));
          return (updated.name !== old.name || (old.enabled && !updated.enabled) || removedScope) && (old.videoCount + old.uploadCount > 0 || old.categoryIds.length > 1);
        });
        if (impacts && input.confirmImpact !== true) throw new HttpError("CONFIG_IMPACT_CONFIRMATION_REQUIRED");
        if (current.categories.some(old => old.enabled && categories.find(item => item.id === old.id)!.enabled === false)) {
          const defaultCategory = db.prepare("SELECT id FROM categories WHERE owner_id=? AND is_default=1 AND archived_at IS NULL").get(ownerId) as { id: string } | undefined;
          if (!defaultCategory || !categories.some(category => category.id === defaultCategory.id && category.enabled)) throw new HttpError("ORGANIZATION_CONFLICT");
        }
        try { next = validateLibraryConfig({ mediaBaseUrl: config.mediaBaseUrl, objectPrefix: config.objectPrefix, categories, tagDefinitions: tags }); }
        catch { throw new HttpError("VALIDATION_ERROR"); }
        // 先验证 SQL 冲突与所有权，尚不写入业务表。
        for (const [table, items] of [["categories", categories], ["tags", tags]] as const) for (const [index, item] of items.entries()) {
          const owner = db.prepare(`SELECT owner_id FROM ${table} WHERE id=?`).get(item.id) as { owner_id: string } | undefined;
          if (owner && owner.owner_id !== ownerId) throw new HttpError("NOT_FOUND");
          const desired = sqlValues(table, item, index, now().toISOString());
          const duplicate = db.prepare(`SELECT id FROM ${table} WHERE owner_id=? AND name_key=? AND id<>?`).get(ownerId, desired.nameKey, item.id) as { id: string } | undefined;
          if (duplicate && !items.some((other, otherIndex) => other.id === duplicate.id && sqlValues(table, other, otherIndex, now().toISOString()).nameKey !== desired.nameKey)) throw new HttpError("ORGANIZATION_CONFLICT");
        }
        copyFileSync(path, `${path}.backup.${randomUUID()}.json`, constants.COPYFILE_EXCL);
        journal = { path, state: "pending", oldRaw, newRaw: JSON.stringify(next, null, 2) + "\n" }; journalId = randomUUID();
        db.prepare("INSERT INTO audit_events(id,owner_id,action,created_at) VALUES(?,?,?,?)").run(journalId, ownerId, JOURNAL + JSON.stringify(journal), now().toISOString());
      }).immediate();
      db.transaction(() => {
        if (readVersion() !== input.version) throw new HttpError("CONFIG_VERSION_CONFLICT");
        const at = now().toISOString();
        for (const [table, items] of [["categories", next!.categories], ["tags", next!.tagDefinitions!]] as const) {
          const changes = items.map((item, index) => {
            const desired = sqlValues(table, item, index, at); const { prior } = desired;
            const changed = !prior || prior.name !== desired.name || prior.name_key !== desired.nameKey || prior.archived_at !== desired.archivedAt || (table === "categories" && prior.sort_order !== desired.sortOrder);
            return { item, ...desired, changed };
          }).filter(change => change.changed);
          // 临时唯一键支持两项合法交换名称，外部读取看不到事务中间态。
          for (const { item } of changes) db.prepare(`UPDATE ${table} SET name_key=? WHERE owner_id=? AND id=?`).run(`configuration-${journalId}-${item.id}`, ownerId, item.id);
          changes.forEach(({ item, name, nameKey, sortOrder, archivedAt }) => {
            if (table === "categories") db.prepare("INSERT INTO categories(id,owner_id,name,name_key,sort_order,is_default,created_at,archived_at) VALUES(?,?,?,?,?,0,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,sort_order=excluded.sort_order,archived_at=excluded.archived_at").run(item.id, ownerId, name, nameKey, sortOrder, at, archivedAt);
            else db.prepare("INSERT INTO tags(id,owner_id,name,name_key,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,updated_at=excluded.updated_at,archived_at=excluded.archived_at").run(item.id, ownerId, name, nameKey, at, at, archivedAt);
          });
        }
        const disabledCategories = previousView!.categories.filter(old => old.enabled && next!.categories.find(category => category.id === old.id)!.enabled === false);
        if (disabledCategories.length) {
          const defaultCategory = db.prepare("SELECT id FROM categories WHERE owner_id=? AND is_default=1 AND archived_at IS NULL").get(ownerId) as { id: string } | undefined;
          if (!defaultCategory || !next!.categories.some(category => category.id === defaultCategory.id && category.enabled !== false)) throw new HttpError("ORGANIZATION_CONFLICT");
          // 分类删除经确认后仅调整视频业务归类；任务快照、标签、图片和 OSS 地址原样保留。
          for (const category of disabledCategories) db.prepare("UPDATE videos SET category_id=? WHERE owner_id=? AND category_id=?").run(defaultCategory.id, ownerId, category.id);
        }
        replaceFile(path, journal!.newRaw, "save");
        db.prepare("UPDATE audit_events SET action=? WHERE id=?").run(JOURNAL + JSON.stringify({ ...journal!, state: "committed" }), journalId);
      }).immediate();
      // 保持所有 Repository/媒体模块持有的同一对象引用。
      Object.assign(config, next!);
      return view(ownerId);
    } catch (error) {
      if (journalId) { try { recoverLibraryConfiguration(database, path); } catch { markLibraryUnavailable(config); throw new HttpError("CONFIG_RECOVERY_REQUIRED"); } }
      if (error instanceof HttpError) throw error;
      throw new HttpError("CONFIG_SAVE_FAILED");
    }
  };
  return { view, save, ensureAvailable };
}

import { createHash, randomUUID } from "node:crypto";
import type { Category, LibraryConfig, LibraryGroup, Tag, OrganizationSelection, VideoListQuery, UpdateVideoRequest, WatchProgress } from "@online-video/shared";
import { MAX_ORGANIZATION_LINKS } from "@online-video/shared";
import type { RegisteredStorageObjectRef, StorageObjectRef, StorageObjectRepository } from "../core/contracts/index.js";
import { HttpError } from "../core/errors.js";
import type { AppDatabase } from "./database.js";
import { assertLibraryAvailable, assertLibrarySelection } from "../core/library-config.js";

type Entity = "categories" | "library_groups" | "tags";
interface OrganizationRow { id: string; owner_id: string; name: string; name_key: string; sort_order?: number; description?: string; is_default?: number; created_at: string; updated_at?: string; archived_at: string | null }
interface ObjectRow { id: string; owner_id: string; provider: "oss" | "mock"; bucket: string; region: string; object_key: string; version_id: string | null; verification_status: RegisteredStorageObjectRef["verificationStatus"] }
export function organizationIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ORGANIZATION_LINKS || value.some(id => typeof id !== "string" || !id || id.includes(",")) || new Set(value).size !== value.length) throw new HttpError("VALIDATION_ERROR");
  return value as string[];
}
function name(value: unknown) {
  if (typeof value !== "string") throw new HttpError("VALIDATION_ERROR");
  const display = value.normalize("NFKC").trim(); const key = display.toLocaleLowerCase("und");
  if (!display || display.length > 100 || key.length > 200) throw new HttpError("VALIDATION_ERROR");
  return { display, key };
}
function integer(value: unknown) { if (!Number.isSafeInteger(value) || Math.abs(value as number) > 2147483647) throw new HttpError("VALIDATION_ERROR"); return value as number; }
function objectRef(row: ObjectRow): RegisteredStorageObjectRef { return { kind: "registered", id: row.id, provider: row.provider, bucket: row.bucket, region: row.region, key: row.object_key, versionId: row.version_id, verificationStatus: row.verification_status }; }

export function createLibraryPersistence(database: AppDatabase, now: () => Date, config?: LibraryConfig) {
  const db = database.client; const atomic = <T>(fn: () => T) => db.transaction(fn).immediate();
  const owned = (entity: Entity, ownerId: string, id: string) => {
    const row = db.prepare(`SELECT * FROM ${entity} WHERE owner_id=? AND id=?`).get(ownerId, id) as OrganizationRow | undefined;
    if (!row) throw new HttpError("NOT_FOUND"); return row;
  };
  const assertSelection = (ownerId: string, selection: OrganizationSelection, allowArchived = false) => {
    const category = owned("categories", ownerId, selection.categoryId); if (category.archived_at && !allowArchived) throw new HttpError("ORGANIZATION_CONFLICT");
    for (const [entity, ids] of [["library_groups", selection.groupIds ?? []], ["tags", selection.tagIds ?? []]] as const) {
      for (const id of organizationIds(ids)) if (owned(entity, ownerId, id).archived_at && !allowArchived) throw new HttpError("ORGANIZATION_CONFLICT");
    }
  };
  const getLinks = (scope: "video" | "upload", type: "group" | "tag", ownerId: string, id: string): string[] =>
    (db.prepare(`SELECT ${type}_id id FROM ${scope}_${type}_links WHERE owner_id=? AND ${scope}_id=? AND removed_at IS NULL ORDER BY ${type}_id`).all(ownerId, id) as { id: string }[]).map(row => row.id);
  const getTagNames = (scope: "video" | "upload", ownerId: string, id: string, categoryId?: string): string[] => {
    const configured = config?.categories.find(category => category.id === categoryId)?.tags ?? [];
    return (db.prepare(`SELECT t.name FROM ${scope}_tag_links l JOIN tags t ON t.owner_id=l.owner_id AND t.id=l.tag_id WHERE l.owner_id=? AND l.${scope}_id=? AND l.removed_at IS NULL ORDER BY t.name_key,t.id`).all(ownerId, id) as { name: string }[])
      .map(row => configured.find(tag => name(tag).key === name(row.name).key) ?? row.name);
  };
  const normalizeSelection = (ownerId: string, input: { categoryId: string; tags?: string[] }) => atomic(() => {
    if (!config) throw new HttpError("SERVICE_NOT_CONFIGURED");
    const selection = assertLibrarySelection(config, input); const category = config.categories.find(item => item.id === selection.categoryId)!;
    const at = now().toISOString(); const normalized = name(category.name);
    const existing = db.prepare("SELECT owner_id,archived_at FROM categories WHERE id=?").get(category.id) as { owner_id: string; archived_at: string | null } | undefined;
    if (existing && existing.owner_id !== ownerId) throw new HttpError("NOT_FOUND");
    if (existing?.archived_at) throw new HttpError("ORGANIZATION_CONFLICT");
    if (!existing) {
      if (db.prepare("SELECT id FROM categories WHERE owner_id=? AND name_key=?").get(ownerId, normalized.key)) throw new HttpError("ORGANIZATION_CONFLICT");
      db.prepare("INSERT INTO categories(id,owner_id,name,name_key,sort_order,is_default,created_at) VALUES(?,?,?,?,?,0,?)").run(category.id, ownerId, normalized.display, normalized.key, config.categories.indexOf(category), at);
    }
    const tagIds = selection.tags.map(tag => {
      const normalized = name(tag);
      const configuredId = category.tagIds?.[category.tags.indexOf(tag)] ?? config.tagDefinitions?.find(definition => name(definition.name).key === normalized.key)?.id;
      let existing = configuredId ? db.prepare("SELECT id,archived_at FROM tags WHERE owner_id=? AND id=?").get(ownerId, configuredId) as { id: string; archived_at: string | null } | undefined : db.prepare("SELECT id,archived_at FROM tags WHERE owner_id=? AND name_key=?").get(ownerId, normalized.key) as { id: string; archived_at: string | null } | undefined;
      if (existing?.archived_at) throw new HttpError("ORGANIZATION_CONFLICT");
      if (!existing) {
        const id = configuredId ?? `tag-${createHash("sha256").update(`${ownerId}:${normalized.key}`).digest("hex").slice(0, 32)}`; db.prepare("INSERT INTO tags(id,owner_id,name,name_key,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, ownerId, normalized.display, normalized.key, at, at); existing = { id, archived_at: null };
      }
      return existing.id;
    });
    return { ...selection, groupIds: [], tagIds };
  });
  const setLinks = (scope: "video" | "upload", type: "group" | "tag", ownerId: string, id: string, ids: string[]) => {
    organizationIds(ids); const at = now().toISOString();
    db.prepare(`UPDATE ${scope}_${type}_links SET removed_at=? WHERE owner_id=? AND ${scope}_id=? AND removed_at IS NULL`).run(at, ownerId, id);
    for (const item of ids) db.prepare(`INSERT INTO ${scope}_${type}_links(owner_id,${scope}_id,${type}_id,assigned_at,removed_at) VALUES(?,?,?,?,NULL)
      ON CONFLICT(owner_id,${scope}_id,${type}_id) DO UPDATE SET assigned_at=excluded.assigned_at,removed_at=NULL`).run(ownerId, id, item, at);
  };
  const readObject = (ownerId: string, id: string) => db.prepare("SELECT * FROM storage_objects WHERE owner_id=? AND id=?").get(ownerId, id) as ObjectRow | undefined;
  const assertObject = (ownerId: string, object: StorageObjectRef, verified = true) => {
    if (object.kind !== "registered") return;
    const row = readObject(ownerId, object.id);
    if (!row || row.provider !== object.provider || row.bucket !== object.bucket || row.region !== object.region || row.object_key !== object.key || row.version_id !== object.versionId) throw new HttpError("NOT_FOUND");
    if (verified && row.verification_status !== "verified") throw new HttpError("STORAGE_UNAVAILABLE");
  };
  const asset = (ownerId: string, videoId: string, role: string, fallback: string): StorageObjectRef => {
    const row = db.prepare("SELECT o.* FROM video_assets a JOIN storage_objects o ON o.id=a.storage_object_id AND o.owner_id=a.owner_id WHERE a.owner_id=? AND a.video_id=? AND a.asset_role=?").get(ownerId, videoId, role) as ObjectRow | undefined;
    return row ? objectRef(row) : { kind: "legacy", key: fallback };
  };
  const attachAssets = (ownerId: string, videoId: string, assets: { originalObject: StorageObjectRef; playbackObject: StorageObjectRef; thumbnailObject: StorageObjectRef | null }) => {
    for (const [role, object] of [["original", assets.originalObject], ["playback", assets.playbackObject], ["thumbnail", assets.thumbnailObject]] as const) {
      if (!object) continue; assertObject(ownerId, object);
      if (object.kind === "registered") db.prepare("INSERT INTO video_assets(owner_id,video_id,asset_role,storage_object_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,video_id,asset_role) DO UPDATE SET storage_object_id=excluded.storage_object_id").run(ownerId, videoId, role, object.id, now().toISOString());
    }
  };
  const uploadObject = (ownerId: string, uploadId: string, fallback: string): StorageObjectRef => {
    const row = db.prepare("SELECT o.* FROM upload_storage_objects a JOIN storage_objects o ON o.id=a.storage_object_id AND o.owner_id=a.owner_id WHERE a.owner_id=? AND a.upload_id=?").get(ownerId, uploadId) as ObjectRow | undefined;
    return row ? objectRef(row) : { kind: "legacy", key: fallback };
  };
  const mapEntity = (entity: Entity, row: OrganizationRow): Category | LibraryGroup | Tag => entity === "categories" ? { id: row.id, name: row.name, sortOrder: row.sort_order!, isDefault: !!row.is_default, archivedAt: row.archived_at }
    : entity === "library_groups" ? { id: row.id, name: row.name, description: row.description!, sortOrder: row.sort_order!, createdAt: row.created_at, updatedAt: row.updated_at!, archivedAt: row.archived_at }
    : { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at!, archivedAt: row.archived_at };
  const organizations = {
    assertOwned: async (ownerId: string, selection: OrganizationSelection) => assertSelection(ownerId, selection),
    normalizeSelection: async (ownerId: string, input: { categoryId: string; tags?: string[] }) => normalizeSelection(ownerId, input),
    list: (entity: Entity, ownerId: string, includeArchived = false) => (db.prepare(`SELECT * FROM ${entity} WHERE owner_id=? ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY ${entity === "tags" ? "name_key" : "sort_order"},created_at,id`).all(ownerId) as OrganizationRow[]).map(row => mapEntity(entity, row)),
    create: (entity: Entity, ownerId: string, input: { name: string; sortOrder?: number; description?: string }) => atomic(() => {
      const normalized = name(input.name); const at = now().toISOString(); const id = randomUUID();
      if (db.prepare(`SELECT id FROM ${entity} WHERE owner_id=? AND name_key=?`).get(ownerId, normalized.key)) throw new HttpError("ORGANIZATION_CONFLICT");
      if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 1000)) throw new HttpError("VALIDATION_ERROR");
      if (entity === "categories") db.prepare("INSERT INTO categories(id,owner_id,name,name_key,sort_order,is_default,created_at) VALUES(?,?,?,?,?,0,?)").run(id, ownerId, normalized.display, normalized.key, integer(input.sortOrder ?? 0), at);
      else if (entity === "library_groups") db.prepare("INSERT INTO library_groups(id,owner_id,name,name_key,description,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, ownerId, normalized.display, normalized.key, input.description ?? "", integer(input.sortOrder ?? 0), at, at);
      else db.prepare("INSERT INTO tags(id,owner_id,name,name_key,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, ownerId, normalized.display, normalized.key, at, at);
      return mapEntity(entity, owned(entity, ownerId, id));
    }),
    update: (entity: Entity, ownerId: string, id: string, input: { name?: string; sortOrder?: number; description?: string; archived?: boolean }) => atomic(() => {
      const row = owned(entity, ownerId, id); const normalized = name(input.name ?? row.name);
      if (db.prepare(`SELECT id FROM ${entity} WHERE owner_id=? AND name_key=? AND id<>?`).get(ownerId, normalized.key, id)) throw new HttpError("ORGANIZATION_CONFLICT");
      if (row.is_default && input.archived === true) throw new HttpError("ORGANIZATION_CONFLICT");
      if (input.archived !== undefined && typeof input.archived !== "boolean") throw new HttpError("VALIDATION_ERROR");
      if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 1000)) throw new HttpError("VALIDATION_ERROR");
      const fields: Record<string, unknown> = { name: normalized.display, name_key: normalized.key, archived_at: input.archived === undefined ? row.archived_at : input.archived ? row.archived_at ?? now().toISOString() : null };
      if (entity !== "tags") fields.sort_order = integer(input.sortOrder ?? row.sort_order);
      if (entity === "library_groups") fields.description = input.description ?? row.description;
      if (entity !== "categories") fields.updated_at = now().toISOString();
      db.prepare(`UPDATE ${entity} SET ${Object.keys(fields).map(field => `${field}=?`).join(",")} WHERE owner_id=? AND id=?`).run(...Object.values(fields), ownerId, id);
      return mapEntity(entity, owned(entity, ownerId, id));
    })
  };
  const objects: StorageObjectRepository = {
    prepareCover: async input => atomic(() => {
      if (!db.prepare("SELECT 1 FROM videos WHERE owner_id=? AND id=?").get(input.ownerId, input.videoId)) throw new HttpError("NOT_FOUND");
      if (!/^[a-f0-9]{64}$/.test(input.checksum) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 2 * 1024 * 1024 || input.contentType !== "image/jpeg") throw new HttpError("VALIDATION_ERROR");
      const eventId = `cover-${createHash("sha256").update(JSON.stringify([input.ownerId, input.videoId, input.checksum])).digest("hex")}`;
      const prior = db.prepare("SELECT action FROM audit_events WHERE owner_id=? AND id=?").get(input.ownerId, eventId) as { action: string } | undefined;
      if (prior) {
        const intent = JSON.parse(prior.action) as { objectId: string; operationId: string; sizeBytes: number; contentType: string };
        if (intent.sizeBytes !== input.sizeBytes || intent.contentType !== input.contentType) throw new HttpError("FILE_MISMATCH");
        const operation = db.prepare("SELECT state FROM storage_operations WHERE owner_id=? AND id=? AND video_id=?").get(input.ownerId, intent.operationId, input.videoId) as { state: string } | undefined;
        if (!operation) throw new HttpError("UPLOAD_STATE_CONFLICT");
        return { object: objectRef(readObject(input.ownerId, intent.objectId)!), operationId: intent.operationId, state: operation.state };
      }
      const object = input.object;
      if (!object.key || /[\\%?#\x00-\x1f]/.test(object.key) || object.key.startsWith("/") || object.key.split("/").some(part => !part || part === "." || part === "..") || object.versionId !== null || (object.provider === "oss" ? !object.bucket || !object.region : object.provider !== "mock" || object.bucket !== "" || object.region !== "")) throw new HttpError("VALIDATION_ERROR");
      const objectId = randomUUID(); const operationId = randomUUID(); const at = now().toISOString();
      db.prepare("INSERT INTO storage_objects(id,owner_id,provider,bucket,region,object_key,version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run(objectId, input.ownerId, object.provider, object.bucket, object.region, object.key, at, at);
      db.prepare("INSERT INTO storage_operations(id,owner_id,operation_type,storage_object_id,video_id,state,created_at,updated_at) VALUES(?,?,'upload',?,?,'prepared',?,?)").run(operationId, input.ownerId, objectId, input.videoId, at, at);
      db.prepare("INSERT INTO audit_events(id,owner_id,action,created_at) VALUES(?,?,?,?)").run(eventId, input.ownerId, JSON.stringify({ type: "cover.intent.v1", videoId: input.videoId, checksum: input.checksum, sizeBytes: input.sizeBytes, contentType: input.contentType, objectId, operationId }), at);
      return { object: objectRef(readObject(input.ownerId, objectId)!), operationId, state: "prepared" };
    }),
    prepare: async input => atomic(() => {
      const object = input.object; if (!object.key || /[\\%?#\x00-\x1f]/.test(object.key) || object.key.startsWith("/") || object.key.split("/").some(part => part === "." || part === "..")) throw new HttpError("VALIDATION_ERROR");
      if (object.provider === "oss" ? !object.bucket || !object.region : object.provider !== "mock" || object.bucket !== "" || object.region !== "" || object.versionId !== null) throw new HttpError("VALIDATION_ERROR");
      const existing = db.prepare("SELECT * FROM storage_objects WHERE provider=? AND bucket=? AND region=? AND object_key=? AND coalesce(version_id,'')=?").get(object.provider, object.bucket, object.region, object.key, object.versionId ?? "") as ObjectRow | undefined;
      if (existing && existing.owner_id !== input.ownerId) throw new HttpError("NOT_FOUND");
      const id = existing?.id ?? randomUUID(); const at = now().toISOString();
      if (!existing) db.prepare("INSERT INTO storage_objects(id,owner_id,provider,bucket,region,object_key,version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, input.ownerId, object.provider, object.bucket, object.region, object.key, object.versionId, at, at);
      const operationId = randomUUID(); db.prepare("INSERT INTO storage_operations(id,owner_id,operation_type,storage_object_id,state,created_at,updated_at) VALUES(?,?,?,?,'prepared',?,?)").run(operationId, input.ownerId, input.operation, id, at, at);
      return { object: objectRef(readObject(input.ownerId, id)!), operationId };
    }),
    verify: async input => atomic(() => {
      assertObject(input.ownerId, input.object, false); const meta = input.metadata; const version = meta.versionId ?? input.object.versionId;
      if (!Number.isSafeInteger(meta.sizeBytes) || meta.sizeBytes < 0 || !meta.etag || !meta.contentType) throw new HttpError("STORAGE_UNAVAILABLE");
      const row = readObject(input.ownerId, input.object.id)!;
      if (row.verification_status === "verified" && row.version_id !== version) throw new HttpError("FILE_MISMATCH");
      const prior = db.prepare("SELECT size_bytes,etag FROM storage_objects WHERE id=?").get(row.id) as { size_bytes: number | null; etag: string | null };
      if (row.verification_status === "verified" && (prior.size_bytes !== meta.sizeBytes || prior.etag !== meta.etag)) throw new HttpError("FILE_MISMATCH");
      db.prepare("UPDATE storage_objects SET version_id=?,size_bytes=?,etag=?,content_type=?,verification_status='verified',verified_at=coalesce(verified_at,?),updated_at=? WHERE owner_id=? AND id=?").run(version, meta.sizeBytes, meta.etag, meta.contentType, now().toISOString(), now().toISOString(), input.ownerId, row.id);
      return objectRef(readObject(input.ownerId, row.id)!);
    }),
    recordOperation: async input => atomic(() => {
      const row = db.prepare("SELECT * FROM storage_operations WHERE owner_id=? AND id=?").get(input.ownerId, input.operationId) as { storage_object_id: string; upload_id: string | null; video_id: string | null } | undefined;
      if (!row) throw new HttpError("NOT_FOUND");
      if (input.uploadId && !db.prepare("SELECT 1 FROM upload_storage_objects WHERE owner_id=? AND upload_id=? AND storage_object_id=?").get(input.ownerId, input.uploadId, row.storage_object_id)) throw new HttpError("UPLOAD_STATE_CONFLICT");
      if (input.videoId && !(row.video_id === input.videoId && row.upload_id === null && db.prepare("SELECT 1 FROM videos WHERE owner_id=? AND id=?").get(input.ownerId, input.videoId)) && !db.prepare("SELECT 1 FROM video_assets WHERE owner_id=? AND video_id=? AND storage_object_id=?").get(input.ownerId, input.videoId, row.storage_object_id)) throw new HttpError("NOT_FOUND");
      db.prepare("UPDATE storage_operations SET state=?,storage_upload_id=coalesce(?,storage_upload_id),upload_id=coalesce(?,upload_id),video_id=coalesce(?,video_id),error_code=?,updated_at=? WHERE owner_id=? AND id=?").run(input.state, input.storageUploadId ?? null, input.uploadId ?? null, input.videoId ?? null, input.errorCode ?? null, now().toISOString(), input.ownerId, input.operationId);
    })
  };
  return { assertSelection, getLinks, getTagNames, normalizeSelection, setLinks, assertObject, asset, attachAssets, uploadObject, organizations, objects, atomic };
}

export function createCatalogPersistence(database: AppDatabase, library: ReturnType<typeof createLibraryPersistence>, findVideo: (owner: string, id: string) => Promise<import("../core/contracts/index.js").VideoRecord | null>, now: () => Date, config?: LibraryConfig) {
  const db = database.client;
  return {
    list: async (ownerId: string, query: VideoListQuery) => {
      const page = query.page ?? 1; const pageSize = query.pageSize ?? 24;
      if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || (query.q !== undefined && (typeof query.q !== "string" || query.q.length > 256))) throw new HttpError("VALIDATION_ERROR");
      const where = ["v.owner_id=?"]; const params: (string | number)[] = [ownerId];
      if (query.categoryId) { where.push("v.category_id=?"); params.push(query.categoryId); }
      if (query.q) { where.push("(instr(lower(v.title),lower(?))>0 OR EXISTS(SELECT 1 FROM video_tag_links l JOIN tags t ON t.owner_id=l.owner_id AND t.id=l.tag_id WHERE l.owner_id=v.owner_id AND l.video_id=v.id AND l.removed_at IS NULL AND instr(lower(t.name),lower(?))>0))"); params.push(query.q.trim(), query.q.trim()); }
      if (query.tags !== undefined) {
        let selected: unknown; try { selected = JSON.parse(query.tags); } catch { throw new HttpError("VALIDATION_ERROR"); }
        if (!Array.isArray(selected) || selected.length > MAX_ORGANIZATION_LINKS || selected.some(tag => typeof tag !== "string" || !tag.trim() || tag.length > 100) || new Set(selected).size !== selected.length) throw new HttpError("VALIDATION_ERROR");
        for (const tag of selected) { where.push("EXISTS(SELECT 1 FROM video_tag_links l JOIN tags t ON t.owner_id=l.owner_id AND t.id=l.tag_id WHERE l.owner_id=v.owner_id AND l.video_id=v.id AND l.removed_at IS NULL AND t.name_key=?)"); params.push(name(tag).key); }
      }
      for (const [kind, raw] of [["group", query.groupIds], ["tag", query.tagIds]] as const) {
        if (raw === undefined || raw === "") continue;
        if (typeof raw !== "string") throw new HttpError("VALIDATION_ERROR");
        for (const id of organizationIds(raw.split(","))) { where.push(`EXISTS(SELECT 1 FROM video_${kind}_links l WHERE l.owner_id=v.owner_id AND l.video_id=v.id AND l.${kind}_id=? AND l.removed_at IS NULL)`); params.push(id); }
      }
      const condition = where.join(" AND "); const total = (db.prepare(`SELECT count(*) total FROM videos v WHERE ${condition}`).get(...params) as { total: number }).total;
      const ids = db.prepare(`SELECT v.id FROM videos v WHERE ${condition} ORDER BY v.created_at DESC,v.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as { id: string }[];
      const items = await Promise.all(ids.map(async row => (await findVideo(ownerId, row.id))!.video)); return { items, total, page, pageSize };
    },
    update: async (ownerId: string, videoId: string, patch: UpdateVideoRequest) => {
      library.atomic(() => {
        const row = db.prepare("SELECT category_id,title FROM videos WHERE owner_id=? AND id=?").get(ownerId, videoId) as { category_id: string; title: string } | undefined;
        if (!row) throw new HttpError("NOT_FOUND");
        if (patch.title !== undefined && (typeof patch.title !== "string" || !patch.title.trim() || patch.title.length > 256)) throw new HttpError("VALIDATION_ERROR");
        // 同分类可保留或取消历史标签；新增标签与切换分类的选择必须有效。
        let normalized: ReturnType<typeof library.normalizeSelection> | undefined;
        const historicalTags = library.getTagNames("video", ownerId, videoId, row.category_id);
        const unchangedPublicSelection = !!config && (patch.categoryId === undefined || patch.categoryId === row.category_id) && (patch.tags === undefined || (Array.isArray(patch.tags) && JSON.stringify([...patch.tags].sort()) === JSON.stringify([...historicalTags].sort())));
        if (config && !unchangedPublicSelection && (patch.categoryId !== undefined || patch.tags !== undefined)) {
          const categoryId = patch.categoryId ?? row.category_id; const selectedTags = patch.tags ?? historicalTags;
          if (categoryId !== row.category_id) normalized = library.normalizeSelection(ownerId, { categoryId, tags: selectedTags });
          else {
            assertLibraryAvailable(config);
            if (!Array.isArray(selectedTags) || selectedTags.length > MAX_ORGANIZATION_LINKS || selectedTags.some(tag => typeof tag !== "string" || !tag || tag.length > 100) || new Set(selectedTags).size !== selectedTags.length) throw new HttpError("VALIDATION_ERROR");
            const addedTags = selectedTags.filter(tag => !historicalTags.includes(tag));
            const added = addedTags.length ? library.normalizeSelection(ownerId, { categoryId, tags: addedTags }) : { categoryId, tags: [], groupIds: [], tagIds: [] };
            const existing = db.prepare("SELECT t.id,t.name FROM video_tag_links l JOIN tags t ON t.owner_id=l.owner_id AND t.id=l.tag_id WHERE l.owner_id=? AND l.video_id=? AND l.removed_at IS NULL").all(ownerId, videoId) as { id: string; name: string }[];
            const retainedKeys = new Set(selectedTags.filter(tag => historicalTags.includes(tag)).map(tag => name(tag).key));
            normalized = { ...added, tags: selectedTags, tagIds: [...existing.filter(tag => retainedKeys.has(name(tag.name).key)).map(tag => tag.id), ...added.tagIds] };
          }
        }
        if (!config && patch.tags !== undefined) throw new HttpError("VALIDATION_ERROR");
        if (!normalized && !unchangedPublicSelection && (patch.categoryId !== undefined || patch.groupIds !== undefined || patch.tagIds !== undefined)) {
          if (patch.categoryId !== undefined) library.assertSelection(ownerId, { categoryId: patch.categoryId });
          for (const [kind, values] of [["group", patch.groupIds], ["tag", patch.tagIds]] as const) if (values !== undefined) {
            const entity = kind === "group" ? "library_groups" : "tags";
            for (const id of organizationIds(values)) { const selected = db.prepare(`SELECT archived_at FROM ${entity} WHERE owner_id=? AND id=?`).get(ownerId, id) as { archived_at: string | null } | undefined;
              if (!selected) throw new HttpError("NOT_FOUND"); if (selected.archived_at) throw new HttpError("ORGANIZATION_CONFLICT"); }
          }
        }
        db.prepare("UPDATE videos SET title=?,category_id=? WHERE owner_id=? AND id=?").run(patch.title?.trim() ?? row.title, patch.categoryId ?? row.category_id, ownerId, videoId);
        if (patch.groupIds !== undefined) library.setLinks("video", "group", ownerId, videoId, patch.groupIds);
        if (normalized) library.setLinks("video", "tag", ownerId, videoId, normalized.tagIds);
        else if (patch.tagIds !== undefined) library.setLinks("video", "tag", ownerId, videoId, patch.tagIds);
      });
      return (await findVideo(ownerId, videoId))!.video;
    },
    progress: {
      read: async (ownerId: string, videoId: string): Promise<WatchProgress> => {
        if (!await findVideo(ownerId, videoId)) throw new HttpError("NOT_FOUND");
        const row = db.prepare("SELECT position_seconds,updated_at FROM watch_progress WHERE owner_id=? AND video_id=?").get(ownerId, videoId) as { position_seconds: number; updated_at: string } | undefined;
        return { videoId, positionSeconds: row?.position_seconds ?? 0, updatedAt: row?.updated_at ?? null };
      },
      save: async (ownerId: string, videoId: string, position: number): Promise<WatchProgress> => {
        library.atomic(() => {
          const row = db.prepare("SELECT duration_seconds FROM videos WHERE owner_id=? AND id=?").get(ownerId, videoId) as { duration_seconds: number | null } | undefined;
          if (!row) throw new HttpError("NOT_FOUND");
          if (typeof position !== "number" || !Number.isFinite(position) || position < 0 || position > Number.MAX_SAFE_INTEGER || (row.duration_seconds !== null && position > row.duration_seconds)) throw new HttpError("VALIDATION_ERROR");
          db.prepare("INSERT INTO watch_progress(owner_id,video_id,position_seconds,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner_id,video_id) DO UPDATE SET position_seconds=excluded.position_seconds,updated_at=excluded.updated_at").run(ownerId, videoId, position, now().toISOString());
        });
        return { videoId, positionSeconds: position, updatedAt: now().toISOString() };
      }
    }
  };
}

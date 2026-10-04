import { integer, real, sqliteTable, text, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), singleton: integer("singleton").notNull().default(1).unique(),
  displayName: text("display_name").notNull(), passwordHash: text("password_hash").notNull(),
  totpCipher: text("totp_cipher").notNull(), totpEnabled: integer("totp_enabled", { mode: "boolean" }).notNull().default(true),
  lastTotpCounter: integer("last_totp_counter").notNull().default(-1), createdAt: text("created_at").notNull()
});
export const loginSessions = sqliteTable("login_sessions", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(), createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(), expiresAt: text("expires_at").notNull(), revokedAt: text("revoked_at")
});
export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id),
  name: text("name").notNull(), sortOrder: integer("sort_order").notNull().default(0),
  nameKey: text("name_key").notNull().default(""), archivedAt: text("archived_at"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false), createdAt: text("created_at").notNull()
});
export const videos = sqliteTable("videos", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id),
  title: text("title").notNull(), categoryId: text("category_id").notNull().references(() => categories.id),
  durationSeconds: real("duration_seconds"), sizeBytes: integer("size_bytes").notNull(), status: text("status").notNull(),
  createdAt: text("created_at").notNull(), codec: text("codec"), width: integer("width"), height: integer("height"),
  playable: integer("playable", { mode: "boolean" }).notNull(), originalKey: text("original_key").notNull(),
  playbackKey: text("playback_key").notNull(), thumbnailKey: text("thumbnail_key")
});
export const uploadTasks = sqliteTable("upload_tasks", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id),
  videoId: text("video_id").references(() => videos.id), fileName: text("file_name").notNull(),
  title: text("title").notNull(), categoryId: text("category_id").notNull().references(() => categories.id),
  sizeBytes: integer("size_bytes").notNull(), partSizeBytes: integer("part_size_bytes").notNull(),
  status: text("status").notNull(), objectKey: text("object_key").notNull().unique(),
  storageUploadId: text("storage_upload_id").notNull(), createdAt: text("created_at").notNull()
});
export const uploadParts = sqliteTable("upload_parts", {
  uploadId: text("upload_id").notNull().references(() => uploadTasks.id), partNumber: integer("part_number").notNull(),
  sizeBytes: integer("size_bytes").notNull(), checksum: text("checksum").notNull(), etag: text("etag").notNull()
}, table => [uniqueIndex("upload_part_number").on(table.uploadId, table.partNumber)]);
export const watchProgress = sqliteTable("watch_progress", {
  ownerId: text("owner_id").notNull().references(() => users.id), videoId: text("video_id").notNull().references(() => videos.id),
  positionSeconds: real("position_seconds").notNull(), updatedAt: text("updated_at").notNull()
}, table => [uniqueIndex("watch_owner_video").on(table.ownerId, table.videoId)]);
export const playbackSessions = sqliteTable("playback_sessions", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id),
  loginSessionId: text("login_session_id").notNull().references(() => loginSessions.id),
  videoId: text("video_id").notNull().references(() => videos.id), createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(), lastSeenAt: text("last_seen_at").notNull(),
  closedAt: text("closed_at"), ttlMs: integer("ttl_ms").notNull(), mode: text("mode").notNull().default("proxy"), sourceExpiresAt: text("source_expires_at")
});
export const usageCounters = sqliteTable("usage_counters", {
  ownerId: text("owner_id").notNull().references(() => users.id), periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(), timezone: text("timezone").notNull(),
  transferredBytes: integer("transferred_bytes").notNull().default(0), reservedBytes: integer("reserved_bytes").notNull().default(0)
}, table => [uniqueIndex("usage_owner_period").on(table.ownerId, table.periodStart)]);
export const transferReservations = sqliteTable("transfer_reservations", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id),
  playbackSessionId: text("playback_session_id").notNull(), periodStart: text("period_start").notNull(),
  grantedBytes: integer("granted_bytes").notNull(), transferredBytes: integer("transferred_bytes"), createdAt: text("created_at").notNull()
});
export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(), ownerId: text("owner_id").references(() => users.id),
  action: text("action").notNull(), createdAt: text("created_at").notNull()
});
export const recoveryCodes = sqliteTable("recovery_codes", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id),
  codeHash: text("code_hash").notNull().unique(), usedAt: text("used_at")
});
export const loginAttempts = sqliteTable("login_attempts", {
  key: text("key").primaryKey(), windowStart: integer("window_start").notNull(), failures: integer("failures").notNull()
});

export const libraryGroups = sqliteTable("library_groups", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id), name: text("name").notNull(),
  nameKey: text("name_key").notNull(), description: text("description").notNull().default(""), sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(), archivedAt: text("archived_at")
});
export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id), name: text("name").notNull(),
  nameKey: text("name_key").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(), archivedAt: text("archived_at")
});
export const videoGroupLinks = sqliteTable("video_group_links", {
  ownerId: text("owner_id").notNull(), videoId: text("video_id").notNull(), groupId: text("group_id").notNull(), assignedAt: text("assigned_at").notNull(), removedAt: text("removed_at")
}, t => [primaryKey({ columns: [t.ownerId, t.videoId, t.groupId] })]);
export const videoTagLinks = sqliteTable("video_tag_links", {
  ownerId: text("owner_id").notNull(), videoId: text("video_id").notNull(), tagId: text("tag_id").notNull(), assignedAt: text("assigned_at").notNull(), removedAt: text("removed_at")
}, t => [primaryKey({ columns: [t.ownerId, t.videoId, t.tagId] })]);
export const uploadGroupLinks = sqliteTable("upload_group_links", {
  ownerId: text("owner_id").notNull(), uploadId: text("upload_id").notNull(), groupId: text("group_id").notNull(), assignedAt: text("assigned_at").notNull(), removedAt: text("removed_at")
}, t => [primaryKey({ columns: [t.ownerId, t.uploadId, t.groupId] })]);
export const uploadTagLinks = sqliteTable("upload_tag_links", {
  ownerId: text("owner_id").notNull(), uploadId: text("upload_id").notNull(), tagId: text("tag_id").notNull(), assignedAt: text("assigned_at").notNull(), removedAt: text("removed_at")
}, t => [primaryKey({ columns: [t.ownerId, t.uploadId, t.tagId] })]);
export const storageObjects = sqliteTable("storage_objects", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id), provider: text("provider").notNull(),
  bucket: text("bucket").notNull().default(""), region: text("region").notNull().default(""), objectKey: text("object_key").notNull(), versionId: text("version_id"),
  sizeBytes: integer("size_bytes"), etag: text("etag"), contentType: text("content_type"), verificationStatus: text("verification_status").notNull().default("pending"),
  verifiedAt: text("verified_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
});
export const videoAssets = sqliteTable("video_assets", {
  ownerId: text("owner_id").notNull(), videoId: text("video_id").notNull(), assetRole: text("asset_role").notNull(), storageObjectId: text("storage_object_id").notNull(), createdAt: text("created_at").notNull()
}, t => [primaryKey({ columns: [t.ownerId, t.videoId, t.assetRole] })]);
export const uploadStorageObjects = sqliteTable("upload_storage_objects", {
  ownerId: text("owner_id").notNull(), uploadId: text("upload_id").notNull(), storageObjectId: text("storage_object_id").notNull(), createdAt: text("created_at").notNull()
}, t => [primaryKey({ columns: [t.ownerId, t.uploadId] })]);
export const storageOperations = sqliteTable("storage_operations", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id), operationType: text("operation_type").notNull(),
  storageObjectId: text("storage_object_id").notNull(), uploadId: text("upload_id"), videoId: text("video_id"), state: text("state").notNull(),
  storageUploadId: text("storage_upload_id"), errorCode: text("error_code"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull()
});
export const sourceAuthorizations = sqliteTable("source_authorizations", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id), loginSessionId: text("login_session_id").notNull().references(() => loginSessions.id),
  videoId: text("video_id").notNull(), playbackSessionId: text("playback_session_id").references(() => playbackSessions.id), purpose: text("purpose").notNull(), sourceExpiresAt: text("source_expires_at").notNull(), createdAt: text("created_at").notNull()
});

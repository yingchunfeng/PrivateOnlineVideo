import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false), createdAt: text("created_at").notNull()
});
export const videos = sqliteTable("videos", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id),
  title: text("title").notNull(), categoryId: text("category_id").notNull().references(() => categories.id),
  durationSeconds: real("duration_seconds"), sizeBytes: integer("size_bytes").notNull(), status: text("status").notNull(),
  createdAt: text("created_at").notNull(), codec: text("codec"), width: integer("width"), height: integer("height"),
  playable: integer("playable", { mode: "boolean" }).notNull(), originalKey: text("original_key").notNull(),
  playbackKey: text("playback_key").notNull(), thumbnailKey: text("thumbnail_key")
}, table => [uniqueIndex("videos_owner_object").on(table.ownerId, table.originalKey)]);
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
  closedAt: text("closed_at"), ttlMs: integer("ttl_ms").notNull()
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

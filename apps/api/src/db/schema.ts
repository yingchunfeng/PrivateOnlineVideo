import { integer, real, sqliteTable, text, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), singleton: integer("singleton").notNull().default(1).unique(),
  displayName: text("display_name").notNull(), passwordHash: text("password_hash").notNull(),
  totpCipher: text("totp_cipher").notNull(), totpEnabled: integer("totp_enabled", { mode: "boolean" }).notNull().default(true),
  lastTotpCounter: integer("last_totp_counter").notNull().default(-1), createdAt: text("created_at").notNull(),
  email: text("email"), emailVerifiedAt: text("email_verified_at"),
  authMethod: text("auth_method", { enum: ["totp", "email"] }).notNull().default("totp"), authVersion: integer("auth_version").notNull().default(1)
});
export const loginSessions = sqliteTable("login_sessions", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(), createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(), expiresAt: text("expires_at").notNull(), revokedAt: text("revoked_at"), authVersion: integer("auth_version").notNull().default(1)
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
export const guests = sqliteTable("guests", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id),
  name: text("name").notNull(), passwordHash: text("password_hash").notNull(), permissions: text("permissions").notNull(),
  expiresAt: text("expires_at").notNull(), revokedAt: text("revoked_at"), createdAt: text("created_at").notNull(),
  version: integer("version").notNull().default(1)
});
export const guestSessions = sqliteTable("guest_sessions", {
  loginSessionId: text("login_session_id").primaryKey().references(() => loginSessions.id),
  guestId: text("guest_id").notNull().references(() => guests.id)
});
export const guestUploads = sqliteTable("guest_uploads", {
  uploadId: text("upload_id").primaryKey().references(() => uploadTasks.id),
  guestId: text("guest_id").notNull().references(() => guests.id)
});
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

/** v6 显式登录方式；没有扩展行的旧账号仍读取 users.auth_method。 */
export const accountLoginModes = sqliteTable("account_login_modes", {
  ownerId: text("owner_id").primaryKey().references(() => users.id),
  method: text("method", { enum: ["password", "totp", "email"] }).notNull(), updatedAt: text("updated_at").notNull()
});
export const installationState = sqliteTable("installation_state", {
  id: integer("id").primaryKey(), stage: text("stage", { enum: ["password", "configuration", "ready"] }).notNull(),
  installationCodeHash: text("installation_code_hash").notNull(), keyFingerprint: text("key_fingerprint").notNull(),
  ownerId: text("owner_id").references(() => users.id), version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(), completedAt: text("completed_at")
});
export const installationSessions = sqliteTable("installation_sessions", {
  id: text("id").primaryKey(), tokenHash: text("token_hash").notNull().unique(), installationVersion: integer("installation_version").notNull(),
  createdAt: text("created_at").notNull(), expiresAt: text("expires_at").notNull(), revokedAt: text("revoked_at")
});
export const installationSettings = sqliteTable("installation_settings", {
  id: integer("id").primaryKey(), payloadCipher: text("payload_cipher").notNull(), version: integer("version").notNull().default(1), updatedAt: text("updated_at").notNull()
});

export const siteSettings = sqliteTable("site_settings", {
  id: integer("id").primaryKey(), defaultTheme: text("default_theme", { enum: ["light", "dark"] }).notNull(),
  maxUploadBytes: integer("max_upload_bytes").notNull(), version: integer("version").notNull(), updatedAt: text("updated_at").notNull()
});
export const homepageSettings = sqliteTable("homepage_settings", {
  ownerId: text("owner_id").primaryKey().notNull().references(() => users.id),
  categoryRandomEnabled: integer("category_random_enabled", { mode: "boolean" }).notNull(),
  videoOrder: text("video_order").notNull(), version: integer("version").notNull(), updatedAt: text("updated_at").notNull()
});
export const emailVerificationChallenges = sqliteTable("email_verification_challenges", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id), loginSessionId: text("login_session_id").notNull().references(() => loginSessions.id),
  authVersion: integer("auth_version").notNull(), enabled: integer("enabled", { mode: "boolean" }).notNull(), targetEmail: text("target_email").notNull(),
  codeDigest: text("code_digest").notNull(), ipHash: text("ip_hash").notNull(), createdAt: text("created_at").notNull(), expiresAt: text("expires_at").notNull(), resendAt: text("resend_at").notNull(),
  errorCount: integer("error_count").notNull().default(0), sendState: text("send_state", { enum: ["pending", "sent", "failed"] }).notNull().default("pending"), usedAt: text("used_at"), invalidatedAt: text("invalidated_at")
});

export const smtpConfig = sqliteTable("smtp_config", {
  id: integer("id").primaryKey(), host: text("host").notNull(), port: integer("port").notNull(),
  secure: integer("secure", { mode: "boolean" }).notNull(), user: text("user").notNull(),
  passwordCipher: text("password_cipher").notNull(), from: text("from").notNull(),
  timeoutMs: integer("timeout_ms").notNull().default(15000), updatedAt: text("updated_at").notNull()
});

export const smtpProviderTypes = sqliteTable("smtp_provider_types", {
  code: text("code", { enum: ["qq", "163"] }).primaryKey(), name: text("name").notNull(),
  emailDomain: text("email_domain").notNull().unique(), smtpHost: text("smtp_host").notNull().unique(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true)
});
export const smtpProviderConfigs = sqliteTable("smtp_provider_configs", {
  providerCode: text("provider_code", { enum: ["qq", "163"] }).primaryKey().references(() => smtpProviderTypes.code),
  host: text("host").notNull(), port: integer("port").notNull(), secure: integer("secure", { mode: "boolean" }).notNull(),
  user: text("user").notNull(), passwordCipher: text("password_cipher").notNull(), from: text("from").notNull(),
  timeoutMs: integer("timeout_ms").notNull().default(15000), updatedAt: text("updated_at").notNull()
});

export const accountOperations = sqliteTable("account_operations", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id),
  loginSessionId: text("login_session_id").notNull().references(() => loginSessions.id), authVersion: integer("auth_version").notNull(),
  operationType: text("operation_type", { enum: ["bind_email", "change_password", "change_email"] }).notNull(), targetEmail: text("target_email").notNull(),
  state: text("state", { enum: ["pending", "old_verified", "completed", "cancelled", "invalidated"] }).notNull().default("pending"),
  createdAt: text("created_at").notNull(), expiresAt: text("expires_at").notNull(), oldVerifiedAt: text("old_verified_at"), invalidatedAt: text("invalidated_at")
});
export const emailChallenges = sqliteTable("email_challenges", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id),
  purpose: text("purpose", { enum: ["login", "bind_email", "change_password", "change_email_old", "change_email_new"] }).notNull(),
  targetEmail: text("target_email").notNull(), authVersion: integer("auth_version").notNull(),
  operationId: text("operation_id").references(() => accountOperations.id), loginSessionId: text("login_session_id").references(() => loginSessions.id),
  codeDigest: text("code_digest").notNull(), sendSequence: integer("send_sequence").notNull(),
  createdAt: text("created_at").notNull(), expiresAt: text("expires_at").notNull(), resendAt: text("resend_at").notNull(),
  errorCount: integer("error_count").notNull().default(0), sendState: text("send_state", { enum: ["pending", "sent", "failed"] }).notNull().default("pending"),
  usedAt: text("used_at"), invalidatedAt: text("invalidated_at")
});
/** 每次发送预留一行，用滑动一小时窗口统计；失败投递同样占用额度。 */
export const emailSendLimits = sqliteTable("email_send_limits", {
  challengeId: text("challenge_id").primaryKey().references(() => emailChallenges.id), ownerId: text("owner_id").notNull().references(() => users.id),
  ipHash: text("ip_hash").notNull(), reservedAt: integer("reserved_at").notNull()
});
export const securityNotifications = sqliteTable("security_notifications", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id), targetEmail: text("target_email").notNull(),
  purpose: text("purpose", { enum: ["password_changed", "email_changed"] }).notNull(),
  state: text("state", { enum: ["pending", "sent", "failed"] }).notNull().default("pending"), createdAt: text("created_at").notNull(), completedAt: text("completed_at")
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

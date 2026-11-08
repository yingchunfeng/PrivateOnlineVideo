-- 云影匣：新部署完整 SQLite 结构（v9）。UTF-8，无 BOM。
-- 仅在新的空 .db 中整份执行；绝不能在现有正式库或旧测试库执行。
-- 数据库工具必须遇错停止；若报错，在同一连接 ROLLBACK 后核查，不要继续执行或删除旧数据。
-- 本文件由当前迁移结构生成，含真实版本校验记录；不要再叠加执行历史 SQL。
-- 不包含账号、默认密码哈希、安装码、密钥或 OSS/SMTP 凭据。首次启动新部署入口时生成独立安装资料。
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
CREATE TEMP TABLE __online_video_empty_database_guard (object_count INTEGER NOT NULL CHECK(object_count=0));
INSERT INTO __online_video_empty_database_guard SELECT count(*) FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%';

-- table: schema_migrations
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);

-- table: users
CREATE TABLE users (id TEXT PRIMARY KEY, singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton=1), display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, totp_cipher TEXT NOT NULL, totp_enabled INTEGER NOT NULL DEFAULT 1 CHECK(totp_enabled IN (0,1)),
  last_totp_counter INTEGER NOT NULL DEFAULT -1, created_at TEXT NOT NULL, email TEXT, email_verified_at TEXT, auth_method TEXT NOT NULL DEFAULT 'totp' CHECK(auth_method IN ('totp','email')), auth_version INTEGER NOT NULL DEFAULT 1 CHECK(auth_version>0));

-- table: login_sessions
CREATE TABLE login_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, auth_version INTEGER NOT NULL DEFAULT 1 CHECK(auth_version>0));

-- table: categories
CREATE TABLE categories (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)), created_at TEXT NOT NULL, archived_at TEXT, name_key TEXT NOT NULL DEFAULT '');

-- table: videos
CREATE TABLE videos (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id),
  duration_seconds REAL CHECK(duration_seconds IS NULL OR duration_seconds>=0), size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('processing','ready','unsupported','failed')), created_at TEXT NOT NULL, codec TEXT,
  width INTEGER CHECK(width IS NULL OR width>0), height INTEGER CHECK(height IS NULL OR height>0), playable INTEGER NOT NULL CHECK(playable IN (0,1)),
  original_key TEXT NOT NULL, playback_key TEXT NOT NULL, thumbnail_key TEXT);

-- table: upload_tasks
CREATE TABLE upload_tasks (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), video_id TEXT REFERENCES videos(id), file_name TEXT NOT NULL,
  title TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id), size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 9007199254740991),
  part_size_bytes INTEGER NOT NULL CHECK(part_size_bytes BETWEEN 1 AND 16777216), status TEXT NOT NULL CHECK(status IN ('uploading','finalizing','completed','failed')),
  object_key TEXT NOT NULL UNIQUE, storage_upload_id TEXT NOT NULL, created_at TEXT NOT NULL);

-- table: upload_parts
CREATE TABLE upload_parts (upload_id TEXT NOT NULL REFERENCES upload_tasks(id), part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 16777216), checksum TEXT NOT NULL CHECK(length(checksum)=64 AND checksum NOT GLOB '*[^0-9a-f]*'), etag TEXT NOT NULL);

-- table: watch_progress
CREATE TABLE watch_progress (owner_id TEXT NOT NULL REFERENCES users(id), video_id TEXT NOT NULL REFERENCES videos(id), position_seconds REAL NOT NULL CHECK(position_seconds>=0), updated_at TEXT NOT NULL);

-- table: playback_sessions
CREATE TABLE playback_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), login_session_id TEXT NOT NULL REFERENCES login_sessions(id),
  video_id TEXT NOT NULL REFERENCES videos(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, closed_at TEXT, ttl_ms INTEGER NOT NULL CHECK(ttl_ms>0), mode TEXT NOT NULL DEFAULT 'proxy' CHECK(mode IN ('proxy', 'oss')), source_expires_at TEXT);

-- table: usage_counters
CREATE TABLE usage_counters (owner_id TEXT NOT NULL REFERENCES users(id), period_start TEXT NOT NULL, period_end TEXT NOT NULL, timezone TEXT NOT NULL,
  transferred_bytes INTEGER NOT NULL DEFAULT 0 CHECK(transferred_bytes BETWEEN 0 AND 9007199254740991),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes BETWEEN 0 AND 9007199254740991));

-- table: transfer_reservations
CREATE TABLE transfer_reservations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), playback_session_id TEXT NOT NULL, period_start TEXT NOT NULL,
  granted_bytes INTEGER NOT NULL CHECK(granted_bytes BETWEEN 1 AND 9007199254740991), transferred_bytes INTEGER CHECK(transferred_bytes BETWEEN 0 AND granted_bytes), created_at TEXT NOT NULL);

-- table: audit_events
CREATE TABLE audit_events (id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id), action TEXT NOT NULL, created_at TEXT NOT NULL);

-- table: recovery_codes
CREATE TABLE recovery_codes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), code_hash TEXT NOT NULL UNIQUE, used_at TEXT);

-- table: login_attempts
CREATE TABLE login_attempts (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, failures INTEGER NOT NULL CHECK(failures>=0));

-- table: library_groups
CREATE TABLE library_groups (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  name_key TEXT NOT NULL CHECK(length(name_key) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 1000),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE(owner_id, id),
  UNIQUE(owner_id, name_key)
);

-- table: tags
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  name_key TEXT NOT NULL CHECK(length(name_key) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE(owner_id, id),
  UNIQUE(owner_id, name_key)
);

-- table: video_group_links
CREATE TABLE video_group_links (
  owner_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY(owner_id, video_id, group_id),
  FOREIGN KEY(owner_id, video_id) REFERENCES videos(owner_id, id),
  FOREIGN KEY(owner_id, group_id) REFERENCES library_groups(owner_id, id)
);

-- table: video_tag_links
CREATE TABLE video_tag_links (
  owner_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY(owner_id, video_id, tag_id),
  FOREIGN KEY(owner_id, video_id) REFERENCES videos(owner_id, id),
  FOREIGN KEY(owner_id, tag_id) REFERENCES tags(owner_id, id)
);

-- table: upload_group_links
CREATE TABLE upload_group_links (
  owner_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY(owner_id, upload_id, group_id),
  FOREIGN KEY(owner_id, upload_id) REFERENCES upload_tasks(owner_id, id),
  FOREIGN KEY(owner_id, group_id) REFERENCES library_groups(owner_id, id)
);

-- table: upload_tag_links
CREATE TABLE upload_tag_links (
  owner_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY(owner_id, upload_id, tag_id),
  FOREIGN KEY(owner_id, upload_id) REFERENCES upload_tasks(owner_id, id),
  FOREIGN KEY(owner_id, tag_id) REFERENCES tags(owner_id, id)
);

-- table: storage_objects
CREATE TABLE storage_objects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK(provider IN ('oss', 'mock')),
  bucket TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  object_key TEXT NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
  version_id TEXT CHECK(version_id IS NULL OR length(version_id) BETWEEN 1 AND 1024),
  size_bytes INTEGER CHECK(size_bytes BETWEEN 0 AND 9007199254740991),
  etag TEXT,
  content_type TEXT,
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending', 'verified', 'unavailable')),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, id),
  CHECK((provider = 'oss' AND length(trim(bucket)) > 0 AND length(trim(region)) > 0)
    OR (provider = 'mock' AND bucket = '' AND region = '' AND version_id IS NULL)),
  CHECK(verification_status <> 'verified'
    OR (size_bytes IS NOT NULL AND etag IS NOT NULL AND length(etag) > 0
      AND content_type IS NOT NULL AND length(content_type) > 0 AND verified_at IS NOT NULL))
);

-- table: video_assets
CREATE TABLE video_assets (
  owner_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  asset_role TEXT NOT NULL CHECK(asset_role IN ('original', 'playback', 'thumbnail')),
  storage_object_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, video_id, asset_role),
  FOREIGN KEY(owner_id, video_id) REFERENCES videos(owner_id, id),
  FOREIGN KEY(owner_id, storage_object_id) REFERENCES storage_objects(owner_id, id)
);

-- table: upload_storage_objects
CREATE TABLE upload_storage_objects (
  owner_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  storage_object_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, upload_id),
  FOREIGN KEY(owner_id, upload_id) REFERENCES upload_tasks(owner_id, id),
  FOREIGN KEY(owner_id, storage_object_id) REFERENCES storage_objects(owner_id, id)
);

-- table: storage_operations
CREATE TABLE storage_operations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  operation_type TEXT NOT NULL CHECK(operation_type IN ('upload', 'import')),
  storage_object_id TEXT NOT NULL,
  upload_id TEXT,
  video_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('prepared', 'multipart_started', 'object_completed', 'registered', 'failed')),
  storage_upload_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(owner_id, storage_object_id) REFERENCES storage_objects(owner_id, id),
  FOREIGN KEY(owner_id, upload_id) REFERENCES upload_tasks(owner_id, id),
  FOREIGN KEY(owner_id, video_id) REFERENCES videos(owner_id, id)
);

-- table: source_authorizations
CREATE TABLE source_authorizations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  login_session_id TEXT NOT NULL REFERENCES login_sessions(id),
  video_id TEXT NOT NULL,
  playback_session_id TEXT REFERENCES playback_sessions(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('playback','renewal','download')),
  source_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(owner_id, video_id) REFERENCES videos(owner_id,id)
);

-- table: account_operations
CREATE TABLE account_operations (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),login_session_id TEXT NOT NULL REFERENCES login_sessions(id),
  auth_version INTEGER NOT NULL,operation_type TEXT NOT NULL CHECK(operation_type IN ('bind_email','change_password','change_email')),target_email TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','old_verified','completed','cancelled','invalidated')),
  created_at TEXT NOT NULL,expires_at TEXT NOT NULL,old_verified_at TEXT,invalidated_at TEXT);

-- table: email_challenges
CREATE TABLE email_challenges (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('login','bind_email','change_password','change_email_old','change_email_new')),target_email TEXT NOT NULL,
  auth_version INTEGER NOT NULL,operation_id TEXT REFERENCES account_operations(id),login_session_id TEXT REFERENCES login_sessions(id),code_digest TEXT NOT NULL,
  send_sequence INTEGER NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,resend_at TEXT NOT NULL,
  error_count INTEGER NOT NULL DEFAULT 0 CHECK(error_count>=0),send_state TEXT NOT NULL DEFAULT 'pending' CHECK(send_state IN ('pending','sent','failed')),
  used_at TEXT,invalidated_at TEXT);

-- table: email_send_limits
CREATE TABLE email_send_limits(challenge_id TEXT PRIMARY KEY REFERENCES email_challenges(id),owner_id TEXT NOT NULL REFERENCES users(id),ip_hash TEXT NOT NULL,reserved_at INTEGER NOT NULL);

-- table: security_notifications
CREATE TABLE security_notifications(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),target_email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('password_changed','email_changed')),state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed')),
  created_at TEXT NOT NULL,completed_at TEXT);

-- table: smtp_config
CREATE TABLE smtp_config (
  id INTEGER PRIMARY KEY CHECK(id=1),
  host TEXT NOT NULL CHECK(length(host)>0),
  port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
  secure INTEGER NOT NULL CHECK(secure IN (0,1)),
  user TEXT NOT NULL CHECK(length(user)>0),
  password_cipher TEXT NOT NULL CHECK(length(password_cipher)>0),
  "from" TEXT NOT NULL CHECK(length("from")>0),
  timeout_ms INTEGER NOT NULL DEFAULT 15000 CHECK(timeout_ms BETWEEN 1 AND 60000),
  updated_at TEXT NOT NULL
);

-- table: smtp_provider_types
CREATE TABLE smtp_provider_types (
  code TEXT NOT NULL PRIMARY KEY CHECK(code IN ('qq','163')),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  email_domain TEXT NOT NULL UNIQUE,
  smtp_host TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  CHECK((code='qq' AND email_domain='qq.com' AND smtp_host='smtp.qq.com') OR
        (code='163' AND email_domain='163.com' AND smtp_host='smtp.163.com'))
);

-- table: smtp_provider_configs
CREATE TABLE smtp_provider_configs (
  provider_code TEXT NOT NULL PRIMARY KEY REFERENCES smtp_provider_types(code),
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  secure INTEGER NOT NULL CHECK(secure IN (0,1)),
  user TEXT NOT NULL CHECK(length(user)>0),
  password_cipher TEXT NOT NULL CHECK(length(password_cipher)>0),
  "from" TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 15000 CHECK(timeout_ms BETWEEN 1 AND 60000),
  updated_at TEXT NOT NULL,
  CHECK((port=465 AND secure=1) OR (port=587 AND secure=0)),
  CHECK(instr(user,'@')>1),
  CHECK((provider_code='qq' AND host='smtp.qq.com' AND lower(substr(user,instr(user,'@')+1))='qq.com') OR
        (provider_code='163' AND host='smtp.163.com' AND lower(substr(user,instr(user,'@')+1))='163.com')),
  CHECK(lower("from")=lower(user))
);

-- table: account_login_modes
CREATE TABLE account_login_modes (
  owner_id TEXT PRIMARY KEY REFERENCES users(id),
  method TEXT NOT NULL CHECK(method IN ('password','totp','email')),
  updated_at TEXT NOT NULL
);

-- table: installation_state
CREATE TABLE installation_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  stage TEXT NOT NULL CHECK(stage IN ('password','configuration','ready')),
  installation_code_hash TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK((stage='password' AND owner_id IS NULL) OR (stage IN ('configuration','ready') AND owner_id IS NOT NULL))
);

-- table: installation_sessions
CREATE TABLE installation_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  installation_version INTEGER NOT NULL CHECK(installation_version>0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

-- table: installation_settings
CREATE TABLE installation_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  payload_cipher TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at TEXT NOT NULL
);

-- table: email_verification_challenges
CREATE TABLE email_verification_challenges (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  login_session_id TEXT NOT NULL REFERENCES login_sessions(id),
  auth_version INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  target_email TEXT NOT NULL,
  code_digest TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resend_at TEXT NOT NULL,
  error_count INTEGER NOT NULL DEFAULT 0 CHECK(error_count>=0),
  send_state TEXT NOT NULL DEFAULT 'pending' CHECK(send_state IN ('pending','sent','failed')),
  used_at TEXT,
  invalidated_at TEXT
);

-- table: site_settings
CREATE TABLE site_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  default_theme TEXT NOT NULL CHECK(default_theme IN ('light', 'dark')),
  max_upload_bytes INTEGER NOT NULL CHECK(max_upload_bytes > 0),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TEXT NOT NULL
);

-- table: guests
CREATE TABLE guests (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  permissions TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)
);

-- table: guest_sessions
CREATE TABLE guest_sessions (
  login_session_id TEXT PRIMARY KEY NOT NULL REFERENCES login_sessions(id),
  guest_id TEXT NOT NULL REFERENCES guests(id)
);

-- table: guest_uploads
CREATE TABLE guest_uploads (
  upload_id TEXT PRIMARY KEY NOT NULL REFERENCES upload_tasks(id),
  guest_id TEXT NOT NULL REFERENCES guests(id)
);

-- table: homepage_settings
CREATE TABLE homepage_settings (
  owner_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  category_random_enabled INTEGER NOT NULL CHECK(category_random_enabled IN (0, 1)),
  video_order TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TEXT NOT NULL
);

-- index: login_owner
CREATE INDEX login_owner ON login_sessions(owner_id);

-- index: default_category
CREATE UNIQUE INDEX default_category ON categories(owner_id) WHERE is_default=1;

-- index: upload_part_number
CREATE UNIQUE INDEX upload_part_number ON upload_parts(upload_id,part_number);

-- index: watch_owner_video
CREATE UNIQUE INDEX watch_owner_video ON watch_progress(owner_id,video_id);

-- index: playback_owner_active
CREATE INDEX playback_owner_active ON playback_sessions(owner_id,expires_at,closed_at);

-- index: usage_owner_period
CREATE UNIQUE INDEX usage_owner_period ON usage_counters(owner_id,period_start);

-- index: stage2_category_names
CREATE UNIQUE INDEX stage2_category_names ON categories(owner_id, name_key);

-- index: stage2_videos_owner_id
CREATE UNIQUE INDEX stage2_videos_owner_id ON videos(owner_id, id);

-- index: stage2_upload_tasks_owner_id
CREATE UNIQUE INDEX stage2_upload_tasks_owner_id ON upload_tasks(owner_id, id);

-- index: stage2_group_videos
CREATE INDEX stage2_group_videos ON video_group_links(owner_id, group_id, removed_at, video_id);

-- index: stage2_tag_videos
CREATE INDEX stage2_tag_videos ON video_tag_links(owner_id, tag_id, removed_at, video_id);

-- index: stage2_storage_identity
CREATE UNIQUE INDEX stage2_storage_identity
ON storage_objects(provider, bucket, region, object_key, coalesce(version_id, ''));

-- index: stage2_asset_videos
CREATE INDEX stage2_asset_videos ON video_assets(owner_id, storage_object_id);

-- index: stage2_storage_operation_state
CREATE INDEX stage2_storage_operation_state ON storage_operations(owner_id, state, updated_at);

-- index: stage2_legacy_video_key
CREATE INDEX stage2_legacy_video_key ON videos(owner_id, original_key);

-- index: stage2_original_asset_identity
CREATE UNIQUE INDEX stage2_original_asset_identity ON video_assets(owner_id, storage_object_id) WHERE asset_role = 'original';

-- index: stage2_authorizations_owner_time
CREATE INDEX stage2_authorizations_owner_time ON source_authorizations(owner_id, created_at);

-- index: account_operations_owner
CREATE INDEX account_operations_owner ON account_operations(owner_id,state);

-- index: email_challenges_scope
CREATE INDEX email_challenges_scope ON email_challenges(owner_id,purpose,send_sequence);

-- index: email_send_account
CREATE INDEX email_send_account ON email_send_limits(owner_id,reserved_at);

-- index: email_send_ip
CREATE INDEX email_send_ip ON email_send_limits(ip_hash,reserved_at);

-- index: email_verification_owner
CREATE INDEX email_verification_owner ON email_verification_challenges(owner_id,created_at);

-- index: email_verification_ip
CREATE INDEX email_verification_ip ON email_verification_challenges(ip_hash,created_at);

-- index: guests_owner
CREATE INDEX guests_owner ON guests(owner_id);

-- index: guest_sessions_guest
CREATE INDEX guest_sessions_guest ON guest_sessions(guest_id);

-- index: guest_uploads_guest
CREATE INDEX guest_uploads_guest ON guest_uploads(guest_id);

-- trigger: stage2_default_category_not_archived
CREATE TRIGGER stage2_default_category_not_archived
BEFORE UPDATE OF archived_at ON categories
WHEN NEW.is_default = 1 AND NEW.archived_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'default category cannot be archived');
END;

-- trigger: stage2_storage_identity_immutable
CREATE TRIGGER stage2_storage_identity_immutable
BEFORE UPDATE OF owner_id, provider, bucket, region, object_key ON storage_objects
WHEN OLD.owner_id IS NOT NEW.owner_id OR OLD.provider IS NOT NEW.provider OR OLD.bucket IS NOT NEW.bucket
  OR OLD.region IS NOT NEW.region OR OLD.object_key IS NOT NEW.object_key
BEGIN
  SELECT RAISE(ABORT, 'storage identity is immutable; register a new object');
END;

-- trigger: stage2_storage_version_pinned
CREATE TRIGGER stage2_storage_version_pinned
BEFORE UPDATE OF version_id ON storage_objects
WHEN OLD.version_id IS NOT NEW.version_id
  AND NOT (OLD.version_id IS NULL AND OLD.verification_status = 'pending' AND OLD.verified_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'verified object version cannot change');
END;

-- trigger: stage2_storage_verification_not_reset
CREATE TRIGGER stage2_storage_verification_not_reset
BEFORE UPDATE OF verification_status, verified_at ON storage_objects
WHEN OLD.verified_at IS NOT NULL AND (NEW.verified_at IS NULL OR NEW.verification_status = 'pending')
BEGIN
  SELECT RAISE(ABORT, 'verified object cannot return to unbound pending state');
END;

-- trigger: users_email_auth_insert
CREATE TRIGGER users_email_auth_insert BEFORE INSERT ON users
WHEN NEW.auth_method='email' AND (NEW.email IS NULL OR length(trim(NEW.email))=0 OR NEW.email_verified_at IS NULL)
BEGIN SELECT RAISE(ABORT,'verified email required'); END;

-- trigger: users_email_auth_update
CREATE TRIGGER users_email_auth_update BEFORE UPDATE OF auth_method,email,email_verified_at ON users
WHEN NEW.auth_method='email' AND (NEW.email IS NULL OR length(trim(NEW.email))=0 OR NEW.email_verified_at IS NULL)
BEGIN SELECT RAISE(ABORT,'verified email required'); END;

-- 内置支持的邮箱类型；无发信账号和授权码。
INSERT INTO smtp_provider_types(code,name,email_domain,smtp_host,enabled) VALUES('163','163 邮箱','163.com','smtp.163.com',1);
INSERT INTO smtp_provider_types(code,name,email_domain,smtp_host,enabled) VALUES('qq','QQ 邮箱','qq.com','smtp.qq.com',1);

-- 对应 0001～0009 的结构来源校验；应用会核对版本、顺序和 SHA-256。
INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(1,'b2f9606329c23ed3b94d175842450f50989f4eada73c0d5b1f4602d7d5e7a92e',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(2,'ed502f9ad6854fc43178fc5ec37d65476bdb0475d151adbdd2a36c0bf42e151a',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(3,'6aa89f44a7c995d5aa2694bf24b8482b5ae68e928c44b4fa21ce99998625b0fc',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(4,'fba00211ebf42250049a3e54dc061a54a986b883d80888b19123871edfa7f37b',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(5,'afc765ff5ccbdff15d229e7150d3a1786b3ea3c0f4e0f9551de3b64e74cc3e52',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(6,'d982b4876cfe735370e1c93efce7fb09e089b49e7b5ffceec8758b4da563dc55',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(7,'b5db48e45e1a5b980a3a1e0419e6a23bf4a2b9d0904d0692edfc80307bead524',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(8,'61f5d06a0df37caa3365c6e9e8608808a90b6d47dbd2c1cd02a5b85117f463d4',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(9,'0a97bedb1cc66ca7f9c1c2e7a6f170b83c6fcf4013d732a65b3dbfff8082ce8f',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;
PRAGMA foreign_key_check;
PRAGMA integrity_check;

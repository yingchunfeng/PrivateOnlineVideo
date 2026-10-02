-- 仅由受保护的本地初始化/迁移命令执行，不在服务启动时自动迁移。
CREATE TABLE users (id TEXT PRIMARY KEY, singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton=1), display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, totp_cipher TEXT NOT NULL, totp_enabled INTEGER NOT NULL DEFAULT 1 CHECK(totp_enabled IN (0,1)),
  last_totp_counter INTEGER NOT NULL DEFAULT -1, created_at TEXT NOT NULL);
CREATE TABLE login_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE INDEX login_owner ON login_sessions(owner_id);
CREATE TABLE categories (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)), created_at TEXT NOT NULL);
CREATE UNIQUE INDEX default_category ON categories(owner_id) WHERE is_default=1;
CREATE TABLE videos (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id),
  duration_seconds REAL CHECK(duration_seconds IS NULL OR duration_seconds>=0), size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('processing','ready','unsupported','failed')), created_at TEXT NOT NULL, codec TEXT,
  width INTEGER CHECK(width IS NULL OR width>0), height INTEGER CHECK(height IS NULL OR height>0), playable INTEGER NOT NULL CHECK(playable IN (0,1)),
  original_key TEXT NOT NULL, playback_key TEXT NOT NULL, thumbnail_key TEXT);
CREATE UNIQUE INDEX videos_owner_object ON videos(owner_id,original_key);
CREATE TABLE upload_tasks (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), video_id TEXT REFERENCES videos(id), file_name TEXT NOT NULL,
  title TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id), size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 9007199254740991),
  part_size_bytes INTEGER NOT NULL CHECK(part_size_bytes BETWEEN 1 AND 16777216), status TEXT NOT NULL CHECK(status IN ('uploading','finalizing','completed','failed')),
  object_key TEXT NOT NULL UNIQUE, storage_upload_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE upload_parts (upload_id TEXT NOT NULL REFERENCES upload_tasks(id), part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 16777216), checksum TEXT NOT NULL CHECK(length(checksum)=64 AND checksum NOT GLOB '*[^0-9a-f]*'), etag TEXT NOT NULL);
CREATE UNIQUE INDEX upload_part_number ON upload_parts(upload_id,part_number);
CREATE TABLE watch_progress (owner_id TEXT NOT NULL REFERENCES users(id), video_id TEXT NOT NULL REFERENCES videos(id), position_seconds REAL NOT NULL CHECK(position_seconds>=0), updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX watch_owner_video ON watch_progress(owner_id,video_id);
CREATE TABLE playback_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), login_session_id TEXT NOT NULL REFERENCES login_sessions(id),
  video_id TEXT NOT NULL REFERENCES videos(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, closed_at TEXT, ttl_ms INTEGER NOT NULL CHECK(ttl_ms>0));
CREATE INDEX playback_owner_active ON playback_sessions(owner_id,expires_at,closed_at);
CREATE TABLE usage_counters (owner_id TEXT NOT NULL REFERENCES users(id), period_start TEXT NOT NULL, period_end TEXT NOT NULL, timezone TEXT NOT NULL,
  transferred_bytes INTEGER NOT NULL DEFAULT 0 CHECK(transferred_bytes BETWEEN 0 AND 9007199254740991),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes BETWEEN 0 AND 9007199254740991));
CREATE UNIQUE INDEX usage_owner_period ON usage_counters(owner_id,period_start);
CREATE TABLE transfer_reservations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), playback_session_id TEXT NOT NULL, period_start TEXT NOT NULL,
  granted_bytes INTEGER NOT NULL CHECK(granted_bytes BETWEEN 1 AND 9007199254740991), transferred_bytes INTEGER CHECK(transferred_bytes BETWEEN 0 AND granted_bytes), created_at TEXT NOT NULL);
CREATE TABLE audit_events (id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id), action TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE recovery_codes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), code_hash TEXT NOT NULL UNIQUE, used_at TEXT);
CREATE TABLE login_attempts (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, failures INTEGER NOT NULL CHECK(failures>=0));

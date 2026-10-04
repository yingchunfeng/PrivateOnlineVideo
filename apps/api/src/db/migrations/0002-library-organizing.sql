-- 第二阶段待执行变更块；2026-10-02；SQLite；UTF-8 无 BOM。
-- 【已有库升级专用】空库没有categories表，不能从本文件开始执行。
-- 新空库学习结构请看 docs/sql/01_EMPTY_DATABASE_FULL.sql；实际应用新库仍由有序迁移器创建。
-- 不要将两份文件连续执行；完整脚本已经包含本文件新增的字段与表。
-- 目标：已经通过 0001-initial.sql/account:init 初始化的正式库，基线迁移版本为 1。
-- 本轮仅提供语句，未执行到现有数据库；禁止用于 sqlite-test.db，禁止重新初始化账号。
-- 源码已接入版本 2；正式库仍须先一致性备份并获得目标/DDL执行授权。
-- 事务/PRAGMA foreign_keys=ON/校验/ledger 版本与 SHA-256 记录由迁移器统一负责。
-- 本文件故意不包含 BEGIN/COMMIT/ledger INSERT，避免与迁移器事务嵌套或产生伪造校验值。
-- 不要在 GUI 中直接粘贴到现有库；仅 DROP 旧key唯一索引，不删除表/数据，不含密钥。
-- 登录相关表 users/login_sessions/recovery_codes/login_attempts/audit_events 已在 0001 中存在并保留。

ALTER TABLE categories ADD COLUMN archived_at TEXT; -- 给已存在的主分类表增加归档时间；NULL表示未归档
ALTER TABLE categories ADD COLUMN name_key TEXT NOT NULL DEFAULT '';
UPDATE categories SET name_key = lower(trim(name));
CREATE UNIQUE INDEX stage2_category_names ON categories(owner_id, name_key);
CREATE TRIGGER stage2_default_category_not_archived
BEFORE UPDATE OF archived_at ON categories
WHEN NEW.is_default = 1 AND NEW.archived_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'default category cannot be archived');
END;

-- 复合唯一键让关联表的外键同时检查资源 ID 与 owner_id。
CREATE UNIQUE INDEX stage2_videos_owner_id ON videos(owner_id, id);
CREATE UNIQUE INDEX stage2_upload_tasks_owner_id ON upload_tasks(owner_id, id);

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
CREATE INDEX stage2_group_videos ON video_group_links(owner_id, group_id, removed_at, video_id);

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
CREATE INDEX stage2_tag_videos ON video_tag_links(owner_id, tag_id, removed_at, video_id);

-- 组织信息在创建上传任务时保存，重开/续传/完成时以服务端记录为准。
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

-- 永久定位信息，不保存 AccessKey、STS Token、签名播放 URL 或公开播放授权。
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
CREATE UNIQUE INDEX stage2_storage_identity
ON storage_objects(provider, bucket, region, object_key, coalesce(version_id, ''));

CREATE TRIGGER stage2_storage_identity_immutable
BEFORE UPDATE OF owner_id, provider, bucket, region, object_key ON storage_objects
WHEN OLD.owner_id IS NOT NEW.owner_id OR OLD.provider IS NOT NEW.provider OR OLD.bucket IS NOT NEW.bucket
  OR OLD.region IS NOT NEW.region OR OLD.object_key IS NOT NEW.object_key
BEGIN
  SELECT RAISE(ABORT, 'storage identity is immutable; register a new object');
END;
CREATE TRIGGER stage2_storage_version_pinned
BEFORE UPDATE OF version_id ON storage_objects
WHEN OLD.version_id IS NOT NEW.version_id
  AND NOT (OLD.version_id IS NULL AND OLD.verification_status = 'pending' AND OLD.verified_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'verified object version cannot change');
END;
CREATE TRIGGER stage2_storage_verification_not_reset
BEFORE UPDATE OF verification_status, verified_at ON storage_objects
WHEN OLD.verified_at IS NOT NULL AND (NEW.verified_at IS NULL OR NEW.verification_status = 'pending')
BEGIN
  SELECT RAISE(ABORT, 'verified object cannot return to unbound pending state');
END;

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
CREATE INDEX stage2_asset_videos ON video_assets(owner_id, storage_object_id);
CREATE TABLE upload_storage_objects (
  owner_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  storage_object_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, upload_id),
  FOREIGN KEY(owner_id, upload_id) REFERENCES upload_tasks(owner_id, id),
  FOREIGN KEY(owner_id, storage_object_id) REFERENCES storage_objects(owner_id, id)
);

-- OSS 与 SQLite 不是一个分布式事务：先记 prepared，再操作云，最后事务登记关联。
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
CREATE INDEX stage2_storage_operation_state ON storage_operations(owner_id, state, updated_at);

-- 原有 key 列继续保留原含义；唯一性改由完整对象身份与资产关系管理。
DROP INDEX videos_owner_object;
CREATE INDEX stage2_legacy_video_key ON videos(owner_id, original_key);
CREATE UNIQUE INDEX stage2_original_asset_identity ON video_assets(owner_id, storage_object_id) WHERE asset_role = 'original';
ALTER TABLE playback_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'proxy' CHECK(mode IN ('proxy', 'oss'));
ALTER TABLE playback_sessions ADD COLUMN source_expires_at TEXT;
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
CREATE INDEX stage2_authorizations_owner_time ON source_authorizations(owner_id, created_at);

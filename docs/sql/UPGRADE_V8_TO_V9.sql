-- 云影匣：已有标准 v8 数据库增量升级到 v9。UTF-8，无 BOM。
-- 操作前停止 API/上传任务，使用 SQLite 一致性备份；本文件本身不创建备份。
-- 仅适用于具有正确 1～8 迁移账本的库；不是新空库初始化，不支持 v5～v7 或重复执行。
-- 必须遇错停止；若连接仍在事务中，执行 ROLLBACK 后排查，不要继续执行或重新初始化。
-- 只新增首页排序表与第 9 条迁移账本，不写入账号、视频、密钥或 OSS/SMTP 配置。
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
CREATE TEMP TABLE __online_video_v8_to_v9_guard (ok INTEGER NOT NULL CHECK(ok=1));
INSERT OR ROLLBACK INTO __online_video_v8_to_v9_guard SELECT CASE WHEN
  (SELECT count(*) FROM schema_migrations)=8
  AND (SELECT count(*) FROM schema_migrations WHERE (version=1 AND checksum='b2f9606329c23ed3b94d175842450f50989f4eada73c0d5b1f4602d7d5e7a92e')
    OR (version=2 AND checksum='ed502f9ad6854fc43178fc5ec37d65476bdb0475d151adbdd2a36c0bf42e151a')
    OR (version=3 AND checksum='6aa89f44a7c995d5aa2694bf24b8482b5ae68e928c44b4fa21ce99998625b0fc')
    OR (version=4 AND checksum='fba00211ebf42250049a3e54dc061a54a986b883d80888b19123871edfa7f37b')
    OR (version=5 AND checksum='afc765ff5ccbdff15d229e7150d3a1786b3ea3c0f4e0f9551de3b64e74cc3e52')
    OR (version=6 AND checksum='d982b4876cfe735370e1c93efce7fb09e089b49e7b5ffceec8758b4da563dc55')
    OR (version=7 AND checksum='b5db48e45e1a5b980a3a1e0419e6a23bf4a2b9d0904d0692edfc80307bead524')
    OR (version=8 AND checksum='61f5d06a0df37caa3365c6e9e8608808a90b6d47dbd2c1cd02a5b85117f463d4'))=8
  AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE name='homepage_settings')
  AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
  AND (SELECT count(*) FROM pragma_integrity_check)=1
  AND (SELECT integrity_check FROM pragma_integrity_check LIMIT 1)='ok'
  THEN 1 ELSE 0 END;

-- 迁移来源：0009-homepage-settings.sql；与应用内迁移完全一致。
CREATE TABLE homepage_settings (
  owner_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  category_random_enabled INTEGER NOT NULL CHECK(category_random_enabled IN (0, 1)),
  video_order TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TEXT NOT NULL
);

-- 原有 1～8 账本保持不变，只追加 v9 校验值。
INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(9,'0a97bedb1cc66ca7f9c1c2e7a6f170b83c6fcf4013d732a65b3dbfff8082ce8f',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR ROLLBACK INTO __online_video_v8_to_v9_guard SELECT CASE WHEN
  (SELECT count(*) FROM schema_migrations)=9
  AND (SELECT checksum FROM schema_migrations WHERE version=9)='0a97bedb1cc66ca7f9c1c2e7a6f170b83c6fcf4013d732a65b3dbfff8082ce8f'
  AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
  AND (SELECT count(*) FROM pragma_integrity_check)=1
  AND (SELECT integrity_check FROM pragma_integrity_check LIMIT 1)='ok'
  THEN 1 ELSE 0 END;
COMMIT;
PRAGMA foreign_key_check;
PRAGMA integrity_check;
SELECT version,checksum FROM schema_migrations ORDER BY version;

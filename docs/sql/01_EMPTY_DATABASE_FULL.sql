-- ================================================================
-- 个人私有视频库：完整建表脚本（SQLite / 新空库专用）
-- 日期：2026-10-02；编码：UTF-8 无 BOM。
-- ================================================================
-- 【解决之前的报错】
-- 之前 STAGE2_PENDING.sql 是“已有库升级脚本”，第一条 ALTER TABLE
-- 要求 categories 表已存在。空 sqlite-test.db 没有该表，因此报 no such table。
-- 本文件从 users 用户表开始创建全部结构，不依赖任何已存在的业务表。
--
-- 【第0步：先有数据库文件，再执行下面的建表语句】
-- SQLite 没有 CREATE DATABASE 语句，不能照搬 MySQL/达梦的建库语句。
-- 一个 .db 文件就是一个数据库；通过 Navicat 的 SQLite 连接打开/创建该文件。
-- 你目前连接的 E:\onlineVideo\sqlite-test.db 已经存在，且已检查为空库，可以使用。
-- 如果另建数据库，在 Navicat 创建 SQLite 连接并指定一个新的 .db 文件路径。
-- 这一步在 Navicat 中完成，不是在查询窗口输入 CREATE DATABASE 或 USE。
--
-- 【第1步：在 Navicat 执行本文件】
-- 1. 确认连接类型为 SQLite，数据库文件为 E:\onlineVideo\sqlite-test.db 这个空库。
-- 2. 在该连接打开查询窗口，载入本文件；从头到尾执行全部，不只执行选中的一行。
-- 3. 执行时必须遇错停止；若工具有“遇错继续”选项，请关闭后再运行。
-- 4. 出错后不要继续执行后续语句；在同一连接执行 ROLLBACK; 回滚本次未提交建表。
-- 5. 仅执行一次；已有表会明确报错，不自动覆盖/删除，也不隐藏结构不一致。
-- 6. 不要执行到 .local/data/video-library.db，该库已经有真实账号。
--
-- 【与 MySQL/达梦的不同】
-- SQLite 的一个 .db 文件就是一个数据库，不使用 CREATE DATABASE 或 USE。
-- -- 是 SQL 注释；不使用 MySQL 的 COMMENT 或达梦的 COMMENT ON TABLE。
-- TEXT 保存字符串/UUID/时间；INTEGER 保存整数、字节、0/1；REAL 保存小数秒。
-- 时间统一由应用写入 UTC ISO8601，例如 2026-10-02T08:00:00.000Z。
-- 所有 owner_id 都表示“归属哪个用户”，引用 users.id，不是登录用户名。
-- ID 由后端生成不可预测的字符串，不是 AUTO_INCREMENT。
--
-- 【读懂下面每行SQL】
-- CREATE TABLE 表名 (...)：新建一张表；括号内每行定义一个字段或一条约束。
-- PRIMARY KEY：主键，用来识别记录；UNIQUE：字段或字段组合不能重复。
-- NOT NULL：必须填写；NULL：没有值；空字符串 '' 与 NULL 是两种不同的值。
-- DEFAULT：省略该字段时使用的默认值；CHECK：写入数据必须满足的规则。
-- REFERENCES / FOREIGN KEY：外键，要求关联的用户、视频或对象记录已经存在。
-- 复合外键同时检查 owner_id 和资源ID，避免关联到其他用户名下的资源。
-- CREATE INDEX：建立查询索引；CREATE UNIQUE INDEX：索引还会检查是否重复。
-- CREATE TRIGGER：建立触发器，特定修改发生时自动检查，必要时拒绝修改。
-- NEW / OLD：触发器里的修改后/修改前记录；IS NOT 可以比较包含 NULL 的值。
-- BEGIN IMMEDIATE / COMMIT：开始写事务/提交，保证这批建表一起完成。
-- 分号 ; 结束一条语句；逗号 , 分隔字段；行尾 -- 后的中文不会被执行。
-- INTEGER 字节数上限9007199254740991是JavaScript可精确表示的最大整数。
--
-- 【重要：这份是手工建结构/学习文件】
-- 含第一阶段和第二阶段全部表，但不插入账号、不写密码/密钥、不伪造迁移记录。
-- 当前应用只支持版本1；手工建好的完整第二阶段库不能直接替换当前运行库。
-- 正式升级仍由下一阶段接入迁移器后执行，已有账号与数据不重建。
--
-- 【表目录】
-- 01 users                  用户账号表
-- 02 login_sessions         登录会话表
-- 03 categories             视频主分类表
-- 04 videos                 视频资料表
-- 05 upload_tasks           上传任务表
-- 06 upload_parts           上传分片表
-- 07 watch_progress         观看进度表
-- 08 playback_sessions      播放会话表（与登录会话不同）
-- 09 usage_counters         流量累计表
-- 10 transfer_reservations  在途流量预留表
-- 11 audit_events           审计记录表
-- 12 recovery_codes         账号恢复码表
-- 13 login_attempts         登录限流计数表
-- 14 schema_migrations      应用迁移版本表（建空表，不填假版本）
-- 15 library_groups         个人分组/合集表
-- 16 tags                   内容标签表
-- 17 video_group_links      视频与分组关系表
-- 18 video_tag_links        视频与标签关系表
-- 19 upload_group_links     上传任务与分组关系表
-- 20 upload_tag_links       上传任务与标签关系表
-- 21 storage_objects        OSS/Mock 对象位置与核验资料表
-- 22 video_assets           视频与原片/播放/封面对象关系表
-- 23 upload_storage_objects 上传任务与存储对象关系表
-- 24 storage_operations     存储操作与数据库登记过程表
-- ================================================================

-- 第2步：检查连接并启用外键；必须在事务开始前设置外键开关。
PRAGMA database_list; -- 查看当前连接的数据库文件路径，确认是你的空库
PRAGMA foreign_keys = ON; -- 启用本次连接的外键检查，后续每个新连接也需启用

-- 第3步：下面全部建表在一个事务里执行，末尾 COMMIT 成功才完成。
BEGIN IMMEDIATE; -- 开始写事务并提前取得写锁，其他连接暂时不能同时写入

-- 01【用户账号表】系统只有本人一个账号。
-- 不保存明文密码；TOTP 是手机验证器产生动态验证码的配置。
CREATE TABLE users ( -- 创建用户账号表，以下各行定义账号字段
  id TEXT PRIMARY KEY,                         -- 用户ID：后端生成UUID
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton = 1), -- 唯一用户标记，固定为1
  display_name TEXT NOT NULL,                   -- 页面显示名，例如“本人”
  password_hash TEXT NOT NULL,                  -- Argon2id密码哈希，不能填明文密码
  totp_cipher TEXT NOT NULL,                    -- 已加密的TOTP密钥，不能填明文密钥
  totp_enabled INTEGER NOT NULL DEFAULT 1 CHECK(totp_enabled IN (0, 1)), -- 1启用动态验证码
  last_totp_counter INTEGER NOT NULL DEFAULT -1, -- 最近用过的验证码时间步，防止重复登录
  created_at TEXT NOT NULL                      -- 创建时间，UTC ISO8601
); -- 结束用户账号表定义

-- 02【登录会话表】一次密码+验证码登录建立一条会话，用于Cookie授权。
CREATE TABLE login_sessions ( -- 创建登录会话表，记录登录后的授权状态
  id TEXT PRIMARY KEY,                         -- 登录会话ID，公开给本人查看/撤销
  owner_id TEXT NOT NULL REFERENCES users(id),  -- 所属用户ID
  token_hash TEXT NOT NULL UNIQUE,              -- Cookie令牌的摘要，不保存Cookie原值
  created_at TEXT NOT NULL,                     -- 本次登录时间
  last_seen_at TEXT NOT NULL,                   -- 最近访问时间
  expires_at TEXT NOT NULL,                     -- 到期时间
  revoked_at TEXT                              -- 撤销时间；NULL表示尚未撤销
); -- 结束登录会话表定义
CREATE INDEX login_owner ON login_sessions(owner_id); -- 加速查询本人的登录会话

-- 03【视频主分类表】一个视频只有一个主分类；“未分类”为默认分类。
CREATE TABLE categories ( -- 创建视频主分类表，archived_at在建表时直接定义
  id TEXT PRIMARY KEY,                         -- 分类ID
  owner_id TEXT NOT NULL REFERENCES users(id),  -- 所属用户
  name TEXT NOT NULL,                           -- 分类名，例如“旅行”“日常”
  sort_order INTEGER NOT NULL DEFAULT 0,        -- 排序值
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)), -- 1表示“未分类”
  created_at TEXT NOT NULL,                     -- 创建时间
  archived_at TEXT                             -- 归档时间；NULL表示活动分类
); -- 结束视频主分类表定义
CREATE UNIQUE INDEX default_category ON categories(owner_id) WHERE is_default = 1; -- 每个用户最多有一个默认分类
-- 上面的部分唯一索引保证每个用户最多有一个默认分类。

-- 04【视频资料表】只保存资料和位置，不把视频二进制放进SQLite。
CREATE TABLE videos ( -- 创建视频资料表，存资料与对象Key，视频文件本身存OSS
  id TEXT PRIMARY KEY,                         -- 视频ID，前端通过此ID访问
  owner_id TEXT NOT NULL REFERENCES users(id),  -- 所属用户
  title TEXT NOT NULL,                          -- 视频标题
  category_id TEXT NOT NULL REFERENCES categories(id), -- 唯一主分类
  duration_seconds REAL CHECK(duration_seconds IS NULL OR duration_seconds >= 0), -- 时长秒；未知为NULL
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 9007199254740991), -- 实际字节数
  status TEXT NOT NULL CHECK(status IN ('processing', 'ready', 'unsupported', 'failed')), -- 处理/可播/不兼容/失败
  created_at TEXT NOT NULL,                     -- 登记时间
  codec TEXT,                                  -- 编码信息，例如h264/aac；未知为NULL
  width INTEGER CHECK(width IS NULL OR width > 0), -- 视频宽度，像素
  height INTEGER CHECK(height IS NULL OR height > 0), -- 视频高度，像素
  playable INTEGER NOT NULL CHECK(playable IN (0, 1)), -- 是否核验为可播放，不能只看后缀
  original_key TEXT NOT NULL,                   -- 第一阶段原片对象Key，保留兼容
  playback_key TEXT NOT NULL,                   -- 第一阶段播放版本Key，保留兼容
  thumbnail_key TEXT                           -- 第一阶段封面Key，无封面为NULL
); -- 结束视频资料表定义
CREATE UNIQUE INDEX videos_owner_object ON videos(owner_id, original_key); -- 第一阶段对象登记去重
CREATE UNIQUE INDEX stage2_videos_owner_id ON videos(owner_id, id);        -- 供归属复合外键使用

-- 05【上传任务表】保存断点续传任务；上传尚未完成时可以没有video_id。
CREATE TABLE upload_tasks ( -- 创建上传任务表，用于断点续传和最终视频登记
  id TEXT PRIMARY KEY,                         -- 上传任务ID
  owner_id TEXT NOT NULL REFERENCES users(id),  -- 任务归属用户
  video_id TEXT REFERENCES videos(id),          -- 完成登记的视频ID，尚未登记为NULL
  file_name TEXT NOT NULL,                      -- 手机所选原文件名，仅供显示/核对
  title TEXT NOT NULL,                          -- 用户填写的视频标题
  category_id TEXT NOT NULL REFERENCES categories(id), -- 创建任务时选择的主分类
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 9007199254740991), -- 文件总字节数
  part_size_bytes INTEGER NOT NULL CHECK(part_size_bytes BETWEEN 1 AND 16777216), -- 服务端分片字节数，最多16MiB
  status TEXT NOT NULL CHECK(status IN ('uploading', 'finalizing', 'completed', 'failed')), -- 上传/完成确认/已完成/失败
  object_key TEXT NOT NULL UNIQUE,              -- 服务端生成的唯一对象Key
  storage_upload_id TEXT NOT NULL,              -- OSS内部Multipart ID，不交由客户端指定
  created_at TEXT NOT NULL                      -- 任务创建时间
); -- 结束上传任务表定义
CREATE UNIQUE INDEX stage2_upload_tasks_owner_id ON upload_tasks(owner_id, id); -- 用户与任务ID组合唯一，供复合外键引用

-- 06【上传分片表】每一片独立保存校验和状态，避免将整个大视频读入内存。
CREATE TABLE upload_parts ( -- 创建上传分片表，一条记录对应任务的一片数据
  upload_id TEXT NOT NULL REFERENCES upload_tasks(id), -- 所属上传任务
  part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000), -- 分片号，从1开始
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 16777216), -- 这片的实际字节数
  checksum TEXT NOT NULL CHECK(length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'), -- SHA-256小写hex
  etag TEXT NOT NULL                            -- OSS返回的内部ETag，不等于SHA-256
); -- 结束上传分片表定义
CREATE UNIQUE INDEX upload_part_number ON upload_parts(upload_id, part_number); -- 同一上传任务的分片号不能重复

-- 07【观看进度表】保存本人在哪个视频看到多少秒。
CREATE TABLE watch_progress ( -- 创建观看进度表，用于下次继续播放
  owner_id TEXT NOT NULL REFERENCES users(id),  -- 观看用户
  video_id TEXT NOT NULL REFERENCES videos(id), -- 对应视频
  position_seconds REAL NOT NULL CHECK(position_seconds >= 0), -- 已看到的位置，秒，可含小数
  updated_at TEXT NOT NULL                      -- 最近保存时间
); -- 结束观看进度表定义
CREATE UNIQUE INDEX watch_owner_video ON watch_progress(owner_id, video_id); -- 同一用户对同一视频只有一条当前进度

-- 08【播放会话表】管理播放器并发/计量，不能替代登录Cookie。
CREATE TABLE playback_sessions ( -- 创建播放会话表，用于播放器并发和流量控制
  id TEXT PRIMARY KEY,                         -- 播放会话ID，一个播放器复用此会话
  owner_id TEXT NOT NULL REFERENCES users(id),  -- 所属用户
  login_session_id TEXT NOT NULL REFERENCES login_sessions(id), -- 绑定真实登录会话
  video_id TEXT NOT NULL REFERENCES videos(id), -- 正在播放哪个视频
  created_at TEXT NOT NULL,                     -- 开始时间
  expires_at TEXT NOT NULL,                     -- 活动会话到期时间
  last_seen_at TEXT NOT NULL,                   -- 最近心跳时间
  closed_at TEXT,                              -- 关闭时间，NULL表示尚未关闭
  ttl_ms INTEGER NOT NULL CHECK(ttl_ms > 0)      -- 心跳续期长度，毫秒
); -- 结束播放会话表定义
CREATE INDEX playback_owner_active ON playback_sessions(owner_id, expires_at, closed_at); -- 加速查询用户尚未过期且未关闭的播放会话

-- 09【流量累计表】统计应用后端转发字节，不是OSS最终账单。
CREATE TABLE usage_counters ( -- 创建流量累计表，每个用户每个周期一条记录
  owner_id TEXT NOT NULL REFERENCES users(id),  -- 所属用户
  period_start TEXT NOT NULL,                   -- 统计周期开始，包含该时间
  period_end TEXT NOT NULL,                     -- 统计周期结束，不包含该时间
  timezone TEXT NOT NULL,                       -- IANA时区，例如Asia/Shanghai
  transferred_bytes INTEGER NOT NULL DEFAULT 0 CHECK(transferred_bytes BETWEEN 0 AND 9007199254740991), -- 已输出字节
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes BETWEEN 0 AND 9007199254740991) -- 在途已预留额度
); -- 结束流量累计表定义
CREATE UNIQUE INDEX usage_owner_period ON usage_counters(owner_id, period_start); -- 用户与统计周期起点组合不能重复

-- 10【在途流量预留表】先占额度再传输，防止多个请求一起突破预算。
CREATE TABLE transfer_reservations ( -- 创建流量预留表，记录传输前占用的额度
  id TEXT PRIMARY KEY,                         -- 本次预留ID
  owner_id TEXT NOT NULL REFERENCES users(id),  -- 所属用户
  playback_session_id TEXT NOT NULL,            -- 播放会话或受保护封面计量关联
  period_start TEXT NOT NULL,                   -- 所属统计周期
  granted_bytes INTEGER NOT NULL CHECK(granted_bytes BETWEEN 1 AND 9007199254740991), -- 允许传出的字节
  transferred_bytes INTEGER CHECK(transferred_bytes BETWEEN 0 AND granted_bytes), -- 最终实际输出，NULL为未结算
  created_at TEXT NOT NULL                      -- 预留时间
); -- 结束流量预留表定义

-- 11【审计表】记录登录/撤销/恢复等操作，禁止写密码和密钥。
CREATE TABLE audit_events ( -- 创建审计记录表，记录账号与安全操作事件
  id TEXT PRIMARY KEY,                         -- 审计记录ID
  owner_id TEXT REFERENCES users(id),           -- 对应用户；未知主体时为NULL
  action TEXT NOT NULL,                         -- 安全操作名称/事件类型
  created_at TEXT NOT NULL                      -- 发生时间
); -- 结束审计记录表定义

-- 12【恢复码表】验证器丢失时用，恢复还需要密码和本机管理权限。
CREATE TABLE recovery_codes ( -- 创建恢复码表，只存恢复码摘要和使用状态
  id TEXT PRIMARY KEY,                         -- 恢复码记录ID
  owner_id TEXT NOT NULL REFERENCES users(id),  -- 所属用户
  code_hash TEXT NOT NULL UNIQUE,               -- 恢复码摘要，不保存原码
  used_at TEXT                                 -- 使用/作废时间；NULL为未使用
); -- 结束恢复码表定义

-- 13【登录限流表】保存账户/IP维度的失败计数，重启不能清零绕过。
CREATE TABLE login_attempts ( -- 创建登录限流表，将失败计数保存到数据库
  key TEXT PRIMARY KEY,                        -- 限流维度，例如account或IP摘要
  window_start INTEGER NOT NULL,               -- 时间窗口起点，Unix毫秒
  failures INTEGER NOT NULL CHECK(failures >= 0) -- 已计入的失败/在验证尝试次数
); -- 结束登录限流表定义

-- 14【迁移版本表】由应用迁移器填写；本手工脚本不插入虚假版本。
CREATE TABLE schema_migrations ( -- 创建迁移记录表，真实版本由应用迁移器写入
  version INTEGER PRIMARY KEY,                -- 已执行迁移序号，例如1、2
  checksum TEXT NOT NULL,                      -- 对应真实迁移SQL的SHA-256
  applied_at TEXT NOT NULL                     -- 执行时间
); -- 结束迁移记录表定义，本文件不插入版本记录

-- 15【分组/合集表】例如“2026旅行”“家人”；一个视频可加入多个分组。
CREATE TABLE library_groups ( -- 创建分组/合集表，保存名称、说明和归档状态
  id TEXT PRIMARY KEY,                         -- 分组ID
  owner_id TEXT NOT NULL REFERENCES users(id),  -- 所属用户
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100), -- 展示名称
  name_key TEXT NOT NULL CHECK(length(name_key) BETWEEN 1 AND 200), -- 应用生成的规范化名称，去重用
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 1000), -- 分组说明
  sort_order INTEGER NOT NULL DEFAULT 0,        -- 排序值
  created_at TEXT NOT NULL,                     -- 创建时间
  updated_at TEXT NOT NULL,                     -- 修改时间
  archived_at TEXT,                            -- 归档时间，不删除历史分组
  UNIQUE(owner_id, id),                        -- 供归属外键引用
  UNIQUE(owner_id, name_key)                   -- 本人名下不允许重复规范化名称
); -- 结束分组/合集表定义

-- 16【标签表】例如“杭州”“夜景”；不同于主分类，也不写入OSS Object Tagging。
CREATE TABLE tags ( -- 创建内容标签表，用于给视频添加多个标签
  id TEXT PRIMARY KEY,                         -- 标签ID
  owner_id TEXT NOT NULL REFERENCES users(id),  -- 所属用户
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100), -- 展示标签名
  name_key TEXT NOT NULL CHECK(length(name_key) BETWEEN 1 AND 200), -- 应用规范化去重名
  created_at TEXT NOT NULL,                     -- 创建时间
  updated_at TEXT NOT NULL,                     -- 修改时间
  archived_at TEXT,                            -- 归档时间，NULL为活动标签
  UNIQUE(owner_id, id), -- 用户与标签ID组合唯一，供复合外键引用
  UNIQUE(owner_id, name_key) -- 同一用户名下不允许重复的规范化标签名称
); -- 结束内容标签表定义

-- 17【视频-分组关系表】不是视频本体表；每条记录表示视频属于一个分组。
CREATE TABLE video_group_links ( -- 创建视频与分组的多对多关系表
  owner_id TEXT NOT NULL,                       -- 关系所属用户
  video_id TEXT NOT NULL,                       -- 视频ID
  group_id TEXT NOT NULL,                       -- 分组ID
  assigned_at TEXT NOT NULL,                    -- 关联建立时间
  removed_at TEXT,                             -- 取消关联时间；NULL为当前有效
  PRIMARY KEY(owner_id, video_id, group_id), -- 同一用户的视频与同一分组最多一条关系记录
  FOREIGN KEY(owner_id, video_id) REFERENCES videos(owner_id, id), -- 视频必须存在并属于该用户
  FOREIGN KEY(owner_id, group_id) REFERENCES library_groups(owner_id, id) -- 分组必须存在并属于同一个用户
); -- 结束视频与分组关系表定义
CREATE INDEX stage2_group_videos ON video_group_links(owner_id, group_id, removed_at, video_id); -- 加速按分组查询当前有效的视频关系

-- 18【视频-标签关系表】一个视频多个标签，用多条关系记录表达。
CREATE TABLE video_tag_links ( -- 创建视频与标签的多对多关系表
  owner_id TEXT NOT NULL,                       -- 关系所属用户
  video_id TEXT NOT NULL,                       -- 视频ID
  tag_id TEXT NOT NULL,                         -- 标签ID
  assigned_at TEXT NOT NULL,                    -- 关联时间
  removed_at TEXT,                             -- 取消关联时间，保留历史记录
  PRIMARY KEY(owner_id, video_id, tag_id), -- 同一用户的视频与同一标签最多一条关系记录
  FOREIGN KEY(owner_id, video_id) REFERENCES videos(owner_id, id), -- 视频必须存在并属于该用户
  FOREIGN KEY(owner_id, tag_id) REFERENCES tags(owner_id, id) -- 标签必须存在并属于同一个用户
); -- 结束视频与标签关系表定义
CREATE INDEX stage2_tag_videos ON video_tag_links(owner_id, tag_id, removed_at, video_id); -- 加速按标签查询当前有效的视频关系

-- 19【上传任务-分组关系表】视频尚未登记时，先保存用户的分组选择。
CREATE TABLE upload_group_links ( -- 创建上传任务与分组关系表，保存上传前的分组选择
  owner_id TEXT NOT NULL,                       -- 所属用户
  upload_id TEXT NOT NULL,                      -- 上传任务ID
  group_id TEXT NOT NULL,                       -- 选择的分组ID
  assigned_at TEXT NOT NULL,                    -- 选择保存时间
  removed_at TEXT,                             -- 取消时间
  PRIMARY KEY(owner_id, upload_id, group_id), -- 同一上传任务与同一分组最多一条关系记录
  FOREIGN KEY(owner_id, upload_id) REFERENCES upload_tasks(owner_id, id), -- 上传任务必须存在并属于该用户
  FOREIGN KEY(owner_id, group_id) REFERENCES library_groups(owner_id, id) -- 分组必须存在并属于同一个用户
); -- 结束上传任务与分组关系表定义

-- 20【上传任务-标签关系表】重开/续传后标签仍可从服务端任务恢复。
CREATE TABLE upload_tag_links ( -- 创建上传任务与标签关系表，保存上传前的标签选择
  owner_id TEXT NOT NULL,                       -- 所属用户
  upload_id TEXT NOT NULL,                      -- 上传任务ID
  tag_id TEXT NOT NULL,                         -- 选择的标签ID
  assigned_at TEXT NOT NULL,                    -- 选择保存时间
  removed_at TEXT,                             -- 取消时间
  PRIMARY KEY(owner_id, upload_id, tag_id), -- 同一上传任务与同一标签最多一条关系记录
  FOREIGN KEY(owner_id, upload_id) REFERENCES upload_tasks(owner_id, id), -- 上传任务必须存在并属于该用户
  FOREIGN KEY(owner_id, tag_id) REFERENCES tags(owner_id, id) -- 标签必须存在并属于同一个用户
); -- 结束上传任务与标签关系表定义

-- 21【存储对象资料表】通过Bucket+地域+Key+版本定位视频，不存过期签名URL。
CREATE TABLE storage_objects ( -- 创建存储对象表，保存OSS位置、版本和核验结果
  id TEXT PRIMARY KEY,                         -- 数据库内对象ID
  owner_id TEXT NOT NULL REFERENCES users(id),  -- 对象归属用户
  provider TEXT NOT NULL CHECK(provider IN ('oss', 'mock')), -- oss真实云 / mock测试内容
  bucket TEXT NOT NULL DEFAULT '',              -- OSS Bucket名；Mock固定空字符串
  region TEXT NOT NULL DEFAULT '',              -- OSS业务地域，例如cn-hangzhou；Mock为空
  object_key TEXT NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024), -- Bucket中的文件Key，不是完整URL
  version_id TEXT CHECK(version_id IS NULL OR length(version_id) BETWEEN 1 AND 1024), -- OSS版本号，可为NULL
  size_bytes INTEGER CHECK(size_bytes BETWEEN 0 AND 9007199254740991), -- 核验的实际字节数，未知为NULL
  etag TEXT,                                   -- OSS返回的变化标识，不等于SHA-256
  content_type TEXT,                           -- 类型，例如video/mp4、image/jpeg
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending', 'verified', 'unavailable')), -- 待核验/已核验/不可用
  verified_at TEXT,                            -- 最近成功核验时间
  created_at TEXT NOT NULL,                     -- 对象资料创建时间
  updated_at TEXT NOT NULL,                     -- 修改时间
  UNIQUE(owner_id, id), -- 用户与对象ID组合唯一，供复合外键引用
  CHECK((provider = 'oss' AND length(trim(bucket)) > 0 AND length(trim(region)) > 0) -- 真OSS对象必须填写非空Bucket和地域
    OR (provider = 'mock' AND bucket = '' AND region = '' AND version_id IS NULL)), -- Mock对象的Bucket和地域必须为空，版本必须为NULL
  CHECK(verification_status <> 'verified' -- 尚未核验成功时允许元数据暂缺
    OR (size_bytes IS NOT NULL AND etag IS NOT NULL AND length(etag) > 0 -- 标为已核验时必须有实际字节数和非空ETag
      AND content_type IS NOT NULL AND length(content_type) > 0 AND verified_at IS NOT NULL)) -- 已核验还必须有非空类型和核验时间
); -- 结束存储对象表定义
CREATE UNIQUE INDEX stage2_storage_identity -- 创建对象位置唯一索引，避免同一对象版本重复登记
ON storage_objects(owner_id, provider, bucket, region, object_key, coalesce(version_id, '')); -- 按归属和完整位置去重，NULL版本按空串比较
-- coalesce把NULL版本转换为空串用于唯一判断，防止无版本对象被重复登记。

-- 22【视频资产关系表】指定哪一个对象是视频原片/播放版本/封面。
CREATE TABLE video_assets ( -- 创建视频资产关系表，关联原片、播放版本和封面对象
  owner_id TEXT NOT NULL,                       -- 所属用户
  video_id TEXT NOT NULL,                       -- 视频ID
  asset_role TEXT NOT NULL CHECK(asset_role IN ('original', 'playback', 'thumbnail')), -- 原片/播放/封面
  storage_object_id TEXT NOT NULL,              -- storage_objects.id
  created_at TEXT NOT NULL,                     -- 绑定时间
  PRIMARY KEY(owner_id, video_id, asset_role), -- 每个视频每种资产角色只关联一个对象
  FOREIGN KEY(owner_id, video_id) REFERENCES videos(owner_id, id), -- 视频必须存在并属于该用户
  FOREIGN KEY(owner_id, storage_object_id) REFERENCES storage_objects(owner_id, id) -- 对象必须存在并属于同一个用户
); -- 结束视频资产关系表定义
CREATE INDEX stage2_asset_videos ON video_assets(owner_id, storage_object_id); -- 加速从对象反查关联的视频

-- 23【上传任务-存储对象关系表】记录这个上传任务要生成哪个对象。
CREATE TABLE upload_storage_objects ( -- 创建上传任务与存储对象关系表
  owner_id TEXT NOT NULL,                       -- 所属用户
  upload_id TEXT NOT NULL,                      -- 上传任务ID
  storage_object_id TEXT NOT NULL,              -- storage_objects.id
  created_at TEXT NOT NULL,                     -- 绑定时间
  PRIMARY KEY(owner_id, upload_id), -- 每个上传任务只关联一个待生成的存储对象
  FOREIGN KEY(owner_id, upload_id) REFERENCES upload_tasks(owner_id, id), -- 上传任务必须存在并属于该用户
  FOREIGN KEY(owner_id, storage_object_id) REFERENCES storage_objects(owner_id, id) -- 对象必须存在并属于同一个用户
); -- 结束上传任务与存储对象关系表定义

-- 24【存储操作记录表】连接云操作与SQL登记，便于失败/重启后恢复。
CREATE TABLE storage_operations ( -- 创建存储操作记录表，用于恢复上传或导入的中间状态
  id TEXT PRIMARY KEY,                         -- 操作ID
  owner_id TEXT NOT NULL REFERENCES users(id),  -- 所属用户
  operation_type TEXT NOT NULL CHECK(operation_type IN ('upload', 'import')), -- 新上传/已有对象导入
  storage_object_id TEXT NOT NULL,              -- 对应的对象资料
  upload_id TEXT,                              -- 对应上传任务；导入或尚未建任务时可为NULL
  video_id TEXT,                               -- 已登记的视频；尚未登记时为NULL
  state TEXT NOT NULL CHECK(state IN ('prepared', 'multipart_started', 'object_completed', 'registered', 'failed')), -- 准备/分片启动/云对象完成/库登记完成/失败
  storage_upload_id TEXT,                      -- 云端Multipart ID，内部恢复用
  error_code TEXT,                             -- 安全错误码，不存原始密钥/完整异常
  created_at TEXT NOT NULL,                     -- 操作创建时间
  updated_at TEXT NOT NULL,                     -- 最后更新阶段时间
  FOREIGN KEY(owner_id, storage_object_id) REFERENCES storage_objects(owner_id, id), -- 对应对象必须存在并属于该用户
  FOREIGN KEY(owner_id, upload_id) REFERENCES upload_tasks(owner_id, id), -- 有上传任务时，必须存在并属于该用户
  FOREIGN KEY(owner_id, video_id) REFERENCES videos(owner_id, id) -- 有视频记录时，必须存在并属于该用户
); -- 结束存储操作记录表定义
CREATE INDEX stage2_storage_operation_state ON storage_operations(owner_id, state, updated_at); -- 加速查找某个用户待恢复的存储操作

-- 【保护触发器】不是额外数据表；遇到不合法修改就拒绝该语句。
-- 默认“未分类”不能归档。
CREATE TRIGGER stage2_default_category_not_archived -- 创建默认分类归档保护触发器
BEFORE UPDATE OF archived_at ON categories -- 在修改分类归档时间前检查
WHEN NEW.is_default = 1 AND NEW.archived_at IS NOT NULL -- 如果修改后的记录是默认分类且设置了归档时间
BEGIN -- 开始触发器执行内容，不是另一个数据库事务
  SELECT RAISE(ABORT, 'default category cannot be archived'); -- 拒绝这次修改，报错“默认分类不能归档”
END; -- 结束该触发器定义

-- 对象身份不能因改分组/标签或换默认Bucket而被悄悄重定位。
CREATE TRIGGER stage2_storage_identity_immutable -- 创建对象身份固定触发器
BEFORE UPDATE OF owner_id, provider, bucket, region, object_key ON storage_objects -- 修改对象归属或位置前检查
WHEN OLD.owner_id IS NOT NEW.owner_id OR OLD.provider IS NOT NEW.provider OR OLD.bucket IS NOT NEW.bucket -- 如果归属、存储服务或Bucket发生变化
  OR OLD.region IS NOT NEW.region OR OLD.object_key IS NOT NEW.object_key -- 或者地域、对象Key发生变化
BEGIN -- 开始触发器执行内容
  SELECT RAISE(ABORT, 'storage identity is immutable; register a new object'); -- 拒绝重定位；新位置应另登记对象
END; -- 结束该触发器定义

-- 版本只能在首次核验前绑定，核验成功后不能改成另一个版本。
CREATE TRIGGER stage2_storage_version_pinned -- 创建对象版本固定触发器
BEFORE UPDATE OF version_id ON storage_objects -- 修改对象版本号前检查
WHEN OLD.version_id IS NOT NEW.version_id -- 如果版本号真的发生了变化，包括NULL与非NULL之间变化
  AND NOT (OLD.version_id IS NULL AND OLD.verification_status = 'pending' AND OLD.verified_at IS NULL) -- 仅允许尚未核验且未绑定版本的对象首次绑定
BEGIN -- 开始触发器执行内容
  SELECT RAISE(ABORT, 'verified object version cannot change'); -- 拒绝更换已绑定或已核验的对象版本
END; -- 结束该触发器定义

-- 核验过的对象不能清除核验标记，绕过版本固定规则。
CREATE TRIGGER stage2_storage_verification_not_reset -- 创建核验记录保护触发器
BEFORE UPDATE OF verification_status, verified_at ON storage_objects -- 修改核验状态或时间前检查
WHEN OLD.verified_at IS NOT NULL AND (NEW.verified_at IS NULL OR NEW.verification_status = 'pending') -- 如果已核验对象被清除时间或退回待核验状态
BEGIN -- 开始触发器执行内容
  SELECT RAISE(ABORT, 'verified object cannot return to unbound pending state'); -- 拒绝清除核验记录，防止绕过版本保护
END; -- 结束该触发器定义

-- 全部语句成功后提交；如果前面有错误，不要单独执行本行。
COMMIT; -- 提交前面全部建表、索引和触发器，提交成功才算结构创建完成

-- 【执行后的只读检查】查询返回结果，不会插入/修改数据。
SELECT name AS table_name -- 查询表名，并把结果列显示为table_name
FROM sqlite_master -- 从SQLite保存表、索引和触发器定义的系统目录查询
WHERE type = 'table' AND name NOT LIKE 'sqlite_%' -- 只列出业务/迁移表，排除SQLite内部表
ORDER BY name;                   -- 应有上面目录列出的24张表
PRAGMA foreign_key_check;       -- 正常应返回0行（没有外键错误）
PRAGMA integrity_check;         -- 正常应返回ok

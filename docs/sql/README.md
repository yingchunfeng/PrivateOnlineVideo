# SQLite 完整建表与已有库升级说明

## 当前新部署入口（2026-10-26）

**新空库只执行 [NEW_INSTALL_FULL.sql](NEW_INSTALL_FULL.sql) 这一份即可。** 已合并 0001～0006 的最终结构，包含 37 张表、正确迁移账本与邮箱类型种子，不包含账号或密钥。导入后按[新部署指南](../NEW_INSTALL.md)启动首次安装向导，使用默认密码和本机一次性安装码设置新账号。

不得在现有数据库执行全量 SQL，不需要再执行旧 SQL 或 `account:init`。导出一致性及重复导入拒绝有自动化测试；生成器 `npm run db:export-full -w @online-video/api` 默认仅输出 SQL，`--output` 仅创建不存在的新文件。旧 v5 继续通过原入口运行，不自动迁移。下文为历史结构/迁移记录，并非新部署操作步骤。

2026-10-04 多邮箱更新：最新迁移链追加 [0005-smtp-providers.sql](../../apps/api/src/db/migrations/0005-smtp-providers.sql)，结构为 v5/32 表，新增支持类型和多账号配置表，保留旧 SMTP 表。授权码只通过 [本地配置命令](../SMTP_PROVIDERS.md) 加密写入，不能放进 SQL。

2026-10-04 SMTP 更新：最新应用结构为 0001 → 0002 → 0003 → [0004-smtp-config.sql](../../apps/api/src/db/migrations/0004-smtp-config.sql)，共 30 张表；0004 只追加 SMTP 表。历史空库脚本仍为 v2，不用于重建正式库。授权码不得写进 SQL，使用 [SMTP 配置命令](../SMTP.md) 加密保存。

2026-10-04 账号邮箱认证新增源码版本 3；[0003-account-email.sql](../../apps/api/src/db/migrations/0003-account-email.sql) 为单独追加迁移。下文和 `01_EMPTY_DATABASE_FULL.sql` 保留第二阶段 v2 的历史结构说明，最新应用结构应通过 0001 → 0002 → 0003 迁移获得；不把手工空 ledger 当成正式库，不对既有正式库执行完整建表脚本。本轮不升级正式库，授权与一致性备份方案见 [账号邮箱实现记录](../ACCOUNT_EMAIL_IMPLEMENTATION.md)。

**2026-10-02最新：用户授权正式目标备份升级后，主控已执行0002，正式 `.local/data/video-library.db` 为25表/版本2/users=1，旧13表旧列SHA和计数保留，integrityok/fk0。** `sqlite-test.db` 仍24表/users=0/ledger为空，不再建表或升级。实际备份及验证报告见[后端交接](../archive/STAGE2_BACKEND_HANDOFF.md)。

[01_EMPTY_DATABASE_FULL.sql](01_EMPTY_DATABASE_FULL.sql)只用于另一个新空库或阅读结构：从users开始建24表，每行中文注释；以下Navicat步骤保留为新空库操作说明，不用于重建现有库。

| 文件 | 适用场景 | 第一条建表/变更语句 |
| --- | --- | --- |
| [01_EMPTY_DATABASE_FULL.sql](01_EMPTY_DATABASE_FULL.sql) | 在新空 SQLite 库中建立完整结构，阅读和手工验证设计 | `CREATE TABLE users` |
| [STAGE2_PENDING.sql](STAGE2_PENDING.sql) | 下一阶段给已有版本 1 库升级，需先接入迁移器 | `ALTER TABLE categories` |

之前报 `no such table: categories`，是因为在空库执行了已有库升级语句；空库尚未有 `categories` 表。完整脚本直接定义归档/名称键和播放模式等新字段，无需叠加升级块。2026-10-02开发后此脚本更新为25表；用户已建的24表手工库仍不动。

## Navicat 从数据库文件开始

1. 使用 **SQLite** 连接。SQLite 的一个 `.db` 文件就是一个数据库，没有 `CREATE DATABASE` 或 `USE` 语句；新库通过数据库工具打开/创建新文件。
2. `E:\onlineVideo\sqlite-test.db` 早先为空，现在已经由用户建好结构，不再作为本次建表目标。若另外练习，指定一个新的、独立的空 `.db` 文件。
3. 在这个连接打开查询窗口，载入 `01_EMPTY_DATABASE_FULL.sql`，从头到尾运行全部。不要只选中某一条执行，也不要再运行 `STAGE2_PENDING.sql`。
4. 关闭“遇错继续”（如果工具提供此选项）。脚本用事务建表；若出错，应停止后续执行，在同一连接执行 `ROLLBACK;`，保留错误原文再排查。
5. 仅对另一个新空库执行新版时应看到25表；现有手工24表不是升级目标。脚本末尾检查外键和数据库完整性。

脚本只建结构，不插入用户或分类数据。因此建好后 `users` 等表为空是正常现象。真实账号需要应用初始化命令生成密码哈希、TOTP 密文等资料，不能往字段里直接填明文密码。现有正式库已经有本人账号，不用重新建表或创建账号，账号说明见 [ACCOUNT.md](../ACCOUNT.md)。

**当前源码和正式库均为有序版本1/2，正式授权迁移已完成。** 手工结构库ledger仍为空，不能直接作为应用库或伪造记录。不要将完整脚本执行到正式库；已有库新增迁移始终需明确授权和一致性备份。

## SQLite 常用写法

| 写法 | 含义 |
| --- | --- |
| `-- 中文说明` | SQL 注释；SQLite 不使用 MySQL 的字段 `COMMENT` 或达梦的 `COMMENT ON TABLE` |
| `TEXT / INTEGER / REAL` | 字符串 / 整数 / 小数；本项目用字符串保存 UUID 和 UTC 时间 |
| `PRIMARY KEY / UNIQUE` | 主键 / 唯一约束，防止记录或指定字段组合重复 |
| `NOT NULL / DEFAULT / CHECK` | 必须有值 / 省略时的默认值 / 数据必须满足的检查规则 |
| `REFERENCES / FOREIGN KEY` | 外键，要求关联记录存在；复合外键还能核验归属 |
| `CREATE INDEX / CREATE TRIGGER` | 创建查询索引 / 创建自动检查特定操作的触发器 |
| `PRAGMA foreign_keys = ON` | 启用当前连接外键检查，每个新连接需分别启用 |
| `BEGIN IMMEDIATE / COMMIT` | 开始写事务 / 全部成功后提交 |

如需单独核对连接、表和字段，下面都是只读语句：

```sql
SELECT sqlite_version(); -- 查看SQLite引擎版本
PRAGMA database_list; -- 查看当前连接实际使用的.db文件路径
SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name; -- 查看当前库的表名
PRAGMA table_info(users); -- 查看用户表字段；空结果表示该表尚不存在
PRAGMA table_info(categories); -- 查看分类表字段及archived_at是否已建好
```

历史准备阶段先在`:memory:`验证，随后用户手工库建24表；开发时只读核验该库无账号/ledger、正式库当时版本1。此历史证据保留，最新正式授权升级至版本2见顶部；手工库始终未被本轮修改。

历史手工版本曾验证24表。新版完整脚本已在内存验证25表，列/类型/外键与0001+0002及Drizzle逐表对照通过，SQL提案与0002规范化LF的SHA相同。隔离证据与实际正式迁移分开：正式迁移现另有授权/一致性备份及验证报告；手工库未升级。

## 已有持久化

| 功能 | 当前表与内容 |
| --- | --- |
| 账号/登录安全 | users：Argon2id 密码哈希、TOTP 密文、验证码防重放计数；login_sessions：Cookie 摘要、过期/撤销/活动时间 |
| 恢复与审计 | recovery_codes、login_attempts、audit_events，保留失效历史，不存明文密码、Cookie 或恢复码 |
| 主分类/视频 | categories、videos.category_id；标题、大小、编码/分辨率/状态及原片/播放/封面 key |
| 上传/观看/计量 | upload_tasks、upload_parts、watch_progress、playback_sessions、usage_counters、transfer_reservations |
| 迁移记录 | schema_migrations：版本、规范化 LF 后的 SQL SHA-256、执行时间 |

应用版本 1 的原始迁移为 [0001-initial.sql](../../apps/api/src/db/migrations/0001-initial.sql)，已执行的文件不能修改。逐行中文说明请看上面的完整建表脚本。现有正式库已经初始化并有本人账号，不能通过重复建表或重新 INSERT 账号来升级。新环境使用 account:init 生成可靠哈希、TOTP 密文、密钥和恢复资料，不把秘密写进版本库的 SQL。

## 下一阶段新增

- categories 增加 archived_at；未分类默认分类不可归档。
- library_groups、tags：本人创建的分组和标签，名称规范化键唯一、软归档。
- video_group_links、video_tag_links：一个视频可属于多个分组、有多个标签；removed_at 软解绑，不永久删除记录。
- upload_group_links、upload_tag_links：上传前选择的组织信息持久化，续传后仍以服务端记录为准。
- storage_objects：provider、Bucket、地域、object_key、可选版本、大小/ETag/类型及校验状态。
- video_assets、upload_storage_objects：把视频/上传任务与对象定位关联；原片、播放版本和封面分别管理。
- storage_operations：记录 OSS/数据库之间的准备、Multipart、对象完成、登记及失败阶段，避免把进度条或 SDK Location 当完整登记成功。
- source_authorizations及playback_sessions.mode/source_expires_at：无秘密签发/续签/下载审计与模式；OSS实际字节仍null/未同步。
- categories.name_key：应用在迁移immediate事务内按NFKC/trim/小写生成，名称冲突回滚而不清理；默认分类保护不变。

这些标签/分组是**应用数据库的组织信息**，与 OSS Object Tagging、对象前缀不同。修改名称/分组/标签只更新关系，不移动、复制、覆盖或删除 OSS 原片。标签名称由应用按 NFKC + trim + 大小写规范化生成 name_key；SQLite 本身不负责完整 Unicode 规范化。

## 执行顺序（交给下一对话的子代理 1）

1. 读取当前源码/实际库状态，明确正式目标与当前 ledger，保留账号、分类、视频和上传历史。不要读取或输出实际秘密；sqlite-test.db 永远不作为目标，用户打开的数据库工具/占用进程不强制关闭。
2. 已接入新增 `0002-library-organizing.sql`、Drizzle、DTO/Repository/装配；0001内容与校验未改。0002仅DROP旧key唯一索引，保留列与数据，以全局完整对象身份/原片资产唯一性代替；正式授权需涵盖该DDL。
3. 已实现有序版本清单、已执行SHA核验和未知/跳号/超前拒绝；SQL、名称规范化、ledger与一致性检查同事务完成，冲突回滚。
4. 在隔离内存库/新测试库验证升级、完整性、复合外键、重启、名称唯一性、对象版本绑定和软解绑，并证明旧账号/会话/视频记录保留。正式库的额外唯一索引若发现现有数据不一致，停止并报告，不自动清理。
5. 已提供正式目标/SQL/一致性备份/副本验证，用户具体授权后主控通过db:migrate执行新增0002（不盲贴STAGE2文本）。实际备份 `.local/backups/before-migration-1790950813946-71816f51-c74c-4667-a682-782f49db3d0d.db` 及同名verification报告证明v2、旧列SHA保留、fk0/integrityok。
6. 旧videos的key不删除；Bucket/版本未确认保持legacy，真实OSS拒绝读取，不默认指向配置的新Bucket。完整交接及实际已验/待验见[后端交接](../archive/STAGE2_BACKEND_HANDOFF.md)。

SQL不写事务边界或ledger插入，由迁移器统一immediate事务执行DDL/校验记录。正式库已按授权执行新增0002；该事实不授权手工库重建、GUI盲贴、后续迁移或云权限变更。

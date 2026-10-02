# SQLite 完整建表与已有库升级说明

**你的 `sqlite-test.db` 是空库，请使用 [01_EMPTY_DATABASE_FULL.sql](01_EMPTY_DATABASE_FULL.sql)。** 它从 `users` 用户表开始，一次建立全部 24 张表，包括登录、视频、分类、分组、标签及 OSS 对象管理。每一行 SQL 都有中文注释，文件开头有数据库文件创建步骤和常用语法说明。

| 文件 | 适用场景 | 第一条建表/变更语句 |
| --- | --- | --- |
| [01_EMPTY_DATABASE_FULL.sql](01_EMPTY_DATABASE_FULL.sql) | 在新空 SQLite 库中建立完整结构，阅读和手工验证设计 | `CREATE TABLE users` |
| [STAGE2_PENDING.sql](STAGE2_PENDING.sql) | 下一阶段给已有版本 1 库升级，需先接入迁移器 | `ALTER TABLE categories` |

之前报 `no such table: categories`，是因为在空库执行了已有库升级语句；空库尚未有 `categories` 表。完整脚本直接在创建分类表时定义 `archived_at`，无需先运行旧升级文件。

## Navicat 从数据库文件开始

1. 使用 **SQLite** 连接。SQLite 的一个 `.db` 文件就是一个数据库，没有 `CREATE DATABASE` 或 `USE` 语句；新库通过数据库工具打开/创建新文件。
2. 你现有的 `E:\onlineVideo\sqlite-test.db` 已只读检查为空库，可以作为本次完整建表目标。若另外练习，可指定一个新的、独立的 `.db` 文件。
3. 在这个连接打开查询窗口，载入 `01_EMPTY_DATABASE_FULL.sql`，从头到尾运行全部。不要只选中某一条执行，也不要再运行 `STAGE2_PENDING.sql`。
4. 关闭“遇错继续”（如果工具提供此选项）。脚本用事务建表；若出错，应停止后续执行，在同一连接执行 `ROLLBACK;`，保留错误原文再排查。
5. 成功后刷新连接中的表列表，应看到 24 张表。脚本末尾还会检查外键和数据库完整性。

脚本只建结构，不插入用户或分类数据。因此建好后 `users` 等表为空是正常现象。真实账号需要应用初始化命令生成密码哈希、TOTP 密文等资料，不能往字段里直接填明文密码。现有正式库已经有本人账号，不用重新建表或创建账号，账号说明见 [ACCOUNT.md](../ACCOUNT.md)。

**当前应用仅支持版本 1，这份包含第二阶段结构的手工建表库暂不能直接作为应用运行库。** 正式升级由下一阶段接入版本 2 迁移器后完成；不要将完整脚本执行到 `.local/data/video-library.db`，也不要自行填写虚假迁移版本。

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

没有对 `sqlite-test.db` 或现有账号库执行建表、插入或迁移；验证仅在 `:memory:` 内存 SQLite 中进行。

完整脚本已验证：24张表、14个显式索引、4个触发器全部创建成功；与原0001加第二阶段升级后的结构一致。逐行注释检查、关键唯一/外键/对象保护约束、`foreign_key_check` 和 `integrity_check` 均通过。

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

这些标签/分组是**应用数据库的组织信息**，与 OSS Object Tagging、对象前缀不同。修改名称/分组/标签只更新关系，不移动、复制、覆盖或删除 OSS 原片。标签名称由应用按 NFKC + trim + 大小写规范化生成 name_key；SQLite 本身不负责完整 Unicode 规范化。

## 执行顺序（交给下一对话的子代理 1）

1. 读取当前源码/实际库状态，明确正式目标与当前 ledger，保留账号、分类、视频和上传历史。不要读取或输出实际秘密；sqlite-test.db 永远不作为目标，用户打开的数据库工具/占用进程不强制关闭。
2. 把待执行块审核后作为新增 `apps/api/src/db/migrations/0002-library-organizing.sql`，同步 Drizzle 映射、DTO、Repository 和运行装配；不能修改 0001 的已执行内容或校验。
3. 将当前只支持版本 1 的 database.ts/migrate-cli.ts 升级为有序的版本清单，验证所有已执行校验、拒绝未知/超前版本。新 SQL、同事务 ledger(version=2,checksum,applied_at) 全部成功才能提交；不能用 IF NOT EXISTS 掩盖不一致或伪造 checksum。
4. 在隔离内存库/新测试库验证升级、完整性、复合外键、重启、名称唯一性、对象版本绑定和软解绑，并证明旧账号/会话/视频记录保留。正式库的额外唯一索引若发现现有数据不一致，停止并报告，不自动清理。
5. 提供具体目标、SQLite 一致性备份、新 SQL 与验证结果，用户授权实际迁移后，才用升级后的迁移命令执行。当前 db:migrate 命令不会处理这份 STAGE2 文件。
6. 旧 videos 的 key 不删除；用户未确认其 Bucket/版本时，不推断、不自动回填成真实对象，也不默认转到新 Bucket。完成受控位置回填后再读取媒体。

SQL 中不写事务边界或 ledger 插入，是为了由迁移器用同一 immediate 事务执行 DDL 和真实校验记录；若使用 SQLite GUI，必须先由负责人明确等价的事务/校验步骤，不能盲粘贴执行。当前没有执行命令或现有库变更。

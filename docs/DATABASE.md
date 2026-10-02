# CORE-02：SQLite 与 Repository

2026-10-02 下一阶段增量计划见 [SQL说明](sql/README.md) 和 [STAGE2_PENDING.sql](sql/STAGE2_PENDING.sql)。当前只支持版本1，尚未应用增量，不要直接在现有库执行这份待接入脚本。

使用 Navicat 在新空库中手工建结构/学习，请用 [完整建表 SQL（每行中文注释）](sql/01_EMPTY_DATABASE_FULL.sql)。SQLite 通过打开/创建 `.db` 文件建库，没有 `CREATE DATABASE`；该脚本从用户表开始包含全部24张表，不用于覆盖现有账号库，也不直接作为当前版本应用库。

本项目使用 `drizzle-orm@0.45.3` + `better-sqlite3@13.0.3`，Node.js 22.21.1 已实际加载 SQLite 3.53.4。SQLite CLI、Docker/MySQL/Redis 均不是本地前提。

正式库默认位于项目 `.local/data/video-library.db`，不会使用 `sqlite-test.db`。`.local/` 整体不纳入 Git，包含本地数据库、密钥、账号交接、备份和隔离测试产物；不对外作为静态目录发布。

结构映射在 `apps/api/src/db/schema.ts`，实际迁移 SQL 为 `apps/api/src/db/migrations/0001-initial.sql`。SQL 是版本化执行来源，schema.ts 为 Drizzle 类型映射；后续结构变化必须添加新迁移，不能修改已执行版本。ledger 保存版本、UTC 时间和 SHA-256（换行统一 LF 后计算，适配 Git/Windows），校验不符拒绝启动。没有删除、重建或自动回退迁移。

表：users（唯一本人账户）、login_sessions、categories、videos、upload_tasks、upload_parts、watch_progress、playback_sessions、usage_counters、transfer_reservations、audit_events、recovery_codes、login_attempts。字节安全整数、状态/单人约束、对象/分片唯一性和外键由 SQL 约束。TOTP 以密文保存；Cookie 原值不存库；恢复码保存高熵随机码的摘要。数据库不存视频文件。

`openDatabase` 不创建不存在的文件，不在服务启动时迁移。首次创建由账号初始化 CLI 显式执行；重复初始化拒绝已有库。路径必须是项目 .local 下的 .db，拒绝测试库、外部目录和越界父目录。未知既有库也拒绝初始化。未来服务器数据路径需在部署时明确授权与适配，本轮不处理部署。

现有正式库后续有新迁移时，需由用户在明确目标、备份及授权后调用：

```powershell
npm run db:migrate -w @online-video/api -- --database E:\onlineVideo\.local\data\video-library.db --apply
```

命令通过 SQLite backup API 保存全新的 `.local/backups/before-migration-*.db`，不覆盖旧备份；再执行事务迁移。没有删除或回滚命令。恢复时先停止使用目标库、保留现有库，再将已验证备份作为新的目标做完整性/版本检查；不能直接覆盖在线库。账号密钥必须与数据库一同保管，否则无法解密 TOTP。未对用户原库运行此命令。

`createRepositories(database, now)` 实现所有媒体契约：分类归属预检、原对象登记原子幂等（不覆盖原条目）、分片冲突校验/状态 CAS、按登录会话绑定的原子播放并发、实际传输计量预留及幂等结算。SQLite immediate 事务和唯一性约束保证多个连接竞争不突破限额。上传同实例 finalizing 完成恢复不等于多进程任务互斥；多 API 实例的 Multipart 完成仍需任务租约。

字节预留持久化，在途也占额度；发生进程崩溃时不自动释放/清零未结算预留，保守占用原统计周期，避免重启绕过预算。需后续根据实际输出审计人工结算；未声称其数值等同最终云账单。关闭或撤销登录会话的播放不计活动并发，过期会话通过条件查询自然失效，不清理历史记录。

无外部副作用的可替换测试入口仍可用：`apps/api/test/helpers/media-dependencies.ts`（失败安全替身）及 `apps/api/test/media/fakes.ts`（明确内存 Fake）。真实 SQL 验证另外使用 :memory: 或 .local/tests 下新建的测试库，两者不能混记。新增测试验证迁移/路径边界、SQL 单人约束、所有权/幂等/CAS、两个 SQLite 连接竞争及重启持久化，保留所有隔离测试产物。

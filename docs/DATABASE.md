# CORE-02：SQLite 与 Repository

2026-10-02 第二阶段源码支持有序版本1/2。**正式库已授权备份升级版本2/25表，账号仍1个；实云/业务登记后2视频/2上传/1分组/2标签、完整性ok/fk0，正常重启后库和兼容视频2秒进度恢复。** 账号静态密码/TOTP与10条恢复摘要保留，正常登录/审计/进度允许增加；手工库未改。实云后端只读及浏览器证据见[交接](STAGE2_BACKEND_HANDOFF.md)，最终网站/安卓/服务器部署另属第三阶段。

使用 Navicat 在另一个新空库中学习结构，可阅读 [完整建表 SQL](sql/01_EMPTY_DATABASE_FULL.sql)，现已同步25张表；现有 `sqlite-test.db` 仍保留此前24表、空账号/空ledger，不再执行脚本。手工结构不填写假ledger，不直接作为应用目标；实际新应用库使用有序迁移器和受保护初始化。

本项目使用 `drizzle-orm@0.45.3` + `better-sqlite3@13.0.3`，Node.js 22.21.1 已实际加载 SQLite 3.53.4。SQLite CLI、Docker/MySQL/Redis 均不是本地前提。

正式库默认位于项目 `.local/data/video-library.db`，不会使用 `sqlite-test.db`。`.local/` 整体不纳入 Git，包含本地数据库、密钥、账号交接、备份和隔离测试产物；不对外作为静态目录发布。

结构映射在 `apps/api/src/db/schema.ts`，版本化SQL为未修改的 `0001-initial.sql` 和新增 `0002-library-organizing.sql`。迁移器拒绝未知/跳号/超前版本与哈希差异；新DDL、NFKC名称规范化、版本/SHA记录及完整性检查在同一 immediate 事务提交，冲突全部回滚。0002仅移除 `videos_owner_object` 旧key唯一索引，保留原列和数据，以完整对象身份/原片资产唯一性代替，未删除表或数据。

表：users（唯一本人账户）、login_sessions、categories、videos、upload_tasks、upload_parts、watch_progress、playback_sessions、usage_counters、transfer_reservations、audit_events、recovery_codes、login_attempts。字节安全整数、状态/单人约束、对象/分片唯一性和外键由 SQL 约束。TOTP 以密文保存；Cookie 原值不存库；恢复码保存高熵随机码的摘要。数据库不存视频文件。

`openDatabase` 不创建不存在的文件，不在服务启动时迁移。首次创建由账号初始化 CLI 显式执行；重复初始化拒绝已有库。路径必须是项目 .local 下的 .db，拒绝测试库、外部目录和越界父目录。未知既有库也拒绝初始化。未来服务器数据路径需在部署时明确授权与适配，本轮不处理部署。

现有正式库后续有新迁移时，需由用户在明确目标、备份及授权后调用：

```powershell
npm run db:migrate -w @online-video/api -- --database E:\onlineVideo\.local\data\video-library.db --apply
```

命令通过SQLite backup API保留新一致性快照，再事务迁移，不覆盖旧备份或重建账号。2026-10-02实际备份为 `.local/backups/before-migration-1790950813946-71816f51-c74c-4667-a682-782f49db3d0d.db`，同名 `.db.verification.json` 记录正式v2/旧数据保留true/integrityok/fk0/手工库保留true；0001/0002 SHA未变。恢复时只把已验证备份作为新的独立目标，保留原库，不覆盖在线库；auth.key单独匹配保管。

`createRepositories(database, now)` 返回组织、对象、catalog、progress及媒体四仓储。组织名按NFKC/trim/小写唯一；关联软解绑、默认分类不可归档。上传先保存组织快照/唯一对象/操作，再初始化Multipart；`finishRegistration` 同事务绑定视频、对象资产、组织、任务完成及操作记录。原片按完整位置全局唯一并防跨owner登记，已核验位置/版本固定。旧key未确认Bucket时保留legacy，真实OSS拒绝读取。多 API 实例 Multipart 完成仍需任务租约，当前按单API实例运行。

`playback_sessions.mode/source_expires_at` 与 `source_authorizations` 保存无秘密授权审计。SQL不存完整签名URL。签发/续签/下载在事务中重查登录与关闭状态并持久频控；oss真实字节为空/未同步、应用会话不代表OSS连接数。退出仅阻止后续授权，已发URL可能继续到实际有效期；proxy继续真实字节预留/结算。

本轮检查命令：API typecheck/test/build；主控API61/61历史证据与后端7项隔离SQL检查保留（最终新增修正由主控统一rootcheck，不重复无改动测试）。真实STS/OSS授权验收另有两private上传/匿名403/V4 Range206/权限收窄/List/完整下载/同session自动续签/退出边界/正常重启报告，本机FFprobe9.0.2亦真实分析。最终readonly报告再核账号静态资料/10恢复摘要保留、2completed任务/2registered操作、19授权实际字节null与兼容1条2秒进度；最终生产/安卓/内网归第三阶段。

字节预留持久化，在途也占额度；发生进程崩溃时不自动释放/清零未结算预留，保守占用原统计周期，避免重启绕过预算。需后续根据实际输出审计人工结算；未声称其数值等同最终云账单。关闭或撤销登录会话的播放不计活动并发，过期会话通过条件查询自然失效，不清理历史记录。

无外部副作用的可替换测试入口仍可用：`apps/api/test/helpers/media-dependencies.ts`（失败安全替身）及 `apps/api/test/media/fakes.ts`（明确内存 Fake）。真实 SQL 验证另外使用 :memory: 或 .local/tests 下新建的测试库，两者不能混记。新增测试验证迁移/路径边界、SQL 单人约束、所有权/幂等/CAS、两个 SQLite 连接竞争及重启持久化，保留所有隔离测试产物。

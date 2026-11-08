# CORE-02：SQLite 与 Repository

> **2026-11-08 首页排序更新：源码最新为 v9（42 表），新空库完整 SQL 包含 0001～0009 和匹配账本。** [0009-homepage-settings.sql](../apps/api/src/db/migrations/0009-homepage-settings.sql) 新增 `homepage_settings`，按资料库所有者保存分类随机优先开关、全部视频的手动顺序、版本号与更新时间。默认开启算法，读取默认值不写库；写入原子校验配置版本与当前视频 ID 集合。既有 v5～v8 可继续启动，缺表时保留旧排序且禁用保存；没有自动升级或修改任何现有业务库。以下 v8 等说明为历史记录。

手工升级已有 v8 库使用 [UPGRADE_V8_TO_V9.sql](sql/UPGRADE_V8_TO_V9.sql)，其中包含旧版本/校验验证、原始 0009 迁移和第 9 条账本追加，不能只运行原始建表片段。执行前须停服务、核对目标并完成一致性备份，具体边界见 [SQL 说明](sql/README.md#已有-v8-库升级到-v9)。

> **2026-11-02 管理页面与访客更新：源码最新为 v8（41 表），新空库完整 SQL 已包含 0001～0008 和匹配账本。** [0007-site-settings.sql](../apps/api/src/db/migrations/0007-site-settings.sql) 新增 `site_settings`，保存默认登录外观和单文件上传上限；[0008-guests.sql](../apps/api/src/db/migrations/0008-guests.sql) 新增 `guests`、`guest_sessions`、`guest_uploads`，保存访客密码摘要、会话关联和任务归属。既有 v5/v6/v7 库可兼容启动，但缺表时不开放对应持久化写入；服务不自动迁移。本次提交未执行正式库升级，已有库不得导入新空库完整 SQL，须先另行核对目标、备份并授权增量迁移。当前流程见[新部署指南](NEW_INSTALL.md)与[数据库切换说明](DATABASE_SWITCHING.md)，以下保留各历史版本记录。

> **2026-10-26 新部署更新：源码新增 v6（37 表），完整新空库使用 [NEW_INSTALL_FULL.sql](sql/NEW_INSTALL_FULL.sql)，不再逐份执行旧 SQL。** v6 仅增加安装状态、独立认证方式、安装会话/配置及邮箱开关挑战表，0001～0005 保持原校验。旧 v5 通过原入口兼容运行，不自动升级；本轮没有改动原正式库。新库及配套密钥如何启动见[新部署指南](NEW_INSTALL.md)，下文为历史升级记录。

2026-10-04 多邮箱更新：源码与正式库已为 v5/32 表，用户单独授权后已备份追加 `smtp_provider_types`、`smtp_provider_configs`，并保存 163 配置。旧 `smtp_config` 保留，QQ 配置、旧表业务记录及原密钥保持一致，两套授权码均加密保存。迁移、配置和验证证据见 [QQ 与 163 邮箱支持](SMTP_PROVIDERS.md)；服务启动仍不自动迁移。

2026-10-04 SMTP 更新：源码新增 [0004-smtp-config.sql](../apps/api/src/db/migrations/0004-smtp-config.sql)，只追加单条站点 SMTP 配置表，授权码加密保存。用户明确授权后正式库已备份升级为 v4/30 张表并保存配置；旧表业务记录、原密钥、手工库和旧迁移校验保持一致。配置、备份与验证见 [SMTP 数据库配置](SMTP.md)。下文保留先前版本的历史验收记录。

2026-10-04 07:34 UTC 授权升级补充：正式目标 `E:/onlineVideo/.local/data/video-library.db` 已先使用 SQLite backup API 新建一致性备份，再从 v2 升级到 v3。ledger 1/2/3 校验一致，29 张表，原有 25 张表全部旧列/记录校验一致；integrity_check=ok、外键异常 0。账号 1、恢复码 10、视频 8 均保留。证据本地保留于 `docs/ACCOUNT_EMAIL_IMPLEMENTATION.md` 的正式 v3 升级段落。原开发阶段与 v1/v2 历史记录保留。

2026-10-04 新增账号认证版本 3：仅追加 [0003-account-email.sql](../apps/api/src/db/migrations/0003-account-email.sql)，保留原 0001/0002 内容和校验和。users 增邮箱、验证时间、认证方式与版本；会话记录版本；新增持久验证码、账号操作、发码额度和安全通知状态表。旧账号默认保持 TOTP；正式库本轮未升级，启动仍拒绝旧版本而不自动迁移。设计、隔离验收及授权升级方案本地保留于 `docs/ACCOUNT_EMAIL_IMPLEMENTATION.md`。下文原 v1/v2 验收记录保留。

2026-10-02 第二阶段源码支持有序版本1/2。**正式库已授权备份升级版本2/25表，账号仍1个；实云/业务登记后2视频/2上传/1分组/2标签、完整性ok/fk0，正常重启后库和兼容视频2秒进度恢复。** 账号静态密码/TOTP与10条恢复摘要保留，正常登录/审计/进度允许增加；手工库未改。实云后端只读及浏览器证据本地保留于 `docs/archive/STAGE2_BACKEND_HANDOFF.md`，最终网站/安卓/服务器部署另属第三阶段。

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

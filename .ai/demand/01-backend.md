# 子代理 1：后端基础与业务

日期：2026-09-30  
当前状态：CORE-01～03 已完成；独立正式库与本人账号已按用户授权创建并验证，CORE-04～06 未启动

## 0. 模块设计/数据库文件清单

- 产品依据：[PRD](../../PRD.md)。
- 总看板：[TASKS](../../TASKS.md)。
- 接口依据：[API_CONTRACT](../../docs/API_CONTRACT.md)。
- 本代理范围：负责工程初始化、共享类型、SQLite Repository、单人登录、分类及视频元数据、观看记录和安全设置。先完成 CORE-01，再按依赖顺序逐卡实施。
- 可写范围：根目录工程配置、packages/shared/、apps/api/package.json、apps/api/src/core/、apps/api/src/db/、apps/api/src/modules/auth/、catalog/、progress/、settings/、API 注册入口和对应测试。
- 数据边界：规划表：users、login_sessions、categories、videos、upload_tasks、upload_parts、watch_progress、playback_sessions、usage_counters、audit_events。实际 schema 在 CORE-02 登记，现有 sqlite-test.db 不作为目标。
- 新模块和迁移路径在真正创建后追加登记；除下列 CORE-01 已创建路径外，其他源码路径仍为规划路径。
- CORE-01 已创建：`packages/shared/`（公开 DTO/状态/错误）；`apps/api/src/core/`（配置、错误、监听与服务端契约）、`apps/api/src/app.ts`、`server.ts`；`apps/api/test/`（骨架验证与失败安全的测试替身）。没有创建数据库或迁移。
- CORE-01 交接：[CORE01_HANDOFF](../../docs/CORE01_HANDOFF.md)，已冻结并同步 [API_CONTRACT V0.2](../../docs/API_CONTRACT.md)。
- CORE-02 已创建：`apps/api/src/db/schema.ts`、`database.ts`、`repositories.ts`、`migrations/0001-initial.sql`、`migrate-cli.ts`；说明 [DATABASE](../../docs/DATABASE.md)。目标为独立 `.local/data/video-library.db`，不使用 sqlite-test.db。
- CORE-03 已创建：`apps/api/src/modules/auth/`（加密、设置、AuthGuard、路由、运行装配、本地初始化/恢复 CLI）、`apps/api/test/auth.test.ts`；说明 [ACCOUNT](../../docs/ACCOUNT.md)。正式库、auth.key 和账号资料位于 Git 排除的 .local，实际密码/密钥不记录到本任务板。

## 1. 默认协作规则

- 继承用户全局规则和 TASKS.md。不修改 apps/web/ 或 media 模块内部。apps/web/package.json 由子代理 3 负责；共享依赖安装及 package-lock.json 由你或主控串行更新。不要实施服务器部署或 B 方案。
- 每次完整读取当前任务卡；依赖未完成时先处理独立设计或 Fake/Mock，不伪造完成。
- 只回写自己的任务板，不改总看板和其他代理任务板。
- 开始实际实施才设 DOING；完成真实验证后设 DONE。完成说明区分已验证和待外部环境验证。
- 真实数据库写入、迁移执行、云权限调整、删除及配置覆盖遵守用户确认规则，不把编写代码当作对真实数据操作的授权。
- 任务只涉及本地开发，服务器部署和 B 模式留待后续。
- 使用 UTF-8 无 BOM，最小修改，保留其他代理的工作。

## 2. 任务总览

| ID | 状态 | 任务 |
| --- | --- | --- |
| CORE-01 | DONE | 工程骨架与公共契约 |
| CORE-02 | DONE | SQLite schema 与 Repository |
| CORE-03 | DONE | 单人账户、TOTP 与会话 |
| CORE-04 | TODO | 分类、视频元数据与搜索 |
| CORE-05 | TODO | 观看记录、会话与用量接口 |
| CORE-06 | TODO | 模块装配与后端交付 |

## 3. 任务卡

### CORE-01：工程骨架与公共契约

- 状态：DONE
- 优先级：P0
- 前置依赖：无
- 需求描述：让三个代理有共同的工作区、类型和媒体接入接口，避免分别创建互不兼容的项目。
- 实现要求：
  - 建立 npm workspaces、后端 TypeScript 配置及健康检查；前端工作区仅约定路径，不覆盖子代理 3 已创建的文件。
  - 落实 docs/API_CONTRACT.md 的 DTO、状态、错误码、AuthGuard、Repository 和媒体注册约定；将分片 checksum 算法和传递方式统一到可编译类型。
  - 配置本地 Mock 存储模式和端口，检查端口占用，不强制终止其他进程。
  - 向子代理 2、3 交接类型路径、注册签名、启动命令及依赖安装方式；新增依赖与锁文件更新串行处理。
- 计划变更范围：根目录 package.json、tsconfig 基线；packages/shared/；apps/api/ 工程骨架；docs/ 的后端接口交接说明。
- 验收条件：工作区与后端基础构建可运行，health 不泄露配置；共享类型可供三个模块引用。将源码已完成的骨架与尚待实际运行的检查分别记录。
- 影响范围：根目录 npm 工作区/构建配置；共享 DTO；Fastify 后端骨架、配置/错误及媒体协作接口；API 契约与交接文档。无前端、数据库或真实 OSS 变更。
- 实际变更文件：
  - 根目录：`.gitignore`、`.npmrc`、`.env.example`、`package.json`、`package-lock.json`、`tsconfig.base.json`。
  - 共享包：`packages/shared/package.json`、`tsconfig.json`、`tsconfig.browser-check.json`、`src/index.ts`、`src/dto.ts`、`src/errors.ts`、`test/browser-consumer.ts`（上述简写均相对 packages/shared/）。
  - 后端：`apps/api/package.json`、`tsconfig.json`、`tsconfig.check.json`、`src/app.ts`、`src/server.ts`、`src/core/config.ts`、`src/core/errors.ts`、`src/core/start.ts`、`src/core/contracts/index.ts`、`repositories.ts`、`storage.ts`、`media.ts`、`test/core.test.ts`、`test/helpers/media-dependencies.ts`（contracts 简写相对该目录，其余简写相对 apps/api/）。
  - 文档：`docs/API_CONTRACT.md`、`docs/CORE01_HANDOFF.md`、`.ai/demand/01-backend.md`。安装生成 node_modules、.npm-cache；构建生成 shared/api 的 dist，未清理已有文件。
- 完成说明：
  - 建立 shared/api 的 npm 工作区、严格 TypeScript 配置和开发/检查/构建脚本；Fastify 构建与监听分离，health 仅返回公共健康状态。前端缺席时可独立安装和构建。
  - 冻结公开 DTO/状态/分页/错误、逐片 SHA-256 小写 hex 与请求头、限额 null 的消歧及服务端接口/媒体注入；缺鉴权、未配置限额或生产安全依赖未交付时明确拒绝，不连接真实 OSS。
  - 实际安装成功（57 个包，执行时审计 0 漏洞）；最终 npm run check 通过（类型检查含浏览器消费者、7 项测试、生产编译）。编译产物与开发 watch 均实际启动并以 HTTP 检查 health=200；404、敏感日志过滤及端口冲突均验证。本次启动进程已退出，3000 端口已释放。30 个交付文件通过 UTF-8 无 BOM 检查；sqlite-test.db SHA-256 未变化。真实数据库/OSS、业务接口、安卓和部署仍待后续任务验证。
- 完成时间：2026-10-01
- 阻塞原因：

### CORE-02：SQLite schema 与 Repository

- 状态：DONE
- 优先级：P0
- 前置依赖：CORE-01；实际数据库写入与迁移执行遵守用户确认规则
- 需求描述：建立单人视频库的数据模型及媒体模块可调用的数据库接口。
- 实现要求：
  - 使用 Drizzle ORM + better-sqlite3；定义账户、会话、分类、视频、上传分片、观看位置、播放会话与应用计量的 schema。
  - 实现约定的 Repository、唯一性和原子更新规则；支持媒体模块在并发检查与计量时使用。
  - 提供初始化/迁移代码、版本记录及备份边界，不对现有 sqlite-test.db 或其他用户库运行初始化。
  - 提供可替换的 Fake Repository，未获真实写入授权时用 Fake 验证模块边界。
- 计划变更范围：apps/api/src/db/、迁移文件、Repository 及相关测试。
- 验收条件：接口实现与公共类型一致；数据初始化和迁移目标明确；不把编写迁移代码记录成已执行真实迁移。
- 影响范围：SQL schema、Drizzle/SQLite Repository、迁移与隔离验证；独立新正式库已按用户授权由 CORE-03 初始化，用户测试库未修改。
- 实际变更文件：apps/api/src/db/schema.ts、database.ts、repositories.ts、migrations/0001-initial.sql、migrate-cli.ts；apps/api/scripts/copy-migrations.mjs；apps/api/test/database.test.ts；apps/api/package.json、package-lock.json、.gitignore、docs/DATABASE.md、本任务板。
- 完成说明：Drizzle + better-sqlite3 实现完整媒体 Repository，使用 immediate 事务约束对象/分片/会话/字节竞争。迁移 ledger/校验与一致性备份 CLI 就绪，运行时不自动建库/迁移，未知库/测试库拒绝接入。原生 SQLite 加载、类型/构建和 4 项实际 SQL 测试通过（双连接竞争、重启、备份恢复）；已有 Fake 入口保持可替换。本轮正式迁移仅在用户授权新建的 .local/data/video-library.db 执行，未对 sqlite-test.db 或其他用户库迁移。
- 完成时间：2026-10-01
- 阻塞原因：

### CORE-03：单人账户、TOTP 与会话

- 状态：DONE
- 优先级：P0
- 前置依赖：CORE-02
- 需求描述：落实私有系统的登录与授权基础，供所有敏感接口使用。
- 实现要求：
  - 实现密码哈希、TOTP、Cookie 服务端会话、过期、撤销和登录失败限流。
  - 提供受保护的首次初始化和恢复方案，禁止公开注册、匿名密码重置或生产放行默认值。
  - 实现约定 AuthGuard、归属检查、CSRF/来源检查及可信代理配置。
  - 过滤凭证日志，区分本地 HTTP 开发 Cookie 与生产 HTTPS 保护。
- 计划变更范围：apps/api/src/modules/auth/、相关 core 安全组件及测试。
- 验收条件：无会话、过期会话、撤销会话和 CSRF 不合法的请求被拒绝；正确登录可进入受保护接口。
- 影响范围：真实本人账号、密码/TOTP、Cookie 会话、AuthGuard、持久化失败限流、来源/CSRF、可信代理、受保护本地初始化/恢复与启动入口。
- 实际变更文件：apps/api/src/modules/auth/crypto.ts、settings.ts、service.ts、routes.ts、runtime.ts、account-cli.ts；apps/api/src/app.ts、server.ts、core/config.ts、core/start.ts；apps/api/test/auth.test.ts、database.test.ts；apps/api/src/db/database.ts；apps/api/package.json、package-lock.json、packages/shared/src/errors.ts、.env.example、.gitignore、docs/ACCOUNT.md、DATABASE.md、API_CONTRACT.md、PARALLEL_DEVELOPMENT_HANDOFF.md、TASKS.md、本任务板。新建正式数据/资料及隔离验证文件在 .local 内，不纳入 Git。
- 完成说明：Argon2id + AES-GCM TOTP、原子计数防重放、Cookie 摘要会话、CSRF/Origin、失败限流、过期/撤销已实现；本地初始化/恢复先写入并同步绑定资料，再修改账号，失败不锁死账号，不公开注册/匿名重置。6 项鉴权/CLI测试、4 项 SQL 测试及全工程检查通过；实际正式账号 HTTP 登录/me/退出为200，退出后访问401、密码/密钥存储及完整性验证通过。批准后收紧新建 .local 的 Windows ACL；用户测试库未变，未连 OSS/部署或展开 CORE-04～06。
- 完成时间：2026-10-01
- 阻塞原因：

### CORE-04：分类、视频元数据与搜索

- 状态：TODO
- 优先级：P0
- 前置依赖：CORE-02、CORE-03
- 需求描述：提供视频库的基本业务接口，与媒体对象内容分离。
- 实现要求：
  - 实现分类创建/重命名、分页视频列表、标题搜索、详情和标题/分类修改。
  - 提供未分类默认分类，校验分类和视频归属；禁止永久删除和任意对象路径读取。
  - 接收媒体模块登记的真实大小、时长、编码与兼容状态，未采集字段使用 null。
  - 保持媒体读取与业务元数据分层，支持将来播放链路变化而无需重新上传。
- 计划变更范围：apps/api/src/modules/catalog/ 与相应 Repository/测试。
- 验收条件：列表、筛选、编辑、分页和不存在资源均有一致响应；其他模块通过 Repository 接口登记和读取元数据。
- 影响范围：待实施后填写
- 实际变更文件：待实施后填写
- 完成说明：待实施后填写
- 完成时间：
- 阻塞原因：

### CORE-05：观看记录、会话与用量接口

- 状态：TODO
- 优先级：P0
- 前置依赖：CORE-02、CORE-03；与 MEDIA-03 对接计量
- 需求描述：保存观看进度并提供本人会话和应用用量查询。
- 实现要求：
  - 实现观看位置保存与恢复，校验非负范围及视频归属。
  - 提供会话列表与撤销接口，撤销后媒体请求同步失效。
  - 读取 UsageRepository，返回 application_proxy 统计来源、周期、时区及限额。
  - 不把应用计量当作最终云账单；限额配置与缺失配置的安全行为需明确。
- 计划变更范围：apps/api/src/modules/progress/、settings/ 与相关测试。
- 验收条件：进度持久化逻辑、撤销语义和用量结构与前端/媒体契约一致；Fake 与真实数据验证区分记录。
- 影响范围：待实施后填写
- 实际变更文件：待实施后填写
- 完成说明：待实施后填写
- 完成时间：
- 阻塞原因：

### CORE-06：模块装配与后端交付

- 状态：TODO
- 优先级：P0
- 前置依赖：CORE-03～05；媒体模块已提供注册函数
- 需求描述：将后端业务与媒体模块安全装配，交付主控进行完整联调。
- 实现要求：
  - 在统一 API 入口注册媒体模块并注入真实鉴权与 Repository；生产缺少安全依赖时拒绝启动。
  - 串行整理依赖、类型检查与后端构建；不直接重写子代理 2 模块修复接口不一致。
  - 完成关键接口和会话安全验证，记录未验证的真实 OSS/数据库项目。
  - 提供启动、配置、初始化授权边界和调试参数给主控，用于 VS Code 配置。
- 计划变更范围：apps/api/ 入口及注册文件；后端测试与运行说明。
- 验收条件：后端模块可统一加载，敏感接口没有未授权路径；真实外部服务检查有准确的已验/待验清单。
- 影响范围：待实施后填写
- 实际变更文件：待实施后填写
- 完成说明：待实施后填写
- 完成时间：
- 阻塞原因：

## 4. 完成记录

- 2026-10-01 [CORE-03] DONE：真实本人账号和新正式库已创建，密码/TOTP 资料存入受保护且 Git 排除的本地文件；实际 HTTP 登录与撤销验证通过。6 项鉴权/CLI、4 项 SQL测试及类型/构建通过；完整变更见任务卡，业务/真实OSS/部署仍待后续。
- 2026-10-01 [CORE-02] DONE：完整 Repository/SQL迁移/备份边界实现；3 项真实隔离 SQL 测试与 API 类型检查通过；实际文件见任务卡。未迁移 sqlite-test.db，正式库等待账号初始化。
- 2026-10-01 [CORE-01] DONE
  - 结果：工程骨架与公共契约落地，交接文档已提供；没有进入 CORE-02 或启动额外代理。
  - 变更文件：30 个源码/配置/文档文件，完整清单见 CORE-01 任务卡；长期路径已登记到本板第 0 节。
  - 验证：串行依赖安装、shared/api/浏览器消费者类型检查、7 项骨架测试、生产构建、编译/开发入口启动及真实 HTTP 健康检查通过；UTF-8 无 BOM，测试数据库未变更。
  - 待验：真实 SQLite/OSS、登录与业务模块、Range/上传/用量完整实现、安卓手机和服务器部署，按后续任务推进。TASKS.md 和其他代理任务板未回写。

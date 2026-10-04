# 第二阶段子代理 1：数据库、组织管理与真实 API

日期：2026-10-02。状态：P2-CORE-01～06 DONE；正式迁移/两对象private实云范围已明确授权并验证，后端readonly账号/恢复摘要保留、关系/ledger/integrity及真实浏览器自动续签/退出/正常重启证据齐全。手工库未改，网站HTTPS/安卓/杭州内网属于第三阶段。

## 0. 模块设计/数据库文件清单

- 入口：[STAGE2](../../../docs/task/STAGE2.md)、[PRD](../../../docs/PRD.md)、[TASKS](../../../docs/task/TASKS.md)；[架构评审](../../../docs/task/STAGE2_ARCHITECTURE_REVIEW.md)、[用户准备记录](../../../docs/task/OSS和框架调整相关.md)。
- 当前契约：[API_CONTRACT](../../../docs/API_CONTRACT.md)；下一阶段提案：[STAGE2_API_CONTRACT](../../../docs/STAGE2_API_CONTRACT.md)。
- 数据设计/待执行块：[SQL说明](../../../docs/sql/README.md)、[STAGE2_PENDING.sql](../../../docs/sql/STAGE2_PENDING.sql)。
- 已有基线：apps/api/src/db/schema.ts、database.ts、repositories.ts、migrations/0001-initial.sql；modules/auth/；docs/ACCOUNT.md、DATABASE.md。账号与真实会话已入库，不重做初始化。
- 正式目标.local/data/video-library.db迁移前ledger1/users1；用户具体授权后已备份升级ledger1/2、25表/users1，旧13表全部旧列SHA与计数保留、fk0/integrityok。sqlite-test.db仍用户手工24表、users/ledger空，不建表/升级、不作为应用目标。
- 初始规划表：library_groups、tags、视频/上传组标签关联、storage_objects、video_assets、upload_storage_objects、storage_operations；当时没有实现，本轮源码/隔离结果见下一项。
- 已接入源码：0002-library-organizing.sql、db/library.ts、modules/catalog/routes.ts、modules/progress/routes.ts、core/runtime.ts；另增source_authorizations/mode/source_expires_at/category name_key。25表SQL/schema对照通过，正式库已授权升级版本2。
- 新交接：[STAGE2_BACKEND_HANDOFF](../../../docs/STAGE2_BACKEND_HANDOFF.md)；实际运行契约已更新API_CONTRACT V0.5。
- 可写：db/、core/、modules/auth/catalog/progress/settings/、API 入口、packages/shared/、后端配置/锁文件（串行）、apps/api/test/stage2-backend.test.ts 及自有测试目录、本任务板；公共契约/SQL由你统一维护，变更通知主控与其他代理。

## 1. 默认协作规则

- 继承用户全局规则，UTF-8 无 BOM。逐卡读取/实现/验证/回写，不重排或删除无关文件。
- P2-CORE-01 先冻结可编译契约，再交接媒体/前端；它们等待时可准备自有设计/Fake。不要同时改 media 或 apps/web 内部。
- schema、迁移、共享类型、API 注册和根锁唯一写入方；依赖安装串行。其他代理提交清单，不抢改同文件。
- 代码与隔离 SQL 测试可先行；现有正式库迁移要先形成可审阅 SQL/目标/一致性备份并获用户授权。本轮计划不代表迁移已执行。
- 保留已初始化账号、TOTP密文、会话/上传/计量；不重新 account:init，不创建放行鉴权，不清空旧预留，不写实际秘密到 SQL/日志/Git。
- 真实OSS目标为PLAYBACK_MODE=oss，上传经服务器、播放/下载STS签名后直连；保留显式proxy兼容，不隐式回退。HTTPS未配置，是上线前条件；不部署、不自动调整云服务/权限。只回写自己的看板。

## 2. 任务总览

| ID | 状态 | 任务 | 依赖 |
| --- | --- | --- | --- |
| P2-CORE-01 | DONE | 正式库版本2迁移、组织/对象及直连契约冻结（正式已授权升级） | 现有CORE-02/03；读阶段提案/评审 |
| P2-CORE-02 | DONE | 分类/分组/标签管理及关系Repository | P2-CORE-01 |
| P2-CORE-03 | DONE | 真视频库、筛选搜索与元数据编辑 | P2-CORE-02 |
| P2-CORE-04 | DONE | 观看记录、授权会话与分模式用量 | P2-CORE-01；复用auth |
| P2-CORE-05 | DONE | OSS/STS双用途配置及安全装配（本地协议已验） | P2-CORE-03/04；媒体交接 |
| P2-CORE-06 | DONE | SQL一致性、重启/备份和后端交付（含授权本机实云） | P2-CORE-01～05 |

## 3. 任务卡

### P2-CORE-01：正式库版本2迁移、组织/对象及直连契约冻结

- 状态：DONE
- 优先级：P0
- 需求描述：冻结组织/对象登记与proxy/oss播放、续签/下载和直连用量契约，避免三方沿用代理传输假设。
- 实现要求：先只读核对正式库/手工库，审核STAGE2_PENDING作为新增0002接入，保留0001校验；有序ledger、同事务版本/SHA与一致性备份。同步Drizzle/组织/对象Repository、上传原子登记、StorageObjectRef及kind；冻结PlaybackMode判别联合、sourceUrl/sourceExpiresAt/renewAfter、同会话续签/下载DTO和签名提供者/带Expiration的STS提供者。proxy精确计量与oss实际字节未知独立表达，评估新增持久化字段并纳入迁移，不能伪造云统计。只在隔离库验证；正式升级另授权，不重跑手工建表。
- 计划变更范围：db/、core/contracts/、shared/、公共SQL/契约和对应测试。
- 验收条件：类型/Fake可编译、两种播放和用量模式不混淆，签名期限不超过STS剩余时间；SQL与schema一致，旧账号/会话/视频保留。跨owner、唯一对象、回滚/重复升级检查通过，手工库无改动。交接代理2/3后才依赖新版。
- 影响范围：后端/共享接口/数据库迁移源码与SQL文档；正式库按用户具体授权备份升级，手工库不改
- 实际变更文件：apps/api/src/db/database.ts、schema.ts、repositories.ts、library.ts、migrations/0002-library-organizing.sql；apps/api/src/core/contracts/repositories.ts、storage.ts、media.ts；packages/shared/src/dto.ts、errors.ts；apps/api/test/database.test.ts、stage2-backend.test.ts；docs/sql/STAGE2_PENDING.sql、01_EMPTY_DATABASE_FULL.sql、README.md；docs/API_CONTRACT.md、STAGE2_API_CONTRACT.md
- 完成说明：开发先只读核验v1正式库与24表手工库，新增有序0002/SHA/immediate事务/25表Drizzle/组织对象/原子登记及完整身份保护；契约编译交接、回滚/重复/重启/只读backup副本旧列保留通过。随后用户具体授权，主控正式一致性备份并升级ledger1/2、25表/users1，旧13表全部旧列SHA与计数保留、fk0/integrityok，0001/0002 SHA未改；实际备份和verification报告路径见交接。手工库不变。
- 完成时间：2026-10-02
- 阻塞原因：

### P2-CORE-02：分类/分组/标签管理及关系Repository

- 状态：DONE
- 优先级：P0
- 需求描述：组织信息由SQL和本人归属管理，而不是浏览器临时标签。
- 实现要求：分类单主类，分组/标签多对多；创建/改名/排序/描述/归档/恢复，默认未分类不可归档。名称规范化唯一，关联软解绑，归档不删视频/对象。实现上传组织快照、视频关联更新与事务归属验证，错误/归档的新选择明确拒绝，旧显示可保留归档标识。
- 计划变更范围：modules/catalog/、组织Repository/测试。
- 验收条件：归属、重复名称、重复关联、默认分类、归档/恢复、重启保留和同事务更新可通过真SQL验证。
- 影响范围：后端组织API与SQL关系Repository
- 实际变更文件：apps/api/src/db/library.ts、repositories.ts；apps/api/src/modules/catalog/routes.ts；apps/api/src/modules/auth/service.ts；apps/api/test/stage2-backend.test.ts
- 完成说明：本人组织创建/改名/适用排序描述/归档恢复；NFKC-trim-小写唯一、默认分类保护、上传快照与视频关系软解绑/事务归属验证；新归档选择409拒绝，标题局部编辑保留历史关联。新隔离账号默认分类同步nameKey，不重建实际账号。真SQL归属/重复/多选/回滚与文件库重启验证通过。
- 完成时间：2026-10-02
- 阻塞原因：

### P2-CORE-03：真视频库、筛选搜索与元数据编辑

- 状态：DONE
- 优先级：P0
- 需求描述：视频记录可以按主分类、分组、标签查找、编辑和分页。
- 实现要求：落实CORE-04未完成的列表/详情/标题搜索/分页/标题分类编辑，扩展组/标签过滤和编辑。按提案的跨维度AND与多选全命中，组合条件重置分页；输出nullable真实元数据和站内封面地址。不接收任意URL/key，不修改OSS对象位置，不公开分享/永久删除。
- 计划变更范围：catalog/、VideoRepository、测试。
- 验收条件：空态/无匹配/长标题/组合筛选及total一致；编辑失败原数据保留，非法对象/跨owner不可访问，组标签重启后仍一致。
- 影响范围：后端视频库查询/元数据API
- 实际变更文件：apps/api/src/db/library.ts、repositories.ts；apps/api/src/modules/catalog/routes.ts；apps/api/test/stage2-backend.test.ts
- 完成说明：列表/详情/搜索/分页/标题分类组标签编辑真实SQL，跨维度AND与多选全命中、默认24/上限100/total一致；真实nullable元数据/站内封面、不接收bucket/key/url。重复筛选/跨owner/归档选择/编辑失败回滚/软解绑与重启验证通过。补显式单项existingVideoId/已核验预览bindLegacy契约及事务实现，精确旧key/owner/完整身份检查，保留旧id/title/组织/进度并幂等，不猜Bucket；后端新增检查通过，媒体/前端接入各自负责。
- 完成时间：2026-10-02
- 阻塞原因：

### P2-CORE-04：观看记录、授权会话与分模式用量

- 状态：DONE
- 优先级：P0
- 需求描述：完成CORE-05尚缺的真实HTTP入口，复用已有账号会话能力。
- 实现要求：观看位置GET/PUT绑定owner/video并校验秒数；会话列表/撤销复用CORE-03。proxy保留真实字节/三态限额/IANA周期及未结算预留；oss返回实际传输量未知/未同步、签发次数与应用会话数，不能填0或文件大小冒充实际字节，也不能套用proxy每日硬限制。持久化签发/续签/下载审计（不存完整URL/秘密），撤销原子拒绝后续授权；已发URL不会因站内撤销立即失效，应用并发不等于OSS实际连接数。
- 计划变更范围：progress/settings/、必要Repository/测试。
- 验收条件：进度/审计重启保留；proxy撤销后的站内流拒绝、周期/DST/字节计量旧检查通过；oss撤销后创建/续签/下载授权拒绝，旧签名的剩余有效期边界与未知用量有独立证据。
- 影响范围：真实观看记录、授权审计、分模式用量
- 实际变更文件：apps/api/src/db/repositories.ts、library.ts；apps/api/src/modules/progress/routes.ts；apps/api/src/modules/catalog/routes.ts；packages/shared/src/dto.ts；apps/api/test/stage2-backend.test.ts
- 完成说明：进度owner/video秒数校验与SQL持久化；真实AuthService已有会话列表/原子撤销复用。oss无秘密签发/续签/下载审计及跨进程频控、未同步真实字节null与独立次数/应用会话数；proxy仍实际字节/三态/IANA/DST/在途预留。隔离SQL与主控HTTP证明撤销后新授权拒绝，已发URL剩余期限仍可用，不承诺OSS连接数/字节封顶。
- 完成时间：2026-10-02
- 阻塞原因：

### P2-CORE-05：OSS/STS双用途配置及安全装配

- 状态：DONE
- 优先级：P0
- 需求描述：落实CORE-06的本地完整注册，真实SQL/鉴权配合明确开发Mock或授权OSS。
- 实现要求：统一注入真AuthGuard、Repo/登记事务和代理2的签名/STS factory，不改媒体内部。配置区分test/development/production、proxy/oss；上传OSS_ENDPOINT与固定OSS_PLAYBACK_ENDPOINT/cname分离，接入角色ARN或受保护ARN文件、STS期限/刷新余量/URL期限，校验Bucket/onlineVideo前缀/身份与网络。用户确认Get/Put/List策略绑定用户和角色，优先复用同角色STS按用途收窄并隔离缓存，读取签名不使用长期AK。生产拒绝Mock/测试依赖、HTTP媒体域名和缺上传/授权控制参数，不因失败回退公网/Mock。核对新增依赖workspace归属与STS SDK选型，安装串行且不删除用户依赖。
- 计划变更范围：入口/core配置/注册、根工程配置、必要测试。
- 验收条件：同一应用真实auth/catalog/progress/settings/media协作；配置/来源/STS失败安全拒绝，前端只获受限签名URL而非长期AK/AccessKeySecret/完整STS凭据。本地真SQL+协议替身验证两种模式；HTTPS尚未完成不能宣称生产验收通过。
- 影响范围：API统一入口、显式资源/OSS配置、安全装配
- 实际变更文件：apps/api/src/app.ts、server.ts；apps/api/src/core/config.ts、runtime.ts、contracts/media.ts；.env.example；packages/shared/src/dto.ts；apps/api/src/modules/catalog/routes.ts
- 完成说明：同一真实SQLite/AuthService/组织/库/进度/媒体统一装配；upload/read/import STS用途工厂复用代理2实现，独立上传Endpoint和HTTPS CNAME。配置严格Bucket/杭州/onlineVideo前缀/网络/受保护密钥与ARN路径/到期资源；生产拒绝Mock/测试/HTTP/非安全Cookie/缺控制参数。用户确认2GiB/3会话/3600秒-300续签/Asia-Shanghai，实施8MiB/上传2并发/签发12min；不冒用Fake预算。ali-oss内置STS复用无安装、保留用户依赖。API typecheck/build、本机协议全链及主控最新61/61通过；本机FFprobe与真实样例已分析，真实OSS/生产仍待验。
- 完成时间：2026-10-02
- 阻塞原因：

### P2-CORE-06：SQL一致性、重启/备份和后端交付

- 状态：DONE
- 优先级：P0
- 需求描述：交付下一阶段后端的可复现操作与验收证据。
- 实现要求：核对SQL/schema/ledger与源码；完整链登录→组织→上传登记→筛选→直连授权/续签/下载/进度→重启恢复，并回归proxy。交接手工库已建结构与正式迁移状态，提供备份/新目标恢复说明；不覆盖原库或删除产物。分列STS/RAM、HTTPS/CORS、真OSS/安卓/服务器证据；明确撤销和未知字节统计边界，不伪报旧Mock为新完成。
- 计划变更范围：自有测试、DATABASE/阶段后端交接文档、任务板。
- 验收条件：相关typecheck/build/SQL与HTTP验证有实际输出；账号未重建，数据/秘密排除Git，正式迁移与外部验收授权/目标明确。
- 影响范围：后端交接与SQL/运行说明；正式库已授权备份迁移，手工库只读
- 实际变更文件：docs/DATABASE.md、STAGE2_BACKEND_HANDOFF.md、API_CONTRACT.md、STAGE2_API_CONTRACT.md、sql/README.md；apps/api/test/stage2-backend.test.ts；本任务板
- 完成说明：本地typecheck/build/API61历史通过、proxy回归、25表SQL/schema/ledger、备份副本及正式授权升级证据齐全。受控2private真实STS上传/SQL登记、匿名403/V4 Range206、readPut403/importList200、两原片完整SHA下载通过；browser baseline/真实900STS同session自动续签与Token变化boolean/暂停2秒/logout401而旧URL206/正常API重启库组织及进度恢复均status=passed。本代理最终readonly formalv2/users1/videos2/uploads2/objects2/assets4/operations2每任务completed/opregistered唯一、组织/资产与报告匹配、ledger/schema正确/integrityok/fk0、账号静态密码TOTP及10恢复摘要与备份保留true、手工库不变；1条兼容进度position2，19签发实际字节null且期限<=3600，正常配置STS3600/refresh300/原上传前缀恢复。无秘密backend-readonly-1790961903448-a887bda3-b05c-4300-8e6e-004d5177d2ca.json及交接详列。native video无crossOrigin已验；附加fetchRange CORS不可读未自动改规则，不宣称通用fetch/HEAD或最终站点通过；网站HTTPS/安卓后台/杭州内网归阶段3。本代理后续实际SQL只读，未停止API或操作云。
- 完成时间：2026-10-02
- 阻塞原因：

## 4. 完成记录

2026-10-02（最终后端交接）：P2-CORE-06 DONE。已核实际short/resume报告passed与权限readPut403/List200、完整附件SHA；最终readonly正式DB/账号恢复摘要/ledger关系/未知用量/正常配置均正确，兼容仅1条观看记录position2（不伪报2行）。CORE06按阶段2本机实云范围完成；额外fetchRange CORS读取、最终网站HTTPS/安卓/杭州内网边界独立列，不把未验项声称通过。所有产物/对象保留，无后续实际SQL写或清理。

2026-10-02（实云登记后只读核验）：用户授权两新private对象/真实OSS及SQL业务写，主控已完成两上传登记。后端readonly formalv2/users1/videos2/uploads2/group1/tags2/objects2/assets4/operations2，各唯一完成任务/登记操作/资产组织快照与报告匹配、schema/ledger正确/fk0/integrityok，原账号静态密码/TOTP和10恢复摘要保留true，手工users0/ledger0。留无秘密backend-readonly JSON；原片下载已验、兼容浏览器下载/媒体权限等收尾待齐，P2-CORE-06仍DOING。

2026-10-02（最新工具/检查状态）：主控完整API61/61通过；portable FFprobe9.0.2已安装于.local/tools/ffmpeg-9.0.2-stage2/ffprobe.exe，原ces HEVC/AAC329035字节unsupported、独立H264/AAC460063字节ready，analysis-20261002.json确认originalUnchanged=true。本次仅同步文档事实、未重复无变化API测试；P2-CORE-06继续DOING待实云外部授权/验收，未云写入或权限变更。

2026-10-02（14:21 UTC）：用户具体授权正式目标一致性备份升级，主控db:migrate实际完成版本2/25表/users1，旧13表全部旧列SHA和count不变、fk0/integrityok，手工24表库保留。备份与同名verification报告见后端交接。P2-CORE-06仍DOING待真实STS/OSS/私有范围/CORS/分析器验收；未云写入/改权限，FFprobe工具下载未完成。

2026-10-02（收尾审计）：补齐明确旧位置回填的existingVideoId/bindLegacy契约与事务，7项后端SQL/HTTP检查通过；普通导入不受影响，0002不变。媒体/前端分别接入可操作入口，未推断或写实际旧对象位置。修正文档两行尾空格。

2026-10-02（迁移前历史）：P2-CORE-01～05源码/隔离DONE，P2-CORE-06当时待正式/外部授权。共享/API编译、API54项及后端SQL6项通过；主控真HTTP+SDK本机协议完整链与只读backup副本升级证据另见交接。当时正式库v1/本人1账号、手工24表空ledger未改；后续正式授权升级见顶部新记录，未装新依赖或进行云/权限/部署/提交。

2026-10-02：根据用户混合架构准备记录重排契约/迁移/配置/用量验收；只读确认正式库版本1、手工库24表。开发卡仍TODO，未改源码或数据库。

2026-10-02：建立下一阶段任务卡，所有TODO；未实施应用源码、正式迁移或真实OSS操作。完成后按倒序回写事实。

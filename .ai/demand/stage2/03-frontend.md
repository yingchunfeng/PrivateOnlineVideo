# 第二阶段子代理 3：分类、分组、标签与真实网站链路

日期：2026-10-02。状态：P2-WEB-01～05完成；本人会话+真实私有OSS/900秒STS自动续签、角色刷新、唯一原片附件及实际重启续播已补验。最终网站HTTPS/安卓原生后台与额外fetch CORS归第三阶段待验。

## 0. 模块设计/数据库文件清单

- 入口：[STAGE2](../../../docs/task/STAGE2.md)、[架构评审](../../../docs/task/STAGE2_ARCHITECTURE_REVIEW.md)、[用户准备记录](../../../docs/task/OSS和框架调整相关.md)；下一阶段契约：[STAGE2_API_CONTRACT](../../../docs/STAGE2_API_CONTRACT.md)。
- 已有真实账号：[ACCOUNT](../../../docs/ACCOUNT.md)；原前端代码/自测/HANDOFF在apps/web，全部保留，不重新创建项目。
- 已复用原页面完成真实视频库/组织/媒体统一接入；隔离SQL/Auth/协议、本人真实会话/私有OSS及真实STS分别留证，旧WEB DONE保留历史。
- 可写：apps/web/**及本任务板；公共类型/后端/SQL/根配置和锁只提需求，不自行安装更新根锁。
- 前端控制请求仍用共享DTO与站内API；video/download按后端签名URL直连限定OSS域名。网页不读取.local账号/密钥/数据库、不接收AccessKeySecret/完整STS凭据，不引入OSS SDK。本轮用户具体授权Node验收仅读run目录短期session Cookie/CSRF用于自有BrowserContext，不读长期资料/正式DB。

## 1. 默认协作规则

- 读取全局规则和任务依据，UTF-8无BOM、逐卡验证回写；先复用已有布局/播放器/上传客户端，不无关重构。
- P2-CORE-01冻结新版字段/过滤语义后实现公共接入；等待时可做自有组件/契约一致Fake设计。
- 所有新增依赖提出精确版本给主控/代理1串行安装。已有Cookie/CSRF、401失效和生产Mock隔离不能降低。
- 创建/改名/排序/归档/关联更新由后端DB管理，刷新/重启不能靠本地数组保存；本地只留非敏感恢复提示。
- 不读长期密钥、改云/服务器/数据库、不永久删除/公开分享/PWA缓存。本阶段明确实现OSS签名直连，保留显式proxy；不擅自放宽所有外部URL校验。截图唯一目录保留旧文件，构建不清空输出。

## 2. 任务总览

| ID | 状态 | 任务 | 依赖 |
| --- | --- | --- | --- |
| P2-WEB-01 | DONE | 真登录/会话与新版API客户端 | P2-CORE-01；已有CORE-03 |
| P2-WEB-02 | DONE | 主分类/分组/标签管理和库筛选 | P2-CORE-02/03 |
| P2-WEB-03 | DONE | 上传/续传/导入的组织信息 | P2-MEDIA-02/04 |
| P2-WEB-04 | DONE | OSS直连播放/下载、续签与分模式用量 | P2-CORE-01；P2-MEDIA-03；联调依赖CORE-04/05 |
| P2-WEB-05 | DONE | 安卓界面与真实完整链验收交接 | 前四卡；实际环境补验 |

## 3. 任务卡

### P2-WEB-01：真登录/会话与新版API客户端

- 状态：DONE
- 优先级：P0
- 需求描述：使用已有本人账号和真实服务恢复会话，所有新增类型只来自冻结契约。
- 实现要求：真实password/TOTP、me、logout、sessions/revoke对接，保持HttpOnly Cookie、CSRF/可信来源和统一401处理；不把秘密放localStorage或读取本地账号JSON。Mock显式独立，生产无默认Mock、不因接口失败回退；账户恢复按本地受保护流程说明，不造匿名重置。
- 计划变更范围：apps/web/src/api/auth与必要组件/测试。
- 验收条件：真HTTP登录/退出/过期/撤销可验证，异常JSON401仍失效；源码/前端产物无凭据/数据库/Node依赖，未重复创建账号。
- 影响范围：站内认证客户端、会话恢复/失效与安全会话操作
- 实际变更文件：apps/web/src/api/auth.ts、apps/web/src/api/client.ts、apps/web/src/auth.tsx、apps/web/src/pages/Security.tsx、apps/web/test/unit.test.ts、apps/web/test/stage2-browser.test.ts
- 完成说明：复用真实 password/TOTP 与 HttpOnly Cookie/CSRF；me/login DTO 完整校验、未知/畸形 JSON 401 先清会话且返回登录失效。隔离真 SQLite/Auth/HTTP 浏览器验证登录、刷新恢复、退出、撤销、过期及后续业务 401；既有账号秘密与正式库未由前端读取或初始化。生产引用图及全新发布目录扫描通过。
- 完成时间：2026-10-02 14:22 UTC
- 阻塞原因：

### P2-WEB-02：主分类/分组/标签管理和库筛选

- 状态：DONE
- 优先级：P0
- 需求描述：本人可管理组织信息并按不同维度查找视频。
- 实现要求：一个主分类、多分组、多标签，创建/改名/排序/描述/归档恢复；默认未分类受保护。库/详情显示标签与分组，多选AND过滤/标题/分页一致，改条件重置页码。视频编辑经真API保存，取消选择软解绑，归档历史可读；空态/长中文/重复名称/权限错误清晰，不提供永久删除或分享。
- 计划变更范围：库/分类/新组织管理页、详情/编辑组件、测试。
- 验收条件：真DB数据刷新后保留，过滤total与页码一致；触控多选/键盘可用，无封面/null元数据正常，组织更新不改OSS地址。
- 影响范围：组织管理、AND 库筛选、归档历史详情与编辑
- 实际变更文件：apps/web/src/organization.tsx、apps/web/src/pages/Categories.tsx、apps/web/src/pages/Library.tsx、apps/web/src/pages/Video.tsx、apps/web/src/styles.css、apps/web/src/api/mock.ts、apps/web/test/browser.test.ts、apps/web/test/stage2-browser.test.ts
- 完成说明：真 API 分类/分组/标签创建、名称/排序/分组描述/归档恢复，默认未分类保护；列表/详情显示关联和历史归档，多选 AND/标题/分页及条件变更重置页码。PATCH 仅发送改变的组织维度，按集合比较；归档历史仅改标题通过，取消选择 SQL removed_at 软解绑后保留历史。真 DB 重启持久化、重复名称、长中文/150%文字与触控回归通过，组织修改未改对象位置。
- 完成时间：2026-10-02 14:22 UTC
- 阻塞原因：

### P2-WEB-03：上传/续传/导入的组织信息

- 状态：DONE
- 优先级：P0
- 需求描述：上传前选择类别/分组/标签，重开续传和导入后关联仍由DB保留。
- 实现要求：创建请求发送冻结的组织ID，GET任务恢复后显示服务端快照；按partSizeBytes逐片SHA-256，不整文件读，不由文件名判续传。已有failed/finalizing完成恢复复用，只有后端完整登记成功才成功。已有对象预览分页/选中ID+组织提交，无原始Bucket/key输入；归档/过期/权限变化提示可恢复行为。
- 计划变更范围：上传/导入页、客户端与测试。
- 验收条件：暂停/失败/重开/错文件/归档选择/重复complete均通过真API及SQL验证；新视频类别/全部标签分组正确，无伪造OSS成功或后台上传承诺。
- 影响范围：上传组织快照、2 GiB 上限、续传和分页导入/明确旧记录位置绑定
- 实际变更文件：apps/web/src/pages/Upload.tsx、apps/web/src/upload.ts、apps/web/src/pages/Library.tsx、apps/web/src/organization.tsx、apps/web/src/api/mock.ts、apps/web/test/unit.test.ts、apps/web/test/stage2-browser.test.ts
- 完成说明：受保护 limits 返回的 2147483648 字节上限在选文件/启动前拦截；组织 ID 创建和任务恢复以服务端快照为准，仍逐片 SHA-256/顺序上传且不整文件读。真 HTTP 两片暂停/重开/同名同大小错文件拒绝/完整登记与唯一 SQL 关联通过；failed/finalizing/重复 complete 保留既有恢复并由单元/Mock 及后端 SQL 证据覆盖。100 条分页+opaque cursor/选中 ID 导入后标签持久化；单选既有视频位置绑定先拒错 key，再核验精确匹配保留原 ID/标题/归档分组/进度。未接收 Bucket/key 输入，该卡本地验证不访问实云；后续已由主控对本轮两样例完成真实上传/组织登记，前端只验本人真实库/详情与恢复，未新增上传。
- 完成时间：2026-10-02 14:22 UTC
- 阻塞原因：

### P2-WEB-04：OSS直连播放/下载、续签与分模式用量

- 状态：DONE
- 优先级：P0
- 需求描述：以DB管理的对象和真实会话播放，并保存观看位置/应用用量。
- 实现要求：按proxy/oss判别DTO验证sourceUrl；proxy仍限定站内stream，oss仅允许配置的媒体origin/协议与前缀边界，拒绝任意外域/javascript URL，不扩大站内API客户端的URL权限。按sourceExpiresAt/renewAfter同会话续签，更新video源时保留currentTime/播放暂停状态；后台恢复/过期/403类媒体错误重新鉴权，有限重试后明确提示，不全量缓冲/PWA缓存、不隐式代理回退。下载经站内授权接口拿限定原片签名，不能假设跨域download属性一定生效，按后端Content-Disposition验证。保留心跳关闭、比例/全屏/进度API，更新A模式文案；安全页分开proxy实际字节与oss未知/未同步用量，说明退出/撤销停止后续授权但旧链接可能仍有效。
- 计划变更范围：现播放器、安全/用量页、真实API测试。
- 验收条件：进度刷新/重启保留；直连域名/源模式验证、短STS期限续签、换源位置/暂停状态、长视频/后台返回/错误重试、原片下载有证据。撤销后续签拒绝且用量无虚假精确字节/立即断流承诺；proxy旧测试保留，HTTPS未配置前不宣称正式HTTPS/安卓通过。
- 影响范围：签名直连播放/下载、同会话续签恢复、分模式用量与安全边界
- 实际变更文件：apps/web/src/media-policy.ts、apps/web/src/media.ts、apps/web/src/player.tsx、apps/web/src/download.tsx、apps/web/src/usage.ts、apps/web/src/usage-panel.tsx、apps/web/src/pages/Security.tsx、apps/web/src/pages/Video.tsx、apps/web/src/App.tsx、apps/web/test/media-policy.test.ts、apps/web/test/stage2-browser.test.ts、apps/web/test/stage2-long-playback.test.ts、apps/web/package.json、apps/web/qa/stage2-long-2026-10-02T15-24-57-650Z/heartbeat-before-fix.json、apps/web/qa/stage2-long-2026-10-02T15-35-09-922Z/foreground-heartbeat.json、apps/web/qa/stage2-long-2026-10-02T15-35-09-922Z/long-application-session-expired.png、apps/web/qa/stage2-long-2026-10-02T15-35-09-922Z/long-login-revoked.png、apps/web/qa/stage2-long-final-2026-10-02.log、apps/web/test/stage2-real-oss.test.ts、apps/web/qa/stage2-real-baseline-2026-10-02T16-57-38-206Z/diagnosis.json、apps/web/HANDOFF.md、apps/web/README.md
- 完成说明：源码与本地验证已完成：固定 Origin/协议/前缀校验（含合法中文空格 key），proxy 限当前视频/会话 stream；实际 renewAfter 同会话签名换源保留位置和暂停/播放，心跳不签 URL。同秒相同 URL 显式 video.load，403 类错误两次有限重新鉴权后明确提示；12 秒本地授权续签、Range206、原片字节/附件、进度重启、撤销后 source401 而旧 URL206、proxy 真字节、OSS null 未同步文案均通过。未全量 fetch/blob/PWA/隐式代理回退。补验真FFprobe及原生video确认3600秒/6411947字节H264，1800/3590秒真实seek、seeking=false/ready4与中/尾非零Range及Content-Range记录。48秒真实复现心跳0/SQL期限未延长，按稳定session.id修复后心跳2/期限延长40.064秒；源延迟响应跨一次真心跳后按max保留已确认期限。真SQLite重启恢复3590秒、Page frozen14秒/APP8秒403提示可重建、真revoke后冻结恢复统一401+source401均通过；长TAP pass6/fail0/skip1，原生后台明确跳过。 真实补验：本人Cookie恢复/两视频组织与HEVC提示、HTTPS兼容nativeplay/Range206/2秒暂停/无站点Cookie；兼容唯一完整附件460063字节SHA=f7083ce3ecc34bf2639622d4144f545022570e9601f5f9fc447257fc459d12a4。真实900秒STS等待17:17:59首次续签和17:20:29新凭证刷新，均同id/paused位置2/ready4，Token只内存比对布尔；退出后source401而新已发URL仅1byte仍206。正常模式/真实API和SQL重启后新短期session仅读GET恢复2秒/组织，两视频保留，媒体和签发0。签名type非法参数曾导致400/XML/ORB，媒体最小移除后native通过，未改ACL/CORS/TLS。safe baseline/short/resume报告在受保护run目录，无URL查询/凭据/HAR。
- 完成时间：2026-10-02 17:25 UTC
- 阻塞原因：无本阶段阻塞。原生安卓后台/正式网站HTTPS及额外fetch CORS规则明确归第三阶段：nativevideo HTTPS已成功，额外1byte跨域fetch不可读、未改CORS/权限。真3600秒与Page frozen恢复为本地证据，未宣称一小时持续观看/大文件内存/真实安卓。

### P2-WEB-05：安卓界面与真实完整链验收交接

- 状态：DONE
- 优先级：P0
- 需求描述：交付可用的网站交互与真实链路证据给新对话主控。
- 实现要求：Playwright手机/横竖屏/文字放大/触控/长标签/空态/关键错误；隔离真SQLite+真Auth+业务API+本地OSS协议服务验证上传→登记→签名直连/续签/下载全链，并回归proxy。生产build无Mock/秘密，说明媒体origin及必要CSP/media-src/connect-src配置（部署由主控另处理），提供截图。HTTPS/CORS、安卓真机/真实OSS/杭州内网上传/大文件另验，不用仿真冒充真机。
- 计划变更范围：前端e2e、自有界面修正与HANDOFF/任务板。
- 验收条件：类型/单元/生产构建、真HTTP数据链测试有实际输出；公开字段与DB/媒体一致，状态已验/待验准确，服务优雅退出，不清理用户文件/进程。
- 影响范围：手机本地真实链路 QA、独立生产发布目录、运行/待验交接
- 实际变更文件：apps/web/test/stage2-browser.test.ts、apps/web/test/browser.test.ts、apps/web/test/production.test.ts、apps/web/test/release-build.ts、apps/web/test/mock-media-plugin.ts、apps/web/package.json、apps/web/vite.config.ts、apps/web/README.md、apps/web/HANDOFF.md、apps/web/qa/stage2-2026-10-02T14-20-00-951Z/phone-library.png、apps/web/qa/stage2-2026-10-02T14-20-00-951Z/phone-direct-player.png、apps/web/qa/stage2-2026-10-02T14-20-00-951Z/phone-long-tags-150-percent.png、apps/web/qa/stage2-2026-10-02T14-20-00-951Z/landscape-organization-filter.png、apps/web/qa/stage2-2026-10-02T14-20-00-951Z/phone-oss-usage.png、apps/web/qa/stage2-browser-final-2026-10-02T14-20.log
- 完成说明：typecheck、14 单元、7 Mock 子场景/TAP8、7 隔离真 HTTP 子场景/TAP8、production1 均通过。真实链以独立 SQLite/Auth/业务 API+真 ali-oss SDK+独立 V4 HMAC 本地协议服务验证，媒体分析器明确受控注入；320/375px、812×375、150%文字/长标签/触控/空态与错误截图已交接。测试用随机回环端口优雅关闭，不终止用户服务。根.env仅读取两个公开媒体键且恢复 loadEnv 的 NODE_ENV 副作用，保持 .env.mock 隔离。最新独立 dist/stage2-release-2026-10-02T15-40-47-545Z 全目录扫描/SHA-256 manifest 已交付，旧构建文件全部保留但不进入发布包。真实云/CORS/长视频/安卓/内网明确另验，部署/CSP交接未执行。
- 完成时间：2026-10-02 14:22 UTC
- 阻塞原因：

## 4. 完成记录

2026-10-02 17:25 UTC：P2-WEB-04 DONE、前端五卡完成；实际本人/两私有OSS样例native HTTPS、唯一兼容附件SHA、12.5分钟真实900s STS双续签/角色刷新同id保留暂停2秒、退出source401旧签名1byte206和正常API/SQL重启进度2秒全部通过。原生安卓/最终网站HTTPS/额外fetch CORS明确第三阶段待验；私有real/long QA只本地不默认Git/发布，旧产物不删。

2026-10-02 15:41 UTC：补P2-WEB-04真3600秒文件/FFprobe/非零Range/独立心跳/页面冻结恢复；48秒心跳0缺陷已复现并最小修复为2次，延迟源响应保留较晚APP期限。长test pass6/fail0/skip1（原生visibility未验）；typecheck/14单元、短真链与proxyMock各TAP8、production1及15:40新cleanrelease扫描通过。P2-WEB-04仍DOING留原生后台/实云，不宣称持续一小时观看。

2026-10-02 14:22 UTC：P2-WEB-01/02/03/05 DONE、P2-WEB-04 DOING；真HTTP浏览器7子场景/TAP8、Mock7/TAP8、14单元、typecheck与production1通过；独立发布全目录扫描及manifest交付。新增明确旧记录位置绑定 UI/真SQL验证，保留账号/用户文件/历史构建；真实云、长视频、安卓和内网未验。

2026-10-02：按新混合架构重排直连播放器/下载、同会话续签、域名校验和未知用量展示；开发卡仍TODO，未启动实现/浏览器或云操作。

2026-10-02：建立下一阶段前端任务，未启动实现/浏览器服务/真实链路操作。

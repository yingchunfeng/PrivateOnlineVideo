# 子代理 3：前端界面与交互

日期：2026-09-30  
当前状态：WEB-01～07 前端实现与本地自测完成；真实业务 API、OSS 与安卓真机待主控联调

## 0. 模块设计/数据库文件清单

- 产品依据：[PRD](../../PRD.md)。
- 总看板：[TASKS](../../TASKS.md)。
- 接口依据：[API_CONTRACT](../../docs/API_CONTRACT.md)。
- 本代理范围：负责 React/TypeScript 安卓优先网站、页面路由、API 客户端、Mock、登录、视频库、播放器、上传和安全用量界面。
- 可写范围：apps/web/**、前端组件、API 客户端与测试；本任务板。apps/web/package.json 可修改，但依赖安装与共享锁文件由子代理 1/主控串行处理。
- 数据边界：前端不直接访问 SQLite。所有数据经站内 API；共享 DTO 来自 packages/shared/。
- 新模块和迁移路径在真正创建后追加登记；当前列出的源码路径是规划路径。
- 实际前端模块：apps/web/src/（API、鉴权、库/分类/详情/上传/安全页面、播放器与上传客户端）、apps/web/test/（Node/Edge/生产验证及仅开发合成WebM）、apps/web/qa/（按UTC唯一目录保存界面证据）。
- 前端运行说明：apps/web/README.md；交接、验证与待验接口：apps/web/HANDOFF.md。

## 1. 默认协作规则

- 继承用户全局规则和 TASKS.md。不修改后端、packages/shared/、根目录配置或锁文件。不获取长期 OSS 密钥，不改服务器配置或数据库，不实现原生 App、PWA 离线视频缓存或 B 方案。
- 每次完整读取当前任务卡；依赖未完成时先处理独立设计或 Fake/Mock，不伪造完成。
- 只回写自己的任务板，不改总看板和其他代理任务板。
- 开始实际实施才设 DOING；完成真实验证后设 DONE。完成说明区分已验证和待外部环境验证。
- 真实数据库写入、迁移执行、云权限调整、删除及配置覆盖遵守用户确认规则，不把编写代码当作对真实数据操作的授权。
- 任务只涉及本地开发，服务器部署和 B 模式留待后续。
- 使用 UTF-8 无 BOM，最小修改，保留其他代理的工作。

## 2. 任务总览

| ID | 状态 | 任务 |
| --- | --- | --- |
| WEB-01 | DONE | 前端骨架、路由与 Mock |
| WEB-02 | DONE | 登录、TOTP 与会话 |
| WEB-03 | DONE | 分类、搜索与视频库 |
| WEB-04 | DONE | 在线播放与观看记录 |
| WEB-05 | DONE | 手机上传与续传 |
| WEB-06 | DONE | 安全、会话与应用用量 |
| WEB-07 | DONE | 安卓适配、界面验证与交接 |

## 3. 任务卡

### WEB-01：前端骨架、路由与 Mock

- 状态：DONE
- 优先级：P0
- 前置依赖：CORE-01 工作区及类型交接；此前可准备界面结构
- 需求描述：建立能独立预览并逐项切换真实 API 的网站基础。
- 实现要求：
  - 初始化 React + TypeScript + Vite、React Router 和样式基线，建设统一布局、加载、空态与错误提示。
  - 封装同源 API、会话失效和 CSRF 处理，使用共享 DTO，不另写冲突字段。
  - 提供契约一致的 Mock 场景；生产不默认启用 Mock，不伪造真实上传或 OSS 成功。
  - 向主控提出依赖清单，不并发修改 package-lock.json。
- 计划变更范围：apps/web/ 工程与布局、API 客户端、Mock。
- 验收条件：页面可启动预览，路由和类型检查可运行；Mock 与真实 API 切换明确，不把密钥打包进前端。
- 影响范围：前端工作区、开发 Mock、浏览器验证；未改后端、数据库或 OSS
- 实际变更文件：apps/web/package.json、index.html、tsconfig.json、tsconfig.test.json、vite.config.ts、.env.mock、README.md、src/main.tsx、App.tsx、styles.css、theme.css、ui.tsx、api/client.ts、api/index.ts、api/mock.ts、test/unit.test.ts、test/browser.test.ts、test/generate-media.ts、test/mock-media-plugin.ts、test/fixtures/demo.webm
- 完成说明：React/Router/Vite 骨架、同源 Cookie/CSRF 客户端、共享 DTO、显式开发 Mock 与统一状态已建立；主控串行安装精确依赖。typecheck、生产 build、3 项 API 单元测试和 Edge 375px 骨架浏览器场景通过。生产未启用 Mock；真实业务接口未交付，不能作为真实联调结果。
- 完成时间：2026-10-01
- 阻塞原因：

### WEB-02：登录、TOTP 与会话

- 状态：DONE
- 优先级：P0
- 前置依赖：WEB-01；真实对接 CORE-03
- 需求描述：提供本人进入私有系统的登录及退出体验。
- 实现要求：
  - 实现密码/TOTP 输入、登录错误、恢复入口和退出，不展示公众注册。
  - 加载当前会话，统一处理过期/撤销；不以本地标记作为后端授权证明。
  - 会话由 Cookie 管理，不保存会话或长期凭证到 localStorage。
  - 恢复流程严格按 CORE-03 的受保护设计对接，不独立创建匿名重置接口。
- 计划变更范围：apps/web/src/ 的 auth 页面、路由保护和测试。
- 验收条件：正确登录、错误验证码、会话过期和退出路径可验证；敏感页面恢复行为清晰。
- 影响范围：前端鉴权页面、路由保护、客户端错误处理及开发 Mock
- 实际变更文件：apps/web/src/auth.tsx、pages/Login.tsx、App.tsx、styles.css、api/client.ts、test/unit.test.ts、test/browser.test.ts
- 完成说明：密码/TOTP、退出、/auth/me 会话恢复、统一失效与受保护恢复提示实现；不保存真实会话或凭证到 localStorage，不创建匿名重置。typecheck、4 项单元及错误登录/过期/退出 Edge 场景通过。CORE-03 真实登录和恢复操作未交付，仍待联调。
- 完成时间：2026-10-01
- 阻塞原因：

### WEB-03：分类、搜索与视频库

- 状态：DONE
- 优先级：P0
- 前置依赖：WEB-01；真实对接 CORE-04、MEDIA-06
- 需求描述：实现容易在手机上找到视频的列表与管理界面。
- 实现要求：
  - 分类筛选、标题搜索、分页列表、封面、时长和处理状态；提供未分类、空态与错误状态。
  - 分类创建/重命名及视频标题/分类修改通过受保护 API 完成。
  - 提供已有 OSS 视频预览、勾选和导入入口，对接 MEDIA-06；仅处理后端验证过的授权条目。
  - 详情显示可信元数据，封面不存在时使用占位，不以原片地址替代。
  - 触控、横竖屏及长标题布局合理，不提供永久删除或公开分享。
- 计划变更范围：视频库、分类、详情元数据及编辑组件和测试。
- 验收条件：筛选与分页条件一致，编辑成功后刷新正确内容，null 元数据和无封面正常展示。
- 影响范围：前端视频库、分类、详情编辑与选择性导入
- 实际变更文件：apps/web/src/pages/Library.tsx、pages/Categories.tsx、pages/Video.tsx、App.tsx、styles.css、test/browser.test.ts
- 完成说明：标题搜索/分类筛选更改会重置分页，URL 保留筛选条件；无封面/null 元数据与兼容状态明确。分类及标题编辑、后端预览 ID 勾选导入实现。typecheck 和 Edge 375px 搜索/分页/编辑/导入场景通过；CORE-04、MEDIA-06 真实 API 待验。
- 完成时间：2026-10-01
- 阻塞原因：

### WEB-04：在线播放与观看记录

- 状态：DONE
- 优先级：P0
- 前置依赖：WEB-03；真实对接 MEDIA-02、CORE-05
- 需求描述：提供 A 方案播放、拖动、全屏和续播体验。
- 实现要求：
  - 创建播放会话，HTML5 Video 使用站内 sourceUrl，维护 heartbeat/close，不自行拼 OSS 地址。
  - 按原视频比例显示，支持暂停、拖动、全屏和观看位置保存/恢复。
  - 区分加载、缓冲、格式不支持、会话失效和流量限制，避免无限重试。
  - 高码率视频允许出现带宽提示，不默认压缩、改用下载或回退到 B。
- 计划变更范围：播放器、播放页、进度交互和测试。
- 验收条件：Mock 的交互与真实 Range 播放分别验证；浏览器请求保持 A 模式，进度恢复与离开清理可靠。
- 影响范围：前端 A 模式播放器、观看进度和会话清理
- 实际变更文件：apps/web/src/player.tsx、pages/Video.tsx、styles.css、test/browser.test.ts
- 完成说明：站内 sourceUrl/mode 校验、native video controls/完整比例、heartbeat/close、观看位置读取与顺序保存、异常/缓冲/限额反馈完成。Edge 的开发合成 VP8 原生播放、拖动、Mock 206 与进度恢复通过；仅为开发样例，真实后端 Range、鉴权/计量和安卓真机/原片兼容性待验。
- 完成时间：2026-10-01
- 阻塞原因：

### WEB-05：手机上传与续传

- 状态：DONE
- 优先级：P0
- 前置依赖：WEB-01；真实对接 MEDIA-04
- 需求描述：实现可感知进度、可恢复的手机视频上传。
- 实现要求：
  - 选择视频、标题和分类；按后端 partSizeBytes 分片，展示进度、状态和失败原因。
  - 支持重试和暂停，恢复时读取服务端任务并核对重新选择的文件；不只按同名续传。
  - 逐片处理，避免将完整大视频加载进内存；完成由服务端确认，不仅靠进度条判断。
  - 提示锁屏/切后台可能中断，页面重开后保留可恢复任务信息，不保存敏感授权。
- 计划变更范围：上传页面、分片客户端、任务状态组件和测试。
- 验收条件：失败重试、页面重开、错误文件和任务完成状态均正确；无法支持后台上传时如实提示。
- 影响范围：前端上传客户端、任务提示、状态恢复与开发 Mock
- 实际变更文件：apps/web/src/upload.ts、pages/Upload.tsx、App.tsx、styles.css、api/mock.ts、test/unit.test.ts、test/browser.test.ts；协作审阅修正 src/player.tsx 的关闭竞态与重播
- 完成说明：服务端分片尺寸、单片 SHA-256/小写 hex、顺序上传、暂停/人工重试、任务提示按用户/API模式隔离、重开文件重选后核对全部完成片实现；failed/finalizing/completed 已齐片可仅重试 complete，拒绝未齐片和假完成。typecheck、7 项单元（禁止整文件读取/文件不匹配/完成恢复等）、Mock Edge 分片失败/暂停/重开/错误文件/完成失败恢复通过。真实 MEDIA-04/OSS/安卓后台行为待验；单片超过64MiB明确拒绝，不擅自改尺寸。
- 完成时间：2026-10-01
- 阻塞原因：

### WEB-06：安全、会话与应用用量

- 状态：DONE
- 优先级：P0
- 前置依赖：WEB-02；真实对接 CORE-05、MEDIA-03
- 需求描述：让本人可查看会话、撤销访问并理解应用流量限制。
- 实现要求：
  - 显示登录会话和撤销操作，撤销当前会话时更新本地页面状态。
  - 显示应用代理流量、周期、时区、限额和活动播放会话，明确不是云账单。
  - 显示当前为 A 模式，不提供未实现的 B 切换按钮或费用封顶承诺。
  - 限额到达、来源未知和统计不可用时使用明确提示，不捏造剩余量。
- 计划变更范围：安全/用量页及相应组件、测试。
- 验收条件：页面字段与 ApplicationUsage 一致，撤销和限额反馈正确，无秘密配置泄露。
- 影响范围：前端会话管理、安全状态和应用代理用量
- 实际变更文件：apps/web/src/usage.ts、pages/Security.tsx、App.tsx、styles.css、api/mock.ts、test/unit.test.ts、test/browser.test.ts
- 完成说明：当前/其他会话查看与撤销；严格检查 source、统计字节与时区、限额三态及0限额，明确应用统计非云账单。typecheck、8 项单元及 Mock Edge 会话撤销/限额/未知来源/用量不可用场景通过。CORE-05/MEDIA-03 真实计量和会话接口未联调。
- 完成时间：2026-10-01
- 阻塞原因：

### WEB-07：安卓适配、界面验证与交接

- 状态：DONE
- 优先级：P0
- 前置依赖：WEB-02～06
- 需求描述：完成前端自测并交付主控做完整真实链路联调。
- 实现要求：
  - 覆盖手机宽度、横竖屏、触控、空态、长文本和关键异常场景。
  - 使用 Playwright 等必要工具验证页面；真实安卓的上传/播放单独记录，不以模拟器通过替代真机。
  - 关闭或明确隔离开发 Mock，提供 API 地址、代理和启动参数给主控。
  - 交付问题清单及对应接口任务，不直接修改后端绕过失败。
- 计划变更范围：前端测试、界面调整和运行/交接说明。
- 验收条件：前端构建及必要检查通过，真实 API 与 Mock 验证状态准确，可由 INT-03 完成端到端验收。
- 影响范围：前端交互补验、时区/可访问性修正、生产Mock隔离、截图与交接
- 实际变更文件：apps/web/HANDOFF.md、README.md、package.json、tsconfig.test.json、vite.config.ts、src/styles.css、ui.tsx、player.tsx、upload.ts、pages/Security.tsx、pages/Login.tsx、api/mock.ts、test/browser.test.ts、production.test.ts、generate-media.ts、mock-media-plugin.ts、fixtures/portrait.webm；qa/2026-10-01T15-34-53-169Z、qa/2026-10-01T15-39-06-464Z、qa/2026-10-01T15-43-01-595Z 的稳定截图（保留旧qa文件）
- 完成说明：typecheck、8项Node单元、7个Edge功能场景（TAP含父测试8项）与1项实际生产入口验证通过。覆盖320/375px及812×375、360×640合成竖视频、20s heartbeat、完成重播新会话、离开会话归零、150%字号/减少动态效果、长文本/空态/网络与统计异常、撤销焦点/Escape。生产实际chunk无Mock凭据/fixture，build保留旧产物；最终截图和真实待验清单见apps/web/HANDOFF.md。真实3000 health当前未监听，业务API/OSS/安卓未验，不以Mock代替。
- 完成时间：2026-10-01
- 阻塞原因：

## 4. 完成记录

- 2026-10-01 [WEB-07] DONE：前端最终自测和交接完成；8单元、7Edge功能场景、1生产隔离通过。真实API/OSS/安卓待主控按HANDOFF推进。
- 2026-10-01 [WEB-06] DONE：登录会话撤销、应用代理用量与限制反馈；8 项单元及 Mock Edge 三态/未知来源/不可用验证通过。
- 2026-10-01 [WEB-05] DONE：逐片上传和强校验续传、任务提示及完成确认恢复；7 项单元与 Mock Edge 主流程通过，真实上传链路待验。
- 2026-10-01 [WEB-04] DONE：原生 A 模式播放器、观看记录与清理；合成 VP8 开发流 206、拖动及恢复通过，真实链路/手机原片待验。
- 2026-10-01 [WEB-03] DONE：库、分类、详情元数据与选择性导入，typecheck 及手机视口交互场景通过；真实 CORE-04/MEDIA-06 待验。
- 2026-10-01 [WEB-02] DONE：登录/TOTP、会话保护及退出的 Mock 浏览器场景通过；真实 CORE-03 恢复流程待对接。实际文件见卡片。
- 2026-10-01 [WEB-01] DONE：前端骨架、同源 API/CSRF 与显式开发 Mock；typecheck/build、3 项单元测试、375px Edge 场景通过。真实业务 API/OSS/安卓未验；详见任务卡实际文件。

# 媒体与前端并行开发交接

> **历史产物整理（2026-10-26）**：用户已授权清理 `apps/web/qa/` 的旧截图、日志和报告，下文此目录的证据路径仅作历史记录，不再表示文件仍存在。测试源码及 `.local/acceptance/` 的资料保留；详见[清理记录](README.md)。

> **历史归档（2026-10-26）**：原位置 `docs/PARALLEL_DEVELOPMENT_HANDOFF.md`。以下保留历史设计与完成记录，不作为当前任务指令；当前工作见[未完成工作清单](../task/UNFINISHED_WORK.md)，归档范围见[归档索引](README.md)。

后续进展：用户已授权并完成 CORE-02/03，真实本人账号、数据库与登录方式见 [ACCOUNT](../ACCOUNT.md) 和 [DATABASE](../DATABASE.md)。本文件保留媒体/前端独立交付时的验证记录。

日期：2026-10-01。用户确认 CORE-01 后，子代理 2、3 并行实施各自全部 P0 任务；主控负责共享接口、依赖串行安装及独立复核。

## 1. 交付和当前可用范围

| 交付 | 入口与详细说明 |
| --- | --- |
| MEDIA-01～07 媒体模块 | [模块入口](../../apps/api/src/modules/media/index.ts)、[媒体交接](../../apps/api/src/modules/media/HANDOFF.md)、[媒体任务板](.ai/demand/02-media.md) |
| WEB-01～07 安卓优先网站 | [前端运行说明](../../apps/web/README.md)、[前端交接](../../apps/web/HANDOFF.md)、[前端任务板](.ai/demand/03-frontend.md) |
| 当前公共契约 | [API_CONTRACT V0.3](../API_CONTRACT.md)、[共享 DTO](../../packages/shared/src/dto.ts)、[服务端接口](../../apps/api/src/core/contracts/index.ts) |
| 工程基线 | [CORE-01 交接](CORE01_HANDOFF.md)，记录的是本轮之前的骨架验证；当前运行命令和依赖以本交接及 package.json 为准 |

媒体模块包含 Mock/OSS 存储、A 方案 Range/HEAD、鉴权接入、流量原子预留/结算、播放并发、流式分片续传、完成恢复、受控 FFprobe 分析和选择性导入。前端包含登录、分类搜索、详情编辑、原生播放器、观看记录、上传续传、安全会话和用量页面。

当前可独立运行的是**显式开发 Mock 前端**，用于预览页面和交互。默认 API 启动入口仍只有 health；真实账户、SQLite Repository 及生产装配属于尚未启动的 CORE-02～06。媒体模块已可通过 buildApp 注入测试依赖，前端真实 API 客户端已准备，但完整真实链路未验收。不能将本轮完成解释为已经连接本人 OSS、真账号或真实视频。

## 2. 安装、预览和检查

基线：Node.js 22.21.1（允许 >=22.21.1 <23）/ npm 10。依赖更新和 package-lock.json 由主控串行管理；不并发安装，不通过删除 node_modules/缓存/构建目录解决问题。

当前依赖已安装；需要补安装时，在根目录使用：

```powershell
Set-Location E:\onlineVideo
npm install --ignore-scripts --no-fund
```

直接预览前端：

```powershell
npm run dev:web:mock
```

打开 `http://127.0.0.1:5173`。Mock 登录密码为 `demo-password`，验证码为 `123456`；仅为公开开发样例，不能作为真实账户使用。页面有持续可见的 Mock 标记。合成视频已在 test/fixtures 中，不需要真实视频或 FFmpeg 才能预览。上传模拟完成保持 processing，不伪造格式分析与 OSS 成功。

默认真实 API 模式：`npm run dev:web`；后端健康骨架：`npm run dev:api`。前端 `/api` 代理到 `http://127.0.0.1:3000`，同源 Cookie/CSRF；目前缺失的真实业务接口会正常报错。Vite 固定 5173 且 strictPort，Fastify 固定 3000，均不自动换端口。发生占用时只读检查，不终止其他进程。

完整验证命令（浏览器两项使用同一端口，必须顺序执行）：

```powershell
npm run check
npm run test:e2e -w @online-video/web
npm run test:production -w @online-video/web
```

`check` 包含 shared/浏览器消费者/api/web 类型检查、单元与接口测试、shared→api→web 构建。浏览器验证使用本机 Edge + Playwright，无需另外下载浏览器；真实安卓仍单独验收。Vite emptyOutDir=false，保留旧构建输出；生产隔离检查核对 dist/index.html 实际引用的 chunk，不以清空目录作为通过条件。每次浏览器验证在唯一 qa 日期目录保存截图，保留既有图片。

## 3. 主控协调的公共变更

- 根目录增加 dev:web、dev:web:mock，build 纳入 web；新增 frontend 工作区由 npm 自动链接。公开的 apps/web/.env.mock 只含 VITE_API_MODE=mock，作为源码交付；其他 .env/secret 仍不进入版本库。
- VideoRepository 新增 assertCategoryOwned，在建立 Multipart 或导入前校验分类归属；register 约定 ownerId + originalObject.key 的原子幂等，新登记再次校验分类，已有对象原样返回且不覆盖元数据。
- 导入 preview 必须提供字符串 prefix；明确空串选择服务端授权根范围，非空仅允许该范围下的目录前缀。对象 key/ETag/OSS 上传 ID 不进入前端 DTO。
- UploadRepository 支持单 API 实例任务锁内的 finalizing→finalizing 状态校验及完成恢复；同状态 CAS 不提供跨进程互斥，多实例需持久化租约。
- 契约仍采用逐片 SHA-256 / 小写 64 位 hex、x-part-checksum、x-csrf-token。后端分片上限 16MiB；前端按服务端尺寸逐片处理，额外对超过浏览器 64MiB 安全边界的单片明确拒绝，不自行改片长。

上述变更已同步 API_CONTRACT、服务端接口/注册检查和默认失败安全测试替身，未提前开发 SQLite 或正式登录模块。

## 4. 独立复核证据

| 检查 | 本轮主控实际结果 |
| --- | --- |
| npm install --ignore-scripts --no-fund | 新增 118 包，审计 179 包，执行时 0 漏洞；npm ls 无缺失依赖 |
| npm run check | exit 0；shared/api/web 及浏览器消费者类型通过，三包构建通过 |
| 后端测试 | 30 项通过：7 项工程基线 + 23 项媒体验证 |
| 前端单元 | 8 项通过：同源/CSRF、畸形 401 清会话、逐片校验/续传、完成恢复、用量三态 |
| Edge 浏览器 | 7 个功能场景通过（TAP 含父测试为 8）：登录/库编辑/导入、原生横竖视频/206/心跳/重播、暂停重开/错文件/失败完成恢复、会话撤销、限额/未知来源、320/375/812px、150% 文字、触控/空态/长标题/异常 |
| 实际生产入口 | 1 项通过：当前入口引用 chunk 无 Mock/开发凭据/fixture，浏览器默认请求站内真实 API，无 Mock 控件 |
| 视觉复核 | 已读取加载完成的库/上传/安全页及横竖播放器 PNG；统计周期按返回时区显示，原视频比例以 contain 保留 |
| 数据与环境边界 | sqlite-test.db SHA-256 仍为 E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855，PRD 未变；未写数据库/迁移、未连真实 OSS、未改云权限/服务器、未清理用户数据或缓存、未开发 B；最终构建保留已有输出 |

主控最终浏览器截图在 `apps/web/qa/2026-10-01T15-46-39-606Z/`；例如 手机竖视频（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/2026-10-01T15-46-39-606Z/phone-portrait-player.png`）、上传页面（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/2026-10-01T15-46-39-606Z/phone-upload.png`）。此前代理 QA 也全部保留。验证服务已正常退出，复核时 3000/5173 没有监听服务，仅可能存在正常 TCP TIME_WAIT。

媒体测试的真实 HTTP 和真实 ali-oss SDK 只到本机受控服务，Repository 是 Fake；FFprobe 子进程测试使用受控 Node fixture，未将它说成真实 FFprobe。前端浏览器使用开发 Mock 和合成 VP8 测试视频。生产构建浏览器测试用路由拦截返回标准 401，验证默认真实 API 选择与 Mock 隔离，不能替代真实账户安全测试。

## 5. 后续接入项

1. 后端 CORE-02～05 实现持久化 Repository、账户/TOTP/会话/CSRF、分类/元数据/观看记录和用量。遵守新增分类预检、对象原子幂等、上传 CAS、播放会话与用量预留/结算契约。不能将测试鉴权装入生产。
2. CORE-06 选择 createMediaModule 的明确资源限制/授权前缀/分析器及真实安全依赖，统一装配。现有 readConfig/buildApp 的生产和 OSS 安全拒绝仍保留；不能仅移除检查以宣称接入完成。
3. 主控 INT 任务进行真实前后端登录→分类→上传→播放→续播联调。账户受保护初始化/恢复流程须以 CORE-03 设计接入；前端当前提供受保护恢复说明，没有匿名重置接口。
4. 真实 OSS、杭州内网/来源授权、私有权限、FFprobe 参数与手机原片、超内存大文件/安卓锁屏切网、3Mbps 传输、持久化重启恢复均待实际环境验证。预算、统计时区、授权前缀及服务器部署未擅自设定。

本轮只完成媒体和前端独立模块及共享协调，没有自动启动 CORE-02 或部署/B/原生 App/PWA 视频缓存任务。

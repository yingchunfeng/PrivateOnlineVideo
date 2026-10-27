# WEB-01～07 前端交接

> **历史产物整理（2026-10-26）**：用户已授权清理 `apps/web/qa/` 的旧截图、日志和报告，下文此目录的证据路径仅作历史记录，不再表示文件仍存在。测试源码及 `.local/acceptance/` 的资料保留；详见[清理记录](../../docs/archive/README.md)。

第二阶段最新交付与待验见本文末尾。下列第一阶段记录保留为历史；不代表第二阶段直连已完成真实 OSS 验收。

日期：2026-10-01。前端 P0 源码和本地自测已完成；`.ai/demand/03-frontend.md` 已逐卡回写。真实账户/Repository 与最终媒体装配尚需主控 CORE-02～06、INT-01～03 接入，真实安卓与 OSS 未验。

## 实际交付

| 任务 | 实现 | 本地证据 |
| --- | --- | --- |
| WEB-01 | React 19.3/TypeScript/Vite 8.3/Router 7.18，站内 Cookie/CSRF API、共享 DTO、显式开发 Mock、加载/空态/错误布局 | typecheck、生产 build、API 单元和手机路由场景 |
| WEB-02 | 密码/TOTP、`/auth/me` 恢复、统一 401 失效、退出、受保护恢复说明 | 错误验证码、登录、过期、退出与受保护入口场景；畸形 401 先清会话 |
| WEB-03 | 分类筛选、标题搜索、URL 分页、封面占位、null 元数据、分类创建/重命名、视频编辑、选中预览 ID 导入 | 手机筛选条件重置分页、编辑刷新、选择性导入场景 |
| WEB-04 | 只接受站内 proxy sourceUrl，HTML5 native controls/playsInline/完整比例、20s heartbeat、close、观看进度、重播与异常提示 | 合成 VP8 206 流、播放/拖动/暂停/位置恢复、真实计时 heartbeat、完成后新会话从0重播、离开活动会话归零；原生流出错后查询会话/应用用量 |
| WEB-05 | 后端尺寸逐片 SHA-256/64位小写 hex、顺序 PUT、暂停/手动重试、提示保存、重开文件强核对、服务端完成确认及恢复 | 禁止整文件 arrayBuffer、仅补缺片、同名同大小不同数据拒绝、暂停/重开、complete失败/遗留finalizing恢复、未齐片/假完成拒绝 |
| WEB-06 | 本人会话列表/撤销、当前会话失效、代理用量周期/时区/活动会话、三种 limitMode | 三态/0限额/达到限额、未知来源/统计不可用、安全撤销及焦点/Escape 验证 |
| WEB-07 | 手机触控与响应式，开发 Mock 和生产严格隔离，验证脚本、截图及本交接 | Edge 的320px/375px/812×375、360×640合成竖视频、长标题/空态/网络异常、150%字号/减少动态效果；生产入口独立验证 |

源代码全部在 `apps/web/`，不引用服务端、数据库、内部对象 key 或长期秘密。语义 CSS 与深色令牌、自有 SVG 图标、48px 主要控件、安全区及底部导航由前端维护。没有永久删除、公开分享、B 切换、原生 App、PWA 缓存或服务器配置动作。

## 启动与验证

从 `E:\onlineVideo` 执行。版本核验、安装与共享锁文件由主控串行处理；前端没有独立安装或更改根锁文件。

```powershell
npm run build -w @online-video/shared
npm run dev -w @online-video/web
```

默认 http://127.0.0.1:5173，`/api` 同源代理到 http://127.0.0.1:3000；`strictPort:true`，不会自动换端口或终止占用进程。API 地址改变时由主控同步 `vite.config.ts` 代理。默认真实业务，不因服务不可用回退 Mock。

明确开发 Mock：

```powershell
node --import tsx apps/web/test/generate-media.ts
npm run dev:mock -w @online-video/web
```

Mock 登录为 `demo-password` / `123456`，仅公开开发样例。固定 Mock 横幅和场景选择器持续显示。Mock 使用专用 Cookie 模拟会话；不代表生产鉴权。业务模拟记录位于 sessionStorage；仅提示任务的 ID/文件名/尺寸/时间保存到按用户与模式隔离的 localStorage，不保存真实 Cookie、CSRF、密码或视频内容。刷新后读取服务端任务并重新选择原文件；大小与全部已完成片 SHA-256 均匹配才续传。文件名相同不会跳过校验。

上传通过站内 `/uploads`、`/parts/:number`、`/complete`。每次只读一个分片，PUT 带 `application/octet-stream`、`x-part-checksum`、`x-csrf-token`；并发为1。客户端分片安全上限64MiB，媒体模块16MiB上限已由主控确认相容；不自行调整返回的 partSizeBytes。进度只累计服务端确认的分片。complete 是权威确认，failed/finalizing 已齐片可重新确认，completed 可幂等查询原视频。开发上传不写OSS，完成后的模拟视频仍是 processing，不冒充格式检查通过。

```powershell
npm run typecheck -w @online-video/web
npm test -w @online-video/web
npm run test:e2e -w @online-video/web
npm run test:production -w @online-video/web
```

| 实际检查 | 结果与边界 |
| --- | --- |
| typecheck | 浏览器源码、配置与 Node/Playwright 测试通过 |
| Node 单元 | 8项通过：API/CSRF/401/错误码、逐片校验和续传、完成恢复、用量三态 |
| Edge Playwright | 7个功能场景通过；Node TAP 计入父测试显示8个。使用本机Edge，真实计时20s heartbeat；总运行约45s |
| 生产检查 | 1项通过：实际 `dist/index.html` 引用的 JS 无 Mock凭据/状态/样例入口、无 AccessKey；生产浏览器无Mock控件，且发起站内 `/auth/me`。该浏览器场景对会话响应做401隔离替身，不宣称真实登录 |
| build | 最新入口 JS309.05kB/gzip97.73kB；CSS9.60kB/gzip2.77kB。Mock动态模块及测试WebM未发布 |
| 主控独立复验 | 根 `npm run check` exit0：后端30项、前端8项单元、shared浏览器消费者/API/Web类型和三包构建通过；独立e2e7场景与production1项通过。最后仅移除登录恢复文案里的技术任务编号，重新build/production通过 |
| API只读尝试 | 当前 GET `127.0.0.1:3000/api/health` 连接失败，netstat未显示3000监听；没有为此启动或终止后端，未记录真实接口成功 |
| 安卓真机/真实OSS | 未验，留给INT-03/媒体真实环境；Edge手机视口不能代替真机 |

浏览器脚本都在 `finally` 中优雅关闭自己的 Vite/浏览器，5173测试必须串行。生产配置使用 `emptyOutDir:false` 保留已有构建文件；核对当前 index 引用的 chunk，未清空目录。所有截图按UTC唯一目录生成，旧图保留。

## 最终稳定截图

本轮最新自测目录 `qa/2026-10-01T15-43-01-595Z/`，等待页面数据就绪再截取。它们都是开发 Mock，不代表真实媒体或安卓验收。

主控独立重复验证另存 `qa/2026-10-01T15-46-39-606Z/`，已视觉复核竖播放器、分类加载完毕的库与上传页及UTC周期。旧图保留。

- 手机视频库（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/2026-10-01T15-43-01-595Z/phone-library.png`）
- 长标题布局（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/2026-10-01T15-43-01-595Z/phone-long-title.png`）
- 横屏播放器（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/2026-10-01T15-43-01-595Z/landscape-player.png`）
- 竖视频播放器（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/2026-10-01T15-43-01-595Z/phone-portrait-player.png`）
- 安全与UTC用量（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/2026-10-01T15-43-01-595Z/phone-security.png`）
- 手机上传（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/2026-10-01T15-43-01-595Z/phone-upload.png`）

## 真实联调清单

| 依赖任务 | 主控需补验 |
| --- | --- |
| CORE-03 | 真实密码/TOTP、HttpOnly/Secure/SameSite Cookie、来源/CSRF、登录限流、过期/撤销、受保护恢复具体指引；前端未添加匿名重置 |
| CORE-04/05 | 分类默认ID、搜索分页、编辑、观看进度持久化、会话撤销和真实计量字段 |
| MEDIA-02/03 | Cookie鉴权的 HEAD/Range/206/416、并发、真实字节计量、上限中止、native video失败诊断、断开取消；不把开发fixture代理当真实OSS |
| MEDIA-04/05 | 真实上传完整对象/登记/metadata、同编号幂等、冲突、failed/finalizing重启恢复、不兼容原片；客户端checksum不代表真实对象完成 |
| MEDIA-06 | 空prefix解析到授权根范围、预览/选中ID再次验证授权与存在性、实际用户指定前缀 |
| INT-03 | 真安卓前台上传/锁屏中断/切网/文件重选、native拖动/全屏/音量/续播、实际MP4/H.264/AAC及HEVC/MOV、3Mbps条件缓冲 |

手机实际访问要由主控明确监听和可信站点来源，并提供HTTPS安全上下文，Web Crypto不能因HTTP LAN不可用而跳过校验。前端不会放宽CORS、关闭生产Cookie保护或保存长期OSS凭据。

对于不兼容原片，界面保留原文件并明确建议离线生成新兼容副本后导入；具体处理由后续真实格式验证确定。例如具备FFmpeg的独立环境可使用 `ffmpeg -n -i 原片.mov -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart 兼容副本.mp4`，`-n`禁止覆盖。这里仅给指引，本轮未安装FFmpeg、转换用户视频或覆盖数据。

尚未联调项是外部依赖和实机验收，不隐藏为已完成。主控已独立通过根 `check` 和前端浏览器检查；下一步完成真实后端装配后执行INT-03完整链路。

## 第二阶段交接（2026-10-02）

P2-WEB-01～05全部完成本阶段交付，P2-WEB-04真实私有OSS/900秒STS与浏览器原片下载已补验，最终记录见本文末节。原生安卓后台、最终网站HTTPS与额外fetch/CORS规则留第三阶段。复用原工程与本人登录协议，没有读账户初始化资料/长期AK/实际数据库；本轮Node验收只读取具体批准的短期Cookie/CSRF。

| 卡 | 当前实现与实际证据 |
| --- | --- |
| P2-WEB-01 | 真 Cookie/password/TOTP/me/logout/sessions/revoke；畸形 JSON 401 先清会话并返回失效状态；隔离真实 AuthService、Argon2id/TOTP、HttpOnly/SameSite Cookie、刷新恢复、退出/撤销/过期 401 均已在浏览器验证 |
| P2-WEB-02 | 分类/分组/标签创建、名称/排序/描述、归档恢复、默认分类保护；多选 AND、改条件重置页码、详情关联与真 PATCH；归档历史仅改标题成功，取消关联后 removed_at SQL 保留，DB 重开后数据与观看进度仍在 |
| P2-WEB-03 | 上传组织 ID 与恢复快照、2 GiB 公开上限拦截、分片 SHA-256；真 HTTP 两片暂停/重开/同名同大小错文件拒绝/完整登记；已有对象 100 条分页、opaque cursor 下一批、选中 ID 导入与标签 SQL 持久化。旧记录单对象绑定先拒绝错 key，再核验精确匹配并保留 ID/标题/归档分组/观看位置 |
| P2-WEB-04 | 显式 proxy/oss、精确媒体 Origin/协议/前缀、12 秒授权同会话续签/暂停及播放状态恢复、真实浏览器 Range 206、原片下载字节一致；媒体 403 类错误最多两次重新鉴权，重复同秒 URL 显式 load；撤销后 source 401，但旧链接 206，安全页实际字节 null/未同步；proxy 真字节回归 |
| P2-WEB-05 | 独立回环端口 Edge Playwright；375/320px、812×375、触控、150%文字和长中文标签、空态/关键错误；全链使用独立 SQLite 与真实 auth/API、ali-oss SDK 及独立 V4 HMAC 本地协议服务，优雅关闭自有服务；完整新发布目录扫描通过 |

最终检查命令与结果：

```powershell
npm run typecheck -w @online-video/web
npm test -w @online-video/web
npm run test:e2e -w @online-video/web
npm run test:stage2 -w @online-video/web
npm run test:production -w @online-video/web
npm run build:release -w @online-video/web
```

类型检查通过；单元 14 项通过；Mock 7 个浏览器子场景通过（TAP 8）；隔离真 HTTP 7 个子场景通过（TAP 8，约25秒）；生产入口及所有引用 chunk 检查 1 项通过；独立发布目录全文件扫描与 SHA-256 清单完成。`test:stage2` 使用原合成 VP8 WebM（为两片验证附加尾部字节），分析器受控注入，不能当作真实手机编码或 FFprobe 验收。Ali-OSS 的临时凭证刷新建议是测试 SDK 输出，测试没有读取长期密钥。

本轮当前发布产物为 `dist/stage2-release-2026-10-02T15-40-47-545Z/`，清单：[manifest.json](dist/stage2-release-2026-10-02T15-40-47-545Z/manifest.json)。该目录只有当前 index/JS/CSS/清单，全目录无 Mock、长期凭据、数据库或 Node 模块引用。此前 14:21 的独立目录、普通 dist 历史文件与失败构建遗留全部保留，不能混入本次发布包。当前 JS 325.83kB/gzip102.94kB，CSS10.25kB/gzip2.90kB。未发布或部署。

最新真 HTTP 截图目录 `qa/stage2-2026-10-02T14-20-00-951Z/`，日志：本地完整链 TAP（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/stage2-browser-final-2026-10-02T14-20.log`）。截图已视觉检查，包含开发合成样例标识，均非真实云/安卓设备：

- 真 HTTP 手机视频库（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/stage2-2026-10-02T14-20-00-951Z/phone-library.png`）
- 签名直连播放器（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/stage2-2026-10-02T14-20-00-951Z/phone-direct-player.png`）
- OSS 未同步用量（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/stage2-2026-10-02T14-20-00-951Z/phone-oss-usage.png`）
- 150%文字及长标签（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/stage2-2026-10-02T14-20-00-951Z/phone-long-tags-150-percent.png`）
- 横屏组织筛选（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/stage2-2026-10-02T14-20-00-951Z/landscape-organization-filter.png`）

根 `.env` 两个公开字段 `VITE_MEDIA_ORIGIN/VITE_MEDIA_PREFIX` 与后端固定签名域名必须一致。前端仅接收限定对象的签名 URL，不接收完整 STS 密钥。生产不允许 HTTP 媒体源；仅本地协议测试在开发态显式 `VITE_ALLOW_LOCAL_MEDIA_HTTP=true` 允许回环 HTTP。video 未设置 crossOrigin，不把网站 Cookie 发送到 OSS，不做全量 fetch/blob 或 PWA 缓存。

第三阶段部署需在现有 CSP 中精确允许 `media-src 'self' https://oss.meetdawn.top`；若确实使用跨域媒体 fetch/HEAD，再在 `connect-src` 加同一固定 Origin 并核对 CORS。当前控制请求和上传只需站内 connect-src；下载采用授权后 noreferrer 原片附件，不依赖跨域 download 属性一定生效。不得改为通配域名；此处是配置交接，未操作服务器/CSP/CORS。

仍需材料与授权：P2-WEB-04 原生标签页/安卓后台返回、真实短剩余 STS 刷新、真实 OSS/CORS/HTTPS浏览器链及原片附件；P2-MEDIA-05 私有对象/小样例范围与费用具体授权后实施。最终 HTTPS 网站、安卓真机锁屏/切网/大文件与杭州内网归第三阶段。短样例 visibilitychange 模拟只验证处理入口；新增真实页面冻结恢复另见下节，两者都不能冒充真实安卓后台。本人正式账号/库迁移及云权限变更由主控单独明确目标和授权。

## P2-WEB-04 长文件与心跳补验（2026-10-02 15:41 UTC）

命令 `npm run test:stage2:long -w @online-video/web` 使用主控新建的隔离 `long-3600.mp4`（6411947 字节、3600 秒、H.264 Main/yuv420p、148×320、无音轨）；独立 SQLite/真实 auth/API、本地 V4 协议及真实 FFprobe `FFprobeMetadataInspector` 完成上传登记。该文件是新的测试副本，两个用户原样例未改。测试没有模拟 duration 或 currentTime 属性，位置通过原生 seek 设置并等待 seeking=false/解码就绪。

长测试 5 个子场景全部通过，TAP pass6/fail0/skip1、总97.55秒。原生屏幕外双tab/最小化探测始终返回 visible，因此该项明确 SKIP，不再调整浏览器 flags。另经批准使用浏览器真实 `Page.setWebLifecycleState frozen→active`，Node 实际等待14秒，验证页面冻结恢复；这不等同于原生 hidden/visible 或安卓后台。

| 补验 | 实际证据 |
| --- | --- |
| 长文件真元数据/解码 | 真 FFprobe、数据库和 HTMLVideoElement 均确认3600秒；尾位置3590秒、paused=true、seeking=false、readyState=4，buffered 为0～约45秒和3570～3599秒，未先全量缓存 |
| 中间/尾部Range | 实际浏览器 Range `bytes=3211264-` / `bytes=6356992-`；实际206响应 Content-Range分别为 `bytes 3211264-6411946/6411947` / `bytes 6356992-6411946/6411947`，中间/尾部及源重载读取均有记录 |
| 心跳根因与修复 | 修复前48,012ms发出0次心跳，初始/当前SQLexpiry相同，随后source403；原因是每次源续签重置依赖session对象的20秒effect。改为稳定session.id，handler读sessionRef且不调用source签发；修复后48,001ms有2次独立心跳，SQLexpiry从15:36:01.954Z延长到15:36:42.018Z |
| 迟到的源响应 | 第二次真source HTTP响应延迟6秒，跨真实20秒心跳；源捕获旧expiry15:36:01.954Z，交付时SQL已15:36:22.031Z。前端按同id取已确认/返回expiry最大值并同步setSession，不更改真实源有效期 |
| 冻结后授权过期 | 8秒应用授权、页面真实冻结14秒后，source403明确提示重新准备播放并保留3590秒；本人登录仍有效，重新准备恢复长位置 |
| 冻结后登录撤销 | 通过真实受保护revoke撤销隔离登录，冻结14秒再恢复；统一401返回登录页，同播放session/source明确401，未将播放授权403误作登录失效 |

原生 Range 证据使用明确的本地网络吞吐限制1MiB/s避免整个6MB样例被提前缓存；这是受控浏览器网络条件，既不是3Mbps实网、实际大文件内存证据，也不是持续观看一小时。没有真实 STS、OSS/CORS 或安卓设备操作。

证据目录与原始记录：

- 修复前心跳复现（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/stage2-long-2026-10-02T15-24-57-650Z/heartbeat-before-fix.json`）
- 修复后心跳/延迟响应/Range清单（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/stage2-long-2026-10-02T15-35-09-922Z/foreground-heartbeat.json`）
- 完整长测试TAP（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/stage2-long-final-2026-10-02.log`）
- 应用授权过期提示（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/stage2-long-2026-10-02T15-35-09-922Z/long-application-session-expired.png`）
- 登录撤销后的恢复（历史产物已于 2026-10-26 按授权清理；原路径：`apps/web/qa/stage2-long-2026-10-02T15-35-09-922Z/long-login-revoked.png`）

修复后再次通过 typecheck、14单元、短期真实全链7子场景/TAP8、proxy/Mock7/TAP8、production1及新独立发布全目录扫描。服务均已优雅退出；该时点P2-WEB-04维持DOING留实云条件补验，后续最终实云结果见下一节。

## 本人会话与真实私有 OSS 浏览器补验（2026-10-02）

用户已明确授权本轮两条小样例的私有对象上传/业务登记与少量公网读取。前端只使用主控提供的 `.local/acceptance/run-20261002-ces-private/` 短期 Cookie/CSRF，注入自有 HttpOnly/SameSite=Strict BrowserContext；没有读取本人账号初始化资料、长期 AK、ARN、auth.key 或真实数据库，也没有新增上传/组织项。实云入口为 `test/stage2-real-oss.test.ts`，默认不启用，必须显式指定经过主控交接的 phase 与本轮受保护 session 文件。

| 真实检查 | 结果与证据 |
| --- | --- |
| 本人恢复与组织 | 真 me/Cookie 恢复，库恰两条；未分类、同一验收分组和原片/兼容标签正确。原片 HEVC/AAC 为unsupported并明确保留/兼容提示；兼容 H.264/AAC 为ready |
| Native HTTPS私有播放 | Edge实际video.play/seek/pause，兼容5.909688秒、592×1280、position2/paused/readyState4；实际GET直达 `https://oss.meetdawn.top`，Range `bytes=0-`、206及 `bytes 0-460062/460063`。媒体请求未发送站点Cookie |
| 原片附件 | 兼容副本唯一一次完整浏览器附件保存到新.local文件，460063字节，SHA-256 `f7083ce3ecc34bf2639622d4144f545022570e9601f5f9fc447257fc459d12a4`。预留标记禁止重复完整下载；普通签名3600上限只记录实际到期，不声称已模拟过期 |
| 真900秒STS第一次续签 | 实际等待到17:17:59.195 UTC，初始媒体链接剩余871820ms、提前300000ms；同应用会话 `3293d74b-ccf1-42d1-ac59-83895d6d0a17`，暂停/位置2/ready4保持。凭证剩余缩短时新源仍到17:22:59，下一renewAfter为17:20:29.092（真实较短期限，半剩余期） |
| 第二次真实角色刷新 | 实际到17:20:29.498，进程内比较Token changed=true（Token不记录）；同id/暂停/位置2保持，新sourceExpiresAt17:35:01、renewAfter17:30:01。主控helper临时真实AssumeRole900秒，URL上限仍3600/提前300，.env未改成短值 |
| 撤销边界 | 真实退出后同播放会话source返回401；退出前刷新链接仅在内存保留，Node Range0-0读1字节仍206。未承诺立即废止已签链接；未知OSS字节文案持续正确 |
| CORS边界 | Native video未设置crossOrigin且真实成功；额外浏览器GET Range0-0/credentials omit的fetch不可读，准确记录为fetch/CORS规则待核验，不据此改权限或放宽CORS。不将native成功当成所有跨域fetch/HEAD能力已验 |

首次native失败得到 `net::ERR_BLOCKED_BY_ORB`。主控一字节GET定位真实OSS返回400/XML/InvalidRequest，根因是播放签名中的非法 `response-content-type` 覆盖参数。媒体代理最小移除该参数并重启API后，实际Object Content-Type为application/octet-stream、inline，浏览器原生H.264成功解码。未通过更改ACL、匿名访问、CORS或TLS绕过问题。

本轮真实基线报告为 `.local/acceptance/run-20261002-ces-private/browser-baseline-1790960761020-c6d6cbd7-bf31-4e88-b413-32cf62d82071.json`；真实12.5分钟短STS报告为同目录 `browser-short-1790960905830-e70bc8ff-d16d-4fc0-9af0-a3ac540912c1.json`。报告只留id、UTC到期、Origin/path、状态、Range、布尔和SHA，不保存签名URL、查询、Cookie、CSRF、Token、HAR/trace或错误正文。普通应用的Asia/Shanghai统计周期可能跨到10月3日，应用签发次数仍不等于云观看字节/账单。

正常3600秒模式恢复、实际API/SQLite进程重启后，以主控新建的受保护session-resume basename运行resume通过：本人会话、两视频状态/组织与position2恢复，页面“从0:02继续”可见；该phase媒体请求和签发均为0。报告为同目录 `browser-resume-1790961841929-b9b32c3a-7ad2-4f98-b44d-037353a94643.json`，progress updatedAt=2026-10-02T17:20:29.798Z。兼容附件通过仅引用旧baseline的唯一下载记录，不重复下载。主控已恢复业务上传前缀，既有验收对象位置不搬移；短参数仅helper临时覆盖，非改变角色或正式资源预算。

最终P2-WEB-04按本阶段功能与真实native浏览器链验收DONE：直连域名/TLS、授权、长位置、本地真正页面冻结恢复、实际STS剩余期/自动续签/角色刷新、同会话暂停状态、原片附件及重启进度均有证据。原生安卓后台/网站正式HTTPS与额外fetch/CORS配置作为第三阶段外部环境待验，没有将它们伪报已通过。baseline、short、resume自有浏览器/Vite已全部优雅退出；唯一兼容完整下载和本轮两个私有对象保留，不执行删除/移动或额外云写入。

私有样例截图在 `qa/stage2-real-*/`；长视频截图在 `qa/stage2-long-*/` 也来自用户片段生成的测试副本。这些文件仅本机审查，**不默认纳入Git、发布包或公开附件**；保持原位保留，不删除或移动。独立发布目录只包含index/JS/CSS/manifest，未包括这些私有帧。原生安卓后台、最终网站HTTPS与额外fetch/CORS规则仍归第三阶段准确补验；未宣称真实移动OS或持续观看一小时。

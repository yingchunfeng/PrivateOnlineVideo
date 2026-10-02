# WEB-01～07 前端交接

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

- [手机视频库](qa/2026-10-01T15-43-01-595Z/phone-library.png)
- [长标题布局](qa/2026-10-01T15-43-01-595Z/phone-long-title.png)
- [横屏播放器](qa/2026-10-01T15-43-01-595Z/landscape-player.png)
- [竖视频播放器](qa/2026-10-01T15-43-01-595Z/phone-portrait-player.png)
- [安全与UTC用量](qa/2026-10-01T15-43-01-595Z/phone-security.png)
- [手机上传](qa/2026-10-01T15-43-01-595Z/phone-upload.png)

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

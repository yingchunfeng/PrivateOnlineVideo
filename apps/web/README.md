# 前端本地运行

前端使用 React 19、React Router 7、Vite 8 和 TypeScript，保留浅色/深色主题、动态星空及响应式布局。页面和交互以真实 API 为默认入口，Mock 只用于明确启用的本地演示。

使用 Node.js `>=22.21.1 <23` / npm `10.x`，首次检出先在项目根目录执行 `npm ci`。后端安装与配置见[项目说明](../../README.md#首次安装)。

```powershell
cd E:\onlineVideo
npm run build -w @online-video/shared
npm run dev -w @online-video/web
```

打开 http://127.0.0.1:5173。默认真实 API，同源 `/api` 代理到 `http://127.0.0.1:3000`，开发端口占用会报错。另一个终端用 `npm run dev:api` 启动已准备数据库的后端；接口不可用时显示错误，不自动回退 Mock。

明确启用开发 Mock：

```powershell
node --import tsx apps/web/test/generate-media.ts
npm run dev:mock -w @online-video/web
```

Mock 登录：密码 `demo-password`，验证码 `123456`。这是公开开发样例，不能用于真实账户。页面持续显示 Mock 标识。Mock 会话由专用开发 Cookie 模拟，业务数据放 sessionStorage；两者均不代表后端授权，不装配到生产。上传内容仅逐片计算 SHA-256，不写真实 OSS；完成后 Mock 视频为 processing，不能冒充真实格式检查成功。开发 VP8 视频由本机浏览器 canvas 生成，不使用用户视频。

`vite build` 始终使用真实 API；`import.meta.env.DEV` 控制 Mock 动态导入，不因 `.env.mock` 进入生产。Mock 媒体 middleware 只在 `vite --mode mock` 开发服务注册。前端不包含 OSS 密钥、服务端依赖、数据库或 PWA 视频缓存。

## 管理页面与访客入口

- 首页入口名为“高光时刻”，页面路由保持 `/`，权限标识仍为 `library`；使用定宽定高的视频卡片，标题只占一行。搜索和标签筛选按需展开，不展示后台处理状态文字。动态 SVG 保留动画但不展示暂停按钮；布局与窄屏适配沿用现有主题样式。
- 配置、任务、页面和访客管理复用 `src/ui.tsx` 的 `TableContainer`、`Modal` 与 `src/management-ui.css`；列表只读，修改在弹窗内完成。系统设置与账户安全沿用各自流程。
- 页面管理区分当前浏览器外观和管理员配置的默认登录外观；全站设置及上传上限使用版本校验，未启用数据库持久化时不允许保存全站值。
- 管理员从 `/guests` 创建和管理访客，访客从 `/guest/login` 使用临时密码登录；前端菜单/路由按权限展示，真正授权由后端逐请求执行，不能只依赖隐藏按钮。
- 视频编辑、时长/封面补采和仅删数据库记录分别受操作权限控制；只读访客不自动请求写接口。OSS 公共直链不受站内期限控制，详细边界见[项目说明](../../README.md#管理页面与访客)。

检查命令（自有浏览器测试使用独立回环随机端口，构建和浏览器测试仍串行以避免文件变更触发页面重载）：

```powershell
npm run typecheck -w @online-video/web
npm test -w @online-video/web
npm run test:ui -w @online-video/web
npm run test:ui:batch2 -w @online-video/web
npm run test:ui:batch3 -w @online-video/web
npm run test:e2e -w @online-video/web
npm run test:e2e:setup -w @online-video/web
npm run test:production -w @online-video/web
npm run build:release -w @online-video/web
```

Playwright 使用本机 Microsoft Edge，不下载额外浏览器。测试以 `finally` 关闭浏览器和 Vite，不终止用户已有服务。分片 `File.slice()` 独立计算 SHA-256；64 MiB 是客户端单片安全边界，超出时拒绝并提示，绝不擅自更改服务端分片尺寸。任务提示只保存 ID/文件名/大小/创建时间，以账户和 Mock/真实模式分开；任何读取与写入仍依赖 Cookie 及 CSRF。

浏览器测试在本机生成截图、日志和隔离输出，具体目录由测试脚本选择，旧路径不代表文件仍存在。构建 `emptyOutDir:false`，不会主动清空已有产物。`build:release` 另建唯一的 `dist/stage2-release-<UTC时间>/`，扫描目录并写入 SHA-256 `manifest.json`；若手工发布，应选定并校验这一份目录，不混入历史文件。正式 Docker 构建使用干净镜像内的 Vite 产物，部署步骤见[服务器指南](../../docs/DEPLOY_1PANEL.md)。

## 媒体、上传与配置边界

当前公共读方案使用 API 返回的媒体地址直连播放，不要求新部署填写旧私有播放的前端签名参数。Vite 仍兼容读取根 `.env` 的 `VITE_MEDIA_ORIGIN`、`VITE_MEDIA_PREFIX` 两个公开键用于旧签名链接策略，不能把 AccessKey、SMTP 授权码或应用主密钥放进任何 `VITE_*` 变量。API 的 `NODE_ENV` 不改变前端构建模式，原 `apps/web/.env.mock` 仅为公开开发配置。

上传先读取受保护 `/api/settings/limits`，按服务端当前上限校验，不把初始 2 GiB 当成固定上限；管理员可在系统设置调整新任务限制。逐片 SHA-256、暂停/续传和服务端组织快照继续保留。导入只提交预览条目 ID；“确认既有记录位置”由服务端核对旧 key，保留原视频 ID、标题、组织和观看记录。

播放能力取决于浏览器支持的编码/容器，站内授权失效无法撤销已复制的公共 OSS 地址；控制 API 仍只接受站内 `/api/` 路径。旧私有播放会话、短期签名及 `test:stage2*` 兼容测试保留，不作为当前新部署的必经流程。真实 OSS/邮件测试须先明确样例与写入、费用范围，不因普通回归自动执行。

安卓真机、大文件和每次服务器更新后的业务验收单独记录；桌面手机仿真不代表真机通过。真实设备联调不能直接使用设备自己的回环地址，需要明确可信站点来源与监听地址，上传校验需要 HTTPS 安全上下文。前端不会自行开放 LAN、放宽 CORS 或修改后端 Cookie/来源保护。

`test/mock-media-plugin.ts` 被 Vite 配置引用，`test/release-build.ts` 及 `test/release-policy.ts` 被发布脚本调用，测试目录不是可整体忽略或删除的输出目录。普通回归源码和固定合成媒体继续随仓库发布；依赖本机历史授权的 `test/stage2-real-oss.test.ts`，以及截图、报告、覆盖率和随机测试输出只保留本机，不提交 Git。固定媒体夹具、数据库、密钥、备份及恢复资料不能据目录名称直接清理。

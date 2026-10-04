# 前端本地运行

使用 Node.js 22.21.1 / npm 10。依赖和根锁文件由主控串行管理。

```powershell
cd E:\onlineVideo
npm run build -w @online-video/shared
npm run dev -w @online-video/web
```

打开 http://127.0.0.1:5173。默认真实 API，同源 `/api` 代理到 `http://127.0.0.1:3000`，开发端口占用会报错。第二阶段接入真实组织、视频库、上传、播放授权与用量 API；接口不可用时显示错误，不自动回退 Mock。

明确启用开发 Mock：

```powershell
node --import tsx apps/web/test/generate-media.ts
npm run dev:mock -w @online-video/web
```

Mock 登录：密码 `demo-password`，验证码 `123456`。这是公开开发样例，不能用于真实账户。页面持续显示 Mock 标识。Mock 会话由专用开发 Cookie 模拟，业务数据放 sessionStorage；两者均不代表后端授权，不装配到生产。上传内容仅逐片计算 SHA-256，不写真实 OSS；完成后 Mock 视频为 processing，不能冒充真实格式检查成功。开发 VP8 视频由本机浏览器 canvas 生成，不使用用户视频。

`vite build` 始终使用真实 API；`import.meta.env.DEV` 控制 Mock 动态导入，不因 `.env.mock` 进入生产。Mock 媒体 middleware 只在 `vite --mode mock` 开发服务注册。前端不包含 OSS 密钥、服务端依赖、数据库或 PWA 视频缓存。

检查命令（自有浏览器测试使用独立回环随机端口，构建和浏览器测试仍串行以避免文件变更触发页面重载）：

```powershell
npm run typecheck -w @online-video/web
npm test -w @online-video/web
npm run test:e2e -w @online-video/web
npm run test:stage2 -w @online-video/web
npm run test:stage2:long -w @online-video/web
npm run test:production -w @online-video/web
npm run build:release -w @online-video/web
```

Playwright 使用本机 Microsoft Edge，不下载额外浏览器。测试以 `finally` 关闭浏览器和 Vite，不终止用户已有服务。分片 `File.slice()` 独立计算 SHA-256；64 MiB 是客户端单片安全边界，超出时拒绝并提示，绝不擅自更改服务端分片尺寸。任务提示只保存 ID/文件名/大小/创建时间，以账户和 Mock/真实模式分开；任何读取与写入仍依赖 Cookie 及 CSRF。

每次界面验证创建 `qa/<UTC 时间>/` 新目录，保留旧截图。构建 `emptyOutDir:false`，保留已有产物。`build:release` 另建唯一的 `dist/stage2-release-<UTC时间>/`，扫描其完整目录并写入 SHA-256 `manifest.json`；发布只采用交接指定的独立目录，不混入普通 dist 下的历史文件。这里没有实施部署。

根 `.env` 的 `VITE_MEDIA_ORIGIN=https://oss.meetdawn.top`、`VITE_MEDIA_PREFIX=/onlineVideo/` 是公开媒体地址策略。Vite 只读取这两个公开键用于签名 URL 校验，API 的 `NODE_ENV` 不改变前端构建模式；原 `apps/web/.env.mock` 保留。签名链接只在内存中用于媒体/下载，不长期保存、打印或作为视频永久地址。控制 API 仍只接受 `/api/` 站内路径。

上传先读取受保护 `/api/settings/limits`，当前已确认单文件上限 2147483648 字节（2 GiB），超出即拒绝；逐片 SHA-256 与暂停/续传继续复用已有客户端。续传显示服务端组织快照，导入只提交预览条目 ID。导入“确认既有记录位置”只接受单选对象，由服务端核对旧 key 并保留原 ID、标题、组织和观看记录。

直连播放器按实际 `renewAfter/sourceExpiresAt` 同会话续签，换源保留位置与暂停状态；独立心跳只更新应用会话到期，短期限源续签不重置心跳。延迟源响应保留已确认的较晚应用期限。退出/撤销只能停止后续授权，旧签名链接可能仍在有效期内。安全页将代理实际字节与 OSS 未同步字节分开。真实 3600 秒 H.264 文件的 FFprobe、原生中/尾部 Range、长位置续签和页面冻结恢复已验；真实STS/私有OSS native播放与附件已补验，原生手机后台和额外fetch CORS仍待验，详见HANDOFF。

本轮已按具体授权通过本人会话+真实私有 OSS 基线、真实900秒 STS 两次自动续签/角色刷新、唯一兼容原片浏览器附件SHA验证和实际服务重启后的2秒进度恢复。实云脚本 `test/stage2-real-oss.test.ts` 默认不执行，只有主控具体授权/服务交接后才设 phase；短期session只能选本轮受保护目录内的批准basename，网页不读取.local或长期账号/AK资料。私有 `qa/stage2-real-*` 及用户片生成的 `qa/stage2-long-*` 截图只供本地审查，不默认纳Git或发布。当前native播放已过，额外跨域fetch测试不可读，相关CORS规则与最终网站HTTPS/安卓后台归第三阶段，不改云权限。

完整交付、已验与待验见 [HANDOFF.md](HANDOFF.md)。真实安卓联调不能使用默认回环地址：主控需要明确可信站点来源/监听地址，上传校验需要 HTTPS 安全上下文。前端不会自行开放 LAN、放宽 CORS 或修改后端 Cookie/来源保护。

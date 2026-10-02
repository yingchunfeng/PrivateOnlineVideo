# 前端本地运行

使用 Node.js 22.21.1 / npm 10。依赖和根锁文件由主控串行管理。

```powershell
cd E:\onlineVideo
npm run build -w @online-video/shared
npm run dev -w @online-video/web
```

打开 http://127.0.0.1:5173。默认真实 API，同源 `/api` 代理到 `http://127.0.0.1:3000`，端口占用会报错，不自动换端口。CORE-01 只有 health；业务接口缺失时正常显示错误，不伪造登录或上传成功。

明确启用开发 Mock：

```powershell
node --import tsx apps/web/test/generate-media.ts
npm run dev:mock -w @online-video/web
```

Mock 登录：密码 `demo-password`，验证码 `123456`。这是公开开发样例，不能用于真实账户。页面持续显示 Mock 标识。Mock 会话由专用开发 Cookie 模拟，业务数据放 sessionStorage；两者均不代表后端授权，不装配到生产。上传内容仅逐片计算 SHA-256，不写真实 OSS；完成后 Mock 视频为 processing，不能冒充真实格式检查成功。开发 VP8 视频由本机浏览器 canvas 生成，不使用用户视频。

`vite build` 始终使用真实 API；`import.meta.env.DEV` 控制 Mock 动态导入，不因 `.env.mock` 进入生产。Mock 媒体 middleware 只在 `vite --mode mock` 开发服务注册。前端不包含 OSS 密钥、服务端依赖、数据库或 PWA 视频缓存。

检查命令（浏览器测试共用 5173，必须串行，先退出开发服务）：

```powershell
npm run typecheck -w @online-video/web
npm test -w @online-video/web
npm run test:e2e -w @online-video/web
npm run test:production -w @online-video/web
```

Playwright 使用本机 Microsoft Edge，不下载额外浏览器。测试以 `finally` 关闭浏览器和 Vite，不终止用户已有服务。分片 `File.slice()` 独立计算 SHA-256；64 MiB 是客户端单片安全边界，超出时拒绝并提示，绝不擅自更改服务端分片尺寸。任务提示只保存 ID/文件名/大小/创建时间，以账户和 Mock/真实模式分开；任何读取与写入仍依赖 Cookie 及 CSRF。

每次界面验证创建 `qa/<UTC 时间>/` 新目录，保留旧截图。构建 `emptyOutDir:false`，保留已有产物，发布时只采用当前 `dist/index.html` 引用的入口文件；这里没有实施部署。

完整交付、已验与待验见 [HANDOFF.md](HANDOFF.md)。真实安卓联调不能使用默认回环地址：主控需要明确可信站点来源/监听地址，上传校验需要 HTTPS 安全上下文。前端不会自行开放 LAN、放宽 CORS 或修改后端 Cookie/来源保护。

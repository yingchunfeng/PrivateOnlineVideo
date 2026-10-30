# 本地启动与调试

## 当前默认方式：配置文件选择数据库

在两个终端分别执行 `npm run dev:api` 和 `npm run dev:web`。后端读取 `config/deployment.json` 的 `databasePath` 与可选 `authKeyFile`，不加载 `.env`；OSS/SMTP 从目标库读取。切库时停止服务、修改 JSON、重启并刷新页面重新登录。共用主密钥、首次安装及兼容命令见[数据库切换说明](DATABASE_SWITCHING.md)。

以下为旧 `.env`/TOTP 流程的历史运行说明，不能当作当前默认库的状态。VS Code 原 F5 调试入口仍属于旧流程；“启动 API”任务使用新的默认命令。

## 旧入口历史说明

日期：2026-10-02。第二阶段本机真实链路已验收；证据及后续边界见[完成审计](archive/STAGE2_COMPLETION_AUDIT.md)。测试服务已优雅关闭，按下述命令启动即可。

## 前提

本项目使用已安装的 Node.js 22 与 npm 10。前端开发站点固定为 `http://127.0.0.1:5173`，API 为 `http://127.0.0.1:3000`，Vite 将 `/api` 转发到 API。需要改变端口时，同时核对可信 Origin 与前端代理配置。

现有本人账号在 `.local/data/video-library.db`，已按具体授权备份并升级到版本2，旧数据逐项比对保留；`sqlite-test.db` 是用户手工建结构的库，不切换为应用运行目标。启动不会初始化账号或自动迁移；版本不匹配应明确失败，不运行 `account:init` 修复。真实资源配置已写入此前不存在的根`.env`，实云操作仍需明确目标和授权。

## 两个终端

在项目根目录运行：

```powershell
npm run build -w @online-video/shared
npm run dev:legacy -w @online-video/api
```

另开终端运行：

```powershell
npm run dev:web
```

真实 `.env` 根据最终 `.env.example` 与 [OSS 接入说明](OSS_SETUP.md) 局部填写；旧 OSS 准备计划已于 2026-10-30 按确认范围清理。OSS 上传用公网 Endpoint，媒体使用已生效的 HTTPS 域名；本地公网必须显式启用。已确认配置为单文件2GB、8 MiB分片/2片并发、最多3播放会话、每分钟12次签名授权、Asia/Shanghai时区；签名最长3600秒并提前300秒刷新，实际到期受STS限制。缺配置、STS 失败或数据库版本不匹配时先处理对应明确错误，不改为 Mock 或匿名播放。

本机现有根.env已填好上述配置和真实FFprobe路径，不需要再复制模板；普通上传目录恢复onlineVideo/originals/。登录后有原HEVC验收视频（unsupported/可下载）与H264/AAC兼容视频（可播放/续播/下载），兼容观看位置保存为2秒。两新OSS对象是private，原公开样例和Bucket ACL保留；新上传仍设private而不修改整个Bucket。

仅需界面模拟时显式运行 `npm run dev:web:mock`。Mock 是独立开发入口，不能用于验收真实账号、SQLite 或 OSS。

## VS Code

使用“终端 → 运行任务”启动真实前端或 API。F5 选择“API：真实配置与已有数据库”可调试 TypeScript；它只先构建 shared，不执行迁移。前端终端启动后，可选“前端：Edge 本地页面”调试浏览器。

退出服务使用其终端的 Ctrl+C 或调试器停止按钮。若端口被占用，检查已有进程或显式调整配置，不自动终止未知进程。

## 验证

```powershell
npm run check
npm run test:e2e -w @online-video/web
npm run test:production -w @online-video/web
```

`check` 运行类型检查、单元/后端测试和构建。浏览器检查使用已有 Edge；手机仿真与本地协议服务的结果分别记录，不代表真实安卓、真实 OSS、HTTPS 部署或杭州内网通过。测试产物保留，构建不清空输出。

已有1小时隔离H264文件后，可运行 `npm run test:stage2:long -w @online-video/web`，验证真实长位置Range/短期续签/独立心跳/SQL期限及浏览器页面冻结恢复；测试仅使用新隔离库、本地协议和既有FFprobe，不连接实云。原生标签页隐藏项在本机明确skip，不作安卓后台通过声明。当前独立生产交付为 `apps/web/dist/stage2-release-2026-10-02T15-40-47-545Z/`，使用目录内manifest校验，旧dist产物保留。

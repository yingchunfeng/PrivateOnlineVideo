# 本地启动与调试

## 当前默认方式：配置文件选择数据库

后端读取 `config/deployment.json` 的 `databasePath` 与可选 `authKeyFile`，不加载 `.env`；OSS/SMTP 从目标库读取。切库时停止服务、修改 JSON、重启并刷新页面重新登录。共用主密钥和兼容命令见[数据库切换说明](DATABASE_SWITCHING.md)。

## 前提

使用 Node.js `>=22.21.1 <23` 和 npm `10.x`，项目指定 npm `10.9.4`。前端开发站点固定为 `http://127.0.0.1:5173`，API 为 `http://127.0.0.1:3000`，Vite 将 `/api` 转发到 API。需要改变端口时，同时核对可信 Origin 与前端代理配置。

第一次检出后先在项目根目录执行 `npm ci`。没有已准备数据库时，先按[新部署指南](NEW_INSTALL.md)在独立新空库执行 `sql/NEW_INSTALL_FULL.sql`，不要用运行命令替代建库，不在原业务库重新导入 SQL。

本机启动配置由公开模板创建；存在时保留原文件，手动核对目标库与密钥：

```powershell
if (-not (Test-Path -LiteralPath 'config/deployment.json')) {
    Copy-Item -LiteralPath 'config/deployment.example.json' -Destination 'config/deployment.json'
}
```

模板省略 `authKeyFile`，新库首次启动创建伴随密钥；显式填写时只复用目标库匹配的已有密钥。不要覆盖现有配置、替换密钥，或把本机配置与真实凭据提交到 Git。

## 两个终端

在项目根目录运行：

```powershell
npm run build -w @online-video/shared
npm run dev:api
```

另开终端运行：

```powershell
npm run dev:web
```

首次访问按网页完成安装码验证、强制改密、OSS 和可选邮件配置。现行方案上传经 API 写入 OSS，播放直接使用公共 HTTPS 媒体地址；不要求新环境沿用旧私有播放签名/续签流程。公开媒体地址不受站内登录或访客到期控制。

仅需界面模拟时显式运行 `npm run dev:web:mock`。Mock 是独立开发入口，不能用于验收真实账号、SQLite 或 OSS。

## 调试与旧入口

终端命令为可复现的默认入口，不依赖未随仓库发布的个人编辑器配置。若保留旧 `.env`/TOTP 环境，明确使用以下兼容命令，不与默认入口混用：

```powershell
npm run build -w @online-video/shared
npm run dev:legacy -w @online-video/api
```

旧入口按 `.env.example` 配置，参考[账号说明](ACCOUNT.md)和[OSS 接入说明](OSS_SETUP.md)。已有账号、数据库和密钥保留；不运行 `account:init`、全量 SQL 或重置操作来修复配置问题。

退出服务使用其终端的 Ctrl+C 或调试器停止按钮。若端口被占用，检查已有进程或显式调整配置，不自动终止未知进程。

## 验证

```powershell
npm run check
npm run test:e2e -w @online-video/web
npm run test:production -w @online-video/web
```

`check` 运行类型检查、单元/后端测试和构建。浏览器检查使用已有 Edge；手机仿真与本地协议服务的结果分别记录，不代表真实安卓、真实 OSS、HTTPS 部署或杭州内网通过。测试产物保留，构建不清空输出。

当前首页/管理、站点设置/视频维护及访客回归分别使用 `test:ui`、`test:ui:batch2`、`test:ui:batch3`；详细命令见[前端说明](../apps/web/README.md)。历史 `test:stage2*` 涉及私有播放和固定媒体样例，不是新部署的必要步骤；真实 OSS/邮件测试须先明确目标、样例、费用和授权，不因运行普通检查而自动执行。

测试目录包含 Vite Mock 插件、发布构建脚本及固定夹具，不能整体删除。测试输出与业务库、密钥、备份分开保留；清理前先确认具体路径及调用关系。服务器构建与更新见[Docker/1Panel 部署指南](DEPLOY_1PANEL.md)。

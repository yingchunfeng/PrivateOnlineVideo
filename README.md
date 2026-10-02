# PrivateOnlineVideo

个人私有视频库，面向安卓手机和桌面浏览器。项目目标是将视频保存在阿里云私有 OSS 中，通过本人账号完成分类、搜索、上传和在线播放，并控制访问权限与传输用量。

当前处于本地开发阶段，尚未完成全部业务接口、真实 OSS 联调和生产部署。

## 当前进度

| 模块 | 当前状态 |
| --- | --- |
| 工程基础 | npm Workspaces、共享 TypeScript 类型、API 健康检查已实现 |
| 数据库与账号 | SQLite Repository、单人账号、密码 + TOTP 登录、会话撤销与本地恢复已实现 |
| 媒体模块 | 存储适配器、Range 播放、分片上传、元数据检查、导入与用量控制已完成独立模块及本地测试，尚未接入默认服务器 |
| 前端 | 登录、视频库、分类、上传、播放器与安全页面已实现，支持独立开发 Mock |
| 后续开发 | 分类/视频等真实业务接口、分组与标签、完整链路联调、真实 OSS 验收及部署待完成 |

默认 API 当前提供健康检查和真实账号接口。真实登录后，视频库、上传等业务仍依赖后续接口与模块装配；Mock 演示通过不代表真实 OSS 上传或播放已经可用。

## 技术栈

- 前端：React 19、React Router 7、Vite 8、TypeScript。
- 后端：Node.js 22、Fastify 5、TypeScript。
- 数据：SQLite、better-sqlite3、Drizzle ORM。
- 认证：Argon2id、TOTP、HttpOnly Cookie、CSRF 校验。
- 存储：阿里云 OSS（ali-oss），开发默认使用 Mock。
- 验证：Node.js Test Runner、Playwright。

## 项目结构

```text
apps/
  api/                  后端、认证、数据库及媒体模块
  web/                  响应式前端、Mock 与浏览器测试
packages/
  shared/               前后端共享 DTO 和错误定义
docs/                   需求、接口契约、SQL 及交接说明
.env.example            本地配置示例
package.json            Workspaces 和统一运行命令
```

## 环境准备

使用 Node.js `>=22.21.1 <23` 和 npm `10.x`，项目指定 npm `10.9.4`。以下命令以 Windows PowerShell 为例。

```powershell
git clone https://github.com/yingchunfeng/PrivateOnlineVideo.git
cd PrivateOnlineVideo
npm ci
npm run build -w @online-video/shared
```

如需自定义配置，可参考 [.env.example](.env.example) 在根目录创建 `.env`。仅在文件不存在时复制，保留已有配置：

```powershell
if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
```

## 启动 Mock 演示

无需初始化账号或连接 OSS，可先查看前端交互：

```powershell
npm run dev:web:mock
```

访问 <http://127.0.0.1:5173>，演示密码为 `demo-password`，验证码为 `123456`。这些是公开开发样例，只用于 Mock。

Mock 页面会显示模式标识，上传不写入真实 OSS。生产构建使用真实 API，不启用开发 Mock。

## 启动真实登录

新克隆环境没有本地数据库、账号资料和认证密钥。如果需要创建全新账号，在项目根目录执行一次：

```powershell
npm run account:init -w @online-video/api
```

初始化会创建 `.local/data/video-library.db`、`.local/secrets/auth.key` 和 `.local/account-setup.json`。在本机读取账号资料，将 TOTP 配置添加到验证器，妥善保存密码与恢复码。已有账号的环境不要重复初始化；命令会拒绝覆盖已有数据库或资料。

然后在项目根目录分别打开两个 PowerShell 终端：

```powershell
# 终端 1：后端
npm run dev:api
```

```powershell
# 终端 2：前端
npm run dev:web
```

访问 <http://127.0.0.1:5173/login>，使用真实密码和验证器当前的六位动态验证码登录。前端将 `/api` 请求代理到 `http://127.0.0.1:3000`；健康检查为 <http://127.0.0.1:3000/api/health>。

默认服务仅监听本机回环地址。当前 `STORAGE_DRIVER=oss` 和 `NODE_ENV=production` 会被明确拒绝，需完成后续装配后再启用。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev:api` | 启动后端开发服务 |
| `npm run dev:web` | 启动使用真实 API 的前端 |
| `npm run dev:web:mock` | 启动前端 Mock 演示 |
| `npm run typecheck` | 检查共享包、前后端及测试类型 |
| `npm test` | 运行后端与前端单元测试 |
| `npm run build` | 构建共享包、后端和前端 |
| `npm run check` | 依次执行类型检查、单元测试和构建 |
| `npm run test:e2e -w @online-video/web` | 运行前端浏览器测试 |
| `npm run test:production -w @online-video/web` | 验证前端生产构建的 Mock 隔离 |

浏览器测试使用本机 Microsoft Edge，共用 `5173` 端口；请先退出占用该端口的开发服务，再串行运行。`npm run check` 不包含浏览器测试或真实 OSS 验收。

## 数据与配置

本地数据库、认证密钥、账号资料、备份和真实 `.env` 不进入 Git；新克隆环境需要独立初始化。不要将 `.local` 内容上传到仓库、发布为静态文件或发送到前端。

当前数据库迁移版本为 `1`。第二阶段 SQL 是待接入方案，不能直接在已有账号库执行；迁移与备份操作请先阅读 [数据库说明](docs/DATABASE.md) 和 [SQL 说明](docs/sql/README.md)。

真实 OSS 连接所需的 Bucket、访问范围、凭据、网络与用量配置见 [OSS 准备说明](docs/OSS_SETUP.md)。

## 开发文档

- [产品需求](docs/PRD.md)
- [任务总览](docs/task/TASKS.md)
- [第二阶段开发计划](docs/task/STAGE2.md)
- [当前 API 契约](docs/API_CONTRACT.md)
- [第二阶段 API 提案](docs/STAGE2_API_CONTRACT.md)
- [账号与登录](docs/ACCOUNT.md)
- [数据库与迁移](docs/DATABASE.md)
- [媒体模块交接](apps/api/src/modules/media/HANDOFF.md)
- [前端运行说明](apps/web/README.md)
- [前端交接](apps/web/HANDOFF.md)

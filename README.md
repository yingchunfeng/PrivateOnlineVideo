# PrivateOnlineVideo

面向个人使用的视频管理网站，支持桌面及手机浏览器。通过一个管理员账号管理视频、分类、标签、上传任务和系统配置，可按期限授权受限访客；不提供公众注册或通用多租户隔离。

核心功能已完成开发，当前以维护、部署和专项验收为主。首页视频管理入口名为“高光时刻”；产品、仓库和技术路由名称不因此变更。

**默认启动方式为数据库配置模式：** 从 `config/deployment.example.json` 创建本机专用 `config/deployment.json` 后，执行 `npm run dev:api`；后端按该文件选择数据库和应用主密钥，再从数据库读取 OSS、SMTP 等业务配置，不加载项目 `.env`。

> 当前采用公共读媒体直连方案：站内管理需要登录，但视频的公共 HTTPS 地址本身无需登录。请勿把公共媒体地址当作私有访问控制。

## 阅读入口

| 目标 | 操作入口 |
| --- | --- |
| 本地首次运行 | 下文[首次安装](#首次安装)，只在新空库执行一份完整 SQL |
| Linux 服务器首次部署 | [Docker 与 1Panel 指南](docs/DEPLOY_1PANEL.md)，在服务器构建 API/Web 镜像 |
| 已部署环境更新 | [日常更新](docs/DEPLOY_1PANEL.md#9-日常更新不再初始化数据库)，先备份，不重新建库或生成密钥 |
| 切换数据库 | [数据库切换说明](docs/DATABASE_SWITCHING.md)，停服务后修改启动配置 |
| 接口、结构与前端维护 | 文末[维护文档](#维护文档) |

## 项目功能

| 模块 | 功能 |
| --- | --- |
| 首次安装 | 完整新库 SQL、一次性安装码、初始密码限权、强制改密、配置向导及中断后继续设置 |
| 账号安全 | 默认密码登录；可选邮箱验证码登录、密码修改和邮箱验证开关；保留旧 TOTP 账号兼容入口 |
| 高光时刻 | 固定尺寸卡片、单行标题、分类/标签搜索筛选、弹窗编辑、缺失时长补采及仅删除数据库记录 |
| 上传任务 | 多文件队列、分片上传、SHA-256 校验、暂停/续传、任务历史、失败后的完成确认与幂等恢复 |
| 封面与播放 | 浏览器提取封面、预览及上传；封面失败可单独补存；视频通过 OSS/媒体域名直接播放 |
| 分类与标签 | 网页配置、稳定 ID、首页联动和跨标签页同步；分类调整不自动搬移 OSS 对象 |
| 页面管理 | 当前浏览器外观、下次登录使用的站点默认外观，以及动态星空参数 |
| 访客管理 | 临时密码一次交付、页面与视频操作授权、到期时间、重置密码及提前失效 |
| 系统设置 | 网页配置 OSS、QQ/163 SMTP 和单文件上传上限，支持只读 OSS 检查和主动发送测试邮件，敏感字段加密保存 |
| 数据库切换 | 修改启动 JSON 并重启，切换整套账号、配置和业务数据；独立新库可显式共用已有 `.auth.key` |

播放能力取决于浏览器支持的容器和编码，本项目不承诺自动转码或所有视频格式均可播放。已有服务器正常使用的用户确认；安卓真机、大文件和新版本上线后的专项验证仍需分别记录。

## 管理页面与访客

- **管理交互**：配置管理、任务列表、页面管理和访客管理使用只读表格与操作入口，需要修改时打开弹窗；首页保留视频卡片，搜索和标签筛选按需展开。首页不展示视频处理状态文字，后台处理逻辑不受影响。
- **视频维护**：管理员或具备相应权限的访客可编辑视频。时长由浏览器读取真实媒体后补存到数据库，只读访客不会触发时长或封面写入。删除需要单独确认，只删除数据库记录；结果提供可复制的 OSS 路径供人工处理，服务不删除云端对象。
- **外观与上传限制**：个人外观和星空参数作用于当前浏览器；管理员保存的默认外观用于新的登录会话，不强行覆盖当前会话。单文件上传上限以 GiB 输入，受当前分片大小及 10,000 片上限约束；修改仅影响新建任务，不取消既有任务或删除已有视频。
- **新增访客**：管理员在“访客管理”填写名称、到期时间与权限，创建后复制临时密码，通过可信渠道私下交付。访客从 `/guest/login` 登录，不使用管理员密码或邮箱验证码；密码仅创建或重置时展示一次，列表不回显。
- **访客边界**：默认只开放首页库、上传视频和个人页面管理；任务列表、共享分类标签管理、视频编辑及数据库记录删除需分别授权。系统设置、账户安全、访客管理和站点默认外观始终仅管理员可用。视频库共享，上传任务按访客隔离；视频编辑或删除权限必须同时具备首页库权限。
- **凭证期限**：到期、提前失效或重置密码后，全部旧会话失效；已失效的访客不能恢复为有效身份，需要重新创建。已复制的 OSS 公共直链不受站内授权期限控制。

站点设置需数据库 v7，访客持久化需 v8。旧库缺表时页面明确提示并禁用相关保存，不会启动时自动迁移；已有库升级应另行核对目标、备份并授权，不能导入新空库完整 SQL。接口和数据结构见[API 契约](docs/API_CONTRACT.md)与[数据库说明](docs/DATABASE.md)。

## 架构与业务流程

```text
config/deployment.json
  -> 选择 SQLite 数据库与应用主密钥 .auth.key
  -> API 从数据库解密读取 OSS / SMTP 配置

浏览器 -> API -> SQLite（账号、配置、视频与任务记录）
浏览器 -> API -> OSS（视频分片、合并与封面上传）
浏览器 ------> 公共 HTTPS 媒体地址（视频播放）
```

- **安装流程**：新空库执行完整 SQL -> 启动 API/前端 -> 安装码和初始密码验证 -> 强制改密 -> 保存并测试 OSS -> 可选配置邮件 -> 完成安装并重新登录。
- **上传流程**：选择文件和分类/标签 -> 创建任务 -> 上传并校验分片 -> OSS 合并 -> 核验完整对象并登记视频 -> 保存封面。字节传完不等于登记完成，最后确认失败时可在任务列表重试。
- **配置流程**：系统设置保存配置 -> 加密写入当前数据库 -> 后续操作读取当前配置。只读连通测试不等于上传、公共读权限或实际邮件送达全部通过。
- **切库流程**：暂停任务并停止 API -> 修改启动 JSON -> 重启 -> 刷新页面并按目标库重新登录，不在服务运行中热切库。

## 数据库与配置

### 配置保存在哪里

| 内容 | 保存位置 | 说明 |
| --- | --- | --- |
| 当前数据库和主密钥路径 | `config/deployment.json` | 只保存启动定位，不填写阿里云密钥或 SMTP 授权码 |
| 账号、视频、任务和安装状态 | 指定的 SQLite `.db` | 每个数据库独立保存 |
| OSS 配置 | 数据库 `installation_settings` 表 | 配置整体加密，包括 AccessKey、Bucket、地域、可选 ARN 等 |
| SMTP 配置 | 数据库 `smtp_provider_configs` 表 | 密码/授权码加密保存 |
| 默认登录外观和单文件上传上限 | 数据库 `site_settings` 表 | v7；带版本号校验，个人外观仍保存在当前浏览器 |
| 访客凭证、会话与任务归属 | 数据库 `guests`、`guest_sessions`、`guest_uploads` 表 | v8；只保存临时密码摘要，不保存可回读的明文 |
| 应用加密主密钥 | `.auth.key` 文件 | 32 字节二进制文件，不是阿里云 AccessKey，不保存在前端或仓库 |
| 媒体地址、前缀及分类/标签配置 | `<数据库路径>.library.json` | 与该数据库配套，不能随意用另一份替换 |
| 首次安装码 | `<数据库路径>.installation-code.txt` | 仅服务器管理员读取，改密后失效；文件保留 |

默认启动配置示例：

```json
{
  "databasePath": ".local/data/new-install.db",
  "authKeyFile": ".local/data/new-install.db.auth.key"
}
```

`databasePath` 必填；数据库和主密钥必须位于项目 `.local` 内。相对路径始终以项目根目录为基准，不受 npm workspace 工作目录影响。

`authKeyFile` 可选：**填写时只复用已有密钥，不会生成或覆盖它**；省略时使用 `<数据库路径>.auth.key`，仅在新空库首次初始化时创建。已有库缺少密钥或密钥不匹配会拒绝启动，不恢复默认密码。

### 切库与共用主密钥

切换已经准备好的库，只需修改 `databasePath` 并重启；如果目标库使用不同主密钥，还要指定它原来匹配的 `authKeyFile`。

例如第二个独立新库使用相同主密钥、保存另一套 OSS 配置：

```json
{
  "databasePath": ".local/data/another-install.db",
  "authKeyFile": ".local/data/new-install.db.auth.key"
}
```

第二个库必须先在新空库执行完整 SQL，再完成自己的网页初始化。共用 `.auth.key` 不会复制账号、视频或 OSS 配置，也不会授予云端权限。已经用另一把密钥初始化的库不能直接换成共享密钥；共享密钥适用于同一可信管理员管理的库，不适合隔离互不信任的租户。

完整步骤见[数据库切换说明](docs/DATABASE_SWITCHING.md)。

## 技术栈

- 前端：React 19、React Router 7、Vite 8、TypeScript。
- 后端：Node.js 22、Fastify 5、TypeScript。
- 数据：SQLite、better-sqlite3、Drizzle ORM。
- 认证：Argon2id、密码/可选邮箱验证码、HttpOnly Cookie、CSRF 校验，兼容旧 TOTP。
- 访客：独立临时密码、页面及视频操作授权、到期/重置/撤销后全会话失效；共享视频库，上传任务按访客隔离。OSS 公共直链不随站内凭证失效。
- 存储：阿里云 OSS（ali-oss），支持服务端直接 AK 或可选 ARN/STS；Mock 仅用于显式演示及隔离测试。
- 验证：Node.js Test Runner、Playwright。
- 部署：Docker 多阶段构建、Docker Compose、Nginx 静态资源与 API 代理，可复用已有 1Panel/OpenResty 管理域名和 TLS。

具体依赖版本以各 workspace 的 `package.json` 与根 `package-lock.json` 为准；升级依赖时应重新验证原生 SQLite 模块与浏览器行为。

## 项目结构

```text
apps/
  api/                  后端、安装向导、认证、数据库及媒体模块
    src/modules/site-settings/  默认登录外观与上传上限的持久化服务（v7）
    src/modules/guests/  临时密码摘要、访客会话及管理接口（v8）
    src/core/guest-access.ts  旧业务接口默认拒绝式访客授权及在途请求取消
  web/                  响应式前端、系统设置、Mock 与浏览器测试
packages/
  shared/               前后端共享 DTO 和错误定义
config/
  deployment.example.json  可公开的本地启动配置模板
  deployment.json       本机实际数据库与主密钥路径，不应公开
deploy/                 容器部署模板、初始化命令与 Nginx 配置
Dockerfile              Linux 多阶段构建，分别生成 API/Web 镜像
compose.yaml            服务、健康检查和持久化挂载
docs/
  sql/NEW_INSTALL_FULL.sql  新空库完整 SQL
  NEW_INSTALL.md        首次安装步骤
  DATABASE_SWITCHING.md 切库与共用主密钥说明
.local/                 本机数据库、密钥、备份和测试产物，不提交
.env.example            旧兼容入口的本地配置示例
package.json            Workspaces 和统一运行命令
```

## 首次安装

已有可用数据库的环境直接跳到[日常启动](#日常启动)，不要重新导入 SQL、初始化账号或更换主密钥。

### 1. 安装依赖

使用 Node.js `>=22.21.1 <23` 和 npm `10.x`，项目指定 npm `10.9.4`。以下命令以 Windows PowerShell 为例。

```powershell
git clone https://github.com/yingchunfeng/PrivateOnlineVideo.git
cd PrivateOnlineVideo
npm ci
npm run build -w @online-video/shared
```

### 2. 准备新空库

使用 Navicat、SQLite 客户端等创建 `.local/data/new-install.db`，在这个**新空库**中整份执行 [`docs/sql/NEW_INSTALL_FULL.sql`](docs/sql/NEW_INSTALL_FULL.sql)。该 SQL 包含 v8 完整结构及迁移账本，不需要逐份执行旧迁移；已有库不能执行此完整 SQL，站点设置及访客持久化需另行核对目标、备份并授权增量迁移。

不要在旧业务库或 `sqlite-test.db` 上执行完整 SQL。API 启动不会自动创建数据库、执行迁移或清空旧数据。

### 3. 选择数据库与密钥

首次安装先创建本机配置；如果文件已存在则保留，检查后按实际情况编辑，不覆盖已有配置：

```powershell
if (-not (Test-Path -LiteralPath 'config/deployment.json')) {
    Copy-Item -LiteralPath 'config/deployment.example.json' -Destination 'config/deployment.json'
}
Get-Content -LiteralPath 'config/deployment.json' -Encoding UTF8
```

尚无主密钥的新环境应使用：

```json
{
  "databasePath": ".local/data/new-install.db"
}
```

模板故意省略 `authKeyFile`，新空库首次启动会创建配套主密钥和安装码。若已有配置带有 `authKeyFile`，它必须指向目标库原来匹配的已有密钥；不要为套用模板而修改原密钥文件。若要共用一份已有主密钥，则显式填写它的 `authKeyFile` 路径。

### 4. 启动后端和前端

在项目根目录分别打开两个 PowerShell 终端：

```powershell
# 终端 1：后端
npm run dev:api
```

```powershell
# 终端 2：前端
npm run dev:web
```

打开 <http://127.0.0.1:5173>。前端默认将 `/api` 代理到 `http://127.0.0.1:3000`，API 健康检查为 <http://127.0.0.1:3000/api/health>。

### 5. 完成网页初始化

1. 在服务器本机读取终端提示位置的安装码文件，使用初始密码 `adminadmin` 和一次性安装码进入向导。默认密码不能访问正常业务。
2. 设置并确认新的 12～128 字符密码。旧安装会话与初始凭据随即失效，重启不会恢复默认密码。
3. 填写 OSS 的 AccessKeyId、AccessKeySecret、Bucket、地域、媒体 HTTPS 地址、对象前缀和网络类型；需要角色授权时填写 ARN。保存后完成只读连接检查。
4. 按需配置 QQ/163 SMTP 并主动发送测试邮件；不配置邮件也可使用密码登录。
5. 完成初始化并重新登录。若需要邮箱验证码登录，在系统设置中完成邮件测试和邮箱验证码确认后开启。

只读 OSS 检查不会上传对象，也不能代替实际上传权限验收。系统不会自动修改 Bucket/RAM 权限；上传新对象需要相应上传、读取和公共读权限。生产凭据应遵循最小权限原则，不使用阿里云主账号 AccessKey。

更详细的操作和异常处理见[新部署指南](docs/NEW_INSTALL.md)。

## 日常启动

已完成初始化后，无需再填写安装码或重跑 SQL，启动命令保持不变：

```powershell
# 后端，使用 config/deployment.json
npm run dev:api

# 在另一个终端启动前端
npm run dev:web
```

修改启动 JSON 后，在后端原终端按 `Ctrl+C` 停止并重新启动；不要强杀未知进程。切库前暂停上传，切库后刷新页面并重新登录。

默认后端入口不加载 `.env`。监听地址、端口、运行环境和可信 Origin 等基础设施参数仍可由进程环境变量提供，例如 `API_HOST`、`API_PORT`、`NODE_ENV`、`AUTH_ALLOWED_ORIGINS`；本地默认启动无需设置。修改端口时还需同步核对前端代理和可信 Origin。

### 构建后启动

```powershell
npm run build
npm run start:api
```

后端产物位于 `apps/api/dist`，仍按同一个启动 JSON 选择数据库；前端产物位于 `apps/web/dist`，需要单独提供静态文件服务。`start:api` 不会自动托管前端，前端 `preview` 仅用于本地预览。

生产环境还需配置 `NODE_ENV=production`、可信 HTTPS Origin、TLS 反向代理和持久化目录；执行构建不等于完成服务器部署。不要把 Windows 的 `node_modules` 直接当作 Linux 的运行依赖。

### Mock 演示

无需初始化账号或连接 OSS，可先查看前端交互：

```powershell
npm run dev:web:mock
```

访问 <http://127.0.0.1:5173>，演示密码为 `demo-password`，验证码为 `123456`。这些是公开开发样例，只用于 Mock。

Mock 页面会显示模式标识，上传不写入真实 OSS。生产构建使用真实 API，不启用开发 Mock；Mock 演示不能替代实际数据库和 OSS 验证。

### 旧 .env 入口

原 `.env`、v5 账号和 TOTP 逻辑保留，不自动迁移或覆盖。仅在明确继续使用旧环境时执行：

```powershell
npm run build -w @online-video/shared
npm run dev:legacy -w @online-video/api

# 构建后的旧入口
npm run start:legacy -w @online-video/api
```

旧账号初始化、恢复和邮件 CLI 仍属于旧流程，不用于修复新的网页配置库。个人编辑器配置可能仍指向旧入口，应核对启动目标；新方式以本文终端命令为准。

显式指定新部署数据库的命令也继续兼容；它不合并读取默认启动 JSON：

```powershell
npm run start:setup -w @online-video/api -- --database ".local/data/new-install.db"
```

未指定 `--key-file` 时使用目标库的伴随主密钥；共用密钥或使用其他配置文件的写法见[数据库切换说明](docs/DATABASE_SWITCHING.md)。

## 服务器部署与更新

推荐在 Linux 服务器构建，不上传 Windows 的 `node_modules`。仓库已提供完整的 Dockerfile、Compose 和 Nginx 配置；已有 1Panel 时继续使用原 OpenResty 和证书，不另占宿主机 80/443。

```text
/opt/online-video/
  source/      Git 源码，构建和运行 Compose 的位置
  config/      deployment.json、compose.env，服务器专用配置
  data/        SQLite、主密钥、安装码与配套业务配置
  backups/     与源码分离的备份
```

- **首次部署**：准备外部配置和空数据目录 -> 构建 API/Web 镜像 -> 一次性执行 `deploy/init-db.mjs`，它只读取 `docs/sql/NEW_INSTALL_FULL.sql` -> 启动容器 -> 配置 HTTPS 反向代理 -> 完成网页安装。不要先手动创建一个空 `.db` 再运行初始化命令，该命令拒绝任何已存在的数据库文件。
- **访问链路**：浏览器 HTTPS -> 1Panel/OpenResty -> Web 容器 -> API 容器。默认只发布 Web 的 `127.0.0.1:18080`，API 不直接暴露公网；视频播放单独使用公共媒体地址。
- **参数含义**：`APP_ORIGIN` 是管理网站实际 HTTPS Origin，不是 OSS/媒体地址；`DATA_DIR` 和 `DEPLOY_CONFIG_FILE` 是宿主机路径。OSS 与 SMTP 凭据通过网页保存到数据库，不填进公开模板。
- **普通更新**：确认发布内容已提交并推送 -> 保留旧镜像和一致性备份 -> `git pull --ff-only` -> 构建新镜像 -> `up` 替换本项目容器 -> 验证 health、登录和业务。拉取源码或 `restart` 不等于采用新镜像。
- **涉及结构升级**：先暂停普通更新，核对当前数据库版本和目标迁移，备份后另行执行经确认的增量方案。v7 站点设置和 v8 访客表不能靠导入完整 SQL 给旧库补齐；应用不会启动时自动迁移。

逐条可执行命令、host/bridge 代理方案、备份与回退步骤见[部署指南](docs/DEPLOY_1PANEL.md)。该指南中的已有服务器历史记录仅适用于原环境，新服务器使用通用示例并替换目录和域名。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev:api` | 按 `config/deployment.json` 选择数据库，启动后端开发服务 |
| `npm run start:api` | 按同一启动 JSON 运行已构建的后端 |
| `npm run dev:legacy -w @online-video/api` | 显式运行原 `.env` 兼容入口 |
| `npm run dev:web` | 启动使用真实 API 的前端 |
| `npm run dev:web:mock` | 启动前端 Mock 演示 |
| `npm run typecheck` | 检查共享包、前后端及测试类型 |
| `npm test` | 运行后端与前端单元测试 |
| `npm run build` | 构建共享包、后端和前端 |
| `npm run check` | 依次执行类型检查、单元测试和构建 |
| `npm run test:ui -w @online-video/web` | 运行管理组件、首页布局和管理页面浏览器回归 |
| `npm run test:ui:batch2 -w @online-video/web` | 运行站点设置及视频数据闭环浏览器回归 |
| `npm run test:ui:batch3 -w @online-video/web` | 运行访客登录、授权及会话撤销浏览器回归 |
| `npm run test:e2e -w @online-video/web` | 运行前端浏览器测试 |
| `npm run test:e2e:setup -w @online-video/web` | 运行首次安装及系统设置浏览器测试 |
| `npm run test:production -w @online-video/web` | 验证前端生产构建的 Mock 隔离 |

默认 `check` 使用隔离数据库、替身或本地协议服务，不代表真实 OSS、邮件和服务器已经通过验收。浏览器测试需要本机可用的 Edge/Playwright 环境。测试会重新生成本机临时产物，这些产物不应提交到仓库。

## 备份与安全边界

- 备份数据库、匹配的 `.auth.key`、该库的 `.library.json` 和启动 JSON；未完成首次安装时，还需保留安装码。共享密钥必须与所有依赖它的数据库一并纳入备份计划。
- SQLite 应停服务后复制，或使用一致性在线备份；不能只复制运行中的 `.db` 而忽略 WAL。
- 主密钥丢失后不能通过生成新密钥解密旧配置。多个库共用主密钥会扩大密钥泄漏的影响范围。
- 数据库、主密钥、真实 `.env`、本机配置、账号资料、本地备份和验收产物不应提交到 Git，也不能作为前端静态文件发布。对外配置应使用不含真实凭据的示例；`.gitignore` 不会自动解除已跟踪文件或清除历史中的内容，公开前按[仓库维护说明](docs/REPOSITORY_HYGIENE.md)核对。
- 不在已有库重复导入完整 SQL，不通过改指纹绕过密钥检查，不因测试失败自动重置账号、切换 Mock 或扩大云端权限。

## 验证范围

用户本机已确认新库上传和配置文件启动方式可用。数据库切换、共享主密钥、错误密钥拒绝、OSS 错误分类及上传恢复有隔离自动化回归覆盖；这些结果不替代其他环境的真实 OSS/SMTP 权限与送达测试。

管理页面、站点设置、视频数据维护和受限访客功能已提供源码及隔离回归测试。源码完成不代表运行中的服务器已经更新到同一版本，也不代表正式库已升级到 v8。

已有 Docker/1Panel 部署和正常使用的用户确认，具体基线见[部署记录](docs/DEPLOY_1PANEL.md#0-本次部署记录与阅读入口)。安卓真机、大文件、更多容器/封面兼容性、按需 SMTP 实际收件以及每次更新后的持久化与业务检查仍应单独验收，不由 health 或桌面手机仿真推定通过。

## 维护文档

- [Docker 镜像部署与 1Panel 反向代理](docs/DEPLOY_1PANEL.md)
- [新部署完整 SQL 与网页初始化](docs/NEW_INSTALL.md)
- [数据库配置、切库与共享主密钥](docs/DATABASE_SWITCHING.md)
- [本地运行](docs/LOCAL_DEVELOPMENT.md)
- [当前 API 契约](docs/API_CONTRACT.md)
- [账号与登录](docs/ACCOUNT.md)
- [数据库与迁移](docs/DATABASE.md)
- [QQ/163 邮箱配置](docs/SMTP_PROVIDERS.md)
- [前端运行说明](apps/web/README.md)
- [仓库公开、敏感配置与本地产物维护](docs/REPOSITORY_HYGIENE.md)

需求板、开发阶段计划、历史交接和本机测试报告不作为安装依赖或对外使用说明；本地保留的历史文档可能描述旧私有播放方案，当前行为以本页、接口契约和现行操作指南为准。

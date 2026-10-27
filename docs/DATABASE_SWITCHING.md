# 数据库配置启动与切库

## 1. 日常启动不再依赖 .env

在项目根目录执行原来的命令即可：

```powershell
npm run dev:api
```

后端默认读取 `config/deployment.json`，不加载项目 `.env`。当前配置指向已使用的新部署库：

```json
{
  "databasePath": ".local/data/new-install.db",
  "authKeyFile": ".local/data/new-install.db.auth.key"
}
```

- `databasePath` 必填，指定已有的 v6 SQLite 数据库。
- `authKeyFile` 可选，指定已有的 32 字节应用加密主密钥；这里只放路径，不能放密钥内容或阿里云 AccessKey。
- 所有相对路径均以项目根目录为基准，与 npm workspace 的工作目录无关。数据库和密钥必须位于项目 `.local` 内。
- OSS、SMTP 的配置及敏感凭据从选中的数据库读取，不从 `.env` 或这个启动 JSON 读取。网页修改只保存到当前数据库。
- 媒体地址、对象前缀和分类/标签还使用该库自己的 `<数据库路径>.library.json` 配套文件，不共用原 `config/library.json`。
- 监听地址、端口、运行环境、可信 Origin 等基础设施参数仍可使用进程环境变量设置，例如 `API_PORT`、`API_HOST`、`NODE_ENV`、`AUTH_ALLOWED_ORIGINS`；默认本地开发无需设置，也无需创建 `.env`。

构建后启动也使用同一个 JSON：

```powershell
npm run build
npm run start:api
```

配置文件缺失、格式错误、数据库不存在、旧结构或密钥不匹配时直接报错，不回退到 `.env`、旧库或 Mock。

## 2. 切换已准备好的数据库

1. 等待当前上传完成或先暂停任务，在后端原终端按 `Ctrl+C` 正常停止服务。
2. 修改 `config/deployment.json` 的 `databasePath`；如果目标库使用不同主密钥，同时改为它原来匹配的 `authKeyFile`。
3. 执行 `npm run dev:api`，生产构建入口则使用 `npm run start:api`。
4. 刷新浏览器，按目标库的账号重新登录，核对“系统设置”中的 Bucket、地域和媒体地址。

修改 JSON 后必须重启，不支持运行中热切库。切换的是整套账号、配置、视频记录和上传任务，不只是换一个 OSS 地址。不要让旧页面中的上传任务继续提交到新库。

目标库的 `.library.json` 必须配套保留。已有视频的库不能通过改 Bucket 来迁移文件；本功能不复制云文件，也不迁移数据库内容。

## 3. 不同数据库共用同一个 .auth.key

同一个应用主密钥可以解密多个独立数据库各自保存的 OSS/SMTP 配置。它不是阿里云 AccessKey，也不会授予云访问权限；每个数据库仍需填写其自身的 OSS 凭据、Bucket 和媒体地址。

例如当前 A 库已使用 `.local/data/new-install.db.auth.key`，希望新 B 库共用它：

1. 手工创建独立空库 `.local/data/another-install.db`，只在该空库执行 [`sql/NEW_INSTALL_FULL.sql`](sql/NEW_INSTALL_FULL.sql)。不要复制已有 A 库来冒充新安装，也不要在已有库上重跑完整 SQL。
2. 修改启动 JSON，只改变数据库路径，保留已有主密钥路径：

```json
{
  "databasePath": ".local/data/another-install.db",
  "authKeyFile": ".local/data/new-install.db.auth.key"
}
```

3. 执行 `npm run dev:api`。新 B 库只读取该主密钥，不覆盖或重新生成它；另行创建 B 库自己的安装码。
4. 按 [`NEW_INSTALL.md`](NEW_INSTALL.md) 完成 B 库的首次改密与配置，填写另一套 OSS 信息。完成后 B 库拥有独立的 `.library.json`。
5. 要回 A 库时，停止服务，把 `databasePath` 改回 `.local/data/new-install.db`，保持相同 `authKeyFile` 后重启。

**共用密钥的前提是从初始化开始就使用它。** 如果某个库已经用另一把密钥加密，不能直接修改路径、覆盖密钥文件或改数据库指纹。本功能不提供旧密文的密钥迁移；仍然必须使用原密钥。

显式指定的 `authKeyFile` 缺失或损坏会拒绝启动，不生成替代文件。多个库共享主密钥会扩大泄漏影响范围，适用于同一可信管理员管理的库，不适合作为互不信任租户之间的安全隔离。

## 4. 第一个全新安装还没有主密钥

先准备好完整 SQL 的新空库，再省略 `authKeyFile`：

```json
{
  "databasePath": ".local/data/first-install.db"
}
```

首次启动会创建 `.local/data/first-install.db.auth.key` 和该库的独立安装码。已有库仍只读取原伴随密钥；丢失不会补建。以后其他新空库如需共享，显式把 `authKeyFile` 指向这份已有文件。

## 5. 兼容入口与备份

保留显式指定数据库的旧新部署命令；它不会合并读取默认 JSON：

```powershell
npm run start:setup -w @online-video/api -- --database "E:/onlineVideo/.local/data/new-install.db"
```

此命令未指定 `--key-file`，所以使用目标数据库的伴随密钥。若使用共享密钥，必须明确指定：

```powershell
npm run start:setup -w @online-video/api -- --database "E:/onlineVideo/.local/data/another-install.db" --key-file "E:/onlineVideo/.local/data/new-install.db.auth.key"
```

也可使用 `npm run start:setup -w @online-video/api -- --config "config/deployment.json"`。命令行 `--config` 与 `--database` 不能混用。

原 `.env` + 旧 `server.ts` 入口仅作为显式兼容命令保留，不自动升级旧库：

```powershell
npm run dev:legacy -w @online-video/api
# 或构建后：
npm run start:legacy -w @online-video/api
```

旧账号初始化/恢复/邮件 CLI 仍属于旧流程，不用于配置新的数据库启动方式。原 VS Code F5 配置也仍指向旧入口；新方式使用终端 `npm run dev:api` 或“启动 API”任务。

备份时保留启动 JSON、每个数据库及其 `.library.json`、匹配的主密钥；首次安装未完成的库还需保留安装码。SQLite 应停服务后复制或使用一致性在线备份，不能只复制运行中的 `.db` 而漏掉 WAL。共享密钥丢失将同时影响所有依赖它的数据库。

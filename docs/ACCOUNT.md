# 本人账号与真实登录

CORE-02/03 已实现，并按用户授权在 `.local/data/video-library.db` 新建正式库与唯一本人账号。用户 `sqlite-test.db` 未修改。

2026-10-02第二阶段更新：正式库已按具体授权备份升级v2，原账号/恢复资料保留；组织/库/上传/播放/续签/下载/进度真API和本机真实STS/私有OSS完整链已验，当前库有两验收视频。专用测试会话已退出，不重建账号，使用原密码与TOTP即可。下列第一阶段范围记录保留为历史，当前状态优先见[完成审计](STAGE2_COMPLETION_AUDIT.md)和[本地运行](LOCAL_DEVELOPMENT.md)。

## 1. 当前账号

账号显示名：**本人**。系统为单人账户，没有用户名输入或公开注册入口；登录使用密码加 TOTP 六位动态验证码。

初始资料在项目本地 `.local/account-setup.json`，只在本人电脑读取，不纳入 Git：

- `password`：随机生成的初始密码。
- `totpSecret`：验证器的手动绑定密钥；时间型 TOTP、SHA1、6 位、30 秒。
- `otpauthUri`：支持该格式的验证器可导入，不发送到在线二维码生成网站。
- `recoveryCodes`：离线保存的单次恢复码。

在手机验证器中添加账号“PrivateVideoLibrary / 本人”，手动输入 totpSecret，类型选择基于时间；网页验证码栏填验证器当前六位码。每个验证码只能登录一次，重复使用需等下一个 30 秒码。

账号资料、`.local/secrets/auth.key` 与数据库均属秘密，不能放到前端 public、Git 或公开附件中。TOTP 在库中使用 AES-256-GCM 加密，密码使用 Argon2id；数据库里只有 Cookie 摘要和恢复码摘要。仅靠 SQL 插入明文密码无法使用这套登录。

本次实际检查 Windows ACL 后，已按批准范围保护新建 `.local`：普通 Users 组不再有访问权，保留本人 xuzailiang、SYSTEM、Administrators 和已批准的 CodexSandboxOffline 运行账号。没有改其他项目目录权限。CLI 的 0600 创建模式不能单独代替 Windows ACL；在其他机器运行初始化时应核查其本地权限。

## 2. 启动与实际可用范围

两个 PowerShell 终端分别执行：

```powershell
cd E:\onlineVideo
npm run dev:api
```

```powershell
cd E:\onlineVideo
npm run dev:web
```

打开 `http://127.0.0.1:5173/login`。使用真实密码和动态验证码；不要使用 dev:web:mock，它仍是独立演示账号。

真实 `/api/auth/login`、`/me`、`/logout`、`/sessions` 与会话 revoke 已可用，默认 API 同时提供 health。数据库/密钥未初始化、版本或密文错误时拒绝启动，不自动建库/重置凭证。当前网站登录后视频库/上传等业务仍需 CORE-04～06 进行 HTTP 接口和媒体统一装配；本轮没有自动展开这些任务或连接 OSS。独立模块之前的 Mock 完成记录保留。

实际已验证正式账号的 HTTP 登录 200、me 200、退出 200、退出后访问 401、Argon2id/加密 TOTP 与 SQLite integrity_check=ok。验证会话已经退出。最新测试构成为后端 40 项、前端 8 项；类型检查与构建通过。新增验证包括初始化 CLI/拒绝覆盖、绑定资料写盘失败保留旧状态、SQLite 一致性备份恢复。真实 SQL/鉴权已在隔离测试中注入媒体模块验证，默认服务器仍未注册媒体业务。

## 3. 配置与安全行为

| 配置 | 默认/限制 |
| --- | --- |
| DATABASE_PATH | 项目 .local/data/video-library.db，仅允许 .local 内的 .db |
| AUTH_KEY_FILE | 项目 .local/secrets/auth.key，32 字节二进制密钥，禁止缺失后自动生成替代 |
| AUTH_ALLOWED_ORIGINS | 开发为 http://127.0.0.1:5173 与 http://127.0.0.1:3000；精确匹配，无通配符 |
| AUTH_SESSION_TTL_MS | 86400000（24 小时），最长 7 天，不滑动延长登录会话 |
| AUTH_FAILURE_WINDOW_MS / AUTH_MAX_FAILURES | 900000 / 5；账户和可信来源 IP 双维度持久化限流，重启不清零 |
| TRUSTED_PROXIES | 默认未配置，不相信任意转发头；仅允许明确 IP/CIDR |

开发 HTTP 仅允许回环可信 Origin，Cookie 是 HttpOnly、SameSite=Strict、Path=/；HTTPS 策略用 Secure 与 __Host- 前缀。生产可信 Origin 必须 HTTPS，但 NODE_ENV=production 仍留待 CORE-06 完整安全装配，不因本轮账号可用而提前放行。

写操作必须有当前 Cookie、`x-csrf-token` 和可信 Origin，跨站来源拒绝。验证码使用持久化计数器原子消费；异步密码检查期间若账号密钥/密码发生变化，不能按旧快照登录。会话撤销同时关闭其播放会话。日志不输出请求体、Cookie、密码、验证码密钥、CSRF 或内部异常路径。

## 4. 初始化、恢复、SQL 与 Git

本次账号已初始化，**不要再次执行初始化命令**。新环境明确需要创建全新本人账号时才用：

```powershell
npm run account:init -w @online-video/api
```

重复执行会拒绝已有库或资料文件，不覆盖、删除或清空。SQL 表结构在 [0001-initial.sql](../apps/api/src/db/migrations/0001-initial.sql)，数据库/迁移/备份边界见 [DATABASE.md](DATABASE.md)。账号初始化由本地 CLI 生成可靠密码哈希、TOTP 密文及恢复码，不提供公开注册 SQL 或匿名重置接口。

手机验证器丢失后，需要本机管理权限、当前密码及一条未使用的恢复码；在 .local 中创建仅本人读取的 JSON（例如 recovery-input.json）：

```json
{ "password": "当前真实密码", "recoveryCode": "一条未使用的恢复码" }
```

经用户明确授权恢复后执行：

```powershell
npm run account:recover -w @online-video/api -- --input E:\onlineVideo\.local\recovery-input.json
```

验证成功后生成全新的 account-recovery-*.json（不覆盖初始资料），更新 TOTP、使旧会话和旧恢复码失效，新文件包含新的验证器配置和恢复码，密码保持原值。该命令不清理输入文件/日志/数据库。仅在隔离测试中验证了恢复；未对本次实际账号执行恢复。

所有源码模块、SQL迁移、配置、测试和交接文档加入 Git 暂存区；.local、真实 .env、数据库、依赖/缓存/构建目录排除。没有自动提交或推送。

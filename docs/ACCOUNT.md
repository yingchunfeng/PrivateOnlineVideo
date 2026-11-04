# 本人账号与真实登录

> **2026-11-02 受限访客更新：管理员可在“访客管理”按到期时间和页面/操作权限创建临时凭证，访客从 `/guest/login` 独立登录。** 临时密码仅创建或重置时展示一次；到期、提前失效或重置会撤销全部旧会话。访客不拥有系统设置、账户安全或访客管理权限，不绕过管理员邮箱/TOTP/恢复校验，也不提供公众注册。视频库共享，上传任务按访客隔离；已复制的 OSS 公共直链不会随站内凭证失效。需 v8 访客表，已有库不自动升级，详见[管理页面与访客](../README.md#管理页面与访客)。

> **2026-10-26 新部署更新：默认 `adminadmin` 仅配合一次性安装码进入受限向导，强制改密后正常使用纯密码登录。** SMTP 可在网页配置并测试，邮箱登录验证可通过实际收码确认开启/关闭；旧账号、TOTP/邮箱和恢复资料不重置。新流程和独立密钥路径见[新部署指南](NEW_INSTALL.md)，下文旧 CLI 初始化说明不用于新向导。

2026-10-04 多邮箱支持更新：正式库已按单独授权备份升级 v5，新增 QQ/163 类型码表和独立加密 SMTP 配置，163 配置已保存，原账号与 QQ 配置保留。页面提示及后端白名单保持一致；正常重启 API 后生效。最新方案与执行证据见 [QQ 与 163 邮箱支持](SMTP_PROVIDERS.md)，下文 v4/JSON 方案为历史记录。

2026-10-04 SMTP 更新：发信配置改为数据库 `smtp_config`，授权码使用原 `auth.key` 加密；用户授权后正式库已备份升级 v4 并保存配置，原账号资料保留，正常重启 API 后生效。配置命令、备份与验证见 [SMTP 配置说明](SMTP.md)。下文 JSON SMTP 的开发记录为历史方案。

2026-10-04 07:34 UTC 授权升级补充：用户已单独授权正式库一致性备份及 v3 升级，现已执行并验证；原账号、密码哈希、TOTP 密文、10 条恢复码和 8 个视频保留，继续使用原密码 + TOTP。完整运行时在临时回环端口启动检查通过；未代替用户重启现有 watch 进程。备份与校验见本地历史记录 `docs/ACCOUNT_EMAIL_IMPLEMENTATION.md` 的正式 v3 升级段落；下文“不升级”描述为开发阶段历史范围。

2026-10-04 邮箱认证开发更新：账号实时状态以 SQLite 为唯一来源，`account-setup.json` 是离线历史资料，初始密码可能已不再可用。追加 0003 后旧账号保持 TOTP，邮箱验证成功才切到邮箱登录。正式库本轮不升级、不初始化，SMTP 实际投递尚未验证；实现和验收记录本地保留于 `docs/ACCOUNT_EMAIL_IMPLEMENTATION.md`，当前使用步骤见[新部署指南](NEW_INSTALL.md)。下文保留既有历史操作与验收记录。

CORE-02/03 已实现，并按用户授权在 `.local/data/video-library.db` 新建正式库与唯一本人账号。用户 `sqlite-test.db` 未修改。

2026-10-02第二阶段更新：正式库已按具体授权备份升级v2，原账号/恢复资料保留；组织/库/上传/播放/续签/下载/进度真API和本机真实STS/私有OSS完整链已验，当前库有两验收视频。专用测试会话已退出，不重建账号，使用原密码与TOTP即可。下列第一阶段范围记录保留为历史；阶段完成审计本地保留于 `docs/archive/STAGE2_COMPLETION_AUDIT.md`，当前运行方式见[本地运行](LOCAL_DEVELOPMENT.md)。

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

## 5. 会话恢复与退出入口（2026-10-04）

用户明确选择：有效会话期间刷新或再次打开可直接进入；退出后必须重新登录。前端仅在真实 `/api/auth/me` 验证 Cookie 成功后恢复用户状态，未登录访问安全、上传等页面会跳转登录。对实际 `http://127.0.0.1:5173` 的匿名 HTTP 检查返回 AUTH_REQUIRED/401，登录方式接口返回 TOTP；没有关闭路由鉴权或自动创建登录会话。

当前侧栏在窄屏隐藏，因此在账户安全页顶部新增“退出登录”，桌面和手机均可使用。按钮调用现有 Cookie + CSRF 退出接口，撤销当前会话、清理前端认证状态并回到登录页；发送失败会显示错误，不假报退出成功。需要重新走登录时，打开安全页点击该按钮；保留已有有效会话时直接进入属于上述约定。

本次只修改 `apps/web/src/pages/Security.tsx`、`apps/web/test/account-security-browser.test.ts` 和本说明，未修改正式账号、数据库或实际配置。真实 HTTP + 隔离 SQLite + Fake 邮件浏览器测试 7/7 通过，新增验证无 Cookie 的深链接、有效会话刷新与新页面、退出 Cookie 清除、旧 Cookie 返回 401、退出后再次访问上传仍回登录；Web 单元 25/25、类型检查、构建通过。成功证据在 `.local/acceptance/account-security-5ca70358-e2fa-465d-9b2f-e12d9c5a5a78`，含手机退出入口及退出后登录截图。此范围不等同于正式用户浏览器 Cookie 已被清除。

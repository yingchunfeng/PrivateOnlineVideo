# QQ 与 163 邮箱支持

运行配置由 SQLite 的 `smtp_provider_types` 和 `smtp_provider_configs` 提供。两套 SMTP 配置独立保存，发信时按收件地址的完整域名选择对应账号。网站登录页、首次绑定和修改邮箱页面显示启用的类型；目前支持 `@qq.com`、`@163.com`。

## 表与控制

| 表 | 用途 |
| --- | --- |
| smtp_provider_types | 支持类型码表：code、name、email_domain、smtp_host、enabled |
| smtp_provider_configs | 类型对应的发信账号：provider_code、host、port、secure、user、password_cipher、from、timeout_ms、updated_at |
| smtp_config | v4 单条配置历史表，记录保留；v5 运行时不再读取或更新它 |

`provider_code` 为主键并引用支持类型码表，同一种类型只保留一套配置。QQ 和 163 配置分别保存，添加或更新 163 不覆盖 QQ。密码字段只保存原 `auth.key` 加密后的 AES-256-GCM 密文。

| 类型 | 允许的账号域名 | SMTP 地址 |
| --- | --- | --- |
| qq | qq.com | smtp.qq.com |
| 163 | 163.com | smtp.163.com |

类型、账号域名、SMTP 地址必须匹配，From 必须等于发信账号。只允许 465/直接 TLS 或 587/强制 STARTTLS，拒绝其他端口或 TLS 组合。主机白名单防止将服务地址改为任意主机。数据库约束与本地配置命令均检查这些规则。

码表的 `enabled` 控制是否启用该类型。绑定、改绑、邮箱登录发码和确认步骤由后端检查完整域名以及启用状态，不接受子域名、相似域名、其他邮箱类型或已经停用的类型。类型停用后不能使用先前验证码完成绑定；旧绑定、操作和验证码记录保留。已有邮箱登录账号所用类型停用会影响该账号的邮箱登录与安全操作，修改此开关前需要明确授权。

运行时不在两种账号之间自动回退：对应类型缺少配置时返回 `MAIL_NOT_CONFIGURED`，不会使用另一种发信账号。改邮箱保留原双验证流程：向旧类型邮箱发旧验证码，向新类型邮箱发新验证码，成功后通知原邮箱。密码、会话撤销、用途隔离、持久冷却与限流机制保留。

## 保存配置

在项目根目录执行：

```powershell
npm run mail:configure -w @online-video/api -- --database E:/onlineVideo/.local/data/video-library.db --input E:/onlineVideo/.local/secrets/smtp-input.json --apply
```

命令先核对数据库版本、账号与原密钥匹配，创建 SQLite 一致性备份，再加密保存该类型配置。JSON 字段仍为 host、port、secure、user、password、from、timeoutMs；可选 `providerCode` 为 `qq` 或 `163`，省略时按账号域名识别。授权码不要放进可提交脚本、SQL、前端或命令参数。

`--input -` 可从标准输入读取 JSON，无需保留明文输入文件。现有文件不自动覆盖或删除，配置更新后正常重启 API 生效；类型停用会在后端下一次校验时立即阻断发信与新绑定。查看帮助：

```powershell
npm run mail:configure -w @online-video/api -- --help
```

## 迁移与页面契约

新增 [0005-smtp-providers.sql](../apps/api/src/db/migrations/0005-smtp-providers.sql)，v4→v5 只追加两张表并插入 QQ/163 类型；对匹配白名单的旧配置复制现有密文，原 `smtp_config` 和所有账号业务数据保持不变。最新应用结构为 v5/32 表，服务启动不会自动迁移，正式执行需要明确目标与授权，并通过迁移命令先做一致性备份。

`GET /api/auth/login/options` 和已登录的 `GET /api/auth/security` 返回 `emailProviders: [{code,name,domain}]`。页面与后端使用这一份启用类型列表。摘要不包含 SMTP host、账号、授权码或密文；非法列表、重复类型、未知代码和不匹配的域名被前端拒绝。

## 验证范围

前后端构建、类型检查、后端相关 50 项测试、前端 26 项测试与真实 HTTP/SQLite 加 Fake 邮件的手机浏览器 7 项测试通过。验证了 QQ 配置迁移保留、两类型独立保存和投递路由、主机与账号校验、类型停用、域名伪装拒绝、QQ→163 双验证、页面提示和手机无横向溢出。截图证据位于 [手机浏览器验收目录](../.local/acceptance/account-security-b417f894-37ed-4eaf-9e87-2754e31e87d7)。真实 SMTP 接受与收件箱送达尚未验证。

生产入口检查的旧测试摘要已补齐 `emailProviders`，生产构建页面的 QQ/163 提示和无开发凭证检查通过。SQL 约束复核补充拒绝空类型、空名称与账号域名伪装，相关 12 项测试通过。

## 2026-10-04 正式执行记录

用户单独明确授权目标 `E:/onlineVideo/.local/data/video-library.db` 的一致性备份、v5 升级和 163 配置保存，保留原 QQ 配置。已完成：

- [迁移前 SQLite 一致性备份](../.local/backups/before-migration-1791106213144-092af660-3810-4055-b0c1-d12f406b7050.db)，原版本 v4/30 表。
- [保存 163 前一致性备份](../.local/backups/before-smtp-config-1791106223753-1f89d1d1-6a50-4894-bd9a-fcb1a072e4f9.db)，版本 v5/32 表，已复制 QQ 配置。
- [迁移前校验摘要](../.local/acceptance/smtp-providers-v5-20261004-f260c09a/before.json)和[迁移后校验报告](../.local/acceptance/smtp-providers-v5-20261004-f260c09a/after.json)：正式库当前 v5/32 表，类型 2 条、配置 2 条。原 30 表结构与业务记录保持一致，原 ledger 前 4 条校验一致，用户 1、视频 8、恢复码 10 保留；原 `auth.key`、手工测试库与 0001～0004 SQL 的 SHA-256 保持一致。
- 原 QQ 配置的全部字段和密文保持一致。163 配置通过标准输入加密保存，未新建明文凭证 JSON，两类型授权码均可使用原密钥解密。正式 Auth runtime 已装配按类型发信适配器，摘要列出 QQ/163，原邮箱认证方式保留。正式库 integrity_check=ok，外键异常为 0。
- 未连接 SMTP 或发送真实邮件，未强制终止用户进程。正常重启 API 后读取两套配置；前端刷新后显示最新类型提示。

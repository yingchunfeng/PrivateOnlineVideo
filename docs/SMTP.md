# SMTP 数据库配置

> **验收状态更新（2026-10-26）：用户确认真实邮件验证已通过。** 下文未发送真实邮件、真实投递待验等表述是当时的执行记录，不再作为当前待办；当前验证边界见[项目说明](../README.md#验证范围)，v5 配置及正式执行记录见[QQ 与 163 邮箱支持](SMTP_PROVIDERS.md)。

当前方案为 v5：使用 `smtp_provider_types` 支持类型码表和 `smtp_provider_configs` 分别保存 QQ/163 配置，详见 [QQ 与 163 邮箱支持](SMTP_PROVIDERS.md)。以下保留 v4 单条 `smtp_config` 配置方案及实际执行记录；原表不删除，v5 运行时不再读取它。

## 配置表

| 字段 | 内容 |
| --- | --- |
| id | 固定为 1，整个站点只保留一条配置 |
| host、port、secure | SMTP 主机、端口、直接 TLS 开关 |
| user、from | 发信账号与 From 地址 |
| password_cipher | SMTP 授权码的 AES-256-GCM 密文 |
| timeout_ms | 连接、问候与 socket 超时，默认 15000，范围 1～60000 |
| updated_at | 配置保存时间 |

授权码使用原 `.local/secrets/auth.key` 加密，SMTP 与 TOTP 的密文认证用途分离。数据库与匹配密钥需要分别保护并共同保管，不能只复制数据库就更换密钥。配置不会通过网站 API 返回，授权码不写进源码、迁移 SQL、日志或前端。

## 已有库升级

服务启动不会自动升级数据库。明确授权正式目标后，在项目根目录执行：

```powershell
npm run db:migrate -w @online-video/api -- --database E:/onlineVideo/.local/data/video-library.db --apply
```

迁移命令先调用 SQLite backup API 新建一致性备份，然后在事务内升级。v3 升级到 v4 后只有新增的 SMTP 表为空；旧账号、恢复码、会话、视频和已有表数据保留。不要对正式库执行空库完整建表脚本，不使用 `sqlite-test.db`。

## 保存或更新配置

配置命令可显式导入项目 `.local` 内的 UTF-8 无 BOM JSON，字段示例只使用占位值：

```json
{
  "host": "smtp.example.invalid",
  "port": 465,
  "secure": true,
  "user": "sender@example.invalid",
  "password": "在本机填写SMTP授权码",
  "from": "sender@example.invalid",
  "timeoutMs": 15000
}
```

```powershell
npm run mail:configure -w @online-video/api -- --database E:/onlineVideo/.local/data/video-library.db --input E:/onlineVideo/.local/secrets/smtp-input.json --apply
```

`--input -` 支持从标准输入读取 JSON，可由本地管理程序传入，无需保留明文 JSON。不得把授权码直接放进命令参数或可提交的脚本。输入文件若已存在，不自动覆盖或删除。

命令要求显式目标和 `--apply`，先校验字段、数据库版本、原账号与密钥匹配，再新建 `before-smtp-config-*.db` 一致性备份，并将配置保存到固定 id=1 的记录中。授权码只保存为随机密文；后续更新同一条记录，不创建重复配置。失败时仅输出概括错误，不输出输入内容或 SMTP 原始异常。命令不会连接邮箱提供商或发送邮件。

默认密钥路径使用 `AUTH_KEY_FILE` 或项目 `.local/secrets/auth.key`，可用 `--key-file` 指定项目 `.local` 内的匹配原密钥。查看命令说明：

```powershell
npm run mail:configure -w @online-video/api -- --help
```

## 生效与服务器部署

后端在启动时读取配置，保存后需在原终端正常停止并重新执行 `npm run dev:api`；生产环境重启对应 API 服务。原 `smtp.json` 文件保留，但 `SMTP_CONFIG_FILE` 不再作为运行配置。没有数据库配置时旧 TOTP 登录仍可用，发邮件返回 `MAIL_NOT_CONFIGURED`；配置或密钥损坏则拒绝启动，不降级或回退到明文文件。

通常 465 使用 `secure: true`；587 使用 `secure: false`，适配器强制 STARTTLS，具体值以邮箱提供商要求为准。服务器上线时需安全交接数据库与匹配的原密钥，或在服务器正式库单独执行配置命令；后端运行账号需能读取数据库和密钥，并能连接 SMTP 服务。

## 验证范围

已使用隔离数据库验证 v3→v4 旧数据保留、单条配置约束、输入校验、密文随机性、错误密钥和篡改拒绝、用途分离、CLI 的 apply/一致性备份、重启后从数据库读取，以及模拟 SMTP 的投递和 TLS 选项。真实 SMTP 接受、验证码收件箱送达和远程服务器部署需要另行实际验证。

## 2026-10-04 正式库执行记录

用户已单独明确授权正式目标 `E:/onlineVideo/.local/data/video-library.db` 的备份、v4 升级和 SMTP 配置保存，并确认输入末尾的中文“码”为说明文字。已通过标准输入导入配置，未新建明文凭证 JSON。

- 迁移前一致性备份（仅本地）：`.local/backups/before-migration-1791102128391-b47fdfb9-2704-487d-8acc-762fdeb69908.db`，v3/29 表。
- 配置保存前一致性备份（仅本地）：`.local/backups/before-smtp-config-1791102143801-64d5454a-a3a1-4ae4-9822-a4cdb7b8c743.db`，v4/30 表，SMTP 表为空。
- 迁移前校验摘要与迁移后校验报告（仅本地）：`.local/acceptance/smtp-v4-20261004-a972f3cb/before.json`、`.local/acceptance/smtp-v4-20261004-a972f3cb/after.json`；正式库现为 v4/30 表，SMTP 配置 1 条；原有表定义、业务记录及 ledger 前 3 条一致，账号 1、视频 8、恢复码 10 保留。原 `auth.key`、手工 `sqlite-test.db` 和 0001～0003 SQL 的 SHA-256 保持一致。
- 原库与两个备份的完整性均为 ok，外键异常均为 0。正式配置为 `smtp.qq.com:465`、直接 TLS，授权码可用原密钥解密且未以明文保存；正式 Auth runtime 已成功加载 SMTP 适配器，未连接 SMTP 或发送真实邮件。
- API 构建、包含管理脚本的类型检查与相关 45 项测试通过。现有 API 进程未强制终止，用户正常重启后读取新配置。

# 数据库账号与邮箱认证：实现契约及验收记录

> **当前状态（2026-10-26）：真实邮件验证已获用户确认通过。** 正式数据库已有后续 v5 升级与 QQ/163 配置记录，见[邮箱类型说明](SMTP_PROVIDERS.md)。下文 v3/v4、SMTP JSON、待升级/待投递描述保留为历史，不重新执行；当前待办统一见[未完成工作清单](task/UNFINISHED_WORK.md)。

SMTP 最新补充：2026-10-04 已按用户要求改为数据库 `smtp_config` 配置，并经单独授权完成正式库一致性备份、v4 升级与授权码加密保存。配置及证据见 [SMTP 数据库配置](SMTP.md)；下文受保护 SMTP JSON 为上一轮历史方案，运行时不再读取。

最新补充：2026-10-04 用户已单独授权正式库备份升级，v3 迁移与完整运行时启动检查通过；见文末“正式 v3 升级实际记录”。下文“未升级/待授权”为开发阶段的真实历史记录，保留不改写。

本文件记录本次新增功能，不改写 ACCOUNT.md 中既有历史验收结论。正式数据库、初始化资料及实际配置不在本次开发写入范围。

## 冻结契约

共享 DTO 和错误码以 `packages/shared/src/dto.ts`、`errors.ts` 为准。旧 TOTP 请求 `{password,totp}` 仅兼容数据库 `auth_method=totp`；邮箱请求必须为 `{authMethod:"email",password,challengeId,code}`。

| 方法 | 路径 | 请求 / 返回 DTO | 认证 |
| --- | --- | --- | --- |
| GET | /api/auth/login/options | LoginOptions；只公开方式与时间 | 未登录可读 |
| POST | /api/auth/login/code | LoginCodeRequest / EmailChallenge | 可信 Origin；不允许传收件邮箱 |
| POST | /api/auth/login | LoginRequest / AuthSession | 可信 Origin |
| GET | /api/auth/security | AccountSecuritySummary | Cookie |
| POST | /api/auth/email/bind/code | BindEmailRequest / EmailChallenge | Cookie + CSRF + Origin |
| POST | /api/auth/email/bind/confirm | BindEmailConfirmRequest / AccountMutationResult | 同上 |
| POST | /api/auth/password/code | PasswordCodeRequest / EmailChallenge | 同上 |
| POST | /api/auth/password/confirm | ChangePasswordRequest / AccountMutationResult | 同上 |
| POST | /api/auth/email/change/old/code | ChangeEmailRequest / EmailChallenge | 同上 |
| POST | /api/auth/email/change/old/verify | VerifyOldEmailRequest / EmailChangeAuthorization | 同上 |
| POST | /api/auth/email/change/new/code | AccountOperationRequest / EmailChallenge | 同上；目标取持久化操作 |
| POST | /api/auth/email/change/confirm | ChangeEmailConfirmRequest / AccountMutationResult | 同上 |
| POST | /api/auth/operations/cancel | AccountOperationRequest / {success:true} | 同上 |

保留原 me/logout/sessions/revoke。账号修改成功清 Cookie、撤销全部会话并提升认证版本。二次凭据错误为 400，真正会话失效为 401。公开 OSS 播放地址不因站内会话撤销而失效。

## 数据库与状态

仅追加 `0003-account-email.sql`；0001、0002 内容与校验和不变。users 增加 `email`、`email_verified_at`、`auth_method`（默认 totp）、`auth_version`（默认 1）；login_sessions 增加 auth_version。邮箱模式要求非空且已验证的邮箱，通过数据库约束/触发器及服务检查保护。

新增 email_challenges、account_operations、email_send_limits、security_notifications。挑战记录账号、用途、目标、版本、操作、必要会话、HMAC 摘要、发送顺序、时间、错误次数和使用/作废状态。操作绑定账号、会话、版本、类型和目标，状态含 pending/old_verified/completed/cancelled/invalidated。

发送先短事务预留持久额度并建立 pending，网络调用在事务外。成功后重查账号密码快照、版本、会话、操作及同作用域发送顺序，变为 sent 才作废同用途旧码。失败、超时、被更晚请求替代、账号变化均不可用于验证，并保留原有效码。挑战有效期默认 5 分钟，重发 60 秒，错误上限 5，账号及可信 IP 每小时各最多 10 次；计数持久化。

随机 6 位数字仅进入邮件信封和测试 Fake 内存；数据库存由服务端密钥派生、绑定挑战及用途上下文的 HMAC。错误验证事务返回错误码并提交错误计数，事务结束后才抛出 HTTP 错误。正确验证码原子消费与创建会话或账号修改在同一事务。账号安全变更提升 auth_version 并作废所有旧挑战/操作，异步密码检查后事务再次校验原密码哈希、版本和会话状态。

## 邮件注入契约

后端独占 `apps/api/src/modules/auth/mail.ts`，导出：

```ts
type MailMessage =
  | { kind: "verification"; to: string; purpose: EmailChallengePurpose; challengeId: string; code: string; expiresAt: string }
  | { kind: "notification"; to: string; purpose: "password_changed" | "email_changed"; changedAt: string };
interface MailSender { send(message: MailMessage): Promise<void> }
```

`AuthService(database,key,settings,now,mailSender)` 保留第 4 参数时钟，第 5 参数注入 sender。默认缺失 sender 明确报 MAIL_NOT_CONFIGURED。runtime 使用 SMTP 适配器，验收使用 Fake，不提供生产固定码或控制台验证码。通知状态独立持久化，通知失败不得回滚或报告账号修改失败。

AuthService 方法约定：login、requestLoginCode、loginOptions、security、bindEmailRequest、bindEmailConfirm、passwordRequest、passwordConfirm、emailChangeRequest、emailChangeVerifyOld、emailChangeRequestNew、emailChangeConfirm、cancelOperation。除 loginOptions 外所有用户操作接受 FastifyRequest，安全操作自行 requireUser。

SMTP 配置使用受保护文件 `SMTP_CONFIG_FILE`，默认 `.local/secrets/smtp.json`；文件含 host、port、secure、user、password、from、可选 timeoutMs。使用 nodemailer 及其类型包，依赖由主控串行处理。缺失 SMTP 不阻断旧 TOTP 启动或登录。

## 实现与检查

实际文件、命令结果及验收证据见本文后面的交付记录；共享契约本身不作为测试或真实邮件投递证据。

## 使用与配置

全新独立环境只有在明确授权创建新账号后才使用既有 `account:init`，初始方式仍为密码 + TOTP，随后按下面的首次绑定步骤切换邮箱。本项目现有账号无需且不得重新初始化；升级保留原账号 ID 和业务关联。

旧账号升级后仍使用当前密码和原验证器 TOTP 登录。在账号安全页输入当前密码、当前 TOTP 和目标邮箱，发送并验证邮件验证码。验证成功后全部会话撤销，重新进入登录页，输入密码发码，再输入绑定邮箱收到的验证码登录。邮箱验证成功前原 TOTP 登录保持有效；邮箱模式下原 TOTP 仅为受保护恢复保留，不能替代邮箱登录。

邮箱模式下改密码：安全页输入当前密码、新密码及确认密码（12～128 字符），先向当前绑定邮箱发码，再提交验证；成功后所有会话撤销，使用新密码重新邮箱登录。改邮箱：输入当前密码与目标新邮箱，先验证旧邮箱，授权锁定目标，再发送并验证新邮箱。取消/失败/过期均保持原绑定；成功后用新邮箱收码重新登录。通知失败独立记录，前端仍报告账号修改成功。

邮箱不可用时，本机管理员仍使用当前密码和未使用恢复码执行原受保护 `account:recover`，不接受未经验证的新邮箱。新恢复资料以独立文件保存并 sync 成功后才消费恢复码和更新账号；切回 TOTP，保留原邮箱但清除验证时间，随后在安全页使用新 TOTP 验证邮箱并重新切换。历史 account-setup.json 不更新、不作为实时密码/邮箱来源。

需要用户在本机配置具备 SMTP 发信能力的邮箱服务（如支持 SMTP 的企业邮箱或个人邮箱）：服务地址、端口、TLS 模式、发信账号、应用授权码和 From 地址。将信息写入受保护的 `E:/onlineVideo/.local/secrets/smtp.json`，或使用 `SMTP_CONFIG_FILE` 指向 `.local` 内其他受保护文件；不要在聊天中粘贴授权码。配置字段示例（均为占位，实际文件本轮不创建）：

```json
{
  "host": "smtp.example.invalid",
  "port": 465,
  "secure": true,
  "user": "sender@example.invalid",
  "password": "在本机填写应用授权码",
  "from": "sender@example.invalid",
  "timeoutMs": 15000
}
```

465 通常为直接 TLS（secure:true），587 通常为强制 STARTTLS（secure:false）；以所选邮箱服务的配置为准。文件需仅运行账号/管理员可读，并保留现有 .local ACL。当前没有 SMTP 配置，本次只验 Fake 投递与真实 HTTP/SQLite，真实 SMTP 接受及最终邮箱送达待用户本机配置后单独验证。

## 正式数据库升级边界

候选目标为 `E:/onlineVideo/.local/data/video-library.db`（当前配置没有显式 DATABASE_PATH；如后续配置改变，须重新确认精确目标）。本次不执行正式迁移。服务对非最新 ledger 拒绝启动，不自动迁移或初始化。

获得单独明确授权后，再由站点管理员安排服务维护窗口，自行停止对该库写入；本任务不终止现有服务。保留原数据库及 auth.key，使用现有 db:migrate CLI 的 SQLite backup API 创建新的 `.local/backups/before-migration-<时间>-<UUID>.db` 一致性副本，不使用复制在线 db 文件代替备份。确认备份可读、integrity_check=ok、foreign_key_check 无异常，并记录原账号 ID/密码哈希/TOTP 密文/恢复码与业务关联的校验；仅在受保护环境核对，不公开值。CLI 在完成备份后以 immediate 事务应用新增迁移，保留旧数据和既有 ledger 校验和。

以下命令是授权后的操作说明，本轮未执行：

```powershell
npm run db:migrate -w @online-video/api -- --database E:\onlineVideo\.local\data\video-library.db --apply
```

迁移后检查三条 ledger、一致性、外键、原账号/恢复/业务关联，并验证旧 TOTP 登录，再进行真实邮箱首次绑定与重新登录。失败时保留原库/新备份/历史资料，优先停止升级并核查；如需恢复，只从验证后的备份创建新的独立目标并匹配原密钥，另行明确授权，不覆盖在线原库。不执行 account:init。

## 实际交付与验收结果（2026-10-04）

开发与隔离验收完成，保留单人账号、SQLite、Cookie + CSRF 和原账号业务关联。现有工作区修改保留，未切分支、未提交或重写 Git 历史；未删除文件或清理历史产物。开发没有对正式库执行写入、初始化、恢复或迁移，也没有启动/终止用户现有服务或部署。

| 实际检查 | 结果与范围 |
| --- | --- |
| npm run check | 退出码 0；API 121/121，Web 单元 25/25，Shared/API/Web 类型检查及构建全部通过 |
| 新账号 account-email.test.ts | 20/20；真实 SQLite、数据库迁移、双连接竞争、实际关闭再重开、真实 runtime 及恢复 CLI，邮件仅 Fake |
| npm run test:e2e -w @online-video/web | 串行 13/13；包括新账号主测试及 5 个阶段（计 6），其余为原业务浏览器回归 |
| npm run test:production -w @online-video/web | 1/1；实际生产入口/可达 chunk 无 Mock 与服务端资料，邮箱登录表单读取独立路由夹具，不连接正式 API |
| npm run build:release -w @online-video/web | 独立新目录全目录扫描通过，生成 manifest；历史 dist 保留不删除 |
| npm install 邮件依赖 | 固定 nodemailer 10.0.14、@types/nodemailer 8.0.2，安装后 audit 0 漏洞 |
| git diff --check（本次相关路径） | 通过；仅 Git 换行策略提示，未重排无关文件 |
| 编码 | 本次 52 个源码/配置/测试/文档均严格 UTF-8 解码通过，无 BOM |
| 保护文件 | 0001、0002、实际 .env、sqlite-test.db、.local/account-setup.json 与开发基线 SHA-256 完全一致 |

最终全量日志：[npm run check](../.local/acceptance/account-final-check-20261004-0qg3b9obpeub.log)。新账号 HTTP 浏览器成功截图在 [.local/acceptance/account-security-63a677c5-af90-4d93-81b0-a1afd6f05362](../.local/acceptance/account-security-63a677c5-af90-4d93-81b0-a1afd6f05362/)（5 张手机截图，主控已检查邮箱修改页）。页面宽度 375px 的文档和 body 均无横向溢出；邮箱收件地址、验证码、挑战和密码均为隔离测试资料。证据不是 Android 实机验收。

最终独立前端产物：[stage2-release-2026-10-04T07-17-08-386Z](../apps/web/dist/stage2-release-2026-10-04T07-17-08-386Z/index.html)，[manifest](../apps/web/dist/stage2-release-2026-10-04T07-17-08-386Z/manifest.json)。根 dist 中原历史 Mock chunk 仍保留，当前生产入口不会引用；交付采用这个独立产物，不将历史产物目录整体当作本轮发布包。本轮没有部署。

### 核心验收证据

| 要求 | 证据 |
| --- | --- |
| 旧库追加迁移不丢账号与业务关联 | account-email 旧库逐字段/会话/恢复摘要/视频关联/ledger 校验；一致性与外键检查；stage2 历史 v2 SQL 对照及追加 v3 对照 |
| 不依赖初始化 JSON，按认证方式启动/登录 | 新真实 runtime 使用专用数据库与密钥，无 setup JSON；TOTP 登录可用；邮箱模式禁用 totpEnabled 后仍通过 Fake 邮件正式登录；缺 SMTP 报 MAIL_NOT_CONFIGURED |
| 绑定前保留 TOTP，绑定后拒绝普通 TOTP | API + 真实 HTTP 浏览器全流程；密码与 TOTP 双校验；绑定后版本提升/全会话撤销 |
| 密码错误不发码、固定绑定收件人、Origin/CSRF | Fake 发送调用计数不变；额外 email 字段拒绝；真实 HTTP 跨站 403；精确 ApiClient 白名单与安全操作 CSRF |
| 有效期、错误上限、用途/目标/会话隔离 | 错误次数逐次提交；过期、重发旧码失效；跨用途、B目标码不能确认A、另一会话不能使用旧邮箱授权 |
| 单次原子消费、持久冷却与限流 | 两个真实 SQLite 连接并发发码/消费；关闭所有连接重开后错误次数与额度保持；不信任任意转发头 |
| 失败/超时/pending/晚完成 | pending 不能登录且没有 SQLite 写事务占用；失败保留原有效码；更晚成功/失败请求都不能被旧发送晚完成覆盖 |
| 发送期间账号变化 | 改密码、改邮箱及恢复使晚完成挑战无效，账号成功修改保持；恢复资料保存期间版本变化不消费旧恢复码 |
| 修改密码、邮箱与通知状态 | 密码策略、确认/同旧、最终凭据重查；全会话/验证码失效；通知失败仍返回成功，失败状态单独持久化，邮箱修改通知旧邮箱 |
| 恢复与失败保护 | 回调写盘失败账号/恢复码/会话/挑战/操作原样；实际恢复 CLI 新资料存在且不回显凭据，切回 TOTP/保留待验证邮箱，新 TOTP 可登录再绑定 |
| 前端错误、手机与秘密 | 二次错误保持登录、真正/畸形401清会话；浏览器内存验证与持久存储检查；手机5阶段；生产入口及独立全目录禁止标记扫描 |

API 的普通 test/*.test.ts 会通过 media.test.ts 导入全部 7 个 media/ 测试，因此最终 check 已包含这些子目录测试；Web 普通 test 不包含浏览器，已明确注册和单独运行新账号 e2e。Fake MailSender 投递、真实 HTTP/SQLite 与真实 SMTP 是三个不同范围：前两项已验收，真实 SMTP 接受/收件箱送达未验证。

### 本次实际修改文件

以下为本次写入的 52 个项目文件，不包含用户原有其他修改和生成的隔离测试/构建产物：

```text
packages/shared/src/dto.ts
packages/shared/src/errors.ts
docs/ACCOUNT_EMAIL_IMPLEMENTATION.md
docs/ACCOUNT.md
docs/API_CONTRACT.md
docs/DATABASE.md
docs/sql/README.md
.env.example
apps/api/package.json
apps/web/package.json
package-lock.json
apps/api/scripts/copy-migrations.mjs
apps/api/src/db/schema.ts
apps/api/src/db/database.ts
apps/api/src/db/repositories.ts
apps/api/src/db/migrations/0003-account-email.sql
apps/api/src/modules/auth/service.ts
apps/api/src/modules/auth/routes.ts
apps/api/src/modules/auth/runtime.ts
apps/api/src/modules/auth/settings.ts
apps/api/src/modules/auth/mail.ts
apps/api/src/modules/auth/account-cli.ts
apps/api/src/core/runtime.ts
apps/api/scripts/account-tool.ts
apps/api/scripts/simple-oss-browser.ts
apps/api/scripts/video-upgrade-acceptance.ts
apps/web/src/api/auth.ts
apps/web/src/api/client.ts
apps/web/src/api/mock.ts
apps/web/src/auth.tsx
apps/web/src/pages/Login.tsx
apps/web/src/pages/Security.tsx
apps/web/src/account-verification.tsx
apps/web/src/pages/account-security.tsx
apps/web/src/pages/account-security.css
apps/api/test/account-email.test.ts
apps/api/test/helpers/account-email-fixture.ts
apps/api/test/database.test.ts
apps/api/test/video-editor.test.ts
apps/api/test/simple-oss-catalog.test.ts
apps/api/test/stage2-backend.test.ts
apps/api/test/media/fakes.ts
apps/api/test/upgrade-config.test.ts
apps/api/test/account-tool.test.ts
apps/web/test/account-security.test.ts
apps/web/test/account-security-browser.test.ts
apps/web/test/unit.test.ts
apps/web/test/library-workflow-browser.test.ts
apps/web/test/video-upgrade-browser.test.ts
apps/web/test/simple-oss-browser.test.ts
apps/web/test/production.test.ts
apps/web/test/release-build.ts
```

### 尚待用户单独处理或确认

- 配置真实 SMTP 服务类型及受保护本地文件，再验证服务器接受及实际收件箱送达。本机默认 smtp.json 不存在，本轮没有真实邮件投递；不需要在聊天中提供授权码。
- 对正式目标 E:/onlineVideo/.local/data/video-library.db 的一致性备份和 0003 升级须单独明确授权，执行步骤见上节。此库本轮未升级；新版服务不会自动迁移，升级前不能将正式旧版本库当作已支持本功能的证据。
- 本轮没有部署、云权限调整或正式账号登录/修改验收。账号撤销仅影响站内管理/受保护访问，现有公开 OSS 视频地址继续按公共播放模式工作。

## 正式 v3 升级实际记录（2026-10-04）

用户在启动失败后单独明确回复“授权备份并升级到 v3”。本次只针对 `E:/onlineVideo/.local/data/video-library.db` 执行升级，不初始化、恢复或修改账号凭据，不终止既有 watch 服务，不部署或调整云权限。

实际执行：

```powershell
npm run db:migrate -w @online-video/api -- --database E:\onlineVideo\.local\data\video-library.db --apply
```

命令退出码 0。先使用 SQLite backup API 完成独立一致性备份，再以事务仅应用 0003；0001/0002 ledger 校验和保留。

- [v2 一致性备份](../.local/backups/before-migration-1791099164088-ae1b43a2-8892-4c34-be7a-f8937866dc36.db)：integrity_check=ok，外键异常 0，ledger 1/2，全部原 25 张表旧列数据校验与迁移前一致。
- [正式迁移验证报告](../.local/backups/before-migration-1791099164088-ae1b43a2-8892-4c34-be7a-f8937866dc36.db.verification.json)：正式库 ledger 1/2/3 与当前源码校验一致，integrity_check=ok，外键异常 0；全部原 25 张表的旧列、行数及排序摘要一致（schema_migrations 比较原 1/2 行）。
- 原账号 1 个、恢复码 10 条、视频 8 个、登录会话 11 条及原业务记录均保留；密码哈希、TOTP 密文、账号 ID 及关联已通过整行旧字段摘要核对，报告不输出秘密。账号 auth_method=totp、auth_version=1、email=null，原会话新增版本为 1，新 4 张表为空。
- 实际 .env、account-setup.json、auth.key、sqlite-test.db、config/library.json 和旧两份 SQL 内容不变。备份、原库和历史资料均保留。
- [完整运行时启动验证](../.local/backups/before-migration-1791099164088-ae1b43a2-8892-4c34-be7a-f8937866dc36.db.verification.json.startup.json)：使用真实配置、AuthService、SQL、库与媒体模块完整装配，仅监听新临时回环端口；真实 HTTP health=200、login/options=200 且方式为 TOTP，未登录 me=401。验证后正常关闭本次临时服务，未终止用户进程。启动检查后的原表记录和保护文件仍一致；未请求真实 SMTP/OSS、未消费正式 TOTP 或创建正式登录会话。

版本不一致的启动原因已解决。原 watch 进程若仍显示 Waiting for file changes，需要用户在原终端 Ctrl+C 后执行 `npm run dev:api`；数据库变更不保证触发 Node 的源码 watch 重启。本次启动检查不等同于正式账号凭据登录或真实 SMTP 投递验收，这两项本次仍未执行。

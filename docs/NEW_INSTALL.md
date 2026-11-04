# 新部署：完整 SQL 与首次网页配置

适用范围：创建一个**独立的新 SQLite 数据库**，体验首次安装。旧数据库、原账号、原 `.env` 和旧配置继续保留，不在原库上执行完整 SQL。

本文以本地 PowerShell 开发运行为例，先安装项目要求的 Node.js `>=22.21.1 <23`、npm `10.x`，并在项目根目录执行 `npm ci`。Linux 服务器使用[Docker/1Panel 指南](DEPLOY_1PANEL.md)：其一次性初始化命令会创建数据库文件并执行同一份完整 SQL，**不要先手动创建空 `.db` 再运行该命令**。已部署环境更新不再初始化。

## 1. 新建空库并执行一份 SQL

完整文件：[`sql/NEW_INSTALL_FULL.sql`](sql/NEW_INSTALL_FULL.sql)。

1. 用 Navicat、SQLite 客户端等创建新的空数据库文件，例如：
   `E:/onlineVideo/.local/data/new-install.db`。
2. 确认连接的是这个新文件，**不是** `video-library.db` 或根目录的 `sqlite-test.db`。
3. 整份执行 `NEW_INSTALL_FULL.sql`。开启“遇到错误立即停止”，不要只执行部分语句。
4. 正常结果：41 张业务/基础表（含迁移账本）、8 条迁移记录、2 条支持邮箱类型；`users` 为空，完整性检查返回 `ok`。

该 SQL 已将 0001～0008 的最终结构合并为完整建表语句，并带有与源码一致的迁移校验值。**新空库不需要再执行旧 SQL、`account:init` 或 `db:migrate`。** SQL 包含空库检查，不使用删表、覆盖或自动清空来“修复”旧库；若失败，在同一连接执行 `ROLLBACK;`，保留报错并核对目标。既有 v5/v6/v7 库可继续运行，不在启动时自动升级；站点设置（v7）及访客（v8）持久化需要另行备份、核对目标并授权增量迁移。缺少访客表时管理页明确只读提示，不创建凭证；不能把本文件执行到已有库。

SQL 不含默认账号的可复用密码哈希、密钥、安装码或个人 OSS/SMTP 配置。管理员由首次网页改密过程创建。

## 2. 启动新部署 API

先确认 3000 端口没有旧 API 在使用。若是你自己启动的旧开发服务，可在其原终端按 `Ctrl+C` 正常停止；不要强杀未知进程或让前端连错库。

在项目根目录的 PowerShell 执行：

```powershell
cd E:\onlineVideo
npm run build -w @online-video/shared
npm run dev:setup -w @online-video/api -- --database E:/onlineVideo/.local/data/new-install.db
```

此命令是**新部署专用入口**：

- 显式选择新库，不读取原项目 `.env`，不自动迁移、覆盖或切换原数据库。
- 首次启动会独占创建新库专用密钥和一次性安装码文件；只在终端提示文件位置，不打印秘密。
- 必须已经执行完整 SQL。缺库、旧结构、密钥缺失/不匹配、残留初始化资料会报错，不回退为默认密码。
- 开发时默认监听 `127.0.0.1:3000`，不要将本地开发 HTTP 服务直接暴露到公网。

完成新库设置后，日常可使用 `npm run dev:api`；它读取 `config/deployment.json` 中的数据库与密钥路径，不加载 `.env`。首次创建本机配置时先检查，已有文件不覆盖：

```powershell
if (-not (Test-Path -LiteralPath 'config/deployment.json')) {
    Copy-Item -LiteralPath 'config/deployment.example.json' -Destination 'config/deployment.json'
}
```

核对 JSON 的 `databasePath` 与上面显式选择的库一致。模板仅指定 `.local/data/new-install.db`，省略 `authKeyFile` 时使用其伴随密钥；显式填写该字段时必须是目标库匹配的已有密钥。切库和共用主密钥见[数据库切换说明](DATABASE_SWITCHING.md)。

构建后的对应入口：

```powershell
npm run build
npm run start:setup -w @online-video/api -- --database E:/onlineVideo/.local/data/new-install.db
```

这不等于已完成服务器部署。生产环境仍需正确设置 `NODE_ENV=production`、可信 HTTPS `AUTH_ALLOWED_ORIGINS`、监听地址、TLS 反向代理和持久化目录。基础设施配置不放在尚未可访问的首次网页里；完整打包、首次部署、更新和备份步骤见[服务器部署指南](DEPLOY_1PANEL.md)。

## 3. 打开网页并完成初始化

另开一个 PowerShell 终端：

```powershell
cd E:\onlineVideo
npm run dev:web
```

打开 `http://127.0.0.1:5173`。前端默认代理到本机 3000 端口的新 API；不要使用 `dev:web:mock`。

### 第一步：安装身份验证

- 初始密码：`adminadmin`。
- 一次性安装码：在服务器本机打开 `new-install.db.installation-code.txt`，将其中随机码填入页面。
- 没有独立用户名字段，也不开放注册；默认密码不能直接访问正常业务。

### 第二步：强制修改密码

设置 12～128 字符的新密码并确认。成功后，默认密码、安装码和旧安装会话失效。如果中途关闭页面，使用刚设置的新密码继续未完成的设置，不再使用 `adminadmin`。

### 第三步：OSS 配置

在页面填写 AccessKeyId、AccessKeySecret、Bucket、地域、媒体 HTTPS 地址、对象前缀及上传网络：

- 地域填写类似 `cn-hangzhou`、`eu-central-1` 的地域 ID；Endpoint 由后端生成，不接收任意服务器地址。
- 媒体地址是浏览器播放使用的 HTTPS Origin，不是管理网站地址。使用实际已经准备好的 OSS 媒体地址。
- 前缀默认 `onlineVideo/`；新环境可自定义，不绑定本项目原个人域名/Bucket。
- 选择公网需明确勾选费用提示；内网必须在具备对应网络条件的服务器使用，不会失败后自动回退公网。
- ARN 可不填；填写后真正使用 AssumeRole 临时凭据，失败不会绕过角色权限改用长期 AK。
- 凭据应为最小权限 RAM 身份，不要填写阿里云主账号 AccessKey。

保存后点击“测试 OSS 只读连通性”。该操作只读取指定前缀最多一条列表记录，**不创建对象，不代表上传权限或视频播放已经验证**。首次完成设置需要此检查通过。应用沿用公共读媒体直连方案；后续实际上传还需要分片上传、新对象公共读及相关读权限，程序不会替你修改 Bucket/RAM 策略。

初始化完成后锁定 Bucket、地域、媒体地址和对象前缀，避免旧视频及上传任务定位失效；凭据和网络设置仍可在“系统设置”修改。

### 第四步：邮件配置（可稍后完成）

当前支持 QQ 和 163 邮箱，每种类型独立配置 SMTP 主机、端口、TLS、发信账号、授权码及 From。主机/账号类型必须匹配；支持 465 直接 TLS 或 587 STARTTLS，不开放任意 SMTP 服务器。

1. 先保存配置；保存本身不发送邮件。
2. 填入对应类型收件地址，主动点击发送测试邮件。
3. 页面显示 **SMTP 已接受发送** 后，再查看收件箱/垃圾邮件。服务器接受不能替代实际收件箱送达。
4. 测试每类一分钟最多一次、一小时最多十次；失败也计入限额。修改配置后原测试通过状态作废。

### 第五步：完成并重新登录

完成初始化后重新使用**新密码**登录。默认不要求邮箱验证码；邮件未配置时，不影响纯密码登录。

## 4. 开启或关闭邮箱登录验证

登录后进入“系统设置”：

1. 先配置并测试对应类型的 SMTP。
2. 选择开启邮箱验证，填写当前密码和要绑定的收件邮箱，发送验证码。
3. 实际收到并输入正确验证码后才启用。所有旧会话随即失效，下一次登录需要密码和邮箱验证码。
4. 关闭验证也必须输入当前密码和当前邮箱收到的验证码；成功后恢复纯密码登录并要求重新登录。

已开启验证时改绑邮箱仍按原先的双邮箱验证流程进行，不能借开关跳过原邮箱确认。账号安全页支持纯密码模式修改密码；邮箱模式仍需相应验证码。

## 5. 数据和秘密如何保留

以 `new-install.db` 为例：

| 文件 | 用途 |
| --- | --- |
| `new-install.db` | 账号、业务、安装状态、加密 OSS/SMTP 配置 |
| `new-install.db.auth.key` | 默认的数据库伴随主密钥；也可显式选择已有共享主密钥，必须保管与此库匹配的那一份 |
| `new-install.db.installation-code.txt` | 首次安装码；改密后失效，文件保留但不能重新初始化 |
| `new-install.db.library.json` | 完成安装时创建的分类/标签配置，与原 `config/library.json` 分离 |

限制这些目录和文件的访问权限（Windows 同时检查 ACL）。不要放进 Git、通用发布包或前端静态目录。SQLite 在线备份必须保证一致性，不能只复制正在使用的 `.db` 主文件而忽略 WAL。不能删除主密钥后重新生成来解密旧配置。

新密码账号没有公开“忘记密码”或匿名重置入口；请妥善保存新密码及配套资料。旧账号原有 TOTP/恢复流程保持不变。

## 6. 验证边界

仓库提供完整 SQL 与迁移后结构、种子和账本的一致性测试，以及 SQLite/HTTP 初始化、默认密码限权、强制改密、配置脱敏、限流、邮箱验证开关和重启恢复回归。普通测试使用隔离库、替身或受控协议服务，不表示新填的实际凭据已经通过实云验收；也不以旧版本的测试数量代表本次运行结果。

可按[本地运行说明](LOCAL_DEVELOPMENT.md#验证)执行 `npm run check`，再运行 `npm run test:e2e:setup -w @online-video/web` 验证网页安装流程；手机尺寸仿真不能代替安卓真机。

新库设置完成后，还需在页面测试自己的 OSS/SMTP，并实际上传一个明确的小样例，核对登记、封面、播放和邮件实际收件。服务器已正常使用的用户确认只适用于相应环境；每次部署或更新后的持久化、安卓真机和大文件仍单独验收。

## 7. OSS 已保存但测试失败

保存仅校验字段格式，不连接阿里云。测试才会使用当前凭据（有 ARN 时先 AssumeRole）读取前缀下最多一条记录。

2026-10-26 修复：当列表首项为 `onlineVideo/` 这样的零字节目录标记时，旧实现会误拒绝并显示“存储暂不可用”。现已在检查前缀范围后跳过目录标记，并保留分页游标。直接凭据与 ARN 两种路径的本地 SDK 替身复现及回归通过（相关 17 项），不代表用户实际云端故障已确认解决。

测试现在提供固定的安全错误分类：`OSS_NETWORK_ERROR`（网络/DNS/TLS）、`OSS_REQUEST_TIMEOUT`（超时）、`OSS_INVALID_CREDENTIALS`（凭据/签名）、`OSS_CLOCK_SKEW`（系统时间）、`OSS_BUCKET_NOT_FOUND` / `OSS_ENDPOINT_MISMATCH`（Bucket/地域）、`OSS_LIST_PERMISSION_DENIED`（列表权限/前缀）、`OSS_STS_PERMISSION_DENIED` / `OSS_STS_CONFIGURATION_ERROR`（角色授权/参数）、`OSS_RESPONSE_INVALID`（列表内容/范围）。未知错误仍返回 `STORAGE_UNAVAILABLE`；不会展示 SDK 原始响应、密钥或带签名 URL。

使用 `start:setup` 时，修复须重新构建 API 并在原终端正常停止/重启后生效；前端开发服务若保留旧错误字典，也需重启。保留同一数据库和已保存配置，不重新执行 SQL、初始化账号或更换密钥。两次测试至少间隔一分钟；仍失败时反馈新的错误码/文案，不发送密钥或完整请求体。

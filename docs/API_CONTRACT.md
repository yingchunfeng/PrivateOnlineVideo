# 前后端与媒体模块契约 V0.5

## 2026-10-26：新部署初始化与配置扩展

新部署 v6 使用独立入口，流程见[新部署指南](NEW_INSTALL.md)。实际 DTO 以 `packages/shared/src/installation.ts` 和 `dto.ts` 为准；旧 v5 不自动迁移，原接口继续兼容。

| 方法与路径 | 用途与权限 |
| --- | --- |
| `GET /api/setup/status` | 公开安装阶段 `password/configuration/ready`，不返回安装码或配置秘密 |
| `POST /api/setup/login` | 首次密码＋安装码取得受限安装 Cookie；配置阶段改用已设新密码 |
| `POST /api/setup/password` | 受限 Cookie＋CSRF 强制改密，返回轮换后的安装状态与 CSRF |
| `POST /api/setup/complete` | 提交空对象，受限 Cookie＋CSRF；已保存 OSS 且只读检查通过才完成，返回 `{success:true}` 并撤销安装会话；客户端再查状态确认 ready |
| `POST /api/setup/logout` | 撤销当前安装会话 |
| `GET /api/installation/settings` | 配置阶段受限会话或已完成安装的正式账号，返回脱敏配置和测试状态 |
| `PUT /api/installation/oss`、`PUT /api/installation/mail` | 同上，额外要求 CSRF 和配置版本；只保存，不自动网络测试 |
| `POST /api/installation/oss/test` | 限流的前缀列表只读测试，明确 `writePermissionVerified:false` |
| `POST /api/installation/mail/test` | 配置保存后主动发送测试信，只报告 `delivery:"smtp-accepted"` |
| `POST /api/auth/password/direct` | 已登录纯密码账号，当前密码＋新密码确认；邮箱模式不能借此绕过验证码 |
| `POST /api/auth/email-verification/code`、`confirm` | 已登录账号，当前密码＋真实收码开启/关闭验证；成功后所有会话失效 |

`AuthMethod` 新增 `password`，对应登录请求为 `{authMethod:"password",password}`；原 `totp/email` 契约保持。秘密仅服务端加密保存；前端媒体校验使用鉴权 `/api/library` 的域名/前缀，不放开任意 HTTPS 地址。安装未完成时，后端拒绝普通业务和正常登录请求，前端也不创建业务上传队列。

以下保留原阶段契约及历史验收范围。

2026-10-04 邮箱类型补充：`GET /api/auth/login/options` 与已登录的 `/api/auth/security` 增加公开 `emailProviders: [{code,name,domain}]`，仅列启用的 QQ/163 类型，不返回 SMTP 凭证或服务地址。绑定/修改邮箱只接受完整支持域名，类型停用后发码与确认均拒绝；错误码 `EMAIL_PROVIDER_UNSUPPORTED` 为 400。多类型配置及控制见 [QQ 与 163 邮箱支持](SMTP_PROVIDERS.md)。

第二阶段可编译契约已冻结于shared/core/contracts，新增API由完整入口装配并通过隔离HTTP/SQL验证；详见[第二阶段契约](archive/STAGE2_API_CONTRACT.md)与[后端交接](archive/STAGE2_BACKEND_HANDOFF.md)。用户具体授权后正式库已一致性备份升级至版本2、本人账号保留；真实STS/OSS与生产未验，不将协议替身结果当实云。

日期：2026-10-02

性质：真实鉴权/SQLite组织、视频库、观看记录、分模式用量及媒体统一装配已实现，运行须显式资源配置与版本2库
历史依据：原 PRD 和任务总看板已于 2026-10-30 按确认范围清理；当前功能见[项目说明](../README.md)，阶段交付结果保留在[第二阶段完成审计](archive/STAGE2_COMPLETION_AUDIT.md)。

## 1. 基本约定

- 接口统一位于 `/api`，JSON 字段采用 camelCase；输出时间统一为 UTC ISO 8601 字符串（例如 `2026-10-01T00:00:00.000Z`），周期结束时间为不包含的上界。统计日按 `timezone` 的 IANA 时区划分，时间戳仍输出 UTC。
- ID 使用不可预测的字符串；知道 ID 不代表拥有访问权。
- `PlaybackMode = "proxy" | "oss"`，由PLAYBACK_MODE显式选择；真实目标oss直连、proxy兼容，无隐式回退。
- 同源 Cookie 会话；所有写接口（包括分片 PUT）携带 `x-csrf-token`，由 AuthGuard 同时校验 Cookie 会话、CSRF 和可信来源。登录前的来源检查由 CORE-03 实现，登录请求不要求已有登录态的 CSRF token。前端不得把会话或 OSS 长期密钥存入 localStorage。
- 成功的 JSON 响应结构为 `{ data: T }`；分页数据为 `{ data: { items, page, pageSize, total } }`。
- 错误结构为 `{ error: { code, message, requestId } }`，不包含堆栈、凭证或敏感路径。
- 流式媒体响应与原始分片上传不套 JSON 数据包装。
- 所有 byte 数值必须是非负安全整数，后台设置明确的上传、分片和总量限制。
- 控制API/封面保持站内相对路径；oss源为后端固定HTTPS域名STS/V4签名URL，按模式校验。对象定位不由客户端任意指定。

## 2. 共享数据结构

| DTO | 核心字段 |
| --- | --- |
| CurrentUser | `id`, `displayName`, `totpEnabled`, `authMethod`, `authVersion`, `emailMasked`, `emailVerified` |
| Category | `id`, `name`, `sortOrder`, `isDefault`, `archivedAt` |
| LibraryGroup / Tag | id/name/createdAt/updatedAt/archivedAt；分组另description/sortOrder |
| VideoSummary | `id`, `title`, `categoryId`, `groupIds`, `tagIds`, `durationSeconds`, `sizeBytes`, `status`, `thumbnailUrl`, `createdAt` |
| VideoDetail | VideoSummary 字段及 `codec`, `width`, `height`, `playable`, `lastPositionSeconds` |
| PlaybackSession | id/videoId/expiresAt；proxy.sourceUrl站内path；oss.sourceUrl/sourceExpiresAt/renewAfter |
| PlaybackHeartbeat | id/videoId/mode/expiresAt，无源字段，不自动续签 |
| DownloadAuthorization | videoId/mode=oss/sourceUrl/sourceExpiresAt/fileName |
| UploadTask | id/videoId/fileName/sizeBytes/partSizeBytes/status/uploadedParts/createdAt，以及title/categoryId/groupIds/tagIds组织快照 |
| UploadedPart | `partNumber`, `sizeBytes`, `checksum`；OSS 内部状态由服务端维护 |
| ApplicationUsage | application_proxy保持真实字节/三态限额；oss_direct/not_synced的transferredBytes/cloudStatisticsAt=null，limitMode=not_applicable，独立签发次数/应用会话数 |
| LoginSession | `id`, `createdAt`, `lastSeenAt`, `expiresAt`, `isCurrent` |

`status` 初始枚举：

- 视频：`processing`、`ready`、`unsupported`、`failed`。
- 上传：`uploading`、`finalizing`、`completed`、`failed`。暂停为客户端行为，服务端仍保留可续传任务。
- 封面不存在时 `thumbnailUrl = null`，前端展示占位，不公开原片地址替代封面。
- 未采集到的时长、编码、分辨率为 `null`，不得捏造数据。
- 上传任务尚未完成视频登记时，`videoId` 可以为 `null`，由服务端完成流程更新。
- `limitMode = "limited"` 时 `limitBytes` 为非负安全整数，0 表示禁止传输；`limitMode = "unconfigured"` 时 `limitBytes = null`，必须拒绝媒体注册/传输；只有显式 `limitMode = "unlimited"` 时，`limitBytes = null` 才表示不限制应用字节总量。鉴权、并发及请求限制仍生效。
- `categoryId` 必填且不可为 null，未分类使用服务端默认分类的 ID。`sizeBytes` 不可为 null；未知元数据为 null，`playable` 不可据文件后缀设为 true。没有观看记录时 `lastPositionSeconds = 0`，观看记录 `updatedAt = null`。
- `AuthSession = { user: CurrentUser, csrfToken: string }`，登录和 `/auth/me` 返回 `{ data: AuthSession }`；退出、撤销和关闭播放返回 `{ data: { success: true } }`。Cookie 会话凭证不包含在 DTO 中。
- 公共导入为 `@online-video/shared`；源码见 `packages/shared/src/dto.ts`、`errors.ts`。共享包不含 Node.js、数据库、鉴权实现或内部对象 key。

## 3. 路由与责任分工

### 3.1 工程、账户与会话：子代理 1

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 不包含敏感配置的健康状态 |
| POST | `/api/auth/login` | 按数据库 authMethod 使用密码 + TOTP 或密码 + 邮箱挑战，设置会话 Cookie |
| GET | `/api/auth/me` | 当前用户及必要的 CSRF 信息 |
| POST | `/api/auth/logout` | 撤销当前登录会话 |
| GET | `/api/auth/sessions` | 本人登录会话列表 |
| POST | `/api/auth/sessions/:sessionId/revoke` | 撤销指定会话，检查归属 |

账号初始化、TOTP 绑定和恢复是受保护流程，具体命令/路由由 CORE-03 提交设计；不提供公开注册或匿名重置密码接口。

CORE-03 已固定本地命令 `account:init` 和 `account:recover`：初次创建只允许新库，恢复要求当前密码加单次恢复码；密码/验证器配置不作为 CLI 参数、日志或公开接口输出，资料保存于 Git 排除的 .local。绑定 TOTP 的 SHA1/6位/30秒配置由初始化资料导入验证器，同一验证码只能登录一次。详细当前账号与登录方式见 [ACCOUNT](ACCOUNT.md)。

2026-10-04 新增邮箱认证契约见 [数据库账号与邮箱认证](ACCOUNT_EMAIL_IMPLEMENTATION.md)。未登录发码只有 `/api/auth/login/code`，请求只含密码，服务端从数据库已验证邮箱取收件人。登录页方式由 `/api/auth/login/options` 提供，不含邮箱。登录和发码仅豁免登录态 CSRF，仍检查可信 Origin；绑定邮箱、密码和邮箱修改均要求 Cookie + CSRF。二次验证错误使用 400 独立错误码，会话失效为 401。`totpEnabled` 表示数据库中保留的 TOTP 配置状态，当前登录方式由 `authMethod` 决定。密码、验证码和挑战仅存前端内存，认证版本变化使旧会话、挑战和待操作失效。

### 3.2 分类、元数据与观看记录：子代理 1

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| GET | `/api/categories` | 分类列表 |
| POST | `/api/categories` | 新建分类；`name`, `sortOrder` |
| PATCH | `/api/categories/:categoryId` | 重命名/排序/archived归档恢复，默认项不可归档 |
| GET/POST/PATCH | `/api/groups`、`/api/tags`及/:id | 本人组织列表/创建/修改，列表支持includeArchived=true |
| GET | `/api/videos` | 分页筛选categoryId/q/groupIds/tagIds；组标签逗号分隔、跨维度AND、多选全命中，page1/pageSize24默认/max100 |
| GET | `/api/videos/:videoId` | 视频详情与兼容状态 |
| PATCH | `/api/videos/:videoId` | 局部修改title/categoryId/groupIds/tagIds；[]软解绑，省略保持 |
| GET | `/api/videos/:videoId/progress` | 本人的观看位置 |
| PUT | `/api/videos/:videoId/progress` | 保存 `positionSeconds`，校验范围 |
| GET | `/api/settings/usage` | 按模式返回代理实际字节或OSS未知用量，不作为云账单 |
| GET | `/api/settings/limits` | 鉴权后的上传/分片/并发/签发限额 |

### 3.3 视频播放与封面：子代理 2

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| POST | `/api/videos/:videoId/playback-sessions` | 鉴权后创建播放会话并返回 PlaybackSession |
| POST | `/api/playback-sessions/:sessionId/heartbeat` | 维护播放会话活动状态 |
| POST | `/api/playback-sessions/:sessionId/source` | 同会话重新鉴权续签，复用并发槽 |
| POST | `/api/videos/:videoId/download-authorizations` | 本人数据库原片下载STS签名，独立频控与审计 |
| POST | `/api/playback-sessions/:sessionId/close` | 关闭播放会话；不删除视频 |
| GET/HEAD | `/api/videos/:videoId/stream?playbackSessionId=...` | A 模式视频流与范围读取 |
| GET/HEAD | `/api/videos/:videoId/thumbnail` | 受保护封面读取 |

播放会话ID不代替Cookie；proxy每次Range都检查归属与活动状态。oss在发放/续签/下载前重查真实登录/owner，URL本身为临时授权，在有效期可被重复使用。退出/close拒绝后续授权，已发URL不会立即失效；应用3会话限制不等于OSS连接数或字节费用封顶。

`HEAD` 返回必要的类型、长度和范围信息；`GET` 支持合法范围请求。错误范围、客户端断开、并发和流量超限的响应由 MEDIA-02/03 统一验证。流式响应开始后发生错误，应中止流并记录，不能向已发送的视频流追加 JSON 错误。

### 3.4 分片上传：子代理 2

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| POST | `/api/uploads` | fileName/sizeBytes/title/categoryId及可选groupIds/tagIds，组织/对象/操作先持久化 |
| GET | `/api/uploads/:uploadId` | 获取分片大小、已完成分片及状态 |
| PUT | `/api/uploads/:uploadId/parts/:partNumber` | 原始分片数据，`Content-Type: application/octet-stream` |
| POST | `/api/uploads/:uploadId/complete` | 校验分片并完成 OSS 对象，登记真实视频状态 |

分片尺寸由后端通过 `partSizeBytes` 返回，前端不自行硬编码。分片编号从 1 开始，字节偏移为 `(partNumber - 1) * partSizeBytes`；最后一片使用实际余量，分片信息按编号升序返回。

checksum 固定为 **SHA-256 / 64 位小写十六进制**，对每片原始字节计算，不加 `sha256:` 前缀，不用 Base64。PUT 通过 `x-part-checksum` 请求头传递，JSON 的 `UploadedPart.checksum` 使用同一格式；常量与 `isPartChecksum` 从共享包导入。客户端只读取当前 `File.slice()` 分片，用 Web Crypto 或等效增量算法计算，不能读取完整视频计算整文件哈希。

媒体模块对实际接收的分片字节重算 checksum、校验编号和大小；仅 checksum、存储上传均成功后调用 `UploadRepository.savePart`。错误格式返回 `VALIDATION_ERROR`；数据不一致返回 `FILE_MISMATCH`，不登记成功、不完成对象、不自动删除云端分片。适配器返回的 ETag 仅是服务端内部完成凭据，不作为 SHA-256。

恢复任务时先核对文件大小、分片尺寸，并对所有已完成分片重新计算 checksum 与服务端记录比较，不能只因文件名相同就续传。同一编号与相同大小/checksum 的重试幂等；不同数据拒绝。完成请求无客户端对象 key 或 ETag 清单，服务端以已验证的权威分片完成对象，并返回 `{ data: { upload: UploadTask, video: VideoDetail } }`。

OSS 上传 ID、对象路径和 ETag 的权威状态由服务端维护，客户端不得指定任意 Bucket 或对象作为完成目标。中断后保留分片，本轮没有自动清理和永久删除接口。

### 3.5 选择性导入：子代理 2

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| POST | `/api/imports/preview` | 在已授权前缀范围内预览已有 OSS 视频 |
| POST | `/api/imports/commit` | 将用户选定条目登记到视频库，不搬移或删除原文件 |

预览结果使用后端验证过的条目 ID。导入时再次验证范围和对象存在性，不盲信客户端给出的对象路径，不全 Bucket 自动扫描，不更改 OSS ACL。

预览请求必须提供字符串 `prefix`。明确空串表示使用服务端配置的授权根范围；非空字符串必须是授权根下以 `/` 结束的目录前缀。缺字段、非字符串、越界或歧义路径拒绝，不以自动回退掩盖非法输入。预览结果不暴露对象 key，前端使用条目 ID 提交勾选项。

显式旧记录位置绑定可在单项commit增加existingVideoId：owner/旧key须与所选已HEAD核验对象精确一致，通过bindLegacy保留原id/标题/组织/进度，仅固定完整对象及已验媒体分析；已绑定不同身份/错key拒绝，不推断历史Bucket。普通导入省略该字段。

## 4. 初始错误码

| HTTP | code 示例 | 前端处理 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 显示可理解的参数错误 |
| 401 | `AUTH_REQUIRED`, `SESSION_EXPIRED` | 停止敏感请求并返回登录 |
| 401 | `INVALID_CREDENTIALS` | 密码/验证码不正确或已使用，提示重新验证；不区分泄漏因素细节 |
| 403 | `FORBIDDEN`, `CSRF_REJECTED` | 显示无权限/来源检查失败，不重试绕过 |
| 404 | `NOT_FOUND` | 显示资源不存在或不可访问 |
| 409 | `UPLOAD_STATE_CONFLICT`, `FILE_MISMATCH`, `ORGANIZATION_CONFLICT` | 刷新任务、修改重复名称或归档选择 |
| 413/415 | `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` | 修正分片大小或内容类型，不自动提高限制 |
| 416 | `RANGE_NOT_SATISFIABLE` | 处理无效范围，禁止完整下载回退掩盖错误 |
| 429 | `RATE_LIMITED`, `PLAYBACK_CONCURRENCY_LIMIT`, `TRANSFER_LIMIT_EXCEEDED` | 停止无限重试，展示限制信息 |
| 503 | `STORAGE_UNAVAILABLE` | 显示存储暂不可用，记录 requestId |
| 500/503 | `INTERNAL_ERROR`, `SERVICE_NOT_CONFIGURED` | 记录 requestId，提示服务异常或尚未完成配置 |

Native video错误不一定提供JSON；按模式和真实sourceExpiresAt有限续签，保留位置/暂停状态。失败不回退匿名地址或长期AK签名。

## 5. 后端接入接口

CORE-01 在公共类型或后端公共接口目录提供以下约定，MEDIA 模块据此独立开发：

| 接口 | 能力 | 实现负责人 |
| --- | --- | --- |
| AuthGuard | 校验登录、账户归属与 CSRF，返回当前主体 | 子代理 1 |
| VideoRepository | 查询已授权元数据、登记视频、更新兼容状态 | 子代理 1 |
| UploadRepository | 创建/读取上传任务、保存已完成分片和校验信息 | 子代理 1 |
| PlaybackRepository | 创建、校验、关闭和维护播放会话 | 子代理 1 |
| UsageRepository | 原子检查/累计传输、读取统计；支持并发限制 | 子代理 1 |
| StorageAdapter | 元数据、范围流、分片上传、限定范围列表 | 子代理 2 |
| MediaModule | 导出统一注册函数，由 API 入口注入上面的接口 | 子代理 2；子代理 1 注册 |

所有接口提供 Fake 实现或可替换测试依赖，不让独立模块必须依赖真实 OSS 或实际数据库。生产注册时缺少鉴权实现必须失败，不采用放行默认值。

服务端契约统一从 `apps/api/src/core/contracts/index.ts` 导入，具体方法与参数以 `repositories.ts`、`storage.ts`、`media.ts` 为准。它们不能进入前端依赖。测试替身入口为 `apps/api/test/helpers/media-dependencies.ts`，默认鉴权拒绝、其他依赖返回不可用，不伪造业务成功。

媒体公开 `createMediaModule(explicitOptions)`；旧 `registerMediaModule` 仅用于明确test依赖，不能当用户预算。路由含完整/api，runtimeModules注入同一config/auth/真实SQL；dependencies新增organizations/objects/sources，oss要求原子登记/审计/签名依赖齐全。kind为test/development/production，生产拒绝测试或Mock。

AuthGuard 每次敏感请求检查登录会话；Repository 的读写以 ownerId 约束归属。播放会话的创建与并发检查必须原子执行；Range 请求复用会话。用量 `reserve` 原子预留下一小块字节（在途预留也占额度），发送后 `settle` 幂等结算实际发送量并释放未用预留，断开时也结算。不得以独立的“读计数再写计数”实现并发限额。统计不是云账单。

上传/导入先验证本人分类/分组/标签活动状态；不存在/跨owner返回NOT_FOUND，归档或重复名称返回ORGANIZATION_CONFLICT。原片registered完整对象/资产身份原子幂等（legacy仅旧Mock按owner+key兼容），数据库唯一性/事务支撑跨预览/重启去重；新上传最终finishRegistration同时完成快照/资产/视频/任务/操作，已有记录不覆盖。

上传完成允许在单 API 实例的任务锁内重试 `finalizing`：先执行同状态 CAS 校验，再 HEAD 检查对象是否已经完成，以权威分片完成或重新登记，幂等返回原视频。`finalizing -> finalizing` 仅检查状态，不提供跨进程互斥；多 API 实例需要后续持久化任务租约，不能直接将本单机锁扩展为分布式锁。

StorageAdapter只接收服务端对象引用并处理流式I/O/Range/Multipart/限定列表；独立PresignedSourceProvider负责固定CNAME读取STS/V4签名，StsCredentialProvider返回Expiration并按用途隔离缓存。不接受客户端任意URL/key，不清理对象。默认入口已统一真实SQL/Auth/媒体，启用oss前仍需版本2库和显式配置；本轮未连接真实OSS。

## 6. 配置与本地验证

- 开发默认 `PLAYBACK_MODE=proxy`。
- `STORAGE_DRIVER=mock|oss`，默认mock只用于明确开发proxy；oss配置全部校验后装配真实SDK。上传网络匹配固定杭州Endpoint、公网须显式确认；签名使用独立固定HTTPS CNAME，不存在隐式公网/Mock回退。
- 本机 Mock 数据与真实 OSS 数据明确区分，真实访问不得自动产生费用或覆盖对象。
- Fastify 默认 `API_HOST=127.0.0.1`、`API_PORT=3000`；Vite 使用 `127.0.0.1:5173`、`strictPort: true`，将 `/api` 代理到 `http://127.0.0.1:3000`，浏览器使用相对 URL 和 Cookie。前端已创建；改 API_PORT 时需同步代理目标，不自动换端口。占用时只读检查进程，不强制终止。
- 开发会话 Cookie 与生产 HTTPS 配置明确区分，不能为了本地 HTTP 调试永久关闭生产保护。
- Node.js 源码调试与依赖库使用的 SQLite 不依赖用户安装目录 `G:\software\SQLite`。
- `.db` 文件和 secrets 均不作为前端静态资源发布。
- readConfig严格拒绝空值/错枚举/端口/时区/非安全整数；完整业务缺上传/签发/时区/并发参数拒绝。仅proxy需TRANSFER_LIMIT_BYTES三态政策，oss未知字节不使用该每日硬限制；health独立骨架仍可无媒体构建。
- production仅在同一SQLite真实AuthService/安全Cookie/HTTPS Origin与完整OSS/资源配置装配时允许启动，拒绝测试/Mock；代码检查通过不等于生产环境已验。
- .env.example无秘密，已有.env不得覆盖；dev/start加载根.env，进程环境优先。默认服务器读取.local真实库与鉴权密钥、不在启动创建/迁移；显式oss配置才从受保护文件装配STS用途，生产/实云验收另记。详细命令见ACCOUNT/DATABASE与后端交接。

## 7. 契约变更记录

- 2026-10-02（最新准备）：主控完整API61/61通过，本机portable FFprobe9.0.2及真实两样例分析已验（原HEVC/AAC unsupported、独立H264/AAC副本ready，原片保留）；正式库v2/users1。真实STS/OSS/私有范围/CORS验收授权仍待落实，不将本机结果代替实云。
- 2026-10-02（14:21 UTC）：用户具体授权后正式库一致性备份并0002升级完成；版本2/25表/users1，旧13表全部旧列SHA与计数保留、fk0/integrityok，手工24表库不变。0002 SHA未改，真实STS/OSS/FFprobe环境验收仍待完成。
- 2026-10-02（迁移前）：V0.5冻结组织/完整对象、上传原子登记、proxy/oss播放/续签/下载、无源heartbeat、STS提供者、独立未知用量及limits。真SQL/真实Auth/本机SDK协议API54项通过；当时正式原库v1，后续正式授权升级见上条，真实STS/OSS仍待验。
- 2026-10-01：CORE-02/03 实现真实账号、Argon2id/TOTP、Cookie会话、CSRF/可信Origin、失败限流和本地初始化/恢复；增加 INVALID_CREDENTIALS，默认API仅注册health/auth。独立新正式库已按用户授权创建并以实际HTTP验证，用户测试库未变。
- 2026-10-01：补充单 API 实例在任务锁内恢复 finalizing 的同状态 CAS 约定；多实例互斥明确留给后续持久化租约设计。
- 2026-10-01：媒体/前端协调导入预览空 prefix 的含义：明确空串选择服务端授权根范围，其余输入仍严格验证；DTO 形状不变。
- 2026-10-01：媒体代理接入时补充分类归属预检与对象登记原子幂等约定；服务端契约、注册验证和默认失败安全测试替身同步更新，共享前端 DTO 不变。
- 2026-10-01：CORE-01 冻结共享 DTO、可空字段、SHA-256 分片头、限额消歧、服务端接口及注入方式；health 骨架、类型检查、配置/错误测试和构建已实际通过，业务与真实外部服务仍待后续任务实现。
- 2026-09-30：建立 V0.1 初稿，供 CORE-01 落实与三代理交接。此时尚无源码或真实接口验证。

# 前后端与媒体模块契约 V0.4

第二阶段提案另见 [STAGE2_API_CONTRACT](STAGE2_API_CONTRACT.md)，目前尚未修改可编译DTO或实现新增路由；以新对话P2-CORE-01冻结后的契约为准。

日期：2026-10-01  
性质：CORE-02/03 已交付真实 SQLite Repository 与账户登录；默认 API 入口注册 health/auth，catalog/progress/settings 与媒体统一装配仍待 CORE-04～06  
依据：[PRD](../PRD.md)、[任务总看板](../TASKS.md)

## 1. 基本约定

- 接口统一位于 `/api`，JSON 字段采用 camelCase；输出时间统一为 UTC ISO 8601 字符串（例如 `2026-10-01T00:00:00.000Z`），周期结束时间为不包含的上界。统计日按 `timezone` 的 IANA 时区划分，时间戳仍输出 UTC。
- ID 使用不可预测的字符串；知道 ID 不代表拥有访问权。
- 本轮只允许 `playbackMode = "proxy"`。未来的 `oss_direct` 不在本轮实现范围。
- 同源 Cookie 会话；所有写接口（包括分片 PUT）携带 `x-csrf-token`，由 AuthGuard 同时校验 Cookie 会话、CSRF 和可信来源。登录前的来源检查由 CORE-03 实现，登录请求不要求已有登录态的 CSRF token。前端不得把会话或 OSS 长期密钥存入 localStorage。
- 成功的 JSON 响应结构为 `{ data: T }`；分页数据为 `{ data: { items, page, pageSize, total } }`。
- 错误结构为 `{ error: { code, message, requestId } }`，不包含堆栈、凭证或敏感路径。
- 流式媒体响应与原始分片上传不套 JSON 数据包装。
- 所有 byte 数值必须是非负安全整数，后台设置明确的上传、分片和总量限制。
- 页面使用的资源地址为站内相对路径。对象路径不由前端任意指定为后端读取目标。

## 2. 共享数据结构

| DTO | 核心字段 |
| --- | --- |
| CurrentUser | `id`, `displayName`, `totpEnabled` |
| Category | `id`, `name`, `sortOrder` |
| VideoSummary | `id`, `title`, `categoryId`, `durationSeconds`, `sizeBytes`, `status`, `thumbnailUrl`, `createdAt` |
| VideoDetail | VideoSummary 字段及 `codec`, `width`, `height`, `playable`, `lastPositionSeconds` |
| PlaybackSession | `id`, `videoId`, `mode: "proxy"`, `sourceUrl`, `expiresAt` |
| UploadTask | `id`, `videoId`, `fileName`, `sizeBytes`, `partSizeBytes`, `status`, `uploadedParts`, `createdAt` |
| UploadedPart | `partNumber`, `sizeBytes`, `checksum`；OSS 内部状态由服务端维护 |
| ApplicationUsage | `periodStart`, `periodEnd`, `timezone`, `transferredBytes`, `limitMode`, `limitBytes`, `activePlaybackSessions`, `source: "application_proxy"` |
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
| POST | `/api/auth/login` | 密码和 TOTP 登录，设置会话 Cookie |
| GET | `/api/auth/me` | 当前用户及必要的 CSRF 信息 |
| POST | `/api/auth/logout` | 撤销当前登录会话 |
| GET | `/api/auth/sessions` | 本人登录会话列表 |
| POST | `/api/auth/sessions/:sessionId/revoke` | 撤销指定会话，检查归属 |

账号初始化、TOTP 绑定和恢复是受保护流程，具体命令/路由由 CORE-03 提交设计；不提供公开注册或匿名重置密码接口。

CORE-03 已固定本地命令 `account:init` 和 `account:recover`：初次创建只允许新库，恢复要求当前密码加单次恢复码；密码/验证器配置不作为 CLI 参数、日志或公开接口输出，资料保存于 Git 排除的 .local。绑定 TOTP 的 SHA1/6位/30秒配置由初始化资料导入验证器，同一验证码只能登录一次。详细当前账号与登录方式见 [ACCOUNT](ACCOUNT.md)。

### 3.2 分类、元数据与观看记录：子代理 1

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| GET | `/api/categories` | 分类列表 |
| POST | `/api/categories` | 新建分类；`name`, `sortOrder` |
| PATCH | `/api/categories/:categoryId` | 重命名/排序，不永久删除 |
| GET | `/api/videos` | 分页筛选；`categoryId`, `q`, `page`, `pageSize` |
| GET | `/api/videos/:videoId` | 视频详情与兼容状态 |
| PATCH | `/api/videos/:videoId` | 修改 `title`, `categoryId` |
| GET | `/api/videos/:videoId/progress` | 本人的观看位置 |
| PUT | `/api/videos/:videoId/progress` | 保存 `positionSeconds`，校验范围 |
| GET | `/api/settings/usage` | 应用代理流量与限制，不作为云账单 |

### 3.3 视频播放与封面：子代理 2

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| POST | `/api/videos/:videoId/playback-sessions` | 鉴权后创建播放会话并返回 PlaybackSession |
| POST | `/api/playback-sessions/:sessionId/heartbeat` | 维护播放会话活动状态 |
| POST | `/api/playback-sessions/:sessionId/close` | 关闭播放会话；不删除视频 |
| GET/HEAD | `/api/videos/:videoId/stream?playbackSessionId=...` | A 模式视频流与范围读取 |
| GET/HEAD | `/api/videos/:videoId/thumbnail` | 受保护封面读取 |

播放会话 ID 只用于并发与计量关联，不代替会话 Cookie。每个 Range 请求都检查账户、播放会话归属及活动状态；未登录请求不能通过复制 sourceUrl 获得视频。

`HEAD` 返回必要的类型、长度和范围信息；`GET` 支持合法范围请求。错误范围、客户端断开、并发和流量超限的响应由 MEDIA-02/03 统一验证。流式响应开始后发生错误，应中止流并记录，不能向已发送的视频流追加 JSON 错误。

### 3.4 分片上传：子代理 2

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| POST | `/api/uploads` | 创建任务；`fileName`, `sizeBytes`, `title`, `categoryId` |
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

## 4. 初始错误码

| HTTP | code 示例 | 前端处理 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 显示可理解的参数错误 |
| 401 | `AUTH_REQUIRED`, `SESSION_EXPIRED` | 停止敏感请求并返回登录 |
| 401 | `INVALID_CREDENTIALS` | 密码/验证码不正确或已使用，提示重新验证；不区分泄漏因素细节 |
| 403 | `FORBIDDEN`, `CSRF_REJECTED` | 显示无权限/来源检查失败，不重试绕过 |
| 404 | `NOT_FOUND` | 显示资源不存在或不可访问 |
| 409 | `UPLOAD_STATE_CONFLICT`, `FILE_MISMATCH` | 刷新任务或要求重新选文件 |
| 413/415 | `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` | 修正分片大小或内容类型，不自动提高限制 |
| 416 | `RANGE_NOT_SATISFIABLE` | 处理无效范围，禁止完整下载回退掩盖错误 |
| 429 | `RATE_LIMITED`, `PLAYBACK_CONCURRENCY_LIMIT`, `TRANSFER_LIMIT_EXCEEDED` | 停止无限重试，展示限制信息 |
| 503 | `STORAGE_UNAVAILABLE` | 显示存储暂不可用，记录 requestId |
| 500/503 | `INTERNAL_ERROR`, `SERVICE_NOT_CONFIGURED` | 记录 requestId，提示服务异常或尚未完成配置 |

Native video 的错误事件可能无法直接提供 JSON 错误。前端应结合播放会话和站内状态查询展示提示，不通过改用 OSS 公网地址绕过失败。

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

子代理 2 导出 `registerMediaModule: MediaModule`，签名为 `(app: FastifyInstance, dependencies: MediaDependencies) => Promise<void>`。路由包含完整 `/api` 前缀；主控通过 `buildApp({ config, media: { register: registerMediaModule, dependencies } })` 注入，不再叠加第二次前缀。dependencies 包含 `kind`、`auth`、`videos`、`uploads`、`playback`、`usage`、`storage`、`config`、`now`；必须使用同一份 config 对象。只有依赖方法齐全、存储驱动一致且流量/并发限制已明确配置时可注册。

AuthGuard 每次敏感请求检查登录会话；Repository 的读写以 ownerId 约束归属。播放会话的创建与并发检查必须原子执行；Range 请求复用会话。用量 `reserve` 原子预留下一小块字节（在途预留也占额度），发送后 `settle` 幂等结算实际发送量并释放未用预留，断开时也结算。不得以独立的“读计数再写计数”实现并发限额。统计不是云账单。

上传创建 Multipart 和导入前调用 `VideoRepository.assertCategoryOwned(ownerId, categoryId)`；不存在或不属于当前账户的分类返回 NOT_FOUND。`VideoRepository.register` 对 `ownerId + originalObject.key` 原子幂等，已有对象返回原记录且不覆盖标题/分类等元数据；新登记再次检查分类。真实 Repository 必须以数据库唯一性/事务实现跨预览、并发与重启去重，不能只依靠媒体进程内缓存。

上传完成允许在单 API 实例的任务锁内重试 `finalizing`：先执行同状态 CAS 校验，再 HEAD 检查对象是否已经完成，以权威分片完成或重新登记，幂等返回原视频。`finalizing -> finalizing` 仅检查状态，不提供跨进程互斥；多 API 实例需要后续持久化任务租约，不能直接将本单机锁扩展为分布式锁。

StorageAdapter 只接收服务端生成/解析的对象引用，支持元数据、闭区间 Range 流、Multipart 和限定前缀列表，所有 I/O 接收 AbortSignal。媒体模块负责 HTTP Range、背压、断开取消、checksum、鉴权、状态机及用量；适配器不授权用户、不生成 B 播放 URL、不清理对象。真实 Repository 在 apps/api/src/db/repositories.ts，真实 AuthGuard 为 modules/auth/service.ts 的 AuthService；已经隔离 SQL/媒体测试验证兼容，默认 API 入口暂未注册媒体业务，未连接真实 OSS。

## 6. 配置与本地验证

- 开发默认 `PLAYBACK_MODE=proxy`。
- `STORAGE_DRIVER` 枚举为 `mock | oss`，默认 `mock`；`oss` 仅预留，CORE-01 设置它会报错，不实例化真实 OSS。不存在隐式 `local` 或公网回退。
- 本机 Mock 数据与真实 OSS 数据明确区分，真实访问不得自动产生费用或覆盖对象。
- Fastify 默认 `API_HOST=127.0.0.1`、`API_PORT=3000`；Vite 使用 `127.0.0.1:5173`、`strictPort: true`，将 `/api` 代理到 `http://127.0.0.1:3000`，浏览器使用相对 URL 和 Cookie。前端已创建；改 API_PORT 时需同步代理目标，不自动换端口。占用时只读检查进程，不强制终止。
- 开发会话 Cookie 与生产 HTTPS 配置明确区分，不能为了本地 HTTP 调试永久关闭生产保护。
- Node.js 源码调试与依赖库使用的 SQLite 不依赖用户安装目录 `G:\software\SQLite`。
- `.db` 文件和 secrets 均不作为前端静态资源发布。
- 配置由 `readConfig` 严格读取；空值/错枚举/非法端口/非法时区/非安全整数字节数均报错。缺失 `TRANSFER_LIMIT_BYTES` 或 `MAX_PLAYBACK_SESSIONS` 允许启动 health 骨架，拒绝媒体注册。显式 `TRANSFER_LIMIT_BYTES=unlimited` 表示不限应用总量，非缺失配置的回退。
- `NODE_ENV=production` 当前仍拒绝启动，生产模块装配和真实存储留待 CORE-06；本地账号/数据库可用不表示生产业务已可用。不能仅移除检查或复用测试放行实现。
- 根目录 `.env.example` 无凭证；可新建 `.env`，已有文件不得覆盖。dev/start 脚本加载根目录 `.env`，进程环境变量优先；当前默认服务器读取 .local 的正式数据库和安全密钥，不在启动时创建/迁移，不读取 OSS 凭证。详细命令与已验/待验见 [ACCOUNT](ACCOUNT.md)、[DATABASE](DATABASE.md)；CORE-01 记录保留为初始历史基线。

## 7. 契约变更记录

- 2026-10-01：CORE-02/03 实现真实账号、Argon2id/TOTP、Cookie会话、CSRF/可信Origin、失败限流和本地初始化/恢复；增加 INVALID_CREDENTIALS，默认API仅注册health/auth。独立新正式库已按用户授权创建并以实际HTTP验证，用户测试库未变。
- 2026-10-01：补充单 API 实例在任务锁内恢复 finalizing 的同状态 CAS 约定；多实例互斥明确留给后续持久化租约设计。
- 2026-10-01：媒体/前端协调导入预览空 prefix 的含义：明确空串选择服务端授权根范围，其余输入仍严格验证；DTO 形状不变。
- 2026-10-01：媒体代理接入时补充分类归属预检与对象登记原子幂等约定；服务端契约、注册验证和默认失败安全测试替身同步更新，共享前端 DTO 不变。
- 2026-10-01：CORE-01 冻结共享 DTO、可空字段、SHA-256 分片头、限额消歧、服务端接口及注入方式；health 骨架、类型检查、配置/错误测试和构建已实际通过，业务与真实外部服务仍待后续任务实现。
- 2026-09-30：建立 V0.1 初稿，供 CORE-01 落实与三代理交接。此时尚无源码或真实接口验证。

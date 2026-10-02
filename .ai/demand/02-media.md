# 子代理 2：OSS 与视频传输

日期：2026-09-30  
当前状态：MEDIA-01～07 本地实现与隔离验证完成；真实后端/OSS/FFprobe/安卓/服务器环境分别待验

## 0. 模块设计/数据库文件清单

- 产品依据：[PRD](../../PRD.md)。
- 总看板：[TASKS](../../TASKS.md)。
- 接口依据：[API_CONTRACT](../../docs/API_CONTRACT.md)。
- 本代理范围：负责存储适配器、A 方案视频读取、Range、上传续传、格式信息、OSS 选择性导入和应用传输计量。
- 可写范围：apps/api/src/modules/media/**、其中的适配器与对应测试；本任务板。
- 数据边界：数据通过 VideoRepository、UploadRepository、PlaybackRepository、UsageRepository 访问；所有 schema 变更由子代理 1 维护。
- 新模块和迁移路径在真正创建后追加登记；当前列出的源码路径是规划路径。
- 实际存储模块：`apps/api/src/modules/media/storage/`；隔离媒体测试：`apps/api/test/media/`，由 `apps/api/test/media.test.ts` 载入。
- 实际媒体入口：`apps/api/src/modules/media/index.ts`；模块交接：[HANDOFF](../../apps/api/src/modules/media/HANDOFF.md)，包含生产装配参数、Repository 义务、已验/待验与兼容副本人工流程。

## 1. 默认协作规则

- 继承用户全局规则和 TASKS.md。不改公共 DTO、db/schema、migrations、API 根入口、apps/api/package.json 或共享锁文件。所需接口、字段和依赖由主控协调子代理 1。默认不连接真实 OSS、不更改 ACL/Policy、不清理上传分片。
- 每次完整读取当前任务卡；依赖未完成时先处理独立设计或 Fake/Mock，不伪造完成。
- 只回写自己的任务板，不改总看板和其他代理任务板。
- 开始实际实施才设 DOING；完成真实验证后设 DONE。完成说明区分已验证和待外部环境验证。
- 真实数据库写入、迁移执行、云权限调整、删除及配置覆盖遵守用户确认规则，不把编写代码当作对真实数据操作的授权。
- 任务只涉及本地开发，服务器部署和 B 模式留待后续。
- 使用 UTF-8 无 BOM，最小修改，保留其他代理的工作。

## 2. 任务总览

| ID | 状态 | 任务 |
| --- | --- | --- |
| MEDIA-01 | DONE | 存储适配器与本地验证 |
| MEDIA-02 | DONE | A 方案播放会话与 Range |
| MEDIA-03 | DONE | 传输计量、防刷与并发 |
| MEDIA-04 | DONE | 分片上传与断点续传 |
| MEDIA-05 | DONE | 视频信息与兼容状态 |
| MEDIA-06 | DONE | 已有 OSS 视频选择性导入 |
| MEDIA-07 | DONE | 媒体验证与模块交接 |

## 3. 任务卡

### MEDIA-01：存储适配器与本地验证

- 状态：DONE
- 优先级：P0
- 前置依赖：CORE-01 接口交接；此前可准备设计
- 需求描述：以统一存储接口屏蔽真实 OSS 和本地测试环境差异。
- 实现要求：
  - 定义元数据、范围流、Multipart 操作和限定前缀列表的 StorageAdapter，实现 Mock/本地测试适配器与 OSS 适配器边界。
  - 使用 ali-oss 的受支持调用与签名方式；真实凭证只由服务端运行时读取。
  - 本机不尝试把杭州内网当作可达地址；不自动回退公网，真实访问需明确配置。
  - 对象读取范围受后端已授权元数据和配置前缀限制，禁止客户端选择任意 Bucket/对象。
- 计划变更范围：apps/api/src/modules/media/storage/、Fake 实现和适配器测试。
- 验收条件：无真实 OSS 时可验证读取/分片接口；真实适配器配置错误安全失败，不伪造真实对象成功。
- 影响范围：授权前缀、范围流、Multipart、目录列表与存储请求取消；公共接口未由本代理修改。
- 实际变更文件：`apps/api/src/modules/media/storage/scope.ts`、`storage/mock.ts`、`storage/oss.ts`；`apps/api/test/media.test.ts`、`apps/api/test/media/storage.test.ts`。
- 完成说明：实现明确有界 Mock 与 ali-oss 6.23.0 V4 适配器，凭证运行时只读、杭州内网/显式公网配置且无自动回退；每次 I/O 独享 Agent，AbortSignal 销毁 socket 与读取流。2 个实际存储测试通过，含真 SDK 仅连本地 HTTP 的 V4/Range/尚未返回 HEAD 取消；API 类型检查通过。未连接真实 OSS，ACL/Policy/内网可达性另待验证。
- 完成时间：2026-10-01
- 阻塞原因：

### MEDIA-02：A 方案播放会话与 Range

- 状态：DONE
- 优先级：P0
- 前置依赖：MEDIA-01；使用 CORE-03 的 AuthGuard，可先注入测试实现
- 需求描述：提供不暴露 OSS 直连地址的在线播放与受保护封面读取。
- 实现要求：
  - 导出媒体注册函数，创建与登录会话绑定的播放会话，提供 heartbeat 和 close。
  - 实现 GET/HEAD、合法 Range、206、长度与 Content-Range，非法范围明确处理。
  - 每次数据读取前检查用户、视频与播放会话；播放会话 ID 不作为独立授权凭证。
  - 使用流与背压，不整文件读取或下载落盘；客户端断开取消上游读取；封面同样鉴权。
- 计划变更范围：apps/api/src/modules/media/playback/、routes/ 和相关测试。
- 验收条件：无登录复制地址不能读取；拖动进度只读取对应范围；HEAD 不传视频体，断开请求停止上游。
- 影响范围：播放会话、heartbeat/close、站内 GET/HEAD/Range、受保护封面、断开取消。
- 实际变更文件：`apps/api/src/modules/media/index.ts`、`context.ts`、`options.ts`、`playback/range.ts`、`playback/routes.ts`；`apps/api/test/media/playback.test.ts`、`fakes.ts`、`apps/api/test/media.test.ts`。
- 完成说明：全部路由使用完整 /api 前缀和注入鉴权，校验 owner/login session/video/活动状态；视频地址不暴露 OSS。5 项累计测试通过：单 Range/HEAD、Cookie/CSRF/归属、封面、heartbeat/close、真实 loopback HTTP 断开中止持续上游；未连接真实 OSS/安卓，生产鉴权与 Repository 对接仍待 CORE。
- 完成时间：2026-10-01
- 阻塞原因：

### MEDIA-03：传输计量、防刷与并发

- 状态：DONE
- 优先级：P0
- 前置依赖：MEDIA-02；CORE-02 的 UsageRepository 与 PlaybackRepository
- 需求描述：让 A 方案限制真正作用于数据传输，而不是仅限制播放按钮。
- 实现要求：
  - 按应用实际输出字节累计限额，重试、范围读取、重复播放和并发均纳入同一周期。
  - 使用原子检查/累计机制，定义统计与终止误差上界，达到限额限制新请求并终止超限流。
  - 按播放会话控制并发，兼容一个播放器的多个 Range 请求；断开和超时释放活动状态。
  - 向 CORE-05 提供一致的应用统计，不能声称等同云账单或所有云费用封顶。
- 计划变更范围：apps/api/src/modules/media/limits/、metering/、测试。
- 验收条件：并发竞争、额度跨界、断开和持续流场景中限制可验证；不因只验证签名或请求次数而放行超量内容。
- 影响范围：应用正文 byte 计量、原子额度、播放会话并发、按用户分组请求限速与 IANA 统计日。
- 实际变更文件：`apps/api/src/modules/media/limits/rate.ts`、`metering/period.ts`、`playback/routes.ts`、`index.ts`；`apps/api/test/media/metering.test.ts`、`fakes.ts`、`apps/api/test/media.test.ts`。
- 完成说明：输出前原子 reserve，在途预留占额度，每次至多 64KiB；输出回调/断开时 settle 实际交给 HTTP 输出队列正文 byte。对收到设备字节可保守高估每请求至多一块 64KiB，不超已预留额度；非云账单。8 项累计测试通过，含并发竞争、范围重试同日累计、持续流 70000-byte 限额截断、0 限额、超时释放和 DST 日界；生产 Repository 原子实现由 CORE 后续验证。
- 完成时间：2026-10-01
- 阻塞原因：

### MEDIA-04：分片上传与断点续传

- 状态：DONE
- 优先级：P0
- 前置依赖：MEDIA-01；CORE-02、CORE-03
- 需求描述：完成手机经后端写入 OSS 的上传任务生命周期。
- 实现要求：
  - 实现创建、读取任务、原始分片写入和完成接口；生成唯一对象路径，验证任务归属。
  - 服务端返回 partSizeBytes，保存分片状态/checksum，不以完整大文件进入内存。
  - 中断或页面重开后允许重新选择同一文件；核对已上传分片，不只检查文件名。
  - 服务端验证分片和 OSS 完成结果后更新元数据；失败保留任务，不自动删除分片或覆盖原文件。
- 计划变更范围：apps/api/src/modules/media/upload/、路由和相关测试。
- 验收条件：分片重复请求的处理、断线续传、换错文件、缺片完成和无权限请求均有明确结果。
- 影响范围：上传任务创建/读取、原始流分片校验与完成状态机；原片不覆盖、失败分片不清理。
- 实际变更文件：`apps/api/src/modules/media/upload/locks.ts`、`upload/video.ts`、`upload/routes.ts`；`apps/api/test/media/upload.test.ts`、`fakes.ts`、`apps/api/test/media.test.ts`。
- 完成说明：服务端生成随机对象路径与 partSizeBytes，按 owner 读取和分类校验、SHA-256 重算、分片尺寸/编号限制、同任务串行锁及账户上传并发上限；相同字节重试幂等，错误文件不登记。完成 CAS、权威分片、OSS 完成后再 HEAD 大小/ETag、登记；失败保留并允许已完成 OSS 对象登记重试。10 项累计测试和 API 类型检查通过，包含 CSRF/归属/缺片/错误字节/恢复/存储或登记失败；真实手机/OSS/持久化恢复另待验。
- 完成时间：2026-10-01
- 阻塞原因：

### MEDIA-05：视频信息与兼容状态

- 状态：DONE
- 优先级：P0
- 前置依赖：MEDIA-04；CORE-04
- 需求描述：让已上传对象具有可信元数据和明确的播放兼容状态。
- 实现要求：
  - 按需通过 FFprobe 或等效验证获取时长、编码、分辨率；控制子进程与资源使用。
  - 兼容 MP4/H.264/AAC 进入可播放状态，不能凭 .mp4 后缀直接认为支持。
  - 不兼容样例显示 unsupported 和可执行的处理方案；不默认实时转码或购买云处理。
  - 封面生成按需实施，不可用时返回 null 并使用前端占位；原片不覆盖。
- 计划变更范围：apps/api/src/modules/media/metadata/、处理边界说明及测试。
- 验收条件：兼容、未知和不兼容样例状态准确，未采集字段为 null；缺少分析工具时明确记录待验项。
- 影响范围：内容分析器、兼容状态、受控 FFprobe 子进程与无封面 null 边界；不实时转码。
- 实际变更文件：`apps/api/src/modules/media/metadata/types.ts`、`metadata/ffprobe.ts`、`options.ts`、`index.ts`、`upload/routes.ts`；`apps/api/test/media/metadata.test.ts`、`probe-fixture.mjs`、`apps/api/test/media.test.ts`。
- 完成说明：FFprobe 使用单次随机 loopback Range 地址读取存储，限制子进程并发、时间、探针读取 byte 和输出大小，不落盘/全量缓冲；MP4 内容品牌、H264/AAC、8-bit yuv420p 与 profile 判定，HEVC/MOV/10-bit unsupported，关键字段未知 processing；缺工具保留 null。12 项累计测试及类型检查通过，含真实受控 Node 子进程的 Range/缺失/超时/并发/读取限额/失败清理。PATH 无 FFprobe，真实 FFprobe 与手机样例另待验；封面未自动生成，保持 null。
- 完成时间：2026-10-01
- 阻塞原因：

### MEDIA-06：已有 OSS 视频选择性导入

- 状态：DONE
- 优先级：P0
- 前置依赖：MEDIA-01、CORE-04
- 需求描述：允许本人从指定授权目录预览并登记已有视频。
- 实现要求：
  - 实现限定前缀的 preview 和 commit，只处理用户选定条目，不全 Bucket 自动扫描。
  - 确认条目存在与授权范围，完成时再次检查，不直接相信客户端路径。
  - 通过 VideoRepository 登记元数据，避免重复登记，不搬移、删除或改 ACL。
  - 没有真实 OSS 时以明确的 Mock 验证结构，真实导入验证单独记录。
- 计划变更范围：apps/api/src/modules/media/import/ 与相关测试。
- 验收条件：越界前缀、伪造条目、重复登记和对象不存在的情况不会写入错误元数据或访问无权对象。
- 影响范围：限定目录预览、服务端条目 ID、选择登记与防重复，不更改对象或 ACL。
- 实际变更文件：`apps/api/src/modules/media/import/routes.ts`、`upload/video.ts`、`index.ts`；`apps/api/test/media/import.test.ts`、`fakes.ts`、`apps/api/test/media.test.ts`。
- 完成说明：预览最多 100 项、不扫描全 Bucket，随机条目 ID 与账户/登录会话/10 分钟示例过期绑定；commit 接受 ID 后再次核对前缀/分类/HEAD 存在性及 size/ETag，内容分析后再复核。register 依照主控修订公共契约按 owner+原对象原子幂等且不覆盖已有元数据。15 项累计媒体测试通过，含伪造/越界/跨登录/过期/替换/不存在/存储失败及重复预览登记；真实 OSS 导入与持久化幂等仍待验证。
- 完成时间：2026-10-01
- 阻塞原因：

### MEDIA-07：媒体验证与模块交接

- 状态：DONE
- 优先级：P0
- 前置依赖：MEDIA-02～06
- 需求描述：整理媒体模块交付并提供可复现的安全与异常验证结果。
- 实现要求：
  - 验证 Range、上传状态、权限、限额、并发、断开取消及存储错误；优先无外部副作用的 Fake 用例。
  - 提供注册函数、依赖需求和 Repository 使用清单给子代理 1，不自行修改 API 入口。
  - 列出安卓、真实 OSS、服务器内网和大文件尚待验证的项目，不用 Mock 替代它们。
  - 保持 proxy 默认值，只留 B 可替换边界，不新增直连播放或公开授权。
- 计划变更范围：media 模块测试与交接说明。
- 验收条件：模块与共享契约编译一致；必要失败场景有真实证据；交付可由 CORE-06 安全装配。
- 影响范围：完整媒体注册交接、关键安全/异常测试、恢复边界与真实环境补验清单。
- 实际变更文件：`apps/api/src/modules/media/HANDOFF.md`、`index.ts`、`storage/mock.ts`、`storage/oss.ts`、`metadata/ffprobe.ts`、`import/routes.ts`、`upload/routes.ts`；`apps/api/test/media/failure.test.ts`、`storage.test.ts`、`upload.test.ts`、`import.test.ts`、`metadata.test.ts`、`probe-fixture.mjs`、`apps/api/test/media.test.ts`；本任务板。
- 完成说明：20 项媒体测试全通过、API 类型检查与编译通过；新增真 SDK loopback Multipart/list、真实 HTTP 上传中断/播放撤销、heartbeat 延期、上传并发与提前成功拒绝、新注册实例在 OSS 完成前/后恢复 finalizing。FFprobe 限定 demuxer/http协议/禁外部引用/无 shell，清除子进程代理环境；默认媒体注册仅用于 test，生产必须显式资源配置。接口缺口由主控修订，未越界改公共文件；交接清晰列出 CORE 持久化/真鉴权、真实 OSS/FFprobe/安卓/大文件/服务器待验，没有数据清理、B、部署或云权限操作。
- 完成时间：2026-10-01
- 阻塞原因：
- 交接复核补强：requestSignal 同时监听请求 aborted 和未正常完成 response close，上传/完成/导入在写元数据前复核取消；新增完整请求体已接收、等待分片存储/分析/预览响应期间断开的 3 个真实 HTTP 用例，累计 23 项媒体测试、API typecheck/build 通过。实际补充 `context.ts`、`playback/routes.ts`、`upload/routes.ts`、`import/routes.ts`、`failure.test.ts` 与 `HANDOFF.md`。

## 4. 完成记录

- 2026-10-01 MEDIA-07 交接复核：修正完整请求体后等待响应期间的取消边界；23 项媒体测试、API typecheck/build 实际通过，保留失败任务/已完成对象，不登记取消后的虚假成功。
- 2026-10-01 MEDIA-07：交付 `apps/api/src/modules/media/HANDOFF.md` 与 20 项测试；`node --import tsx --test apps/api/test/media.test.ts`、API typecheck、API build 实际通过。Fake Repository、真 SDK loopback 和受控 Node 探针分别明确；真实外部环境未伪造为完成。
- 2026-10-01 MEDIA-06：完成受控预览与选择导入；15 项累计媒体测试通过，真实 OSS/数据库幂等未验。
- 2026-10-01 MEDIA-05：完成受控 FFprobe/兼容分析边界；12 项累计测试及 API 类型检查通过。真实 FFprobe 不在 PATH，未安装或伪造真实分析；手机样例待验。
- 2026-10-01 MEDIA-04：实现流式分片任务和完成重试状态机；10 项累计测试、API 类型检查通过；未连接真实存储或写数据库。
- 2026-10-01 MEDIA-03：完成原子预留/结算与 64KiB 输出边界、IANA/DST 日周期、会话并发/请求限流；8 项累计测试通过，生产持久化计量待接入。
- 2026-10-01 MEDIA-02：完成播放注册/Range/受保护封面，5 项累计测试通过，包含真实 loopback 断开取消；实际 CORE 鉴权/Repository、真实 OSS 与安卓待验。
- 2026-10-01 MEDIA-01：完成 storage/scope.ts、mock.ts、oss.ts 与 storage.test.ts/媒体测试入口；2 项无云副作用测试、API 类型检查通过。真 SDK 仅连接 loopback 假 OSS；真实云、权限与服务器网络未验。

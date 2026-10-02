# MEDIA-01～07 模块交接

日期：2026-10-01。范围：本地 TypeScript 媒体实现与无云副作用验证。真实 OSS、数据库、生产鉴权、安卓与服务器验收仍需后续接入。

## 1. 注册及依赖

入口为 `apps/api/src/modules/media/index.ts`，提供 `registerMediaModule: MediaModule` 和 `createMediaModule(options): MediaModule`。全部路由含完整 `/api`，主控使用现有 `buildApp({ config, media: { register, dependencies } })` 注入，不重复加前缀。注册严格校验 AuthGuard、Repository、存储驱动和同一份配置；所有请求首先登录检查，写请求先 CSRF/来源检查再解析分片和读存储。

`registerMediaModule` 仅允许 development/test 中明确 kind=test 的依赖。其示例前缀 library/、1MiB 分片、8GiB 上传、2 个上传请求、120 秒播放 TTL、每组每分钟 120 请求、10 分钟预览/16 个预览均是本地示例，不是用户确认的生产预算；未知内容始终 processing。生产必须显式使用 `createMediaModule` 选择授权前缀、资源/请求上限和 FFprobe 分析器。当前公共 readConfig/buildApp 仍拒绝生产及真实 oss 注册，本代理未移除限制。

新增外部依赖由主控核验/串行安装：`ali-oss@6.23.0`；类型包 `@types/ali-oss@6.23.3`。其他运行实现使用 Node.js 内置 crypto/stream/http/https/child_process/fs/Intl 和已有 Fastify，不需要新测试框架。SDK README/源码核对了 authorizationV4、getStream、Readable uploadPart、init/completeMultipartUpload、listV2、自定义 Agent；测试真 SDK 仅连接本地假 OSS HTTP。

显式接入示例（仅展示配置结构，不执行真实 OSS）：

```ts
const register = createMediaModule({
  objectPrefix: configuredAuthorizedPrefix,
  partSizeBytes: configuredPartSize,
  maxUploadBytes: configuredMaximumUpload,
  maxUploadConcurrency: configuredUploadConcurrency,
  playbackTtlMs: configuredPlaybackTtl,
  requestsPerMinute: configuredRequestLimit,
  previewTtlMs: configuredPreviewTtl,
  maxPreviews: configuredPreviewLimit,
  metadata: new FFprobeMetadataInspector({
    executable: configuredFFprobePath,
    timeoutMs: configuredProbeTimeout,
    maxReadBytes: configuredProbeByteLimit,
    maxConcurrent: configuredProbeConcurrency
  })
});
```

## 2. Repository 必须实现的行为

| 接口 | 本模块调用与必须保证 |
| --- | --- |
| AuthGuard | requireUser 每次请求和流每个输出块检查会话；mutation 检查 Cookie、CSRF、可信来源。测试鉴权只在 test/media/fakes.ts，不能装入生产。 |
| VideoRepository | assertCategoryOwned 创建 OSS Multipart/登记前校验；findOwned 受 owner 限制；register 必须按 ownerId+originalObject.key 原子幂等，已有记录原样返回、新登记再次检查类别；分析状态经 register 保存。 |
| UploadRepository | create/findOwned/savePart/transition；内部保存 storageUploadId、key、ETag，不能返回前端。savePart 相同编号/大小/SHA-256 幂等，冲突拒绝；transition 为 CAS，支持 uploading/failed→finalizing、finalizing→failed/completed，也支持受保护恢复的 finalizing→finalizing（单实例任务锁，完成 retry 会先 HEAD 已完成对象）。 |
| PlaybackRepository | create 原子检查过期/活动并发再建立会话；findActive 同时核对 owner/login/video/未关闭/未过期；heartbeat 必须受限延长有效期并返回当前会话；close 幂等关闭且检查归属。多个 Range 不新增会话。 |
| UsageRepository | reserve 原子扣除已累计+在途预留，返回 <=请求数的正 byte；settle 幂等提交实际输出并释放其余预留，不能采用独立读取计数后写回；read 与 CORE-05 共用统计日。持久化实现须保守处理进程异常遗留预留。 |

Task/Video 状态和 SHA-256 使用共享类型；publicUpload 主动去除 ETag。前端请求中任何对象 key、OSS 上传 ID、ETag 完成列表均不作为访问目标。上传完成缺片、大小或 checksum 不一致会拒绝。存储完成失败保留全部任务/分片；对象已完成但登记失败可重试 HEAD/登记，不重复覆盖原片。服务器崩溃遗留 finalizing 可通过已鉴权 complete 重试，同实例任务锁串行；多 Node 实例不是当前单机范围，未来需要仓储 lease。

取消同时监听 IncomingMessage.aborted 与未正常完成的 ServerResponse.close：完整请求体已接收但客户端仍在等待存储/分析响应时断开，也会取消对应 AbortSignal。适配器/分析器返回后、登记任务分片或视频前再次检查取消，防止忽略 AbortSignal 的实现返回假成功；已启动的原子 Repository 写入无法回滚，本模块不擅自删除其数据。

## 3. 存储与传输边界

MockStorageAdapter 是明确的内存测试实现，默认总对象/分片 byte 上限 32MiB；保留 Multipart，不清理文件或云数据。不能用于大文件、重启持久化或真实云验收。

createOssStorageAdapter 运行时从指定只读 JSON secret 文件读取 accessKeyId/accessKeySecret（可选 stsToken），不会在导入模块时读凭证/联网。仅允许杭州指定 HTTPS Endpoint，内网失败不回退公网；public 模式同时要求 allowPublicNetwork=true。V4 强制开启；每个 I/O 创建独立 HTTP/HTTPS Agent，AbortSignal 销毁其 socket/流，不依赖 SDK cancel 对普通请求的无效承诺；关闭完成后销毁 Agent。唯一对象路径、complete 的 x-oss-forbid-overwrite 和 server-authoritative ETag 避免覆盖。未提供 delete/abortMultipartUpload/签名 URL/ACL/Policy 操作。

GET/HEAD 支持单 Range、开放终点/后缀、206/Content-Range/Accept-Ranges；错误范围 416。HEAD 不打开视频流、不发送正文。视频与封面均授权；封面只接受 JPEG/PNG/WebP、无封面 null。播放器只获得站内 proxy 地址。

统计日使用 IANA 时区真实 UTC 边界，包含 DST 23/25 小时。每请求下一块最多 64KiB，在输出前原子 reserve，在 HTTP write 回调/断开/finally settle。正文长度不会超预留额度；重复、拖动、重试和并发全部累计。计量定义为交给 HTTP 输出队列的正文 byte，不是对端确认收到 byte：断开时可保守高估至多每个活跃请求一个 64KiB 块；不低估已交给输出队列的 byte。应用 byte 上限对本模块正文可执行，但不是云账单或所有云费用封顶。额度耗尽拒绝新数据读取，进行中的流下一块截断并取消上游，不追加 JSON；尚未开始的错误使用公共安全错误表。

## 4. 内容分析和可执行兼容处理

FFprobe 通过一次性随机路径、仅绑定 127.0.0.1 的 Range HTTP 入口读取已授权对象，既不传 OSS URL/凭证，也不整文件缓冲/落盘。限制并发、总读取 byte、超时、单次 allocation 16MiB、输出 64KiB；probeSize 8MiB、analysis 10 秒。仅允许 mov/mp4、matroska/webm、avi demuxer；protocol 仅 http/tcp，禁止 MOV 外部 data reference 和绝对路径，拒绝 HLS/DASH/网络 manifest 分析，以免对象内容诱导外部子资源请求。子进程禁止 shell，窗口隐藏，超时/取消关闭其 loopback 和自有进程。真实工具版本/参数适配必须在实际 FFprobe 环境补验；max_alloc 是单次分配限制，不能宣称为进程总内存上限。

MP4 内容品牌、H264、8-bit yuv420p、Baseline/Constrained Baseline/Main/High 与 AAC（或无音轨）进入 ready；HEVC/MOV/10-bit 或明确不兼容 unsupported；关键格式未知 processing；分析失败 failed。缺工具 processing，未采集字段 null；始终不凭 .mp4 后缀判可播。封面不自动生成，仍 null；不实时转码、不开通收费云服务、原片不覆盖。

不兼容文件的可执行后续流程：在本人电脑保留原片，使用 FFmpeg 转为单独命名的 MP4/H264/8-bit/AAC 兼容文件，重新上传或将单独对象登记到库；本轮不自动建立原片/副本关联。示例仅为后续人工执行，未执行也未安装 FFmpeg：

```powershell
ffmpeg -n -i "original.mov" -map 0:v:0 -map 0:a? -c:v libx264 -pix_fmt yuv420p -profile:v main -crf 23 -c:a aac -movflags +faststart "compatible-copy.mp4"
```

-n 拒绝覆盖既有输出；原文件保持不变。用 FFprobe 校验输出后再导入，安卓实际播放仍需测试。3Mbps 环境必要时另根据样例选兼容副本码率，不能承诺原片均流畅。

## 5. 导入范围

preview 接受明确 `{prefix:""}` 表示配置授权根范围；缺失、非字符串或越界拒绝，非空只能是授权子目录。一次预览最多 100 项，不扫描全 Bucket；目录更多时先选更窄目录，目前公共 DTO 无分页游标。preview/item ID 随机并绑定 owner+login/TTL，只返回文件名/size/空分析字段，不返回 key。commit 只接受选中 ID，先复核全部对象 size/ETag/存在性再登记，内容分析后再 HEAD 复核；重复通过仓储原子对象幂等。预览缓存仅有界内存，服务重启后重新预览，不丢失原对象。

## 6. 实际验证及补验

实际已运行：

```powershell
node --import tsx --test apps/api/test/media.test.ts
npm run typecheck -w @online-video/api
npm run build -w @online-video/api
```

媒体 23 项测试全部通过，API 类型检查与编译通过。覆盖明确 Mock Storage 与真 SDK loopback V4/Range/Readable Multipart/list/socket 取消；Cookie/CSRF/owner/login 会话保护、Range/HEAD/封面/heartbeat/close；真实 HTTP 播放断开与动态鉴权撤销；原子额度竞争、70000-byte 持续流截断、DST；上传重复/错字节/尺寸/缺片/真实 HTTP 断线/恢复/并发/失败后对象登记重试、新注册实例恢复 finalizing（OSS 完成前/后）；完整 PUT/complete/preview 请求体接收后等待存储或分析时断开并取消，拒绝登记虚假成功；受控子进程探针限制和兼容分类；选择导入、越界、伪造、过期、对象替换/不存在、去重；安全错误与生产拒绝测试依赖。使用 Fake Repository，真 SDK 只到本机测试服务器，Node 探针 fixture 不是真 FFprobe。

尚未验证：CORE-02/03 的持久化 Repository 与生产 Cookie/CSRF；真实 OSS 凭证/V4/私有权限/目录/Multipart/对象一致性；杭州内网网络来源；真实 FFprobe 参数、手机视频编码/码率、超内存尺寸文件和探针资源；真实安卓上传后台/锁屏/重选/切网及浏览器兼容；服务器 3Mbps、重启/断电恢复、容器/部署。生产预算/时区/前缀仍由用户确定。没有修改用户 sqlite-test.db、真实 OSS 权限/数据、服务器，没有执行迁移、删除或 B 方案。

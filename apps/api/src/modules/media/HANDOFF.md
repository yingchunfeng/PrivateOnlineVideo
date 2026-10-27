# MEDIA-01～07 模块交接

日期：2026-10-01。范围：本地 TypeScript 媒体实现与无云副作用验证。真实 OSS、数据库、生产鉴权、安卓与服务器验收仍需后续接入。

最新第二阶段运行事实见第7节；第1～6节保留第一阶段历史，不代表当前OSS仍拒绝装配。

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

## 7. 第二阶段交接（2026-10-02）

P2-MEDIA-01～05完成。正式库/本人账号保留、真实FFprobe、已授权实云两对象上传登记/私有权限/播放下载、真实自动续签/退出边界/实际进程重启持久化均有证据；CORS已核验当前native video路径，额外fetch不可读边界如实记录，最终网站/安卓/杭州内网/部署归第三阶段。服务端共享契约/SQL/配置/入口由后端代理维护，媒体只调用Repository。

### 运行工厂和输入

- `createStsCredentialCache({ bucket, objectPrefix, credentialFile, roleArnFile? 或 roleArn?, durationSeconds, refreshBeforeSeconds }, now?)`：函数运行才读服务端秘密，长期AK仅调用已有`OSS.STS.assumeRole`。用途upload/import/read对应Put+Get/限定List+Get/Get，缓存键含角色+用途+Policy，按Expiration提前刷新、同用途刷新合并、同步/异步失败均可重试，取消一个等待者不取消其它等待者。
- `createOssStorageAdapter(ossOptions, credentialProvider)`：只用STS，SDK region统一`oss-cn-hangzhou`；生产拒legacy key，校验完整provider/Bucket/region/key/version，按输入定位而不根据默认Bucket猜历史位置。每个I/O独享client/Agent，取消不会销毁其它I/O；Multipart不整文件缓冲/落盘，无delete/abortMultipart/ACL/权限变更接口。
- `createOssPresignedSourceProvider({ bucket, region, endpoint: OSS_PLAYBACK_ENDPOINT, objectPrefix, ttlSeconds, safetySeconds, renewBeforeSeconds }, credentialProvider, now?)`：独立固定HTTPS/CNAME，read用途STS，调用`signatureUrlV4('GET',…)`。只接受DB verified registered对象，播放签inline并保留对象实际Content-Type，不签OSS禁止的response-content-type；下载签安全附件文件名。真实工厂不支持test HTTP；本地协议显式new provider(kind=test)仅接受127.0.0.1 HTTP。

用户已确认单文件2147483648 bytes、最多3个应用播放会话、URL上限3600秒/提前300秒续签、Asia/Shanghai。已选8MiB分片、上传并发2、一般请求120/min、签发/续签/下载合并12/min、STS3600秒/提前300秒刷新/安全余量30秒。生产配置由后端冻结，测试旧示例不是默认本人预算。

### 上传/登记与导入

真Repository创建时验证全部活动组织，objects.prepare+uploads.create先存任务/对象/组织/操作意图；首次PUT才初始化云分片，再记录Multipart ID并attach；失败保留任务可重试。完整片SHA-256校验与已有协议保留。complete恢复“云已完成、库失败”时HEAD已存在对象，内容分析+最终HEAD后调用单个finishRegistration事务，完成video/资产/组标签/任务/操作日志。归档后完成明确冲突，重复complete返回同一视频，不清理原片/分片。

Bucket ACL已由用户确认公共读；新唯一对象完成请求固定`x-oss-object-acl:private`与`x-oss-forbid-overwrite:true`，生产适配器只允许pending/null版本对象走本次完成，已verified对象不能收到ACL完成请求。仅使用既有角色upload用途Get/Put会话Policy，不增加PutObjectAcl、不调用Bucket/已有对象ACL修改API；403安全失败，不回退default/public或扩权。原公开样例保留。本轮用户明确授权后，2个新UUID对象匿名403/有效STS V4 Range206已证明本轮新对象私有实效。官方依据见[验收范围](OSS_ACCEPTANCE.md)。

`uploadObjectPrefix`/`OSS_UPLOAD_OBJECT_PREFIX`只能服务端配置根授权范围的子目录，默认`onlineVideo/originals/`。实云验收可明确配置`onlineVideo/acceptance/local/<run-id>/`；客户端不提交key/Bucket/版本，静态前缀由limits公开供受控脚本核对。

导入每页独立previewId/条目ID，不透明cursor绑定owner/login/prefix/TTL，有界100项/页。preview HEAD固定size/ETag/version；commit全部对象和组织重新复核/分析，按完整身份登记。重复导入返回既有视频/组织，不以重复请求覆盖元数据；空组标签对新登记有效。未知旧key保持legacy、真实读取拒绝，不根据当前默认Bucket回填。

显式回填由`ImportCommitRequest.existingVideoId`指定本人旧记录且只能选一个预览项；媒体先查owner并要求旧原key与预览完整对象key精确相同，再HEAD/分析/verify后调用`bindLegacy`事务。保留旧id/title/分类/组标签/createdAt/观看进度，历史归档关联不因回填被清空或改为活动项；已绑定同身份幂等、错身份/错key/多选拒绝。旧兼容副本key不同且未核验不猜位置，播放资产使用本次已验证原片的实际分析状态。真SQLite+HTTP测试验证旧标题/组标签/4秒进度保留、只2条既有视频/4资产/2对象、重复绑定不新增视频。绑定现有视频不是迁移时自动猜Bucket，真实对象读取/登记仍先具体验收授权。

真实FFprobe已准备：`E:/onlineVideo/.local/tools/ffmpeg-9.0.2-stage2/ffprobe.exe`，根.env已局部配置路径。通过真实`FFprobeMetadataInspector`受控Range探针，原片`docs/ces.mp4`329035 bytes识别为unsupported HEVC/AAC、5.909688秒、592×1280；用户明确选择后在本机生成独立副本`.local/acceptance/samples/ces-h264-aac-20261002.mp4`460063 bytes，同一路径分析器识别为ready H264/AAC、5.909688秒、592×1280。记录`.local/acceptance/samples/analysis-20261002.json`证明原片SHA-256不变；原片hash=`dcda48cac1f42ff40775c03200af183a41c2fd067af08f3b4b3722df7fafba2a`，副本hash=`f7083ce3ecc34bf2639622d4144f545022570e9601f5f9fc447257fc459d12a4`，大小/hash已只读复核。没有覆盖原片、写入OSS或实时转码；真实浏览器/实云播放仍待验。受控Node探针与此次真实工具证据分列，未知其它视频仍processing/null字段、封面无则null。

### 直连、安全和用量

OSS创建应用会话后发源，达到3个时在签名之前拒第4个；同会话source续签重新鉴权/归属/状态，复用槽；原片下载独立授权不占播放槽。心跳只返回应用id/videoId/mode/expiresAt，源更新单独source路由；签名URL不保存SQL，不出现在审计/日志。限频与SQL授权审计不包含URL。

签名实际到期取SDK签发时间与STS剩余时间减30秒，不超过3600秒；正常renewAfter=sourceExpiresAt-300秒，短剩余期限取剩余一半避免循环。关闭/退出/撤销拒新签发，旧签名仍可能在有效期内读取。OSS直连`/stream`明确拒绝，不自动代理回退；小封面保留站内鉴权路由。直连usage为not_synced/null字节，授权次数/应用会话数不是云连接数或实际传输量。proxy旧Range/206/416/预留结算仍独立保留。

### 验证和实云门

已运行：`node --import tsx --test apps/api/test/media.test.ts apps/api/test/stage2-media.test.ts apps/api/test/stage2-integration.test.ts`，共35项通过（旧proxy23、自有阶段2 10、主控独立2）；`npm run typecheck -w @online-video/api`、`npm run build -w @online-video/api`通过。

公共Bucket补强后重新运行旧媒体23项+阶段2 12项共35项通过，typecheck/build通过；新增真SDK协议证明private头/403无回退/原public对象保留/无ACL修改API，CLI授权/互斥模式与受控fetch替身证明匿名200立即停止、403+签名206才继续下载。这是本地协议与代码门证据，真实IAM/云ACL尚未执行。

源码于2026-10-02 14:58:34 UTC冻结；主控受影响14项的证据为private头/真HTTP等13项通过，加冻结源码下“新上传私有验收模式”单项复核1/1通过。计数断言精确区分` signed …`与` unsigned …`字段，分别要求一次签名Range和一次完整下载，未放宽数量条件；本轮没有执行真实云。

真SQL导入证明完整对象/2资产/组标签/操作日志单视频与重复幂等；主控真HTTP+文件SQLite+真AuthGuard+独立V4 HMAC协议证明8MiB两片上传/唯一登记、3槽/同会话续签/原片下载、直接206、退出新签发401而旧URL仍206、重启组织/观看进度、proxy实际8bytes。SDK只连本机，测试身份不是真云权限；元数据受控注入不是真FFprobe/手机格式。

正式库当前为`.local/data/video-library.db`版本2；迁移备份为`.local/backups/before-migration-1790950813946-71816f51-c74c-4667-a682-782f49db3d0d.db`，同名`.db.verification.json`证明旧列保留true、账号1条、完整性ok、外键0、手工库保留。媒体文档更新时重新以readonly打开正式库，ledger1/2、账号1条、视频0条、integrity=ok、foreign_key_check=[]；未再次迁移或修改库。已有正式迁移授权不包含新云写入/费用/权限操作。

真实执行清单与受控CLI在[OSS_ACCEPTANCE](OSS_ACCEPTANCE.md)、`acceptance/run.ts`：具体授权/版本2备份声明/指定SHA-256 1 byte～16MiB样例/独立验收前缀/固定本机与HTTPS媒体目标全部校验，六项授权门包括`newObjectPrivateAcl:true`。当前无既有私有视频可用，支持`verifyUploadedObjectPrivate:true`模式：只上传本轮新唯一private对象→完成/原片签名→检查Origin/授权run前缀→匿名1字节Range拒绝且有效签名206→再下载/播放；失败即停止保留记录/对象。它与既有`privateVideoId`模式互斥，后者可在上传前另验已有私有对象；新上传对象在两模式下都验匿名拒绝。默认dry-run不读取会话/样例或联网，只有`--execute`才可能调用本机真实API。原片和兼容副本分别一份清单、各最多一次，具体计划限2个新视频对象+最多1字节读取用途Put拒绝探针。脚本不改Bucket/已有对象ACL/Policy/版本控制、不执行迁移、不删除清理；新对象private头也必须获本轮具体授权才在实云执行。结果仍需真实STS/OSS、浏览器/CORS/撤销/重启/IAM实效补验。

P2-MEDIA-05具体范围在[本轮计划](../../../../../docs/archive/STAGE2_CLOUD_ACCEPTANCE_PLAN.md)，用户已明确授权，授权清单位于`.local/acceptance/run-20261002-ces-private/authorization.json`：同run目录至多2个原片/兼容UUID对象private、有限公网/费用、本人正式库2视频+1组2标签与最多1字节读取用途Put拒绝探针。既有Bucket公共读/原公开样例保留，无策略扩权/删除清理。网站证书/安卓/杭州内网/部署归第三阶段。

### 本轮真实STS/OSS权限和对象结果（16:51:44 UTC）

主控证据同目录STS preflight、`original-result.json`和`compatible-result.json`已读取：read/upload/import各3600秒AssumeRole及Expiration缓存复用通过；站内真API/本人v2库两对象登记、组标签/重复complete幂等通过，原片HEVC/AAC329035 bytes unsupported、兼容H264/AAC460063 bytes ready，均匿名403/STS V4 Range206。原片完整下载SHA通过；兼容浏览器下载当时尚待联调，后续完整交付节已补成功证据。

媒体独立`permission-probe.ts`校验authorization.json精确目标/范围并清空DEBUG、运行时加载服务端AK/ARN；只read用途STS Put一个1字节唯一key，头private+forbid、SDK retryMax=0，先`wx`记录意图禁止重发。实际返回403，requestId=`6ABFE123CBC3093030CF182A`，目标`onlineVideo/acceptance/local/20261002-ces-private/read-only-put-probe-a871dbea-fa80-4721-8838-2e1ce342ff9b.bin`没有意外创建。随后import用途只List同run目录max-keys10，200/requestId=`6ABFE123CBC30930302C192A`，恰好2对象789098 bytes/无截断；read/import Expiration=`2026-10-02T17:51:47.000Z`。结果/意图/探针结果保存`permission-result.json`、`read-only-probe-intent.json`、`read-only-probe-result.json`，无完整URL/凭据输出。已有结果只返回、意图已存在未证明403则停止；无Delete/Abort/ACL/RAM/Bucket操作。

该结果证明Get-only读取STS不能Put且import限定目录List实效；不代替浏览器实际CORS、直接播放、续签位置恢复、兼容下载、撤销与重启。这些独立证据后续在完整交付节补齐，权限探针未重复。

### 浏览器播放根因修复（17:04 UTC）

真实浏览器首次播放`net::ERR_BLOCKED_BY_ORB`，主控1字节诊断实际是OSS400/XML `InvalidRequest`/`Can not override response header on content-type`，requestId=`6ABFE320A5F05D3038807A4D`，不是TLS/DNS/CORS证据。2026-10-02经Exa现读官方[GetObject](https://help.aliyun.com/zh/oss/developer-reference/getobject)与[Node V4预签名下载](https://help.aliyun.com/zh/oss/developer-reference/download-objects-using-a-presigned-url-generated-with-oss-sdk-for-node-js)：支持response-content-disposition等查询响应覆盖，不列response-content-type；本机SDK仅把任意queries参与签名，无API语义验证。

最小修复仅从播放签名去掉非法type query、保留官方允许inline，验收CLI承认真实对象video/mp4或octet-stream元数据；没有改已有2对象元数据/ACL、复制/覆写/新增对象或放宽CORS。新增真SDK+官方响应覆盖白名单协议回归，非法query会400，当前新签名Range206且保留inline/octet-stream；3项受影响检查及typecheck通过。主控需重启helper/API加载新源码并获取新签名，旧已发URL仍非法不能复用。真实1byte读取与native解码/播放由主控/前端补验，NodeRange成功不等于浏览器可解码；05仍DOING。

### 本机实云完整交付（17:29 UTC）

此节为当前结论，前面分时记录保留历史。P2-MEDIA-05已DONE，证据目录`.local/acceptance/run-20261002-ces-private/`含：

- `backend-readonly-1790959879273-c3827e18-8104-41ee-b2e0-fd61ab6ad0bb.json`：同正式v2库ledger/schema一致、账号密码/TOTP设置/恢复摘要保留，2视频/2上传/2操作registered/2storage_objects/4assets、分类/组标签快照/分片恰一次匹配；integrityok/fk0/手工库保持。
- `playback-after-signature-fix.json`：修复后新V4播放GET1byte206、inline、实际application/octet-stream，req=`6ABFE4296E92FC3539B36414`，非法query移除。没有SetObjectMeta或复制/覆盖云对象。
- `browser-baseline-1790960761020-c6d6cbd7-bf31-4e88-b413-32cf62d82071.json`：真实native HTTPS GET/Range206直接OSS媒体域名、无站点Cookie，原片unsupported提示，兼容视频解码5.909688秒/592×1280、拖动2秒/暂停/readyState4；浏览器唯一完整附件460063 bytes，SHA=`f7083ce3ecc34bf2639622d4144f545022570e9601f5f9fc447257fc459d12a4`。原片完整下载SHA亦通过。
- `browser-short-1790960905830-e70bc8ff-d16d-4fc0-9af0-a3ac540912c1.json`：使用临时真实900秒STS profile验证到期前300秒自动续签，首URL实际寿命871820ms；17:17:59首续签、17:20:29第二续签，始终会话`3293d74b-ccf1-42d1-ac59-83895d6d0a17`，第二次freshTokenChanged=true，换源均保留2秒/paused/ready4。退出source401，旧有效URL1byteRange仍206，直连撤销边界实测。
- `browser-resume-1790961841929-b9b32c3a-7ad2-4f98-b44d-037353a94643.json`：实际旧shorthelper API51665关闭且terminal0，新normalhelper实际进程启动requestedSTS3600/temporaryShort=false；再用本人既有账号登录，前端仅GET列两视频/组织并恢复2秒watch progress(updated17:20:29.798)，不是仅重建Fake。主控交接正常.env已恢复STS3600/上传prefixonlineVideo/originals/，随后仅退出该测试会话、正常停止验证进程。
- `existing-public-sample-preserved.json`：旧公开样例HEAD200/329035/videoMP4、未读取正文，req=`6ABFE52CF7C44F34341F5286`；整个Bucket ACL与旧对象/策略/权限保持。2视频新对象789098 bytes保留，read探针403没有第三对象；任务/分片/下载/报告全部保留，无清理。

CORS核验结论限定当前产品native video未设crossOrigin，实际播放正常且媒体没有站点Cookie。额外credentials-omit跨域fetchRange不可读（browserCorsGet.readable=false）；没有修改CORS或把它称为所有跨域规则通过。将来fetch/HEAD/crossOrigin或最终网站Origin需求在第三阶段明确规则后验证，安卓与杭州内网也未在本轮宣称成功。短STS已恢复正常3600秒，未将测试profile当生产预算。

签名根因修复后受影响媒体+主控真HTTP协议15项通过；最终全仓检查由主控独立汇总，此次收尾只更新三份媒体文档/板，没有重复实云探针/List/下载或追加云对象。

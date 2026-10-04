# P2-MEDIA-05 本机实云验收范围与证据

用户已于2026-10-02明确授权[本轮计划](../../../../../docs/STAGE2_CLOUD_ACCEPTANCE_PLAN.md)范围，授权记录为`.local/acceptance/run-20261002-ces-private/authorization.json`。真实STS、两样例站内上传/登记、对象私有/签名Range、读取用途Put拒绝/限定List、真实浏览器播放/兼容下载/自动续签/退出边界/实际进程重启持久化全链证据已验，P2-MEDIA-05于17:29 UTC完成。CORS核验限当前native video未设crossOrigin路径；额外fetch不可读记录保留，不宣称所有跨域、安卓/内网/部署成功。

Bucket ACL为公共读，主控已在授权的两个新唯一对象CompleteMultipartUpload中发送`x-oss-object-acl: private`和`x-oss-forbid-overwrite: true`。两对象匿名Range403、有效STS/V4 Range206证明本轮私有实效；没有调用PutBucketACL/PutObjectACL、修改原公开样例/已有对象或扩大STS会话Policy。官方依据保留：[CompleteMultipartUpload](https://help.aliyun.com/zh/oss/developer-reference/completemultipartupload)、[Object ACL](https://help.aliyun.com/zh/oss/user-guide/object-acl)。

## 已授权目标与当前结果

| 项目 | 具体目标/范围 |
| --- | --- |
| 本机 API / Web | `http://127.0.0.1:3000` / `http://127.0.0.1:5173`，真实本人账号，不启用 Mock |
| SQLite 目标 | 同一正式v2库/本人账号已登记本轮2视频及正确分类/组标签，重复complete幂等；一致性备份及旧列保留报告保留，不切换到`sqlite-test.db` |
| 私有验收模式 | 使用新对象私有验证模式；原片及兼容副本匿名Range403、有效STS/V4 Range206均通过，未假填既有privateVideoId |
| 新上传 | 原片329035 bytes与独立兼容副本460063 bytes已站内流式上传，目录限定`onlineVideo/acceptance/local/20261002-ces-private/`，2个新视频对象合计789098 bytes；保留原公开样例/整个Bucket ACL |
| 组织选择 | 本人活动分类 ID、分组 ID 数组、标签 ID 数组，允许空分组/标签 |
| 分析器 | 真实FFprobe受控Range核验原片unsupported HEVC/AAC与副本ready H264/AAC，均5.909688秒/592×1280；兼容真实浏览器native decode/play/pause/seek和下载SHA已验 |
| STS | 3用途AssumeRole/3600秒/Expiration缓存复用已通过；16:51:44 UTC read Get-only唯一1字节Put403拒绝，import仅授权run前缀List200/2对象789098 bytes；没有建角色/改Policy |
| 网络/费用 | 本机公网上传 Endpoint；签名固定 HTTPS 媒体 Endpoint；明确允许样例上传/读取/下载产生的请求、存储及公网下行费用范围 |
| 保留对象 | 新对象、分片、任务/操作记录全部保留，不删除、不自动清理 |
| CORS/版本 | 当前native video未设crossOrigin实际206正常；额外credentials-omit fetchRange不可读如实记录，未改CORS，不把未来fetch/HEAD/最终Origin视已验。2对象DB versionId=null、HEAD核验，未改版本控制 |

## 执行顺序与证据

1. 校验具体授权与配置，仅打印 Endpoint/用途/Expiration，不打印 AK、Token、完整 URL、Cookie 或 CSRF。
2. 真实本人登录后验证错误 owner/CSRF 拒绝；分类/分组/标签由真 SQLite 读取。
3. 创建任务持久化组织快照，逐片 SHA-256 经站内服务器流式上传；重复片/complete 与断开重试，不整文件缓冲或落盘。
4. OSS complete/HEAD 成功后 SQLite 原子登记；记录唯一视频/资产/组织/完成任务/操作日志及对象完整身份，不把 URL 存为永久对象字段。
5. 新对象登记后核对媒体Origin/run前缀，先验匿名 GET/Range 401/403拒绝、有效 STS/V4 GET/Range 206成功；若匿名200或签名失败，停止完整下载/播放并保留对象/记录，不自动改权限。既有私有对象模式在上传前另核验；读取用途STS Put拒绝探针限授权的最多1字节唯一新key，不拿既有对象做Put测试。
6. 浏览器 Network 证明视频正文直接来自媒体 HTTPS Endpoint，应用 API 只发控制请求；验证 206/Content-Range、sourceExpiresAt/同会话续签、下载 Content-Disposition。
7. 撤销或退出拒绝新发放/续签；旧 URL 仍可在已发有效期内使用。记录应用会话槽复用与直连字节未知，不宣称费用封顶或立即撤销。
8. 应用重启后本人账号/组织/上传任务/视频/观看进度仍在；记录具体时间、目标、样例大小、结果及保留对象清单。

本地协议替身、真实 STS/OSS、真实 FFprobe、手机样例、安卓/杭州内网分别记验。网站证书、部署、杭州内网与最终安卓验证属于第三阶段。

## 已核验的本机材料

分析证据为 `.local/acceptance/samples/analysis-20261002.json`，两个文件当前大小与SHA-256已只读复核：

| 样例 | SHA-256 | 真实分析结果 |
| --- | --- | --- |
| 原片 `docs/ces.mp4`，329035 bytes | `dcda48cac1f42ff40775c03200af183a41c2fd067af08f3b4b3722df7fafba2a` | unsupported，HEVC/AAC，竖视频592×1280，5.909688秒 |
| 独立副本 `ces-h264-aac-20261002.mp4`，460063 bytes | `f7083ce3ecc34bf2639622d4144f545022570e9601f5f9fc447257fc459d12a4` | ready，H264/AAC，竖视频592×1280，5.909688秒 |

本机生成副本已获用户明确选择，分析记录证明原片SHA-256不变；没有覆盖原片。迁移后上传前正式库只读复核ledger1/2、账号1条、视频0条、integrity=ok、foreign_key_check为空，与保留报告一致；本轮授权后已登记2视频。Bucket公共读与已有对象ACL保留，只对本轮2个新唯一对象在完成时设private，匿名拒绝已验证。

## 真实权限与对象证据（2026-10-02）

证据目录`.local/acceptance/run-20261002-ces-private/`含授权、STS preflight、`original-result.json`、`compatible-result.json`、`permission-result.json`；没有完整签名URL/长期AK/Token/Cookie。

- 原片视频`85376723-c12f-4e34-bf5e-0b711bb8a287`，对象`onlineVideo/acceptance/local/20261002-ces-private/1da039d7-e1b2-400d-9c43-bf89db59d5c7`，329035 bytes，真实分析unsupported HEVC/AAC；匿名403、签名Range206、完整附件下载SHA-256通过。
- 兼容视频`cf7c94ce-1911-45cb-9670-cacd5878365f`，对象`onlineVideo/acceptance/local/20261002-ces-private/5f2efb09-29bc-4924-9c3f-36867575292d`，460063 bytes，真实分析ready H264/AAC；匿名403、签名Range206、真实native解码/暂停/拖动和唯一完整附件下载SHA通过。
- `permission-probe.ts`先用`wx`保存唯一意图，read用途STS只尝试一次1字节Put（private+forbid，SDK retryMax=0），返回403，requestId=`6ABFE123CBC3093030CF182A`；没有意外创建探针对象。目标`…/read-only-put-probe-a871dbea-fa80-4721-8838-2e1ce342ff9b.bin`记录保留，不再重试。
- 同脚本import用途只List授权run前缀、max-keys10，不分页/不扫其它前缀，返回200、requestId=`6ABFE123CBC30930302C192A`，恰好上述2对象/789098 bytes/不截断。read/import Expiration=`2026-10-02T17:51:47.000Z`，PolicyHash分别`965e6b43c5697017b3e45829ec8b00416221692e3602242db21fddaa6884ded0`和`d7771e2d189de31a602f3b535aa234ad75ca1562b6dbdfc2d08ff51cb902e316`。

探针脚本`permission-probe.ts`必须读取本轮authorization.json验证精确Bucket/region/prefix/最多2视频+1byte/费用/ACL/保留范围，默认只准备；已有结果直接返回，意图已存在且未证明403则停止，拒绝再次Put。所有记录和对象保留，无Delete/Abort/ACL API/RAM/Bucket策略变更。

浏览器首次播放失败的真实根因：签名查询`response-content-type=video/mp4`被OSS拒绝400/XML InvalidRequest，安全诊断文件`browser-playback-header-diagnostic.json`/`browser-playback-safe-error.json`保留，req=`6ABFE320A5F05D3038807A4D`。按2026-10-02当前官方GetObject覆盖白名单，媒体代码已去该query、保留inline；原对象octet-stream元数据不改、不扩大ACL/CORS、不生成新对象。重启后新签名真实GET和native解码/播放已按下表补验，旧非法URL保留为失败历史。CLI Range允许video/mp4/octet-stream只是元数据检查，浏览器兼容成功来自独立真实native报告。

## 浏览器/续签/退出/实际重启完成证据

以下报告均在上述run目录，已经读取核对；不含完整签名URL/凭据。

| 证据 | 实际结果 |
| --- | --- |
| `playback-after-signature-fix.json` | 重启加载新源码后新播放签名1byteGET206/inline/octet-stream，非法query消失；req6ABFE4296E92FC3539B36414 |
| `browser-baseline-1790960761020-c6d6cbd7-bf31-4e88-b413-32cf62d82071.json` | passed；native HTTPS GET206直接OSS/无站点Cookie；兼容5.909688秒/592×1280/ready4，拖动2秒并暂停；完整附件460063 bytes/SHA f7083ce3ecc34bf2639622d4144f545022570e9601f5f9fc447257fc459d12a4；原片不兼容提示/未知用量/进度通过 |
| `browser-short-1790960905830-e70bc8ff-d16d-4fc0-9af0-a3ac540912c1.json` | passed；真实临时STS900s首URL寿命871820ms，300秒提前续签；17:17:59及17:20:29两次自动source更新复用同3293d74b-ccf1-42d1-ac59-83895d6d0a17，第二次新Token且都保留2秒/暂停/ready4；退出source401，旧URL1byte206 |
| `browser-resume-1790961841929-b9b32c3a-7ad2-4f98-b44d-037353a94643.json` | passed；主控确认旧short API实际terminal0、新normal3600实际进程启动，再本人账号登录；仅GET恢复两视频/组标签及2秒进度，未新签名或云正文 |
| `backend-readonly-1790959879273-c3827e18-8104-41ee-b2e0-fd61ab6ad0bb.json` | 账号/TOTP/恢复摘要保留、v2 schema/ledger匹配、integrityok/fk0；2视频/2对象/2任务/2registered操作/4assets及组织快照恰一次；手工库保留 |
| `existing-public-sample-preserved.json` | 旧公开样例HEAD200/329035 bytes/videoMP4/bodyRead=false，不修改原样例/Bucket |

实际CORS核验：当前video不设置crossOrigin，native正常；额外fetchRange readable=false不是遗漏或成功证据，未为其放宽规则。未来跨域fetch/HEAD/最终网站Origin、安卓/内网/部署进入阶段3，本轮不代验。正常STS已恢复3600秒、上传目录恢复onlineVideo/originals/；只有2个授权视频对象保留，权限探针403无第三对象，没有清理或扩权。签名修复受影响15项协议/HTTP检查通过，最终全仓结果由主控汇总。

## 已准备的受控脚本

`acceptance/run.ts` 只通过已启动的本机真 API 调用，不直接加载长期 AK、不执行迁移/ACL/清理。先完成上表具体授权后在 `.local` 建立清单（不要提交）；会话文件仅包含本人当前 `{ "cookie": "…", "csrfToken": "…" }`，不是长期凭据。

```json
{
  "apiOrigin": "http://127.0.0.1:3000",
  "browserOrigin": "http://127.0.0.1:5173",
  "mediaOrigin": "https://oss.meetdawn.top",
  "authorizationReference": "填写用户明确授权的记录位置/时间",
  "databaseFile": "E:/onlineVideo/.local/data/video-library.db",
  "verifiedSchemaVersion": 2,
  "databaseBackupReference": ".local/backups/before-migration-1790950813946-71816f51-c74c-4667-a682-782f49db3d0d.db.verification.json",
  "sessionFile": "E:/onlineVideo/.local/acceptance/session.json",
  "sampleFile": "E:/onlineVideo/.local/acceptance/samples/ces-h264-aac-20261002.mp4",
  "sampleSha256": "f7083ce3ecc34bf2639622d4144f545022570e9601f5f9fc447257fc459d12a4",
  "verifyUploadedObjectPrivate": true,
  "categoryId": "填写本人活动分类ID",
  "groupIds": [],
  "tagIds": [],
  "uploadObjectPrefix": "onlineVideo/acceptance/local/20261002-ces-private/",
  "authorization": { "cloudWrites": false, "databaseWrites": false, "publicEgress": false, "privateObjectRead": false, "retainObjects": false, "newObjectPrivateAcl": false }
}
```

字段不能代替用户授权；当前示例故意缺授权会拒绝执行。脚本仅接受固定本机/HTTPS媒体目标、正式版本2及备份声明、指定SHA-256且1 byte～16MiB样例；六个授权字段（含只针对新对象的private ACL）全true且传`--execute`才可能发起请求。未带`--execute`只打印准备信息，不读取会话/视频、不联网。执行前本机API局部设置 `OSS_UPLOAD_OBJECT_PREFIX=onlineVideo/acceptance/local/20261002-ces-private/`，脚本先通过limits校验目录再发云请求；该参数只能服务端配置为根授权范围的子目录，默认业务仍 `onlineVideo/originals/`，不接受客户端任意Key。两样例分别使用单文件清单，各最多执行一次，累计至多2个新视频对象；已有私有对象模式需移除`verifyUploadedObjectPrivate`并填真实`privateVideoId`，不能同时声明。完整读取上限为授权样例大小，私有验证只读1字节Range。所有对象保留，下载按流计算SHA-256，输出没有完整签名URL/Token/Cookie。

```powershell
node --import tsx apps/api/src/modules/media/acceptance/run.ts .local/acceptance/manifest.json
# 只有具体授权、正式库/配置及材料全部就绪后，才允许由主控执行：
node --import tsx apps/api/src/modules/media/acceptance/run.ts .local/acceptance/manifest.json --execute
```

CLI结果不是完整P2-MEDIA-05验收：浏览器/CORS、撤销边界、应用重启、实际IAM读取STS不能Put及真实STS/OSS仍按上方步骤记录。真实FFprobe本机样例分析已完成；它不证明浏览器或实云播放成功，其它未知格式仍保持processing。

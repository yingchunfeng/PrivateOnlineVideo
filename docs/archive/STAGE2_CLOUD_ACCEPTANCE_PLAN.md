# 本轮真实OSS验收执行清单（已授权执行）

> **历史归档（2026-10-26）**：原位置 `docs/STAGE2_CLOUD_ACCEPTANCE_PLAN.md`。以下保留历史设计与完成记录，不作为当前任务指令；当前工作见[未完成工作清单](../task/UNFINISHED_WORK.md)，归档范围见[归档索引](README.md)。

日期：2026-10-02。用户已确认xzlbucket的Bucket ACL为公共读；现有Bucket ACL和原公开样例保留。用户随后明确回复“可以使用真实的OSS链路，已经提供了相关的授权”，已授权按本清单执行。实际证据写入STAGE2_INTEGRATION及.local/acceptance/run-20261002-ces-private，授权不扩展到本清单之外。

## 私有范围方案

应用完成新分片对象时发送 `x-oss-object-acl: private` 与 `x-oss-forbid-overwrite: true`，只影响新唯一对象，不调用PutBucketACL或修改既有对象。阿里云[CompleteMultipartUpload](https://help.aliyun.com/zh/oss/developer-reference/completemultipartupload)明确支持该请求头，权限表列oss:PutObject；[Object ACL](https://help.aliyun.com/zh/oss/user-guide/object-acl)说明独立Object ACL优先于Bucket ACL。

不根据文档推断现有角色已实际成功；本轮复用已有Get/Put/List角色，以STS会话Policy按read/upload/import用途收窄。若失败，安全停止并报告，不改为public/default，不扩大RAM或Bucket Policy。即使对象声明private，仍以匿名GET拒绝、有效STS/V4读取成功证明实际访问控制，避免其它Bucket Policy公开授权绕过。

## 唯一目标和费用范围

- Bucket/region：`xzlbucket / cn-hangzhou`；媒体源仅 `https://oss.meetdawn.top`，服务端上传显式公网杭州Endpoint。
- 新对象目录：`onlineVideo/acceptance/local/20261002-ces-private/`；服务端UUID生成key。该目录内至多2个视频新对象，保留不清理、不覆盖。
- 原片：`docs/ces.mp4`，329035字节，SHA-256 `dcda48cac1f42ff40775c03200af183a41c2fd067af08f3b4b3722df7fafba2a`；真分析为HEVC/AAC/unsupported，用于原片上传/下载和格式提示。
- 兼容副本：`.local/acceptance/samples/ces-h264-aac-20261002.mp4`，460063字节，SHA-256 `f7083ce3ecc34bf2639622d4144f545022570e9601f5f9fc447257fc459d12a4`；真分析为H264/AAC/ready，用于播放/Range/续签/下载。
- 两视频合计789098字节；另允许最多一个1字节、唯一命名的权限探针目标，仅验证read用途STS不能Put。若意外成功则报告并保留，不继续或清理。
- 公网范围：这两小样例的上传、HEAD、受控FFprobe、有限Range/播放/续签、各一次完整下载和受限目录List，预计下行数MiB。只测试短样例，不做大文件/长时云压力；请求与存储/下行按现有OSS计费，应用直连字节未知，不承诺费用硬封顶。
- SQLite业务范围：同一正式v2库和已有本人账号，使用现有未分类主类，新建一个“OSS本地验收20261002”分组及“验收原片20261002”“验收兼容20261002”标签，最多2条视频/上传/资产登记、观看进度及正常会话/授权审计；不重建账号或改旧数据。

## 真实执行与留证

具体授权后才将本机API的服务器上传子目录局部设为上面的run目录并开始真实本人会话；会话资料只放.local，完整签名URL/AK/Secret/Token/Cookie不进入日志或Git。

验证AssumeRole/Expiration用途缓存、流式上传/HEAD/重复完成与正确关联；新对象匿名拒绝/读取签名及Range成功，read STS Put拒绝、import STS限定List成功；浏览器直连媒体域名、兼容视频播放与暂停/位置续签、原片附件下载；退出拒绝后续签发、旧URL边界、未知用量及重启保留。源URL最长3600秒且受实际STS剩余有效期约束，不等待一小时才验证前端机制。

自动续签验证使用一次临时验收API进程请求900秒真实STS（不改变角色最大时长或根.env），源TTL仍最大3600并提前300秒刷新。用小样例等待真实renewAfter，证明同会话换源保留暂停/位置、较短实际sourceExpiresAt；完成后恢复普通3600秒配置。期间只有限读取/控制请求，不上传长视频或追加对象。

失败时保留已产生的对象、任务、分片和数据库记录，记录具体公共错误码/目标/时间；不修改Bucket ACL、原公开样例、RAM信任/授权策略、CORS、版本控制，不部署、不购买服务、不删除。

授权问题需明确包含本轮新对象private ACL、上述真实云读写/公网费用和业务数据库写入。此前正式库迁移授权与本地兼容副本授权分别成立，不自动扩展为本轮云操作授权。

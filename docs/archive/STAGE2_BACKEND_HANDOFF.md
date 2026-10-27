# 第二阶段后端交接

> **历史归档（2026-10-26）**：原位置 `docs/STAGE2_BACKEND_HANDOFF.md`。以下保留历史设计与完成记录，不作为当前任务指令；当前工作见[未完成工作清单](../task/UNFINISHED_WORK.md)，归档范围见[归档索引](README.md)。

日期：2026-10-02。P2-CORE-01～06后端交付完成：源码/隔离链、正式授权0002升级、受控两private对象真实STS/上传登记、浏览器直连/自动续签/下载/退出及API重启恢复均有独立证据。生产部署、最终网站HTTPS/安卓/杭州内网属于第三阶段，未执行。

正式目标固定 `E:/onlineVideo/.local/data/video-library.db`，授权升级后再只读核验25表、users=1、ledger=1/2、integrity=ok/fk=0；旧13业务表全部旧列SHA和计数保留，未重建账号。手工 `sqlite-test.db` 为24表、users=0、ledger为空，保留不动。不要执行account:init、重跑完整建表或改用空库。

迁移前主控只读原库backup并仅升级副本，历史报告 `.local/tests/stage2-upgrade-1790949083079-ce9c3a75-5040-4439-81b8-3e50535c6b51/report.json` 当时证明原库v1/副本v2、旧13表旧列/计数保留和重复幂等；不是正式升级证据。随后获用户具体授权，实际一致性备份 `.local/backups/before-migration-1790950813946-71816f51-c74c-4667-a682-782f49db3d0d.db` 与同名 `.db.verification.json` 证明正式v2/数据保留true/fk0/integrityok/手工库保留true。0002 SHA仍`ed502f9ad6854fc43178fc5ec37d65476bdb0475d151adbdd2a36c0bf42e151a`，报告不含凭证原值。

正式迁移方案已可审阅：保留0001哈希；执行新增0002（组织、对象、资产与上传关系、mode/source_expires_at/source_authorizations），仅 `DROP INDEX videos_owner_object` 替换旧key唯一索引，不删除表/数据。复合归属外键、全局完整对象身份、原片资产唯一、防改版本/重置核验约束生效。名称NFKC规范化冲突会回滚并报告，不自动清理。

用户具体授权后，主控已执行如下正式迁移命令：

```powershell
npm run db:migrate -w @online-video/api -- --database E:/onlineVideo/.local/data/video-library.db --apply
```

CLI先留SQLite一致性新快照，再immediate事务执行SQL/规范化/ledger/SHA/完整性；实际正式迁移与旧数据保留已经报告核验。恢复只允许验证备份后作为.local内新的独立目标，不覆盖原库；匹配auth.key单独保管。此次授权只涵盖已明确正式迁移，不包含新云写入、ACL/Policy调整或部署。

隔离应用装配：

```ts
const repositories = createRepositories(database, now);
const app = await buildApp({
  config, auth, logger: false,
  backend: { database, auth, config, now },
  media: {
    register: createMediaModule({ ...explicitMediaOptions, metadata }),
    dependencies: { kind: "test", config, auth, ...repositories, storage, sources, now }
  }
});
```

生产/开发使用 `await runtimeModules(config, authService, database)`，同一真实SQLite/AuthService + SDK工厂；driver显式mock仅开发proxy。生产拒绝测试依赖、Mock、缺资源控制、媒体HTTP、非HTTPS Origin及不安全Cookie。秘密路径受 `.local` 边界保护，上传STS和读取/导入用途分离且不回退长期AK签名。依赖复用现有ali-oss的STS导出，没有新增安装；用户根ali-oss/@types/multipart均保留，当前上传仍用既有原始分片协议。

资源配置见 `.env.example`：用户确认单文件2147483648字节、3应用播放会话、签名3600秒/提前300秒续签、Asia/Shanghai；实施参数8MiB分片、上传并发2、授权12次/分钟/账号（playback/renewal/download共享）、常规请求120/min、会话120秒、导入预览600秒/16份、STS3600/刷新300/安全余量30。受保护 `/api/settings/limits` 供前端获取真实上传/并发限额；没有把OSS未知字节作为每日预算。

业务路由：categories/groups/tags支持列表 `includeArchived=true`、创建/局部修改/归档恢复；videos支持标题/分类/逗号分隔groupIds/tagIds组合AND与多选全命中、默认page1/pageSize24/max100、编辑与进度。显式关联重复/归档/越界拒绝；标题单独修改保留旧归档关系。上传snapshot权威含title/categoryId/groupIds/tagIds；媒体续签返回完整PlaybackSession、heartbeat只id/videoId/mode/expiresAt；下载只接受videoId，不接受bucket/key/url。

旧key位置回填必须显式选择已核验导入预览单项并提供 `existingVideoId`；媒体调用 `bindLegacy`，仅owner/旧key精确匹配且完整对象verified时在事务绑定位置/分析。保留原视频id、标题、组织、createdAt及观看进度；不根据当前默认Bucket自动回填，不接受客户端key，已绑定不同身份拒绝，同身份重复幂等。普通导入不提供existingVideoId仍登记新记录；后端新增该场景隔离SQL检查，0002没有变化。

已验：API类型/build，主控最新完整API61/61通过（此前54项记录为历史）；后端SQL7项与数据库4项。主控真HTTP+SDK本机协议完整链覆盖组织/上传登记/筛选/3应用会话与第四拒绝、直连Range/同会话续签/下载、进度重启、退出后新授权拒绝而旧URL仍可用、proxy实际字节。真实portable FFprobe9.0.2现位于 `.local/tools/ffmpeg-9.0.2-stage2/ffprobe.exe`；实际分析原 `docs/ces.mp4` 329035字节为HEVC/AAC/unsupported，保留原文件，独立H264/AAC副本460063字节为ready。报告 `.local/acceptance/samples/analysis-20261002.json` 含两样例SHA/真实元数据和originalUnchanged=true。

实云授权与已验事实：authorization.json明确两新private对象/读写/公网/SQL业务范围；三用途STS3600秒与缓存、站内分片/FFprobe/唯一登记、匿名GET403/V4 Range206通过。原HEVC仍unsupported且可下载；兼容H264浏览器直接向OSS媒体HTTPS请求Range206、readyState4/真实尺寸、暂停2秒、原片/兼容完整下载SHA均通过。permission-result.json证明read STS尝试1字节Put被403拒绝、import限定run前缀List200且恰2对象/789098字节；未改既有Bucket ACL/RAM/CORS，对象保留。

后端独立只读核验JSON：`.local/acceptance/run-20261002-ces-private/backend-readonly-1790959879273-c3827e18-8104-41ee-b2e0-fd61ab6ad0bb.json`。正式v2/25表，users1/videos2/uploads2/group1/tags2/storage_objects2/video_assets4/upload_storage_objects2/storage_operations2；每视频恰一completed任务、一registered上传operation、原片/播放资产完整授权位置且verified，已登记分片唯一且大小一致，组织快照/资产/操作id及两结果报告逐字段匹配，schema列类型/ledger SHA正确、integrityok/fk0。原账号id/password_hash/totp_cipher等静态列与10条恢复码摘要/状态和迁移前一致性备份相等（报告只记true/count），授权登录计数/会话/审计与业务进度允许新增，不要求旧全表零变化；手工库仍users0/空ledger。本代理仅readonly SQLite，未写实际SQL或停止API。

最终重启后readonly报告 `.local/acceptance/run-20261002-ces-private/backend-readonly-1790961903448-a887bda3-b05c-4300-8e6e-004d5177d2ca.json` 再证同一formalv2/users1/videos2/2completed任务/2registered操作/完整关系与原账号静态资料和10恢复摘要保留、schema与ledger正确/integrityok/fk0/手工库不变。watch_progress为兼容视频**1条、positionSeconds=2**，原unsupported未新增观看记录。该时刻19授权（playback8/renewal8/download3）、实际字节/云统计时间null、活动应用会话0，全部源期限>签发且<=3600秒；正常readConfig恢复STS3600/refresh300/URL3600与上传onlineVideo/originals/。

实云浏览器报告：baseline-1790960761020证明原生video未设置crossOrigin可直连HTTPS Range、暂停/位置/附件SHA与未知用量UI；short-1790960905830证明真实900秒STS初URL871820ms、同一应用session3次授权，17:17:59自动续签，17:20:29第二次实际STS刷新（token变化仅记true），换源后暂停2秒/readyState4，logout续签401而旧URL一字节Range206；resume-1790961841929在正常API重启后仅GET证明库/组织/格式/2秒进度恢复。三份均status=passed，无Cookie发送到OSS，不存完整签名URL。

边界准确分列：当前应用原生video不使用crossOrigin，真实播放/Range/续签/下载已验；额外跨域fetch读取Range响应因CORS/浏览器策略不可读，这个附加检查不等于当前原生播放器失败，不宣称通用fetch/HEAD规则已验，未自动改CORS。后续若引入crossOrigin/fetch/HEAD或最终网站Origin，需按实际请求明确规则和权限差异另验。最终网站HTTPS、真实安卓后台/系统行为、杭州服务器内网和部署运维属于第三阶段；当前开发回环页面与受控实云结论不替代这些证据。退出拒绝新授权，不能立即收回已发URL；应用并发/次数不等于OSS连接数/字节费用封顶。

# 第二阶段主控验收记录

日期：2026-10-02。阶段依据：[STAGE2](task/STAGE2.md)、[本地 OSS 准备](OSS_LOCAL_TEST_PLAN.md)。

最新结论：第二阶段代码、授权正式迁移和本机真实STS/OSS完整链已验；三个任务板收尾事实以[完成审计](STAGE2_COMPLETION_AUDIT.md)为准。以下保留实施过程记录，较早的TODO/待授权/临时配置不代表当前状态。网站HTTPS/安卓/杭州内网及附加fetch CORS场景准确留第三阶段。

已启动三个子代理，按后端、媒体、前端任务板推进。公共契约和迁移由后端代理先冻结，再交接媒体与前端。现有正式库、手工库和本人账号保留；本轮隔离测试使用新目标，不自动执行正式迁移、真实云写入或权限变更。

## 基线

主控在开发初始状态运行 `npm run check`，类型检查、API 40 项测试、前端 8 项测试和三个工作区构建均通过。此结果是第一阶段基线，不是新功能验收。

## 验收层次

| 层次 | 证明范围 | 当前证据 |
| --- | --- | --- |
| 代码与类型 | DTO、接口、两种显式模式可编译 | 主控最终npm run check通过：API59项/前端14项、三包typecheck/build；diff --check及UTF-8无BOM检查通过 |
| 隔离真 SQL | 0002、旧数据保留、组织/资产/原子登记、重启 | 有序升级/回滚/25表SQL-Drizzle一致/完整身份唯一/原子登记/重启/旧key显式绑定保留均通过 |
| 隔离真 HTTP | 真 AuthGuard、上传/筛选/进度、直连授权/续签/下载、proxy 回归 | 主控独立全链通过：8MiB+7字节两片上传、唯一登记和关联、全命中筛选、3播放并发与第4拒签、同会话续签、原片附件、未知直连字节、进度/编辑/登录重启保留、退出续签401而旧URL206、proxy实际8字节 |
| 本地 OSS 协议服务 | 真实 ali-oss SDK、流式 Multipart、V4、到期/Range | 主控独立协议烟测1项通过：Multipart、独立HMAC校验、匿名/篡改/错方法拒绝、206 Range与附件响应；完整应用链仍待验证，不代替阿里云 |
| 浏览器 | 手机布局、源校验、换源恢复、下载、生产隔离 | 前端7个真HTTP子场景/7个Mock子场景、production检查通过；320px/横屏/150%长中文、101候选分页导入、旧key显式绑定、续传错文件/暂停、短TTL源恢复/403有限重试有证据，不代替实云/安卓真机 |
| 正式库升级 | 默认 `.local/data/video-library.db` 的版本2、原账号/历史保留 | 用户明确授权后已生成新一致性备份并正式升级；ledger=2、本人账号1条，旧表原列逐项比对不变，完整性/外键通过；手工库保留 |
| 真实 STS/OSS | 本机上传、私有对象匿名拒绝/签名读取、Range/续签/下载 | 未执行；P2-MEDIA-05 保持待验 |

## 操作边界

真实云验收前列出一个唯一的新对象前缀、小样例文件及大小、最多读写/下载范围、公网费用影响、对象保留清单和私有权限依据。公开读样例只证明已有 HTTPS/传输准备。失败对象和 Multipart 保留，不自动清理，不改 ACL、Policy 或版本控制。

用户已确认单文件上限 2GB（本轮明确按 2 × 1024³ = 2147483648 字节）、最多3个应用播放会话、`Asia/Shanghai`、签名最长3600秒并提前300秒刷新，其余参数授权由开发决定。采用8 MiB分片、最多2片并发上传、每账号每分钟12次源/下载签名授权；一般媒体请求120次/分钟、应用会话120秒（心跳续期）、导入预览10分钟且最多16份。签名实际期限仍取STS剩余期限减30秒安全余量，较短期限按后端真实 `renewAfter` 刷新。测试值只用于隔离测试。真实 `.env` 不进入 Git，也不覆盖已有配置。

启动与调试说明见 [LOCAL_DEVELOPMENT](LOCAL_DEVELOPMENT.md)。后续实际检查结果和任务映射由主控在本页与 [TASKS](task/TASKS.md) 回写。

## 正式库副本验证

主控运行 `node --import tsx apps/api/scripts/stage2-verify-upgrade.ts`。脚本以只读连接打开正式库，通过SQLite backup生成唯一新目标，再在第二份副本执行0002；没有迁移原库。

- 保留位置：`.local/tests/stage2-upgrade-1790949083079-ce9c3a75-5040-4439-81b8-3e50535c6b51/` 下的 `before-migration.db`、`upgraded-copy.db`、`report.json`。
- 原库ledger=1、副本ledger=2；副本所有旧表原列的内容及行数逐项比对不变，包含本人账号1条、登录会话1条和恢复摘要10条。
- 原0001规范LF校验 `b2f9606329c23ed3b94d175842450f50989f4eada73c0d5b1f4602d7d5e7a92e` 保留；0002校验 `ed502f9ad6854fc43178fc5ec37d65476bdb0475d151adbdd2a36c0bf42e151a`。
- 重复迁移幂等，`integrity_check=ok`、`foreign_key_check=[]`；源库数据和ledger仍不变，未输出密码/TOTP/Cookie/恢复摘要。

## 本地样例与配置

用户提供 `E:/onlineVideo/docs/ces.mp4`，实际大小329035字节。已下载FFmpeg官方列出的Gyan Windows 9.0.2便携包，仅提取FFprobe/许可证/README到 `.local/tools/ffmpeg-9.0.2-stage2/`，不改系统PATH。当前源直接获取的归档SHA-256为 `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`，与完整GitHub作者镜像归档一致；Exa缓存抓取的旧hash曾不符，核验当前源后才解压执行。未完成下载文件保留。

直接读取与真实 `FFprobeMetadataInspector` 经一次性loopback Range探针均分析成功：`status=unsupported`、`playable=false`、`codec=hevc/aac`、5.909688秒、592×1280。该样例可用于原片上传/下载与不兼容提示，不能用于证明当前H264兼容播放；可另提供H264样例或生成单独兼容副本。实际受限探针/参数已验证，根`.env`局部新增FFPROBE_PATH。

用户随后明确选择生成独立兼容副本，已用同一校验归档内FFmpeg的 `-n` 创建 `.local/acceptance/samples/ces-h264-aac-20261002.mp4`，460063字节，SHA-256 `f7083ce3ecc34bf2639622d4144f545022570e9601f5f9fc447257fc459d12a4`。真实受控Range分析器输出ready/h264-aac/Main/yuv420p/5.909688秒/592×1280；原片SHA复核不变。两样例的分析报告为 `.local/acceptance/samples/analysis-20261002.json`。仅处理本地验收样例，没有增加自动转码、上传或云服务。

主控只在确认根 `.env` 不存在后新建，写入已确认资源参数、固定HTTPS媒体域名及受保护秘密文件路径，不读取/复制密钥。前端仅使用公开 `VITE_MEDIA_ORIGIN` / `VITE_MEDIA_PREFIX`。`readConfig`已实际验证全部用户资源参数；正式库现已按具体授权升级，不通过重新初始化账号绕过版本校验。

主控随后只读加载现有账号密钥、OSS/ARN文件，完成真实配置/正式v2库/AuthService及媒体factory装配烟测：health200、未登录me401，未初始化账号、未写登录业务记录、未调用AssumeRole或任何云端请求；没有输出实际秘密。

## 正式升级实际结果

用户回复“授权备份并升级该正式库”后，主控执行了已审阅的 `db:migrate` 命令，返回成功。

- 一致性备份：`.local/backups/before-migration-1790950813946-71816f51-c74c-4667-a682-782f49db3d0d.db`。
- 验证报告：同目录同名 `.db.verification.json`，由 `apps/api/scripts/stage2-verify-formal.ts` 以只读连接比对产生。
- 正式ledger与源码0001/0002 SHA一致，版本2；旧13业务表的全部原列和行数与备份逐项相同，本人账号仍1条。
- `integrity_check=ok`、外键违规0；手工 `sqlite-test.db` 的账号/ledger仍为空，未执行迁移或建表。
- 该授权仅用于正式库升级，真实STS/OSS写入、ACL/Policy/CORS修改及部署未执行。

用户对私有验收材料的最新回复为“目前是公共读，是需要提供一个拒绝访问的路径吗”。主控已解释必须是真实存在且确认私有的对象，404不能证明授权；现正确认公共读源于Bucket还是单对象，再形成仅影响新验收对象的方案。此前公共样例保持不动，权限没有变更。

## 前端发布产物

独立新目录为 `apps/web/dist/stage2-release-2026-10-02T14-21-08-138Z/`，主控再次核验manifest中3个HTML/JS/CSS的SHA-256及完整发布文件无开发Mock/长期凭据/数据库/Node引用。旧dist和此前测试产物按用户规则全部保留；第三阶段只发布此独立目录，不将旧产物目录混入。

前端最终浏览器日志：`apps/web/qa/stage2-browser-final-2026-10-02T14-20.log`，截图：`apps/web/qa/stage2-2026-10-02T14-20-00-951Z/`；主控已视检库/直连播放器/未知用量界面。WEB04保持DOING，长视频长时/真实后台恢复/实云短剩余STS和CORS仍待证据；P2-MEDIA05仍TODO，不能宣称整阶段实云完成。

## Bucket公共读后的补强

用户明确确认Bucket ACL公共读后，媒体适配器完成新唯一对象时固定private Object ACL，不调用Bucket/既有对象ACL接口；仅pending未固定版本对象可进入完成，403不回退或扩权。受控CLI新增上传后私有校验模式与明确newObjectPrivateAcl授权门，匿名成功则停止后续读取/播放，保留对象和记录。

主控冻结后再次运行完整API测试：61/61通过，包含新增private SDK头/403失败/旧public保留、CLI模式互斥/授权门和匿名200停止测试；类型/构建由媒体再次通过。早期未冻结新测试有一次字段计数把unsigned尾部匹配为signed，改为完整字段边界后该项及完整61项均通过，没有放宽预期。前端14项及独立生产发布目录仍有效，前端源码未因该服务端补强改变。

实际待执行范围见 [STAGE2_CLOUD_ACCEPTANCE_PLAN](STAGE2_CLOUD_ACCEPTANCE_PLAN.md)。主控已请求本轮两小视频新对象private ACL、一个最多1字节拒写探针、业务登记及公网费用授权；未收到明确确认前无真实STS/云读写。Bucket及既有公开样例保持当前状态。

## 后续本地长视频验证

继续按WEB04的原验收范围补证据，实云授权仍待回复。主控在全新 `.local/tests/stage2-long-media-20261002/` 内生成一个1小时低帧率H264无音轨测试文件，不修改原片或兼容小样例；6411947字节、SHA-256 `b86cce252443acfa9eba1bec72b85db8ac6ef403e0617d432260ff0fbbd0ed3c`。真实受控FFprobe输出ready/h264/3600秒/148×320，报告 `analysis.json`；该长文件只用于本地隔离测试，不在已提出的实云小样例上传范围内。

真实长视频验证已完成：原生video.duration=3600，1800/3590秒seek已完成、seeking=false/readyState=4。实际中/尾请求与响应范围为 `3211264-6411946/6411947`、`6356992-6411946/6411947`，只缓冲开头约45秒和尾部3570～3599秒，未全量fetch/blob。该文件低帧率/约6.4MB，不能冒充真实大文件内存或持续1小时观看验收。

修复前48.012秒真实复现：12秒源多次续签、心跳0、SQL应用期限未延长，45秒应用会话过期后source403。最小修复以稳定session.id建立独立20秒心跳，handler读取当前ref；续签不重置心跳，也不由心跳签发源。修复后48.014秒心跳2次，SQL到期从15:36:01.954延长至15:36:42.018，源续签全200。延迟一份真实source响应6秒跨心跳，客户端单调保留已确认的较晚应用期限，不改源/STS期限。

真实浏览器Page frozen→active暂停14秒后，8秒应用会话source403提示重新准备并恢复3590秒位置，登录保持；真登录撤销后的冻结恢复返回统一401并验证同session/source401。该证据属于真实浏览器页面生命周期，不等同于原生隐藏标签页或安卓后台：本机独立屏幕外双tab/最小化探测仍报visible，已停止试验且明确SKIP，没有伪造Document属性。

最新日志 `apps/web/qa/stage2-long-final-2026-10-02.log`：长验证5子场景+parent通过（TAP pass6/fail0/skip1），约97.55秒；JSON/截图 `apps/web/qa/stage2-long-2026-10-02T15-35-09-922Z/`，修复前证据在15-24-57目录。旧短真HTTP7、proxyMock7、前端14单元、typecheck、production与新独立发布全目录扫描再次通过；主控读取日志/JSON并独立复核typecheck/新发布SHA，API源码未改未重复无关测试。

当前应使用 `apps/web/dist/stage2-release-2026-10-02T15-40-47-545Z/`；JS325834字节、SHA-256 `d22c39e0283583f15d96771d560331da2d702dd85730394a02a2635bba1bdab6`，其3个HTML/JS/CSS文件已由主控核对manifest和隔离标记。旧发布目录全部保留，当前交付以本次新目录为准。整阶段仍待实云授权/验证；WEB04维持DOING，不能以本轮本地补验标整体完成。

## 授权后的真实链路进展

用户明确回复“可以使用真实的OSS链路，已经提供了相关的授权”后，主控按已审阅清单开始实际执行，仅同一独立前缀/两小样例/最多1字节权限探针。授权记录为 `.local/acceptance/run-20261002-ces-private/authorization.json`，根.env只局部新增服务器上传子目录，已有账号不初始化。

- 真实AssumeRole：read/upload/import各请求3600秒成功，同用途二次请求命中缓存，凭据带实际Expiration；报告只记录用途/到期/次数，不包含AK/Secret/Token。预检未写对象或变更权限。
- 真实本人登录200/HttpOnly Cookie，短期会话只存.local。两个样例通过站内原始分片/上传身份STS写入OSS、HEAD与真实FFprobe、SQL原子登记及重复complete幂等。
- 原片：video `85376723-c12f-4e34-bf5e-0b711bb8a287`、upload `4f59ce50-1757-47b9-a005-71f31a47e692`，329035字节、HEVC/AAC、unsupported；唯一对象 `onlineVideo/acceptance/local/20261002-ces-private/1da039d7-e1b2-400d-9c43-bf89db59d5c7`。
- 兼容副本：video `cf7c94ce-1911-45cb-9670-cacd5878365f`、upload `3be34397-43ff-4dba-93c0-741b018eb9a1`，460063字节、H264/AAC、ready；唯一对象 `onlineVideo/acceptance/local/20261002-ces-private/5f2efb09-29bc-4924-9c3f-36867575292d`。
- 两新对象仅Complete设置private，匿名GET Range=403，STS/V4签名GET Range=206，Content-Range/1字节正确。原片完整附件下载SHA与本地文件一致；兼容副本完整下载保留给浏览器验收，未提前标通过。
- 正式库有2video/2upload/1分组/2标签/2完整对象/4资产/2registered操作；旧账号静态密码/TOTP列与恢复摘要保留，外键0/完整性ok。用量仍oss_direct/null/not_synced，没有伪造云字节。

此刻仍进行读取STS不能Put、限定List、浏览器播放/真实到期自动续签/附件及重启撤销验证；失败保持对象记录、不扩权限。原Bucket ACL、原公开样例、RAM/CORS/版本控制未改，尚不能把两对象上传通过等同完整P2-MEDIA05完成。

真实权限补验：read Get-only STS向一次性1字节探针Key写入返回403（requestId `6ABFE123CBC3093030CF182A`），未产生探针对象；import用途仅列本次前缀成功200（requestId `6ABFE123CBC30930302C192A`），恰2视频/789098字节。唯一intent/结果保留，未重试写探针或清理；permission-result.json记录无秘密的Policy摘要/Expiration。

浏览器曾遇到 `net::ERR_BLOCKED_BY_ORB`，最小诊断证明是播放签名携带不受OSS支持的response-content-type参数，实际400 XML `InvalidRequest: Can not override response header on content-type`（req `6ABFE320A5F05D3038807A4D`）。按官方GetObject响应覆盖白名单移除此query，保留inline，未改对象元数据/ACL/CORS或新增对象。本地协议替身加入相同拒绝规则，受影响媒体/独立HTTP15项通过；真实新签名返回206/inline/application-octet-stream（req `6ABFE4296E92FC3539B36414`）。

修正后真实浏览器baseline通过：视频duration5.909688/592×1280/position2/paused/ready4；媒体请求直接到OSS HTTPS，Range206/Content-Range正确、未发送站点Cookie，实际附件下载460063字节SHA正确，进度2秒入SQL，未知用量页正常。兼容附件保留新.local文件，完整下载reservation已消费，不重复完整下载。安全报告 `browser-baseline-1790960761020-c6d6cbd7-bf31-4e88-b413-32cf62d82071.json`，截图QA17-06-01。

额外浏览器credentials=omit跨域fetch Range0-0未获可读响应，原生video（未设crossOrigin）播放正常。只说明当前原生播放需求已验、额外跨域fetch/HEAD场景CORS未通过；未修改云规则，不把两者混为播放失败或宣称全CORS场景通过。既有公开样例本轮匿名HEAD仍200/video-mp4/329035字节，未读取正文。

当前仅临时验收API进程请求900秒真实STS，source上限3600/提前300刷新保持，根.env仍3600。短phase实测等待renewAfter约17:17:59 UTC及下一次角色刷新，paused位置2/同会话、有限GET/Range；报告 `browser-short-1790960905830-e70bc8ff-d16d-4fc0-9af0-a3ac540912c1.json`。进程活跃时按同句柄观察，不因等待超时重启；等待完成后恢复normal配置并补重启/退出边界证据。

实际收尾：short报告passed，17:17:59.195首次自动续签、17:20:29.498第二次真实角色刷新（仅tokenChanged=true，无Token记录），全程同会话/暂停位置2/ready4；退出后source401，已发URL一字节Range206。short进程已正常退出，正常3600配置及上传originals目录恢复，normal新API进程后新本人会话resume报告passed（库/组织/两视频/进度2秒，仅GET、无媒体/新授权）。最后验收专用会话logout200，自有服务均优雅关闭。

最终主控npm run check成功：API62/前端14、类型/构建均通过；当前独立前端发布目录15-40 SHA与源码构建一致，原对象/数据/所有产物保留。保留对象仍仅两个视频789098字节，拒写探针403没有第三对象。完成证据/命令/第三阶段待验边界见完成审计，不将额外fetch CORS不可读写成已通过。

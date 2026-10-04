# 第二阶段子代理 2：OSS 对象登记、上传与视频真实接入

日期：2026-10-02。状态：P2-MEDIA-01～05完成。授权范围内真实3用途STS、2视频流式上传/原子登记、私有匿名拒绝/V4 Range、原片与兼容下载、浏览器播放/真实自动续签、退出边界及实际进程重启持久化已验。Bucket公共读/原公开样例/本人账号与既有数据保留；CORS核验限当前未设crossOrigin的native video，跨域fetch不可读已记录且未改云规则，安卓/内网/部署归阶段3。

## 0. 模块设计/数据库文件清单

- 入口：[STAGE2](../../../docs/task/STAGE2.md)、[架构评审](../../../docs/task/STAGE2_ARCHITECTURE_REVIEW.md)、[用户准备记录](../../../docs/task/OSS和框架调整相关.md)；契约：[阶段提案](../../../docs/STAGE2_API_CONTRACT.md)、[当前API](../../../docs/API_CONTRACT.md)。
- OSS材料/SDK：[OSS_SETUP](../../../docs/OSS_SETUP.md)；SQL设计：[SQL说明](../../../docs/sql/README.md)。
- [本地真实OSS验收](../../../docs/OSS_LOCAL_TEST_PLAN.md)是P2-MEDIA-05交付依据；服务器/杭州内网和最终域名安卓验收交给[第三阶段](../../../docs/task/STAGE3.md)，不以仅写代码替代本机实云。
- [自定义策略JSON](../../../docs/task/自定义策略的json.txt)含GetObject/PutObject及受onlineVideo前缀限制的ListObjects；用户确认绑定RAM用户和角色。优先同角色STS按用途收窄，不另建角色；信任/权限实效仍待受控实云验证。
- 已有media代码/HANDOFF及测试完整保留；AuthGuard/真SQL Repo/配置与入口由代理1维护。已冻结新契约并接入媒体，真SQL+真AuthGuard+本地OSS协议已验，不作为实云通过。
- 当前媒体交接：[HANDOFF](../../../apps/api/src/modules/media/HANDOFF.md#7-第二阶段交接2026-10-02)；实云范围/受控CLI：[OSS_ACCEPTANCE](../../../apps/api/src/modules/media/OSS_ACCEPTANCE.md)、`apps/api/src/modules/media/acceptance/run.ts`。
- 可写：apps/api/src/modules/media/**、apps/api/test/stage2-media.test.ts/自有测试目录、本任务板及media内交接。只提公共接口/依赖需求，不改db/schema/共享类型/根锁/API入口/apps/web。
- 新表/对象/组织登记由代理1实现；媒体只依赖冻结的Repository/事务接口，不自行编写另一套SQL。

## 1. 默认协作规则

- 先读所有依据与本卡，使用UTF-8无BOM、最小修改。冻结前准备设计/Fake，收到P2-CORE-01交接再依赖新版接口。
- SDK使用Node.js ali-oss、V4，当前锁定6.23.0；升级依赖需主控/代理1串行处理，不安装Python SDK或前端直传SDK。
- 每个敏感请求依赖真AuthGuard，写请求CSRF/来源；播放/下载返回限定DB对象的STS/V4签名URL，长期AK/AccessKeySecret/完整STS凭据不返回前端；签名失败不能降为长期AK签名或匿名URL。
- 用户已确认Bucket公共读。新唯一对象完成代码固定private ACL头，仅本轮新对象，不改Bucket/原公开样例/已有对象、不扩RAM；实际发送新对象ACL及云读写仍需本轮具体授权，真实效果由匿名拒绝/签名成功验证。
- 云读写和权限策略变更需具体材料与用户授权；无环境时用隔离依赖推进代码，真实OSS验收单列TODO，不假报DONE。
- 不删除对象/分片、覆盖原片、改ACL/版本控制或购买服务；本阶段OSS直连、不部署。媒体HTTPS和公开样例HEAD/TLS已验，样例公共读原因已确认；本人私有业务另选对象验收签名，网站证书属阶段3，只回写自己的看板。

## 2. 任务总览

| ID | 状态 | 任务 | 依赖 |
| --- | --- | --- | --- |
| P2-MEDIA-01 | DONE | 对象定位、双用途Client及STS缓存 | P2-CORE-01；OSS_SETUP/评审 |
| P2-MEDIA-02 | DONE | 上传组织快照与原子登记/失败恢复 | P2-CORE-02；P2-MEDIA-01 |
| P2-MEDIA-03 | DONE | STS/V4直连播放、续签与下载授权 | P2-CORE-01；P2-MEDIA-01；联调依赖CORE-04/05 |
| P2-MEDIA-04 | DONE | 已有对象导入、版本/格式/封面补强 | P2-MEDIA-01/02；P2-CORE-03 |
| P2-MEDIA-05 | DONE | 授权真实OSS验收及模块交接 | 材料/授权/环境就绪；前四卡 |

## 3. 任务卡

### P2-MEDIA-01：对象定位、双用途Client及STS缓存

- 状态：DONE
- 优先级：P0
- 需求描述：数据库中的Bucket/地域/key/版本可靠定位到指定对象，不能只有可过期URL。
- 实现要求：按冻结对象身份限定xzlbucket/cn-hangzhou/onlineVideo范围，业务region规范化为SDK oss-cn-hangzhou。上传/HEAD/导入client读取OSS_ENDPOINT（本地显式公网、部署内网），签名client读取固定OSS_PLAYBACK_ENDPOINT/cname:true/V4。通过受保护AK+角色ARN调用AssumeRole，按Expiration缓存/提前刷新/并发合并，缓存键含角色+用途+Policy；用户确认角色已有Get/Put/List，优先上传/导入与读取签名复用角色并以会话Policy收窄，读取仅GetObject。角色信任与权限实效单独验收，STS失败不长期AK签名回退。未开版本控制则versionId=null、唯一Key仍受保护；只日志Endpoint，不日志凭据/完整URL，I/O取消不能互相影响。
- 计划变更范围：media/storage与自有测试。
- 验收条件：SDK到本地协议服务验证V4/Multipart/取消、STS刷新并发/过期失败与用途缓存隔离；上传端点切换不改变签名域名，更换默认Bucket不读取错历史对象。收窄为GetObject的读取STS不能上传，HTTP媒体域名不能作为生产配置，实云未验不能写已验。
- 影响范围：完整对象身份、上传/读取/导入用途和独立签名域名；保留显式proxy。
- 实际变更文件：`apps/api/src/modules/media/storage/{oss,sts,signing}.ts`、`apps/api/src/modules/media/index.ts`、`apps/api/test/stage2-media.test.ts`、`apps/api/test/media/storage.test.ts`。
- 完成说明：完整provider/Bucket/region/key/version验证、SDK地域oss-cn-hangzhou；长期AK仅AssumeRole，缓存按角色+用途+Policy隔离且合并刷新/Expiration/取消安全；读取Policy只有GetObject，上传有PutObject，导入含限定ListObjects。真STS SDK到本地协议及真V4 GET/CNAME/Range/下载已验，错历史Bucket/legacy/pending/版本拒绝；HTTP正式签名配置拒绝。实际IAM读取STS不能Put及角色信任仍在05实云核验，不把Policy单测冒充云权限通过。
- 完成时间：2026-10-02（代码/隔离验证）
- 阻塞原因：

### P2-MEDIA-02：上传组织快照与原子登记/失败恢复

- 状态：DONE
- 优先级：P0
- 需求描述：上传后的视频在DB中同时具有对象位置、主分类、分组和标签。
- 实现要求：保留现有创建任务/逐片SHA-256/流式uploadPart/complete续传协议，仍是浏览器→服务器→OSS，不因安装multipart插件重写。高层multipartUpload不接收一次性请求文件流；新增form-data入口如确有需要须与现协议兼容，不整文件缓冲/落盘。创建先校验并持久化全部组织；OSS完成及HEAD核验后由finishRegistration事务完成video/assets/组标签/任务/操作日志。用具有PutObject权限的上传身份，云完成库失败幂等重试，不自动删除或覆盖原片，versionId=null时仍校验唯一Key。
- 计划变更范围：media/upload、对象登记接入/测试。
- 验收条件：错分类/组/标签、同名文件/错误分片、断开、重启、归档选择、完整性、重复complete与云完成库失败均有明确状态；最终恰好一条视频和正确关联。
- 影响范围：上传创建/分片/完成协议、组织快照、对象操作日志及SQL原子登记。
- 实际变更文件：`apps/api/src/modules/media/{context.ts,options.ts,upload/routes.ts,upload/video.ts}`、`apps/api/test/stage2-media.test.ts`。
- 完成说明：创建先验证全部组织并持久化任务/对象/操作意图，首PUT才初始化云分片，初始化失败保留可见任务重试；逐片SHA-256/流式Multipart/唯一Key/断线续传保留。对象完成+两次HEAD/分析后调用finishRegistration事务；归档/错误组织拒绝，云完成库失败保持failed重试，不删对象/分片。新对象Complete固定private+forbid头，已verified/非null版本拒绝本次完成，403不回退或扩权；真SDK协议新头/原public对象保留通过，未调用ACL修改API。阶段2现12项新测试含初始化/登记失败、归档及快照；主控真HTTP+真SQL+真AuthGuard+本地协议8MiB两片唯一视频/资产/组标签/重复complete/重启通过。服务器可配置授权子目录uploadObjectPrefix，默认原片目录不变。新对象private实云实效与授权仍归05。
- 完成时间：2026-10-02（代码/隔离验证）
- 阻塞原因：

### P2-MEDIA-03：STS/V4直连播放、续签与下载授权

- 状态：DONE
- 优先级：P0
- 需求描述：真账号与DB对象控制签名发放，浏览器直接向OSS读取视频，不经过轻量服务器传输视频正文。
- 实现要求：按videoId查owner/视频状态/已验证资产，创建应用播放会话并通过signatureUrlV4('GET',...)发放STS签名；期限上限3600秒、实际sourceExpiresAt不超过STS到期减安全余量，返回renewAfter。新增同会话source续签，重新查登录/归属/会话，不重复占并发槽；下载授权选择DB原片并签名Content-Disposition。发放/心跳/关闭/续签限频与审计不含完整URL。退出/撤销拒绝新授权，明确已发URL有效期内仍可使用；并发只约束应用会话，实际字节未知。proxy Range/206/416/预留结算保留显式回归，oss不自动回退代理。封面可继续受保护站内小流量读取。
- 计划变更范围：playback/签名提供者/metering/limits、自有测试。
- 验收条件：真SQLite+AuthGuard+本地OSS协议服务验证签发、续签/下载、过期和Range；签名V4与CNAME正确、视频正文不经过API。错owner/任意Key/撤销后续签拒绝；旧URL有效期边界、短剩余STS、并发槽复用与未知用量有独立证据，proxy旧测试保留。
- 影响范围：播放会话/同会话source续签/原片下载/分模式用量；oss不提供代理视频正文。
- 实际变更文件：`apps/api/src/modules/media/playback/routes.ts`、`apps/api/src/modules/media/storage/signing.ts`、`apps/api/test/stage2-media.test.ts`。
- 完成说明：只对DB已验证对象发read STS/V4 GET，固定CNAME，播放签inline保留对象实际Content-Type、下载附件安全文件名；实云发现response-content-type非法后已去掉该query，不覆改2个已上传对象元数据。最大3600秒且不超STS到期减30秒，正常过期前300秒续签，短STS用剩余期限一半避免循环。新播放3个槽，第4个在sign前拒绝，续签复用槽、下载不占槽；按owner签发/续签/下载共12/min并SQL审计，心跳仅会话到期。真HTTP+SQL+AuthGuard+独立V4协议验证直接206、续签/下载、退出新授权401/旧URL仍206、未知字节及重启；23项proxy旧检查保留，代理字节回归通过。新增GetObject参数白名单协议回归避免Fake纵容非法query，真实浏览器修复后证据到05补验。
- 完成时间：2026-10-02（代码/隔离验证）
- 阻塞原因：

### P2-MEDIA-04：已有对象导入、版本/格式/封面补强

- 状态：DONE
- 优先级：P0
- 需求描述：已有OSS视频也可登记到本人选定的分类/分组/标签并保留真实位置。
- 实现要求：受控前缀/分页cursor与预览ID，commit重新检查存在/size/ETag/版本/全部组织；不全Bucket扫描、不移动原文件。按完整对象身份幂等，明确旧key位置回填；FFprobe真实可用时核验兼容原片/竖视频，未知保持null/processing。不兼容有离线新副本流程，封面无则null，原片不覆盖。
- 计划变更范围：media/import/metadata、测试与media交接。
- 验收条件：越界、假条目、分页变更/过期、被替换/版本错对象、重复导入和空标签均一致；真实FFprobe/手机样例与受控探针分别记验。
- 影响范围：授权前缀分页预览/选中导入、完整对象与版本快照、真实组织关联。
- 实际变更文件：`apps/api/src/modules/media/import/routes.ts`、`apps/api/test/stage2-media.test.ts`、`apps/api/src/modules/media/HANDOFF.md`。
- 完成说明：每页独立previewId/条目ID，随机不透明cursor绑定owner/login/prefix/TTL且有界，最多100项不全Bucket扫描；预览HEAD固定size/ETag/version，commit全部复核/分析后再次校验组织和对象，完整身份幂等登记/日志。分页篡改/跨登录/前缀/过期、假条目、替换/版本、空标签、归档及真SQLite单视频/2资产/关联/日志通过。单选preview+existingVideoId显式绑定旧位置，owner/旧original.key精确校验，bindLegacy事务保留旧id/title/分类/组标签/进度/createdAt，原旧副本位置不猜、用本次已核验原片；错key/错owner/多选拒绝、同身份重复幂等且旧归档关联保留已验证。追加真实FFprobe9.0.2受控Range探针证据：原片ces.mp4 unsupported HEVC/AAC 329035 bytes；用户选择生成的独立副本ready H264/AAC 460063 bytes，均5.909688秒/592×1280，原片SHA-256未变（analysis-20261002.json）。受控探针与真实工具分列，未知其它内容仍processing/null封面，手机浏览器/实云播放未验。
- 完成时间：2026-10-02（代码/隔离验证及真实FFprobe本机样例）
- 阻塞原因：

### P2-MEDIA-05：授权真实OSS验收及模块交接

- 状态：DONE
- 优先级：P0
- 需求描述：第二阶段在本机实际连接真实STS/OSS，交付上传→登记→直连/续签/下载证据，不能仅以本地Fake完成代替。
- 实现要求：读最新启动清单：OSS证书已生效、样例公共读，HEAD=200无需重复排查。确认本人视频/新上传私有范围，另选私有对象验收匿名拒绝/有效签名成功，公共样例只用于HTTPS/格式/Range参考。核验角色信任/AssumeRole、Get/Put/List、CORS/版本状态及具体小样例费用/范围，授权后受控STS/V4/续签/下载及唯一新对象上传登记，保留不清理，不自动改权限。既有媒体证书不重申，网站/杭州内网/安卓属阶段3。
- 计划变更范围：自有验收脚本、测试、media/HANDOFF、任务板。
- 验收条件：本机公网Endpoint+真实账号/SQLite+真实STS/OSS上传、匿名拒绝/签名读取、Range/续签/下载有目标/授权/输出，按OSS_LOCAL_TEST_PLAN记录。既有HEAD/TLS仅算域名证书证据，不代替完整链；卡未验仍TODO，代码可先推进。杭州内网/部署真机属阶段3，无删除或未授权ACL变更/隐式回退。
- 影响范围：已授权本机真实STS/OSS小样例链、同正式v2库2视频登记；Bucket/既有对象/RAM/权限策略不变。
- 实际变更文件：`apps/api/src/modules/media/OSS_ACCEPTANCE.md`、`apps/api/src/modules/media/acceptance/{run,permission-probe}.ts`、`apps/api/src/modules/media/HANDOFF.md`、`apps/api/test/stage2-media.test.ts`。
- 完成说明：本地代码/FFprobe/正式v2迁移与真SQL协议证据保持。授权记录`.local/acceptance/run-20261002-ces-private/authorization.json`，实云3用途AssumeRole/3600秒/缓存通过；站内上传2对象/原子登记/重复complete/正确组织通过，原片329035 unsupported HEVC/AAC、兼容460063 ready H264/AAC，均匿名403/V4 Range206，两完整附件下载SHA一致。read Get-only唯一1byte Put403拒绝、import仅run目录List200/2对象789098 bytes；无第三对象/清理/扩权。实云播放400参数根因修复后，新签名1byte206/inline/octet-stream，真实native GET206至媒体域名且无站点Cookie，解码5.909688秒/592×1280、暂停/拖动2秒/ready4正常。临时900秒STS真实自动续签2次，同应用会话ID、第二次换新Token且保留2秒/暂停，退出后续签401/旧URL1byte206。实际旧API退出、新normal3600进程启动后GET恢复2视频组标签和2秒进度，正常配置已恢复originals/。CORS核验：当前video未设crossOrigin可用，额外credentials-omit fetch Range不可读，未放宽规则，不把未来跨域fetch/HEAD/安卓/内网/部署称已验。具体JSON/进程交接见HANDOFF/OSS_ACCEPTANCE，旧公共样例HEAD200保留。
- 完成时间：2026-10-02 17:29 UTC（授权本机实云/浏览器/实际进程重启全链）
- 阻塞原因：无本阶段媒体必需阻塞；跨域fetch/HEAD需求、最终网站Origin/安卓/杭州内网/部署分别进入第三阶段，不包含本轮成功声明。

## 4. 完成记录

2026-10-02（17:29 UTC实云完成）：审阅original/compatible/permission/backend报告及browser-baseline1790960761020、browser-short1790960905830、browser-resume1790961841929 JSON均证明本轮完整范围。真实900秒STS自动续签17:17:59和17:20:29同会话/新Token/保留2秒暂停，退出401旧URL206；主控确认旧short API terminal0→新normal3600实际进程→本人登录→仅GET resume恢复2视频/组织/进度，非仅Fake重建。P2-MEDIA-05改DONE，两对象/全部任务记录保留，读取探针403未创建第三对象；未改Bucket/原公开样例/策略/CORS/元数据，无清理。签名rootfix受影响15项通过；最终主控全仓检查另记不冒报。额外fetch Range不可读为CORS核验结果，native现产品路径成功，未来网站/安卓/内网归第三阶段。

2026-10-02（17:04 UTC根因修复）：主控浏览器ORB诊断实际OSS400 InvalidRequest拒绝response-content-type query（req6ABFE320A5F05D3038807A4D）。Exa当前官方GetObject/NodeV4文档与本机SDK核对后，仅移除播放非法type覆盖、保留inline；CLI接受实际video/mp4/octet-stream但不宣称可解码。3项受影响检查+typecheck通过，新本地协议拒非法response参数；未改云对象metadata/ACL/CORS/权限或创建更多对象，等待主控重启加载新源码后真实GET/native联调。05仍DOING。

2026-10-02（16:51:44 UTC实云权限）：用户已明确授权本轮两对象/新对象private/费用/业务范围。主控真实STS/上传/登记/私有Range结果已读；媒体独立真实read Get-only 1byte唯一Put403拒绝、import仅授权run前缀List200/2对象789098 bytes/无截断，目标先wx记录、无自动重试/意外写入/清理/扩权。结果`.local/acceptance/run-20261002-ces-private/permission-result.json`保留；P2-MEDIA-05为DOING，浏览器/续签/撤销/重启未凭此代验。

2026-10-02（冻结后复核）：主控受影响14项逐项证据已齐：private头/真HTTP等13项通过，冻结源码下新上传私有验收单项复核1/1通过；签名/匿名计数使用精确字段且仍要求各1，源码不再改动。P2-MEDIA-05继续TODO，等待本轮具体实云/新对象private授权。

2026-10-02（公共Bucket最小补强）：Bucket公共读确认后，新增唯一对象CompleteMultipartUpload只发private+forbid头，403失败无回退/扩权，已有public对象/Bucket保持。受控CLI支持上传后先验私有性与既有privateVideoId互斥，新增新对象ACL明确授权门；真SDK头/旧public保留及fetch替身匿名200停止测试通过，旧媒体23+阶段2 12共35项、typecheck/build通过。源码14:58:34 UTC冻结；具体两样例789098 bytes/独立前缀/至多2新对象的实云方案已审阅，尚待用户明确授权，未调用真实云。

2026-10-02（准备状态补验）：只更新本板及媒体HANDOFF/OSS_ACCEPTANCE。只读正式库ledger1/2、账号1/视频0、integrityok/fk0，与已授权正式迁移备份保留报告一致；真实FFprobe受控Range记录位于`.local/acceptance/samples/analysis-20261002.json`，原片HEVC/AAC unsupported，独立H264/AAC副本ready/460063 bytes，两者hash复核且原片未变。P2-MEDIA-05仍TODO，尚无实云/ACL权限/公网费用授权；此记录不宣称浏览器、安卓或云播放通过。

2026-10-02（第二阶段开发）：P2-MEDIA-01～04代码/隔离验证完成，显式legacy资产绑定追加证据通过。`stage2-media.test.ts`10项、旧`media.test.ts`23项通过，API typecheck/build通过；主控独立2项真SDK协议/真HTTP+SQL+AuthGuard全链通过（实际步骤见主控测试）。P2-MEDIA-05仍TODO；受控CLI/范围准备完成，未读真实密钥、未执行真实STS/OSS/正式库迁移、未删除/清理或改权限。真实FFprobe/手机样例/浏览器实云分别待验。

2026-10-02：用户OSS证书生效，样例匿名HEAD/TLS通过（到期2026-12-30 UTC）；更新准备状态及私有权限核验要求，P2卡仍TODO，未运行STS/上传或改云配置。

2026-10-02（初建规划）：重排双Client/身份、STS缓存、V4直连/续签/下载及验收；当时HTTPS未配置、未访问OSS。后续证书/样例状态以顶部最新材料与较新记录为准，开发卡仍TODO。

2026-10-02：建立下一阶段媒体任务，未启动代理/开发/真实OSS；当前材料缺口见OSS_SETUP。

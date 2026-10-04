# 第二阶段冻结契约

日期：2026-10-02。P2-CORE-01已冻结shared/core/contracts，新增组织/库/进度和媒体路由通过本机真实HTTP/SQLite/SDK协议替身验证。用户具体授权后正式原库已一致性备份并升级版本2，旧账号/13表旧列保留；真实云操作未执行。依据[API_CONTRACT V0.5](API_CONTRACT.md)与[后端交接](STAGE2_BACKEND_HANDOFF.md)，不声称实云/生产通过。

根据用户OSS准备记录实施服务端上传、OSS直连播放/下载。OSS HTTPS已有材料；本人私有范围/真实STS/CORS待验。0002源码/隔离验证和正式授权升级现已完成；手工24表空账号/ledger库仍保持不变。

## 1. 分类、分组、标签

| 概念 | 规则 | 存储 |
| --- | --- | --- |
| 主分类 | 每个视频一个 categoryId；提供未分类默认值，不可归档该默认分类 | 既有 categories / videos.category_id |
| 分组 | 个人合集，如“2026旅行”“家人”；视频可在多个分组 | library_groups + video_group_links |
| 标签 | 描述属性，如“杭州”“夜景”；视频可有多个标签 | tags + video_tag_links |

分类、分组、标签全部是本人资源，读写检查 owner；它们与 OSS 目录、OSS Object Tagging 不等同。新增/重命名/排序/归档由受保护 API 执行；取消关联使用 removed_at 软解绑。归档不删除元数据或原片；既有视频仍可展示归档标识，新关联不接受归档资源。

名称显示保留中文，唯一性按服务端规范化 nameKey（NFKC、trim、统一大小写），同 owner 不允许重复。恢复同名归档项优先显式取消归档，不另造同名 ID。建议每视频/上传任务最多 20 个分组与 20 个标签；这是接口边界，不是云流量预算，冻结时统一到前后端校验。

## 2. DTO 及路由

保持 JSON `{data:T}`、错误 `{error:{code,message,requestId}}`、UTC ISO 8601、非负安全整数字节、同源 Cookie/CSRF；播放按显式proxy/oss模式区分。站内控制API仍只接受站内路径，外部签名源仅供媒体/下载使用。

- Category 补 isDefault、archivedAt；Group 补 id/name/description/sortOrder/createdAt/updatedAt/archivedAt；Tag 补 id/name/createdAt/updatedAt/archivedAt。
- VideoSummary/VideoDetail 补 groupIds、tagIds（没有时为空数组），详情可带对应安全 Group/Tag 摘要；旧 categoryId 保留。库查询组合 title/category/group/tag，修改筛选条件重置页码。
- CreateUploadRequest、UploadTask、ImportCommitRequest 补 groupIds/tagIds；创建时缺失可解释为 []，错误 ID/重复 ID/越界数量不得静默丢弃；服务端上传记录为完成/续传的权威组织信息。
- Video 编辑支持 title/categoryId/groupIds/tagIds：缺字段保持原值，明确 [] 为清空有效关联（软解绑）。更新组织信息与对象位置分开，不接受客户端 bucket/objectKey/url。
- ImportCommitRequest可选existingVideoId用于显式旧记录位置绑定，必须单选已核验预览项且原key精确匹配；保留旧id/title/组织/进度，已绑定不同身份拒绝。同项无existingVideoId为普通导入，不自动猜Bucket或替换旧记录。
- ImportPreview 分页提案补 nextCursor（不透明、绑定 owner/登录/前缀/TTL），禁止为了超过 100 条而全 Bucket 扫描；沿用预览条目 ID 提交，不接受原始对象地址。
- 不向前端返回长期AK、AccessKeySecret、完整STS凭据、TOTP密钥或OSS uploadId/ETag完成清单。控制API不暴露可自行替换的对象定位输入；oss模式返回的签名URL会自然包含对象路径、临时AccessKeyId与SecurityToken查询项，作为短期敏感授权整体对待，不打印/长期保存。

| 方法 | 新增/扩展路由 | 用途 |
| --- | --- | --- |
| GET/POST | /api/groups、/api/tags | 本人列表/创建，默认列活动项 |
| PATCH | /api/groups/:groupId、/api/tags/:tagId | 重命名/排序/描述（适用项）及显式 archive/unarchive |
| PATCH | /api/categories/:categoryId | 现有改名/排序加归档，默认分类受保护 |
| GET | /api/videos?categoryId=&groupIds=&tagIds=&q=&page=&pageSize= | 跨维度分页筛选 |
| PATCH | /api/videos/:videoId | 编辑元数据及组织关联 |
| POST/GET/PUT/complete | 现有 /api/uploads 系列 | 上传任务包含持久化的组织信息 |
| POST | 现有 /api/imports/preview、/commit | 受控分页预览及选中对象关联组织信息 |
| GET/PUT | 现有 /api/videos/:videoId/progress | 本人持久化观看记录 |
| GET | 现有 /api/settings/usage | 分模式用量：proxy真SQL实际字节，oss实际传输量未知/未同步，非云账单 |
| POST | /api/videos/:videoId/playback-sessions | 创建受保护应用会话；proxy返回站内源，oss返回STS/V4签名源 |
| POST | /api/playback-sessions/:sessionId/source | 同会话续签，重新查登录/归属/会话状态，不新增并发槽 |
| POST | 现有 /api/playback-sessions/:sessionId/heartbeat、/close | 应用会话续期/关闭，不等于撤销OSS已发URL |
| POST | /api/videos/:videoId/download-authorizations | 授权下载DB定位的原片，返回签名URL/实际到期与安全文件名 |

过滤为跨维度AND、多个group/tag全部命中；HTTP groupIds/tagIds逗号分隔字符串，空串不筛选，重复/空项/超过20拒绝。page默认1/pageSize默认24、最大100。创建/编辑组织选择用数组，缺失[]，更新省略保持/[]软解绑；显式含归档项409，标题单独改保留归档历史。错误码新增ORGANIZATION_CONFLICT409；其余参数400/未登录401/权限403/不存在404/限额429/存储503。

### 播放与用量DTO冻结要求

- PlaybackMode扩展为`proxy | oss`判别联合。共有id/videoId/expiresAt（应用会话到期）；proxy.sourceUrl仍为ApiPath，oss.sourceUrl为经后端固定媒体域名签发的URL，并有sourceExpiresAt/renewAfter。不能把会话到期、签名到期和STS到期混为一个字段。
- source续签只更新有效会话的源授权，重新检查owner/登录/状态/频率；心跳不能自动被解释为URL续签。实际签名期限不超过3600秒且不超过STS剩余期限减安全余量；STS短剩余时间需先刷新或返回真实较短有效期。
- heartbeat返回id/videoId/mode/expiresAt，不带sourceUrl/sourceExpiresAt/renewAfter；下载返回videoId/mode=oss/sourceUrl/sourceExpiresAt/fileName。`/api/settings/limits`返回已确认maxUploadBytes/partSizeBytes/maxUploadConcurrency/maxPlaybackSessions/maxAuthorizationsPerMinute。
- oss用量字段固定source=oss_direct/statisticsStatus=not_synced/transferredBytes=null/cloudStatisticsAt=null/limitMode=not_applicable/limitBytes=null；SQL统计authorizationCount、playbackAuthorizationCount、renewalAuthorizationCount、downloadAuthorizationCount与activePlaybackSessions。
- 下载只接受videoId，不接受key/URL；允许下载本人原片，不以网页可解码状态作为唯一下载条件。Content-Disposition/安全文件名与GET签名匹配，返回URL不存为永久视频属性。
- ApplicationUsage分模式：proxy保留application_proxy、实际字节及三态字节限额；oss使用单独来源/未同步状态，实际字节与云统计时间为空，不用0表示未知。签发次数、应用会话数量可来自SQL，但不能冒充实际OSS连接数/传输量。具体字段由代理1先编译冻结。
- 撤销/退出/close立即拒绝新授权与续签；已发签名URL在剩余有效期内可能继续使用，普通直连方案不承诺立即中断或按proxy字节硬封顶。

## 3. OSS 地址的管理

数据库的长期权威定位为 provider + bucket + region + objectKey + 可选 versionId，storageObjectId 供服务端引用。上传 SDK 返回的 Location 只是可构造的对象地址，不证明可匿名访问或网页可播；不把带有效期的签名 URL 存为长期播放字段。

目标定位：bucket=xzlbucket、region=cn-hangzhou、objectKey=onlineVideo/originals/服务端唯一ID。oss播放器查DB归属/资产后获得已生效HTTPS CNAME的STS/V4 GET签名，上传Endpoint切换不改变媒体域名；proxy仍按请求鉴权/计量。私有业务验收须证明匿名读取拒绝、有效签名成功，不能以当前匿名HEAD=200的测试对象替代。

视频原片/播放版本/封面使用 video_assets 的角色关系，原片兼容时 original/playback 可以指同一对象；有单独兼容副本时分别关联，不覆盖原片。修改组/标签不修改对象身份。更换默认 Bucket 不得让历史 key 自动指向新 Bucket；未明确旧位置的记录保持待绑定并拒绝流读取。

用户记录Bucket版本控制未开启，当前versionId=null，但仍须唯一Key/防覆盖及HEAD校验。保留可选versionId支持；以后开启/暂停时重新核验读取/完成返回并固定版本，不能只依赖x-oss-forbid-overwrite。不能自动调整版本控制/ACL。

## 4. 服务端协作

子代理1已增加组织/对象仓储；媒体只调契约，不直接操作SQL。确切签名见core/contracts（兼容旧Fake的optional方法在真实OSS注册强制要求）：

- OrganizationRepository：验证类别/分组/标签归属及活动状态，保存上传组织信息，更新视频关联。
- StorageObjectRepository：准备/核验/定位对象，校验 Bucket/地域/前缀允许范围，维护 storage_operations 与资产关联。
- UploadRepository.finishRegistration：在一个 SQLite immediate 事务里登记/复用视频、绑定资产、转移组/标签、完成上传状态及操作记录；失败保持可恢复状态。
- VideoRepository 登记幂等从旧 owner+key 扩展为已验证的完整存储身份；兼容旧字段且不悄悄改含义，既有 findOwned 等使用方通过公共契约一起更新。
- StorageObjectRef 从仅 key 升级为服务端确认的定位/对象 ID；适配器拒绝不在配置允许 Bucket/地域/前缀中的引用，不采用客户端 URL、不跨 Bucket 回退。
- PresignedSourceProvider独立于StorageAdapter流式I/O接口，按DB已验证对象签GET源/下载授权，返回实际到期；STS提供者返回Expiration并按角色/用途/收窄策略缓存，不让上传权限被当成读取会话权限。
- 上传/签名client分别使用OSS_ENDPOINT与OSS_PLAYBACK_ENDPOINT；后者cname=true并调用signatureUrlV4。用户确认GetObject/PutObject/ListObjects策略同时绑定RAM用户与角色，优先复用角色STS并通过AssumeRole Policy按用途收窄，缓存隔离；角色信任/权限实效另验，不自动改云策略。
- dependencies.kind区分test/development/production；生产拒绝测试/Mock、HTTP媒体域名和缺上传/授权控制参数。proxy字节额度与oss未知传输量分开，不将未知当unlimited，不用代理字节预留宣称直连已封顶。

OSS 与 SQLite 不组成同一原子事务。先把操作意图和唯一对象身份写库，OSS 返回后更新日志，验证对象再原子登记；云端完成而库登记失败时按唯一操作/对象重试，不重复生成视频，不自动删除云端分片/原片。标签/分组在最终登记再次核查，新归档/失效选择应明确返回可恢复错误。

## 5. 完成证据

先以真SQLite+真AuthGuard+本地OSS协议服务完成登录→组织→服务端上传/登记→筛选→签名直连/Range→同会话续签/下载→进度/重启恢复，并回归proxy。受控真STS/OSS、HTTPS/CORS、安卓真机与杭州内网上传分别记录；旧DONE不替代直连验收，手工SQL执行不替代正式迁移。

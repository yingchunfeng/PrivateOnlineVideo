# 第二阶段契约提案（下一对话冻结后实施）

日期：2026-10-02。本文件是阶段 2 的设计来源，不表示以下接口已实现。当前可编译契约仍为 [API_CONTRACT V0.4](API_CONTRACT.md) 和 packages/shared；由子代理 1 在 P2-CORE-01 同步新类型、Fake、迁移和变更记录，交接后媒体/前端才能依赖新版。

## 1. 分类、分组、标签

| 概念 | 规则 | 存储 |
| --- | --- | --- |
| 主分类 | 每个视频一个 categoryId；提供未分类默认值，不可归档该默认分类 | 既有 categories / videos.category_id |
| 分组 | 个人合集，如“2026旅行”“家人”；视频可在多个分组 | library_groups + video_group_links |
| 标签 | 描述属性，如“杭州”“夜景”；视频可有多个标签 | tags + video_tag_links |

分类、分组、标签全部是本人资源，读写检查 owner；它们与 OSS 目录、OSS Object Tagging 不等同。新增/重命名/排序/归档由受保护 API 执行；取消关联使用 removed_at 软解绑。归档不删除元数据或原片；既有视频仍可展示归档标识，新关联不接受归档资源。

名称显示保留中文，唯一性按服务端规范化 nameKey（NFKC、trim、统一大小写），同 owner 不允许重复。恢复同名归档项优先显式取消归档，不另造同名 ID。建议每视频/上传任务最多 20 个分组与 20 个标签；这是接口边界，不是云流量预算，冻结时统一到前后端校验。

## 2. DTO 及路由

保持 JSON `{data:T}`、错误 `{error:{code,message,requestId}}`、UTC ISO 8601、非负安全整数字节、同源 Cookie/CSRF、proxy 规则。

- Category 补 isDefault、archivedAt；Group 补 id/name/description/sortOrder/createdAt/updatedAt/archivedAt；Tag 补 id/name/createdAt/updatedAt/archivedAt。
- VideoSummary/VideoDetail 补 groupIds、tagIds（没有时为空数组），详情可带对应安全 Group/Tag 摘要；旧 categoryId 保留。库查询组合 title/category/group/tag，修改筛选条件重置页码。
- CreateUploadRequest、UploadTask、ImportCommitRequest 补 groupIds/tagIds；创建时缺失可解释为 []，错误 ID/重复 ID/越界数量不得静默丢弃；服务端上传记录为完成/续传的权威组织信息。
- Video 编辑支持 title/categoryId/groupIds/tagIds：缺字段保持原值，明确 [] 为清空有效关联（软解绑）。更新组织信息与对象位置分开，不接受客户端 bucket/objectKey/url。
- ImportPreview 分页提案补 nextCursor（不透明、绑定 owner/登录/前缀/TTL），禁止为了超过 100 条而全 Bucket 扫描；沿用预览条目 ID 提交，不接受原始对象地址。
- 不向前端返回长期凭证、TOTP 密钥、OSS uploadId/ETag 完成清单或 storage_objects 的内部 Bucket/key；页面只使用站内 API 路径。

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
| GET | 现有 /api/settings/usage | 真 SQL 应用计量与限制，非云账单 |

过滤语义固定为：不同维度 AND，选中的多个 groupIds 要求全部命中，多个 tagIds 要求全部命中；空数组不加该维度筛选。参数编码/去重/数量/分页边界在 P2-CORE-01 冻结为准确请求类型，三个代理不能各自解释字符串列表。错误码新增必须由子代理 1 统一，继续遵循参数400、未登录401、权限403、不存在404、状态冲突409、限额429、配置/存储503。

## 3. OSS 地址的管理

数据库的长期权威定位为 provider + bucket + region + objectKey + 可选 versionId，storageObjectId 供服务端引用。上传 SDK 返回的 Location 只是可构造的对象地址，不证明可匿名访问或网页可播；不把带有效期的签名 URL 存为长期播放字段。

例如对象定位：bucket=用户私有Bucket，region=cn-hangzhou，objectKey=library/originals/唯一ID；可推导 `https://<bucket>.oss-cn-hangzhou.aliyuncs.com/<编码后的key>`。A 方案播放器仍得到 `/api/videos/<videoId>/stream?playbackSessionId=...`，后端根据数据库位置鉴权读取；每次检查 Cookie、归属、播放会话和额度。

视频原片/播放版本/封面使用 video_assets 的角色关系，原片兼容时 original/playback 可以指同一对象；有单独兼容副本时分别关联，不覆盖原片。修改组/标签不修改对象身份。更换默认 Bucket 不得让历史 key 自动指向新 Bucket；未明确旧位置的记录保持待绑定并拒绝流读取。

开启/暂停版本控制的 Bucket 必须核验 SDK versionId 读取/HEAD/完成返回，完成后固定所选版本；官方 CompleteMultipartUpload 说明该场景的 x-oss-forbid-overwrite 头可能无效，必须依靠服务端唯一 key、数据库幂等和版本校验，不能只靠此头。不能自动调整 Bucket 的版本控制/ACL。

## 4. 服务端协作

子代理 1 增加组织与存储登记 Repository，媒体模块只调接口，不直接操作 schema/SQL；建议契约（方法签名需先编译冻结）：

- OrganizationRepository：验证类别/分组/标签归属及活动状态，保存上传组织信息，更新视频关联。
- StorageObjectRepository：准备/核验/定位对象，校验 Bucket/地域/前缀允许范围，维护 storage_operations 与资产关联。
- UploadRepository.finishRegistration：在一个 SQLite immediate 事务里登记/复用视频、绑定资产、转移组/标签、完成上传状态及操作记录；失败保持可恢复状态。
- VideoRepository 登记幂等从旧 owner+key 扩展为已验证的完整存储身份；兼容旧字段且不悄悄改含义，既有 findOwned 等使用方通过公共契约一起更新。
- StorageObjectRef 从仅 key 升级为服务端确认的定位/对象 ID；适配器拒绝不在配置允许 Bucket/地域/前缀中的引用，不采用客户端 URL、不跨 Bucket 回退。
- dependencies.kind 明确区分 test/development/production；本地真鉴权+SQLite+Mock 媒体只能作为显式开发，不能装配生产。生产不得采用 test 默认模块、Mock 存储或缺失限额。

OSS 与 SQLite 不组成同一原子事务。先把操作意图和唯一对象身份写库，OSS 返回后更新日志，验证对象再原子登记；云端完成而库登记失败时按唯一操作/对象重试，不重复生成视频，不自动删除云端分片/原片。标签/分组在最终登记再次核查，新归档/失效选择应明确返回可恢复错误。

## 5. 完成证据

应以真 SQLite + 真 AuthGuard + 站内真实 HTTP 完成登录→创建组织→上传（先显式Mock内容）→视频登记→筛选/编辑→播放/观看位置→重启后恢复。Mock 内容、真 OSS、安卓真机和杭州内网的结果分别记录；已有媒体/前端 DONE 仅是上阶段独立模块完成，不替代此链路验收。

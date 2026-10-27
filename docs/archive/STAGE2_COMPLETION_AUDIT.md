# 第二阶段完成审计

> **历史归档（2026-10-26）**：原位置 `docs/STAGE2_COMPLETION_AUDIT.md`。以下保留历史设计与完成记录，不作为当前任务指令；当前工作见[未完成工作清单](../task/UNFINISHED_WORK.md)，归档范围见[归档索引](README.md)。

日期：2026-10-02。范围按STAGE2及三个阶段2任务板，包含本机真实STS/OSS验收。网站部署、最终HTTPS站点、安卓真机/原生后台和杭州内网属于第三阶段，没有作为本轮成功证据。

## 授权与数据保留

已先读取OSS_LOCAL_TEST_PLAN并启动后端、媒体、前端三个代理，公共契约冻结后按文件归属实施。正式迁移经过SQL审阅、只读备份副本验证和用户“授权备份并升级该正式库”确认；实云按STAGE2_CLOUD_ACCEPTANCE_PLAN明确两个新对象/private ACL/唯一1字节拒写探针/业务登记/公网范围后，用户明确同意真实链路。

正式库仍同一 `.local/data/video-library.db`，ledger=1/2、25表、本人账号1条；原账号静态密码/TOTP列与10条恢复码摘要对照迁移前一致性备份相同。手工sqlite-test.db保留24表/空users/空ledger。没有重建账号、修改0001、删除、覆盖原片、改Bucket/RAM/CORS/版本控制、部署、提交或推送。

迁移备份：`.local/backups/before-migration-1790950813946-71816f51-c74c-4667-a682-782f49db3d0d.db`；原列保留验证同名 `.db.verification.json`。最新独立只读报告：`.local/acceptance/run-20261002-ces-private/backend-readonly-1790961903448-a887bda3-b05c-4300-8e6e-004d5177d2ca.json`；主控随后再读确认2视频/2上传/2verified对象/1条进度位置2秒、完整性ok/外键0、验收会话均已退出。

## 按要求核验证据

| 要求/门槛 | 当前权威证据 | 结论 |
| --- | --- | --- |
| G0可编译契约/0002/依赖 | shared判别proxy/oss、组织/完整对象/STS/续签/下载/未知用量；SQL25表/Drizzle及升级/回滚/重复测试 | 通过；0001未改 |
| CORE01～03保留，不重复初始化 | 正式本人账号静态列/恢复摘要与备份相同，受保护真账号登录/me/logout通过 | 通过 |
| 组织/库/多维AND/编辑/分页 | 真SQL/HTTP、归档/软解绑/重复/跨owner/组合筛选/重启检查及浏览器7场景 | 通过 |
| 上传快照/续传/原子登记 | 真流式分片SHA、断开/错误文件/失败恢复/重复完成本地协议与真SQL；实云两任务completed/各1registered操作、资产与组标签精确匹配 | 通过；不整文件缓冲服务器上传 |
| 完整OSS身份/唯一Key/版本 | 正式storage_objects绑定xzlbucket/cn-hangzhou/本次UUID key/versionId=null/verified、video_assets4；重复complete仍2视频 | 通过 |
| STS信任/用途/缓存 | 实际read/upload/import请求3600秒成功/Expiration/缓存；read仅Get的1字节Put403；import限定前缀List200/恰2对象 | 通过；未扩大角色权限 |
| 实际私有授权 | 两新对象Complete设置private、匿名Range403/STS V4 Range206；原公开样例HEAD仍200/329035字节 | 通过；Bucket公共读保留 |
| 内容分析/真实状态 | 真实受控FFprobe9.0.2：原片HEVC/AAC unsupported，独立H264/AAC副本ready；真实UI分别不兼容提示/可播放 | 通过；原片SHA未变 |
| 浏览器OSS直连/Range | baseline实际OSS HTTPS GET Range206、Content-Range、原生video readyState4/尺寸/播放拖动暂停；站点Cookie未发送到OSS | 通过；API只控制请求 |
| 到期/同会话续签/角色刷新 | 真900秒STS等待约12.5分钟，初URL871820ms；17:17:59提前300秒续签，17:20:29刷新STS；同id3次授权、暂停/位置2/ready4 | 通过；根.env恢复正常3600秒 |
| 原片附件下载 | Node原HEVC329035字节、真实浏览器兼容460063字节一次完整附件；SHA均与对应本地样例一致 | 通过；没有再次完整下载 |
| 退出/撤销边界 | 实云logout后source401、已发链接剩余期1字节Range206；本地真revoke/流停止/SQL审计/proxy回归 | 通过；不承诺立即撤回旧URL |
| 用量/并发/频控 | SQL持久授权次数/活动应用会话，oss实际字节null/not_synced；3播放槽第4在签名前拒绝、12/min授权；proxy真实字节/IANA/DST/预留回归 | 通过；不是云账单/费用封顶 |
| 重启保留 | short API优雅停止→normal新进程/3600恢复→新本人会话，resume仅GET显示2视频/组织/进度2秒；正式ledger/完整性匹配 | 通过 |
| 长视频/后台生命周期 | 真实3600秒H264、中/尾Range、48秒心跳根因修复/延期、迟到源响应单调期限、真实Page frozen恢复APP403与Auth401 | 通过当前浏览器生命周期；原生安卓后台另验 |
| 生产/秘密/UTF8/运行交接 | 最终root check：API62/前端14、三包类型/构建通过；独立release15-40目录3文件SHA/无Mock秘密；UTF8无BOM/diffcheck、本地启动/VSCode配置 | 通过 |

真实原始安全报告均在 `.local/acceptance/run-20261002-ces-private/`：sts-preflight、original/compatible-result、permission-result、browser-baseline-1790960761020、browser-short-1790960905830、browser-resume-1790961841929及backend-readonly。完整URL/AK/Secret/Token/Cookie未写报告；短期会话仅.local，本人视频与真实/长QA已从Git候选范围精确排除，文件保留。

## 最终资源与可测试数据

正常配置：单视频2147483648字节、分片8388608字节、上传最多2并发、3播放会话、签发12次/分钟/账号、Asia/Shanghai；STS及URL最长3600秒/提前300刷新，实际URL受STS剩余期限减30秒约束。上传目录恢复onlineVideo/originals/，两个验收视频的永久DB位置仍在独立acceptance目录。

库中保留“OSS验收原片20261002”和“OSS验收兼容20261002”，同“OSS本地验收20261002”分组、分别原片/兼容标签。兼容视频可播放/续播/下载，原片保留下载和unsupported提示。所有本轮对象/分片/数据/日志/产物保留，自有API/Vite/browser已优雅关闭，不影响用户未知进程。

## 明确的后续边界

原生video未设置crossOrigin，当前真实播放/Range/续签/下载全部通过；额外credentials-omit跨域fetch Range检查不可读，未自动修改CORS。将来引入fetch/HEAD/crossOrigin或最终网站Origin时，再按实际请求核对具体规则/授权。网站HTTPS、安卓真机/原生后台、服务器部署/杭州内网、大文件/长时实际压力及运维归第三阶段，不用当前小样例、页面冻结或手机仿真冒充。

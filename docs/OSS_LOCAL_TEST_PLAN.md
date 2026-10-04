# 本地真实 OSS 准备与第二阶段验收

日期：2026-10-02。状态：第二阶段本机真实链路验收完成；正式v2库/账号保留，真实STS、两新private对象站内上传登记、Range/两附件SHA、浏览器播放/真实自动续签/角色刷新/退出边界及重启进度均通过。完整证据见[完成审计](STAGE2_COMPLETION_AUDIT.md)与[主控记录](STAGE2_INTEGRATION.md)，不是只用Fake；原公开样例保留。

第二阶段三个子代理已实施并逐卡回写。用户确认Bucket公共读，原公开样例匿名HEAD仍200；本人新验收对象仅Complete设置private并实际匿名403/STS签名206，Bucket及原对象保留。正式迁移和本轮实云清单均已获具体授权；清单之外的写入/权限/CORS变更仍需单独明确范围，公开样例不用于证明私有授权。

## 1. 能否在本地测试真实 OSS

可以。第二阶段完成接入及P2-MEDIA-05真实验收后，本机运行Node API与前端，上传/HEAD/导入通过OSS公网Endpoint，播放/下载由浏览器直接访问签名媒体URL，不要求先部署轻量服务器。

“代码/Mock完成”与“本地真实OSS验收通过”必须分别记录；P2-MEDIA-05仍TODO时，不能宣称第二阶段实云部分完成。杭州内网上传、服务器发布与安卓域名验收留给[第三阶段](task/STAGE3.md)。

本机`http://127.0.0.1:5173`属于浏览器认可的本地可信来源，当前分片SHA-256可在该环境使用。普通HTTP域名/手机访问电脑LAN地址不等同于localhost；用户最终选择网站与OSS都使用HTTPS，第三阶段沿用安全Cookie及Web Crypto，不增加HTTP登录例外或哈希替代方案。

## 2. 已准备与还需补齐

| 项目 | 当前事实 | 还需要的动作/材料 |
| --- | --- | --- |
| Bucket/地域/前缀 | xzlbucket / cn-hangzhou / onlineVideo/ | 无需另建Bucket；实际接入时核对范围 |
| AK与角色ARN | 私密文件oss.json、ARN.txt存在 | 服务端加载校验；无需在聊天或文档贴真实密钥 |
| OSS策略 | GetObject/PutObject/受前缀限制的ListObjects；用户确认绑定RAM用户与角色 | 无需因为双Client再建角色；核验真实权限与会话Policy收窄 |
| 角色信任 | 实际read/upload/import用途AssumeRole均成功、Expiration缓存有效 | 无需仅为本轮信任证据再提供JSON；不修改角色/授权策略 |
| STS会话时间 | 正常3600秒真实成功；临时900秒真实自动续签两次、第二次角色刷新且同会话保留2秒暂停 | 临时进程已关闭，正常3600/提前300配置恢复，实际源仍受STS剩余期限约束 |
| 媒体HTTPS | 用户确认已生效；独立HEAD默认TLS证书校验通过，到期2026-12-30 23:59:59 UTC | 已不属于待申请项；证书续期列第三阶段，网站自己的域名/证书仍单独处理 |
| 私有访问 | 已获授权新对象Complete/private；两对象匿名Range403、有效read STS/V4 Range206；read用途1字节Put403、import限定目录List200 | 当前访问控制实效已验，不据此推断其它对象权限；原Bucket/公开对象不改 |
| CORS | 真实本地原生video未设置crossOrigin，播放/Range成功；额外credentials-omit跨域fetch Range不可读 | 按实际播放器需求记录；未来跨域fetch/HEAD或最终站点Origin需要具体CORS差异和授权，不自动改为* |
| 本地运行配置 | 已新建此前不存在的根.env，readConfig验证通过；代码已接入用途STS/双Endpoint/固定HTTPS媒体源 | 实云启动前仍确认操作授权/可用分析器，已有配置局部修改不覆盖 |
| 操作范围与费用 | STAGE2_CLOUD_ACCEPTANCE_PLAN已明确授权并执行：2视频789098字节、最多1字节拒写探针及少量下行；全部保留 | 不扩大为压力测试/新云对象/权限策略；当前直连字节未知，不宣称费用硬封顶 |
| 资源控制 | 用户确认2GiB/3播放会话/3600秒签名提前300秒刷新/Asia-Shanghai；其余授权由开发选择：8MiB分片、上传最多2并发、签发12次/分钟/账号 | 参数已冻结；OSS观看字节仍未知，不作为硬费用封顶 |
| 视频样例/分析器 | 用户提供docs/ces.mp4，329035字节；真实受控FFprobe识别HEVC/AAC/unsupported。已按用户选择生成独立H264/AAC副本460063字节，真实分析ready；均5.909688秒/592×1280 | 两样例已可用于受控验收；原片未覆盖，分析报告与SHA见主控记录 |
| 数据库 | 手工库24表/空账号/空ledger保留；正式库已升级25表/ledger版本2/本人账号1条 | 新一致性备份与逐旧列保留报告已生成；不再重跑手工建表/初始化 |

没有默认要求开启版本控制、增加DeleteObject/Abort权限、开通CDN、日志付费服务或新增数据库服务。

### 本轮HTTPS与样例核验记录

- 地址：[用户MP4样例](https://oss.meetdawn.top/onlineVideo/96257570ce7bc1f46e749df9ab2598f7.mp4)，对象Key为onlineVideo/96257570ce7bc1f46e749df9ab2598f7.mp4。
- 2026-10-02：Node默认HTTPS证书校验的匿名HEAD返回200，tlsAuthorized=true、Server=AliyunOSS、Content-Type=video/mp4、Content-Length=329035、Accept-Ranges=bytes；证书到期2026-12-30 23:59:59 UTC。
- 未下载视频正文、未调用STS、未读取长期密钥、未执行云写入。Accept-Ranges响应头不代替实际206/拖动播放证据；用户报告可播放，不作为应用登录/STS/V4签名验收。
- 用户随后确认公共读，故样例不受站内登录/STS限制，能访问不等于私有授权已验。未据此推断整个Bucket或其它对象公开，后续本人私有视频使用独立的权限验收对象；不擅自修改现有样例。

### CORS核对口径

- 开发站点以`http://127.0.0.1:5173`为准；只有确实使用localhost域名时再配置对应origin，端口不同是不同origin。
- 浏览器直连读取需要的规则与服务端SDK访问不同；后者不受浏览器CORS约束。若前端使用跨域fetch/HEAD或设置video.crossOrigin，按实际请求配置GET/HEAD、Range等请求头及需要读取的ETag/Content-Range/Accept-Ranges/Content-Length响应头。
- 普通video播放未设置crossOrigin时不应把所有失败都归因为CORS；同时核查签名、对象状态、媒体格式、网络和Content-Type。GET签名不能未经核验就改为HEAD调用。
- CORS不能代替签名鉴权，不需要把站点登录Cookie发送给OSS。

## 3. 本地拟用配置

以下地址示例现已有代码支持；完整运行配置已经代理1冻结并由主控新建根.env，精确资源参数见根.env.example和[主控记录](STAGE2_INTEGRATION.md)。这里的片段仍不是全部必填配置。

```dotenv
NODE_ENV=development
API_HOST=127.0.0.1
API_PORT=3000
STORAGE_DRIVER=oss
PLAYBACK_MODE=oss
OSS_REGION=cn-hangzhou
OSS_BUCKET=xzlbucket
OSS_OBJECT_PREFIX=onlineVideo/
OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
OSS_NETWORK=public
OSS_ALLOW_PUBLIC_NETWORK=true
# 媒体HTTPS已通过样例HEAD验证；签名/续签代码和本地协议已验，真实OSS仍待授权
OSS_PLAYBACK_ENDPOINT=https://oss.meetdawn.top
OSS_CREDENTIAL_FILE=E:/onlineVideo/.local/secrets/oss.json
OSS_ROLE_ARN_FILE=E:/onlineVideo/.local/secrets/ARN.txt
OSS_STS_DURATION_SECONDS=3600
OSS_STS_REFRESH_BEFORE_SECONDS=300
OSS_SIGNED_URL_TTL_SECONDS=3600
AUTH_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:3000
```

已有.env只局部调整，不覆盖；媒体固定使用已生效的HTTPS域名，不回退HTTP。根目录两个终端运行`npm run dev:api`与`npm run dev:web`，使用已有本人账号，不启用Mock。readConfig和完整装配现已支持oss，正式库版本2已验；真实STS/OSS及权限实效仍未验，代码可用不等于实云验收已通过。

## 4. 必须留下的验收证据

1. 真实AssumeRole成功，读取/上传用途缓存与Expiration有效；不记录AK、Secret、Token或完整签名URL。
2. 唯一新对象经站内分片流式上传，HEAD元数据核验，SQLite仅登记一条视频及正确分类/分组/标签；断开/重试不覆盖原片。
3. 浏览器Network显示视频GET/Range直接到OSS媒体域名，API仅发授权/进度等控制请求；签名过期前续签，换源保留位置/暂停状态。
4. 原片下载可用，兼容格式播放可用；未支持格式明确显示状态，不把所有视频默认ready。
5. 对已确认私有的业务对象，匿名读取拒绝、有效STS/V4签名成功；不能用公共读样例验收访问控制。会话撤销拒绝后续续签，旧签名剩余有效期边界明确，用量页不伪造实际字节。
6. 应用重启后组织、视频登记与观看进度保留；正式库实际版本与schema/ledger一致。

记录目标、网络、测试对象/大小、时间、结果、费用范围及保留对象清单。回环HTTP页面的本地验收不替代最终HTTPS域名/安卓部署验收，也不替代杭州内网证据。

## 5. 最终HTTPS选择与阶段划分

用户最终选择网站与OSS都使用HTTPS；OSS媒体证书已生效并独立通过HEAD校验，网站自己的域名/证书尚未确认。第三阶段不实现非回环HTTP登录例外、不关闭Secure Cookie或绕开安全上下文，不能将OSS证书视为网站证书已配置。

本地开发页面使用回环HTTP即可连接真实HTTPS OSS，普通安卓域名部署则验证HTTPS与Web Crypto。第三阶段配置网站HTTPS、媒体HTTPS、精确Origin/CSRF/HttpOnly/SameSite/Secure、可信反向代理及证书续期方案，密钥不进Git/前端/日志；未授权不购买证书或改DNS。

核验来源：[MDN Crypto.subtle的安全上下文要求](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/subtle)、[MDN本地可信来源](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)、[阿里云STS权限/有效期](https://help.aliyun.com/zh/ram/developer-reference/api-sts-2015-04-01-assumerole)。

## 6. 新对话启动第二阶段的剩余事项

| 优先级 | 事项 | 启动/完成边界 |
| --- | --- | --- |
| 已验 | 本轮private ACL/STS/Get/Put/List | 用户授权后两样例成功私有上传/读写/数据库登记；读取不能Put和限定List有实际输出 |
| 已验 | 真实短剩余STS自动续签/角色刷新及重启 | 实际等待约12.5分钟两轮同会话续签保留2秒/暂停；退出401旧URL206，normal新API重启GET恢复组织/库/2秒进度 |
| 已完成 | 本地.env/公网上传Endpoint/固定HTTPS签名域名、具体资源限额 | 代码/配置已冻结且验证，生产参数来自用户确认；真实调用仍按授权范围 |
| 已完成 | 正式库0002迁移、匹配备份/执行目标 | 用户授权后已备份升级；旧列内容/计数及本人账号保留，手工库未改 |
| 已验 | 小样例上传/播放/附件 | 两对象实际上传、匿名403/签名206、兼容原生播放和两附件SHA匹配，不覆写/清理 |
| 后续按需 | 额外CORS fetch/HEAD与最终Origin | 原生播放已通过，额外fetch不可读准确保留；需求增加时再审阅规则差异，最终域名/安卓归第三阶段 |
| 已准备 | 原片与兼容播放样例 | 原片HEVC用于unsupported/原片下载；用户选择的独立H264/AAC副本已生成并经真实分析器验证ready，未云上传 |

网站域名/证书、服务器访问与杭州内网、安卓部署和证书续期归第三阶段，不阻塞本机第二阶段开发。具体任务与可复制主控提示词见[STAGE2](task/STAGE2.md)。

本轮交接结论：OSS证书/域名/远程样例已准备，公开读原因已确认；剩余项按任务核验，不要求用户先完成全部程序配置再启动开发。只读/代码工作可直接推进，实际云权限变更、正式库迁移及实云写入仍遵守具体目标和授权边界。

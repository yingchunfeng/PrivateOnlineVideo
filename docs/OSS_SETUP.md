# OSS 接入需要的材料与 SDK

核验日期：2026-10-02。官方文档及用户准备材料已核对；本轮对用户HTTPS样例做了匿名HEAD，未运行STS、上传或云配置变更。

更新依据：[用户已完成记录](archive/task/OSS和框架调整相关.md)、[自定义策略JSON](task/自定义策略的json.txt)、[架构评审](archive/task/STAGE2_ARCHITECTURE_REVIEW.md)。本阶段改为服务端上传、STS/V4签名后OSS直连播放/下载；以下“用户已准备”不等于云侧生效或程序已验收。

最新补充：OSS媒体证书已生效，样例匿名HEAD=200且默认TLS校验通过，到期2026-12-30 23:59:59 UTC；用户确认样例为公共读，故匿名成功符合预期。本人私有视频/新上传对象的权限范围仍需确认，公开样例不作为鉴权证据。网站证书归第三阶段，启动材料见[实云计划](archive/OSS_LOCAL_TEST_PLAN.md)。

## 1. SDK 选哪一种

本项目后端是 **Node.js + TypeScript + Fastify**，选 **OSS Node.js SDK，npm 包 ali-oss**。浏览器上传到站内API，由Node后端流式上传OSS；播放/下载由服务器鉴权并用STS生成V4签名URL，浏览器直接GET/Range访问OSS。前端不用OSS SDK，不接收长期AK/AccessKeySecret/完整STS凭据。

现有工程已经锁定 `ali-oss@6.23.0`、`@types/ali-oss@6.23.3`，不是“还需下载一个独立桌面 SDK”。下次开发先核对实际 package.json/锁文件；如需升级，由主控/子代理 1 核验兼容性并串行安装，不并发执行 npm，不随意改 Python 技术栈。FFprobe 是视频分析可执行程序，不是 Python OSS SDK。

官方初始化推荐显式 `authorizationV4: true`；配置层可用业务地域 `cn-hangzhou`，SDK 构造参数按官网写为 `oss-cn-hangzhou`。本地已安装 SDK 的签名标准地域函数会去掉 oss- 前缀，但下一阶段仍须统一这层转换与测试，不能让三个代理各自填不同值。

签名明确调用`signatureUrlV4('GET',...)`，旧`signatureUrl()`不会因构造参数authorizationV4自动变成V4签名。上传优先复用已实现的initMultipart/uploadPart/complete与续传协议；一次性请求流不直接传高层multipartUpload，普通流可用putStream。根包已新增multipart与重复OSS依赖，保留用户改动，代理1开发时核对workspace归属/STS SDK并串行处理。

## 2. 需要你准备什么

| 材料 | 用途/填写方式 | 当前状态 |
| --- | --- | --- |
| Bucket 名称 | 控制台实际私有 Bucket 名称 | 用户提供xzlbucket，云侧待验 |
| 地域 | 已确认杭州：cn-hangzhou | 已知，仍与实际 Bucket 核对 |
| 授权对象前缀 | 应用可读写范围，目录边界以 / 结束 | 用户提供onlineVideo/，策略JSON对应此范围 |
| 既有视频导入前缀 | 只允许预览/选中此范围下的对象 | 限onlineVideo/及其子前缀，不全Bucket扫描 |
| Bucket/Object ACL 与现有 Policy | 保证本人私有业务不允许匿名读取 | 用户样例确认为公共读；其它对象/未来上传的私有范围待确认，不推断整个Bucket，不自动更改 |
| 版本控制状态 | 未启用/开启/暂停；决定是否保存/固定 versionId | 用户记录未启用，versionId=null；仍唯一Key/防覆盖 |
| 存储类型/加密 | 是否标准/归档等；是否有KMS等额外要求/费用 | 待核查，不默认开通新功能 |
| 运行环境与网络模式 | Windows本机测试还是同地域杭州服务器 | 下一阶段先本地，服务器验证另安排 |
| 最小权限身份 | RAM用户调用AssumeRole，STS按用途收窄 | 用户确认Get/Put/List策略同时绑定RAM用户和角色；角色信任/AssumeRole及权限实效待验 |
| 私密凭据读取位置 | 后端仅运行时读取，不贴秘密到对话/Git | oss.json和ARN.txt本地存在，本轮未读取值 |
| STS刷新方式 | 保存Expiration、提前刷新与并发合并 | 程序尚未实现，不把静态token当永久凭据 |
| 播放域名/HTTPS/CORS | 固定HTTPS媒体域名、可信来源与Range读取 | OSS证书已生效且样例HEAD/TLS通过；CORS跨域与签名Range/续签仍待验，网站证书另处理 |
| 实际上传/读取验收授权 | 指定新对象前缀、操作范围和是否允许公网费用 | 必须在实际调用前明确 |
| 应用控制/时区 | 上传大小/并发、签发频率、应用播放会话及统计日 | 待确认；oss实际字节未知，不能套用proxy硬限额或把未知显示为不限额 |
| FFprobe路径/手机样例 | 核验编码/大小/时长/方向及兼容性 | 已有远程MP4样例；本地上传路径/分析器及编码元数据仍待提供/核验 |

AccessKey Secret、STS Token、账号密码/TOTP、auth.key 不属于可公开材料；只告诉新对话负责人“私密文件已就绪及路径”，不要把真实值写到任务板、SQL、源码或日志。

## 3. Endpoint 及当前接入边界

| 场景 | 杭州 Endpoint | 本项目行为 |
| --- | --- | --- |
| 本地不接云 | 无 | 默认显式 Mock，用真SQL/鉴权验证业务 |
| 同地域杭州轻量服务器 | https://oss-cn-hangzhou-internal.aliyuncs.com | 官方说明同地域默认内网互通，实际网络/策略要在服务器验证 |
| 本机授权公网测试 | https://oss-cn-hangzhou.aliyuncs.com | 显式public用于服务端上传/HEAD/导入，先确认调用范围/费用 |
| 浏览器直连播放/下载 | 固定oss.meetdawn.top媒体域名 | 独立签名client、cname=true，不随上传内网/公网切换；生产需HTTPS |

Windows 本机不能当成杭州服务器内网。内网失败不自动用公网，公网失败不自动降为匿名访问或Mock。现有 core/readConfig 仍对 STORAGE_DRIVER=oss 报未接入；这些参数必须先由 P2-CORE-05 与 P2-MEDIA-01 实现并验证，不能现在只改 .env 就期待云接入。

下一阶段拟读取的非敏感配置（杭州部署示例，未写入实际.env；本地受控验收改为公网Endpoint、OSS_NETWORK=public及显式允许公网）：

```dotenv
STORAGE_DRIVER=oss
PLAYBACK_MODE=oss
OSS_REGION=cn-hangzhou
OSS_BUCKET=xzlbucket
OSS_OBJECT_PREFIX=onlineVideo/
OSS_ENDPOINT=https://oss-cn-hangzhou-internal.aliyuncs.com
OSS_NETWORK=internal
OSS_ALLOW_PUBLIC_NETWORK=false
OSS_CREDENTIAL_FILE=E:/onlineVideo/.local/secrets/oss.json
# 固定媒体域名，样例HTTPS已验证；程序STS/V4签名仍待接入
OSS_PLAYBACK_ENDPOINT=https://oss.meetdawn.top
OSS_ROLE_ARN_FILE=E:/onlineVideo/.local/secrets/ARN.txt
# 也可用OSS_ROLE_ARN；二者互斥/校验由P2-CORE-01冻结，不读取错误文件或静默回退
OSS_STS_DURATION_SECONDS=3600
OSS_STS_REFRESH_BEFORE_SECONDS=300
OSS_SIGNED_URL_TTL_SECONDS=3600
# TRANSFER_LIMIT_BYTES=仅proxy实际字节控制，不能用它承诺oss下行硬封顶
# MAX_PLAYBACK_SESSIONS=先明确活动播放数量
# USAGE_TIMEZONE=先明确统计时区
```

本地回环HTTP页面使用已生效的https://oss.meetdawn.top媒体端点；签名端点不随上传内网/公网切换，不回退HTTP。网站HTTPS部署在第三阶段处理，不阻塞本机开发。

私密文件**格式示例**（这里只是占位符，不创建实际文件、不含真实密钥）：

```json
{
  "accessKeyId": "YOUR_RAM_ACCESS_KEY_ID",
  "accessKeySecret": "YOUR_RAM_ACCESS_KEY_SECRET"
}
```

oss.json保留用户已有长期RAM AK格式；STS临时凭据由服务端AssumeRole提供者获取并按Expiration缓存，不要求用户把临时token手工写回。用户确认策略已绑定角色，优先同角色的上传/导入用途STS和收窄只读用途STS，缓存按角色/用途/Policy隔离；不要求另建角色。轻量服务器不默认具备ECSRAMRole。示例均为待实现配置，当前没有根.env，修改示例不等于运行可用。

签名期限上限3600秒，实际取STS剩余有效期与URL期限最小值并留时钟余量，返回sourceExpiresAt供前端续签；刷新STS不会延长旧URL，URL到期不等于已经建立的传输立即终止。

## 4. 最小权限需求

| 操作 | 常见所需 OSS Action | 授权范围 |
| --- | --- | --- |
| 读取/HEAD视频及封面 | oss:GetObject | 指定Bucket及对象前缀 |
| 初始化/上传Part/完成Multipart | oss:PutObject | 指定Bucket及唯一新对象前缀 |
| 预览已有对象 | oss:ListObjects | 指定Bucket资源，并用 oss:Prefix 条件限制目录 |
| 读取对象ACL（管理核验时可选） | oss:GetObjectAcl | 仅必要对象范围，不授予写ACL |

按实际使用的 API 对照官方 Action 表核验。只用已知Bucket的服务端 SDK，不需要为了官网 listBuckets 示例授予所有Bucket列表权限，更不建议直接授予 AliyunOSSFullAccess。列举权限的 Resource 是 Bucket，本身的前缀限制要通过 Condition；对象读写 Resource 则具体到前缀对象范围。

提供的[策略JSON](task/自定义策略的json.txt)在对象资源`xzlbucket/onlineVideo/*`上允许GetObject/PutObject，在Bucket资源上允许ListObjects并限制Prefix为onlineVideo/*，不包含删除/改ACL授权；JSON结构与范围已只读核验，用户明确确认同时绑定RAM用户和角色。角色信任和实际AssumeRole/上传仍需验收。复用同角色时，AssumeRole的Policy分别收窄用途，最终权限是角色策略与会话策略交集，不自动改云权限。

业务“标签”保存于SQLite，本阶段不调用OSS Object Tagging，不需要为业务标签额外授予 PutObjectTagging。若Bucket已有KMS等要求，附加权限须另核查，不默认开启或扩大授权。默认不授予 DeleteObject、AbortMultipartUpload、修改Bucket ACL/Policy等动作；分片/对象清理要单独说明范围并经用户确认。

版本控制开启/暂停时，官方说明 CompleteMultipartUpload 的 x-oss-forbid-overwrite 头无效；必须采用唯一对象Key、数据库操作幂等及版本ID校验，不把这个头当绝对防覆盖。返回Location/ETag/versionId要验证后登记，ETag不等于逐片SHA-256。

## 5. 视频地址、分类与费用

上传后私有对象由Bucket/地域/Key/可选版本长期定位，不保存签名URL为永久属性。播放/下载按videoId鉴权后返回固定媒体域名的STS/V4签名；封面可保留受保护站内小流量读取。签名URL在有效期内可重复访问，不依赖站点Cookie；退出/撤销只能拒绝后续发放/续签，不能承诺立即废止旧URL。

分组/标签都与视频ID关联，视频ID再关联对象定位。改分类、分组名称或标签不会搬动OSS文件，避免重复对象和无关云写入。既有文件导入也只登记选中对象，不复制/删除原对象或改ACL。

同地域轻量服务器内网访问不收取该链路的流量费用，存储/请求及服务器套餐仍要核查；本机公网读取可能产生OSS外网流出费用。40GB存储资源包不能当作40GB观看流量或总费用封顶。真实调用前明确预算与范围；不用应用统计或云告警替代实际账单。

直连观看/下载产生OSS外网下行，应用侧当前无法测得实际观看字节；先显示未知/未同步与授权会话指标。云日志/监控是后续明确任务，不自动开通服务或套用proxy字节预留作为直连硬封顶。

## 6. 官方来源

- [Node.js SDK 初始化 / V4 /地域与Endpoint](https://help.aliyun.com/zh/oss/initialization-10)
- [OSS Node.js SDK 文档入口](https://help.aliyun.com/zh/oss/developer-reference/nodejs-sdk/)
- [RAM Policy 前缀权限与SDK/控制台区别](https://help.aliyun.com/zh/oss/user-guide/access-control-base-on-ram-policy)
- [初始化 Multipart 与所需Action](https://help.aliyun.com/zh/oss/developer-reference/initiatemultipartupload)
- [完成 Multipart、Location/版本ID/防覆盖边界](https://help.aliyun.com/zh/oss/developer-reference/completemultipartupload)
- [私有对象预签名URL及有效期](https://help.aliyun.com/zh/oss/user-guide/how-to-obtain-the-url-of-a-single-object-or-the-urls-of-multiple-objects)
- [轻量服务器通过同地域OSS内网访问](https://help.aliyun.com/zh/simple-application-server/use-cases/implement-service-interconnection-over-the-internal-endpoint-of-an-oss-resource)
- [Node.js V4下载签名与HTTPS](https://help.aliyun.com/en/oss/developer-reference/download-objects-using-a-presigned-url-generated-with-oss-sdk-for-node-js)
- [STS缓存与签名有效期取最小值](https://help.aliyun.com/zh/oss/developer-reference/authorize-access-6)
- [AssumeRole信任关系与会话策略交集](https://help.aliyun.com/zh/ram/developer-reference/api-sts-2015-04-01-assumerole)
- [Node.js流式上传 putStream](https://help.aliyun.com/zh/oss/developer-reference/streaming-upload-1)

## 7. 当前剩余准备与阶段交接

Bucket、前缀、AK文件、角色ARN、Get/Put/List策略、OSS证书与公开远程样例已准备，无需重复创建/申请。剩余为本人私有业务范围、角色信任/STS实效、CORS、运行限额/本地上传样例/分析器、根.env及测试范围/费用；可在第二阶段按卡推进，详见[启动清单](archive/OSS_LOCAL_TEST_PLAN.md#6-新对话启动第二阶段的剩余事项)。

第二阶段完成后可在Windows本机用公网Endpoint测试真实OSS上传/播放/下载，是否通过由P2-MEDIA-05输出决定。HTTPS样例可访问不等于私有STS授权通过；实云验收须分别验证匿名拒绝、有效签名读取、上传/登记/续签。服务器内网、网站HTTPS/安卓、备份/更新与续期运维归第三阶段。

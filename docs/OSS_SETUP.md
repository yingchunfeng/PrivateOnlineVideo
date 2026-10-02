# OSS 接入需要的材料与 SDK

核验日期：2026-10-02。通过阿里云官方文档联网核验；本文是下一阶段材料清单，不表示已访问/配置用户 Bucket。

## 1. SDK 选哪一种

本项目后端是 **Node.js + TypeScript + Fastify**，选 **OSS Node.js SDK，npm 包 ali-oss**。不用 Python/oss2，也不让前端直接接入长期密钥或 OSS SDK。浏览器上传到站内 API，由 Node 后端上传 OSS；视频同样经后端鉴权转发（A/proxy）。

现有工程已经锁定 `ali-oss@6.23.0`、`@types/ali-oss@6.23.3`，不是“还需下载一个独立桌面 SDK”。下次开发先核对实际 package.json/锁文件；如需升级，由主控/子代理 1 核验兼容性并串行安装，不并发执行 npm，不随意改 Python 技术栈。FFprobe 是视频分析可执行程序，不是 Python OSS SDK。

官方初始化推荐显式 `authorizationV4: true`；配置层可用业务地域 `cn-hangzhou`，SDK 构造参数按官网写为 `oss-cn-hangzhou`。本地已安装 SDK 的签名标准地域函数会去掉 oss- 前缀，但下一阶段仍须统一这层转换与测试，不能让三个代理各自填不同值。

## 2. 需要你准备什么

| 材料 | 用途/填写方式 | 当前状态 |
| --- | --- | --- |
| Bucket 名称 | 控制台实际私有 Bucket 名称 | 待用户提供非秘密名称 |
| 地域 | 已确认杭州：cn-hangzhou | 已知，仍与实际 Bucket 核对 |
| 授权对象前缀 | 应用可读写范围，目录边界以 / 结束，如 library/；不要整个Bucket无差别授权 | library/仅是现有Mock示例，真实范围待确认 |
| 既有视频导入前缀 | 只允许预览/选中此范围下的对象 | 待确认，不全Bucket扫描 |
| Bucket/Object ACL 与现有 Policy | 保证非匿名公开；了解已有其他使用方/网络限制 | 待本人控制台核查，不自动更改 |
| 版本控制状态 | 未启用/开启/暂停；决定是否保存/固定 versionId | 待核查 |
| 存储类型/加密 | 是否标准/归档等；是否有KMS等额外要求/费用 | 待核查，不默认开通新功能 |
| 运行环境与网络模式 | Windows本机测试还是同地域杭州服务器 | 下一阶段先本地，服务器验证另安排 |
| 最小权限身份 | RAM用户AK，或已验证可用的角色/STS提供者 | 待配置；不使用主账号AK |
| 私密凭据读取位置 | 后端仅运行时读 .local/secrets/oss.json 或受保护提供者 | 待用户在本机创建，不贴秘密到对话/Git |
| STS刷新方式（使用STS时） | accessKeyId、accessKeySecret、stsToken、有效期及可信刷新来源 | 不把一次临时token当永久凭据 |
| 实际上传/读取验收授权 | 指定新对象前缀、操作范围和是否允许公网费用 | 必须在实际调用前明确 |
| 应用流量/并发/时区 | 确定字节预算、活动播放数量和统计日 | 待确认；缺失不能解释为不限额 |
| FFprobe路径/手机样例 | 核验内容编码、大小、方向及兼容性 | 按后续样例验证，未默认安装 |

AccessKey Secret、STS Token、账号密码/TOTP、auth.key 不属于可公开材料；只告诉新对话负责人“私密文件已就绪及路径”，不要把真实值写到任务板、SQL、源码或日志。

## 3. Endpoint 及当前接入边界

| 场景 | 杭州 Endpoint | 本项目行为 |
| --- | --- | --- |
| 本地不接云 | 无 | 默认显式 Mock，用真SQL/鉴权验证业务 |
| 同地域杭州轻量服务器 | https://oss-cn-hangzhou-internal.aliyuncs.com | 官方说明同地域默认内网互通，实际网络/策略要在服务器验证 |
| 本机授权公网测试 | https://oss-cn-hangzhou.aliyuncs.com | 显式 public + 允许开关 + 用户费用/调用范围确认；仍是后端proxy，不是B |

Windows 本机不能当成杭州服务器内网。内网失败不自动用公网，公网失败不自动降为匿名访问或Mock。现有 core/readConfig 仍对 STORAGE_DRIVER=oss 报未接入；这些参数必须先由 P2-CORE-05 与 P2-MEDIA-01 实现并验证，不能现在只改 .env 就期待云接入。

下一阶段拟读取的非敏感配置（示例，未写入实际 .env）：

```dotenv
STORAGE_DRIVER=oss
PLAYBACK_MODE=proxy
OSS_REGION=cn-hangzhou
OSS_BUCKET=填写本人Bucket名称
OSS_OBJECT_PREFIX=填写已授权前缀/
OSS_ENDPOINT=https://oss-cn-hangzhou-internal.aliyuncs.com
OSS_NETWORK=internal
OSS_ALLOW_PUBLIC_NETWORK=false
OSS_CREDENTIAL_FILE=E:/onlineVideo/.local/secrets/oss.json
# TRANSFER_LIMIT_BYTES=先明确实际非负整数预算
# MAX_PLAYBACK_SESSIONS=先明确活动播放数量
# USAGE_TIMEZONE=先明确统计时区
```

私密文件**格式示例**（这里只是占位符，不创建实际文件、不含真实密钥）：

```json
{
  "accessKeyId": "YOUR_RAM_ACCESS_KEY_ID",
  "accessKeySecret": "YOUR_RAM_ACCESS_KEY_SECRET"
}
```

使用STS时再有 `stsToken`，并实现可信刷新/过期失败；现有静态文件读取不等于已有自动刷新功能。轻量服务器不要直接假设具备 ECSRAMRole，实际身份提供方式须先核实。文件权限参考 .local 的受保护ACL，部署环境再明确 secret 挂载，不注入前端构建产物。

## 4. 最小权限需求

| 操作 | 常见所需 OSS Action | 授权范围 |
| --- | --- | --- |
| 读取/HEAD视频及封面 | oss:GetObject | 指定Bucket及对象前缀 |
| 初始化/上传Part/完成Multipart | oss:PutObject | 指定Bucket及唯一新对象前缀 |
| 预览已有对象 | oss:ListObjects | 指定Bucket资源，并用 oss:Prefix 条件限制目录 |
| 读取对象ACL（管理核验时可选） | oss:GetObjectAcl | 仅必要对象范围，不授予写ACL |

按实际使用的 API 对照官方 Action 表核验。只用已知Bucket的服务端 SDK，不需要为了官网 listBuckets 示例授予所有Bucket列表权限，更不建议直接授予 AliyunOSSFullAccess。列举权限的 Resource 是 Bucket，本身的前缀限制要通过 Condition；对象读写 Resource 则具体到前缀对象范围。

业务“标签”保存于SQLite，本阶段不调用OSS Object Tagging，不需要为业务标签额外授予 PutObjectTagging。若Bucket已有KMS等要求，附加权限须另核查，不默认开启或扩大授权。默认不授予 DeleteObject、AbortMultipartUpload、修改Bucket ACL/Policy等动作；分片/对象清理要单独说明范围并经用户确认。

版本控制开启/暂停时，官方说明 CompleteMultipartUpload 的 x-oss-forbid-overwrite 头无效；必须采用唯一对象Key、数据库操作幂等及版本ID校验，不把这个头当绝对防覆盖。返回Location/ETag/versionId要验证后登记，ETag不等于逐片SHA-256。

## 5. 视频地址、分类与费用

上传成功通常有对象地址/Location，但私有对象不是可匿名播放的公开文件。数据库长期保存 Bucket + 地域 + Key + 可选版本；前端只拿站内受保护 stream/thumbnail 地址。签名URL有期限，不是永久元数据；本阶段不启用B、不生成前端直连授权。

分组/标签都与视频ID关联，视频ID再关联对象定位。改分类、分组名称或标签不会搬动OSS文件，避免重复对象和无关云写入。既有文件导入也只登记选中对象，不复制/删除原对象或改ACL。

同地域轻量服务器内网访问不收取该链路的流量费用，存储/请求及服务器套餐仍要核查；本机公网读取可能产生OSS外网流出费用。40GB存储资源包不能当作40GB观看流量或总费用封顶。真实调用前明确预算与范围；不用应用统计或云告警替代实际账单。

## 6. 官方来源

- [Node.js SDK 初始化 / V4 /地域与Endpoint](https://help.aliyun.com/zh/oss/initialization-10)
- [OSS Node.js SDK 文档入口](https://help.aliyun.com/zh/oss/developer-reference/nodejs-sdk/)
- [RAM Policy 前缀权限与SDK/控制台区别](https://help.aliyun.com/zh/oss/user-guide/access-control-base-on-ram-policy)
- [初始化 Multipart 与所需Action](https://help.aliyun.com/zh/oss/developer-reference/initiatemultipartupload)
- [完成 Multipart、Location/版本ID/防覆盖边界](https://help.aliyun.com/zh/oss/developer-reference/completemultipartupload)
- [私有对象预签名URL及有效期](https://help.aliyun.com/zh/oss/user-guide/how-to-obtain-the-url-of-a-single-object-or-the-urls-of-multiple-objects)
- [轻量服务器通过同地域OSS内网访问](https://help.aliyun.com/zh/simple-application-server/use-cases/implement-service-interconnection-over-the-internal-endpoint-of-an-oss-resource)

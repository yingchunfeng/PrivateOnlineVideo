## 最新交接补充（2026-10-02）

- OSS媒体域名已升级为`https://oss.meetdawn.top`，证书已生效；用户样例`onlineVideo/96257570ce7bc1f46e749df9ab2598f7.mp4`独立匿名HEAD返回200、TLS校验通过、大小329035字节，证书到期2026-12-30 23:59:59 UTC。
- 用户确认样例为公共读，匿名访问符合该权限；它可用于HTTPS/格式/Range参考，不作为私有STS授权已验收的证据。本人视频/新上传的私有范围仍需确认，不能擅自改现有样例或整个Bucket。
- 自定义策略实际包含GetObject/PutObject及受onlineVideo前缀限制的ListObjects，用户确认绑定RAM用户和角色；角色信任/STS实效仍由第二阶段核验，不重复创建身份。
- 当前可以开启第二阶段代码开发；剩余材料及运行/实云验收边界见[最新启动清单](../OSS_LOCAL_TEST_PLAN.md#6-新对话启动第二阶段的剩余事项)，实施入口为[STAGE2](STAGE2.md)。网站自己的域名/证书与服务器部署归第三阶段。
- 下文保留原始准备记录；HTTP端点、旧signatureUrl/高层multipartUpload等具体实现，以最新[架构评审](STAGE2_ARCHITECTURE_REVIEW.md)和[契约提案](../STAGE2_API_CONTRACT.md)为准，签名改用V4、上传复用流式分片协议。

## 一、已完成的云侧配置


> **历史归档（2026-10-26）**：原位置 `docs/task/OSS和框架调整相关.md`。以下保留历史设计与完成记录，不作为当前任务指令；当前工作见[未完成工作清单](../../task/UNFINISHED_WORK.md)，归档范围见[归档索引](../README.md)。
- **Bucket**：`xzlbucket`，地域杭州 `cn-hangzhou`。
- **RAM 用户**：已创建独立 RAM 用户，长期 AK 已写入 `E:/onlineVideo/.local/secrets/oss.json`，格式为 `{ accessKeyId, accessKeySecret }`。不要提交到 Git，不要打印到日志。
- **RAM 角色**：已创建角色，并授予了只允许 `onlineVideo/` 前缀下 `oss:GetObject` 的自定义策略。角色ARN 为：`E:/onlineVideo/.local/secrets/ARN.txt` 放在这个文件中了。
- **RAM 用户额外权限**：该用户已添加系统策略 `AliyunSTSAssumeRoleAccess`，可调用 AssumeRole 获取临时凭证。
- **版本控制**：未开启，无需处理 `versionId` 或 `x-oss-forbid-overwrite`。
- **自定义域名**：`http://oss.meetdawn.top` 已绑定到 OSS，CNAME 已生效，CORS 已配置。
- **依赖已安装**：`ali-oss@6.23.0`、`@types/ali-oss@6.23.3`、`@fastify/multipart`。

## 二、目标架构（重要）

采用混合架构，彻底解决 3M 服务器带宽瓶颈：

1. **上传**：浏览器 → Node.js 服务器（接收文件流）→ 通过内网 Endpoint 上传到 OSS。服务器到 OSS 走内网，不产生外网流量费。
2. **播放/下载**：前端请求 Node.js 服务器 → 服务器用 STS 临时凭证生成签名 URL（有效期 1 小时）→ 前端拿到 URL 后**直接访问 http://oss.meetdawn.top/... 播放**。视频流量走 OSS 外网，不占用服务器带宽。
3. **服务器只负责**：页面、登录、鉴权、调用 STS、生成签名 URL、保存视频元数据到数据库。

## 三、代码实现要求

### 1. STS 临时凭证

- 服务器使用 RAM 用户的长期 AK，调用 `AssumeRole` 接口，扮演上面提供的角色 ARN，获取临时凭证（包含 `AccessKeyId`、`AccessKeySecret`、`SecurityToken`）。
- 缓存临时凭证，在过期前刷新（比如有效期 3600 秒，提前 5 分钟刷新）。不要每次请求都调用 AssumeRole。
- 用临时凭证初始化 `ali-oss` 客户端，不要用长期 AK 生成签名 URL。

### 2. 双 OSS Client 或动态 Client

- **上传 Client**：用于服务端上传、读取、管理文件。`endpoint` 从环境变量 `OSS_ENDPOINT` 读取，不要硬编码。本地开发时我在 `.env` 里设为公网 `https://oss-cn-hangzhou.aliyuncs.com`；部署到杭州轻量服务器后，我会改为内网 `https://oss-cn-hangzhou-internal.aliyuncs.com`。
- **签名 Client**：专门用于生成给前端访问的签名 URL。它的 `endpoint` 始终为 `http://oss.meetdawn.top`，并且必须开启 `cname: true`。这个 Client 不随环境切换。
- 如果使用 STS，建议用临时凭证分别初始化两个 Client，或者封装一个根据用途返回 Client 的函数。

### 3. 上传接口

- 用 `@fastify/multipart` 接收文件流，拼接 `onlineVideo/` 前缀，调用上传 Client 的 `multipartUpload()`，不要先落本地磁盘。
- 上传成功后，将视频元数据（Object Key、ETag、标题、大小、时长等）保存到 SQLite。不要保存签名 URL。

### 4. 播放接口

- 实现一个接口，接收 Object Key，用签名 Client 的 `signatureUrl()` 生成有效期 1 小时的签名 URL，返回给前端。
- 前端用这个 URL 直接播放，不再经过服务器代理

### 5. 环境变量与启动日志

- 在初始化 Client 时打印当前使用的 OSS Endpoint（不打印密钥），方便我确认本地是否成功切换到公网。
- `.env` 示例：

dotenv

```
STORAGE_DRIVER=oss
PLAYBACK_MODE=oss
OSS_REGION=cn-hangzhou
OSS_BUCKET=xzlbucket
OSS_OBJECT_PREFIX=onlineVideo/
OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
OSS_CREDENTIAL_FILE=E:/onlineVideo/.local/secrets/oss.json
OSS_ROLE_ARN=【在此粘贴你复制的角色ARN】（请确保是完整 ARN，以 acs:ram:: 开头）
```

### 6. 安全底线

- 长期 AK 和 STS 临时凭证严禁硬编码，严禁打印到日志。
- `.local/` 和 `.env` 严禁提交到 Git。
- 所有对象 Key 必须严格以 `onlineVideo/` 开头。

### 7. 其他

- 如果遇到 `STORAGE_DRIVER=oss` 未接入的逻辑，按 `OSS_SETUP.md` 的规划实现，不要只改 `.env`。
- FFprobe 可选，如果实现视频分析，请确保调用路径可配置。

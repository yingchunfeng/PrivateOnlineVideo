# CORE-01 交接：工程骨架与公共契约

后续进展：用户确认本基线后已启动媒体/前端并行开发；当前模块与命令见 [并行开发交接](PARALLEL_DEVELOPMENT_HANDOFF.md)。本文件保留 CORE-01 当时的交付记录。

日期：2026-10-01  
任务：CORE-01 已完成，本轮没有进入 CORE-02～06、MEDIA 或 WEB 开发。  
当前业务能力：仅 `GET /api/health`；其余路由只有类型/接入约定，不能视为已实现。  
接口依据：[API_CONTRACT.md](API_CONTRACT.md)，任务回写：[01-backend.md](../.ai/demand/01-backend.md)。

## 1. 实际目录和包

```text
E:\onlineVideo\
  package.json / package-lock.json / .npmrc / tsconfig.base.json
  .env.example / .gitignore
  packages/shared/
    package.json / tsconfig.json / tsconfig.browser-check.json
    src/index.ts / dto.ts / errors.ts
    test/browser-consumer.ts
    dist/                     已生成的 JS 与声明
  apps/api/
    package.json / tsconfig.json / tsconfig.check.json
    src/app.ts                buildApp，不监听端口
    src/server.ts             CLI 启动及正常退出信号
    src/core/config.ts / errors.ts / start.ts
    src/core/contracts/index.ts / repositories.ts / storage.ts / media.ts
    test/core.test.ts / helpers/media-dependencies.ts
    dist/                     已生成的后端 JS 与 source map
  docs/API_CONTRACT.md / CORE01_HANDOFF.md
```

`apps/web/` 仍由子代理 3 创建，`apps/api/src/modules/media/` 仍由子代理 2 创建；本轮没有创建这两个实现目录。工作区使用 `packages/*`、`apps/*`，前端缺席时照常安装、检查、构建。根目录 build 当前只构建 shared 和 api，WEB-01 交付后由主控增加前端构建命令；typecheck/test 会执行已有工作区的同名脚本。

包名：`@online-video/shared`、`@online-video/api`；后续前端建议 `@online-video/web`。前端依赖共享包时使用 `"@online-video/shared": "0.1.0"`，npm 将链接工作区。只从公共出口导入：

```ts
import { PART_CHECKSUM_HEADER, isPartChecksum } from "@online-video/shared";
import type { VideoDetail, UploadTask, ApplicationUsage, ErrorResponse } from "@online-video/shared";
```

服务端接口从 `apps/api/src/core/contracts/index.ts` 引用（ESM 源码相对导入使用 `.js` 后缀）。服务端流、对象 key、ETag、主体/会话及 Repository 均不在 shared 中，前端不能引用这些文件。浏览器消费者验证使用 DOM lib 与 `types: []`。

## 2. 媒体注册和注入

子代理 2 导出 `registerMediaModule: MediaModule`：

```ts
import type { MediaModule } from "../../core/contracts/index.js";

export const registerMediaModule: MediaModule = async (app, dependencies) => {
  // 完整 /api 路由；每个敏感请求显式调用 AuthGuard。
  // 实现在 MEDIA 任务中完成。
};
```

注册签名为 `(app: FastifyInstance, dependencies: MediaDependencies) => Promise<void>`。不使用默认放行鉴权，不自行监听端口，不额外叠加 `/api` 前缀。主控/后端负责装配：

```ts
const config = readConfig(/* 正式装配或测试所需的明确配置 */);
const dependencies: MediaDependencies = {
  kind: "test", // 本地测试；真实生产装配由 CORE-06 交付
  auth, videos, uploads, playback, usage, storage,
  config,
  now: () => new Date()
};
const app = await buildApp({
  config,
  media: { register: registerMediaModule, dependencies }
});
```

上述示例中的接口实现由各负责人提供；不是当前已有的业务实例。必须传同一份 config 对象。注册前检查所有必要方法、依赖标记、存储驱动、流量及并发配置；缺失直接报 ConfigurationError。目前 NODE_ENV=production 无条件拒绝装配，生产安全接入属于 CORE-06。

| 接口 | 已冻结边界 | 后续实现 |
| --- | --- | --- |
| AuthGuard | requireUser(request, { mutation }) 返回主体；验证过期/撤销、写操作 CSRF/来源 | CORE-03 |
| VideoRepository | findOwned/register/updateMedia；内部对象引用与公开 DTO 分离 | CORE-02/04 |
| UploadRepository | create/findOwned/savePart/transition；编号幂等、冲突拒绝、CAS 完成 | CORE-02 |
| PlaybackRepository | create 原子检查并发；findActive 绑定账户/登录会话/视频/有效期；heartbeat/close | CORE-02/05 |
| UsageRepository | read/reserve/settle；在途额度原子预留、实际发送量幂等结算、剩余额度释放 | CORE-02，MEDIA-03 使用 |
| StorageAdapter | head/openRead/createMultipart/uploadPart/completeMultipart/list；每次 I/O 带 AbortSignal | MEDIA-01 |

`ByteRange` 为含两端的字节区间。媒体模块负责 HTTP Range、鉴权、背压、断开取消、分片校验和传输计量；存储适配器只负责受控对象 I/O。不得删除对象、覆盖原片或自动切换 OSS 公网地址。用量预留不能由“读计数后写计数”替代，发送前先占额度，断开后结算实际已发送字节；统计周期是 `[start, end)`。

可用测试入口：`apps/api/test/helpers/media-dependencies.ts` 的 `createTestMediaDependencies(config, overrides)`。返回 `kind: "test"` 的可替换接口；默认鉴权返回 AUTH_REQUIRED，仓储返回 SERVICE_NOT_CONFIGURED，存储返回 STORAGE_UNAVAILABLE。它是失败安全的测试替身骨架，完整内存 Mock 存储由 MEDIA-01 实现，真实 Repository 留给 CORE-02。需要成功场景时只在测试内显式替换接口，不装配到生产。

## 3. DTO、checksum 和错误

共享 DTO/request/response 在 `packages/shared/src/dto.ts`；每个 JSON 业务使用 `ApiResponse<T> = { data: T }`，分页为 `Page<T> = { items, page, pageSize, total }`。响应错误为 `{ error: { code, message, requestId } }`。原始分片请求体、视频/封面响应流不包 JSON。

- 视频状态：processing、ready、unsupported、failed。
- 上传状态：uploading、finalizing、completed、failed。暂停是客户端行为；重试/状态转换由媒体任务实现。
- durationSeconds、codec、width、height 未采集时为 null；thumbnailUrl 不存在为 null；未登记视频的 UploadTask.videoId 为 null。categoryId 使用默认分类 ID，不为 null；没有观看记录时位置为 0，WatchProgress.updatedAt 为 null。
- 时间输出 UTC ISO 8601；统计时区单独携带 IANA 名称。字节数为非负安全整数，单位 byte；秒允许非负小数。API 路径为 `/api/...` 相对地址，不返回 OSS 对象 key 或长期密钥。
- A 模式只有 `proxy`，类型中没有 oss_direct。播放会话 ID 只关联计量/并发，不代替 Cookie 授权。
- `ApplicationUsage.limitMode` 必填：limited 时 limitBytes 为数字（0 禁止传输）；unconfigured 时为 null 且拒绝传输；只有显式 unlimited 的 null 才表示不限应用字节总量。鉴权/并发仍然必须检查。

分片 checksum 为 SHA-256、64 位小写 hex，经 `x-part-checksum` 头传递；分片 PUT 同时携带 `x-csrf-token`，Content-Type 为 application/octet-stream。编号从 1 开始，每片原始字节独立计算。前端按 File.slice() 计算，不能读整个大视频；恢复时重新校验所有已完成分片的大小/checksum。媒体模块对收到的数据重算，格式错误报 VALIDATION_ERROR，字节不匹配报 FILE_MISMATCH；存储和校验都成功后才 savePart。不将 ETag 当成 checksum，客户端不提交对象 key、OSS upload ID 或 ETag 完成清单。

公共错误表 `ERROR_DEFINITIONS` 是 code → HTTP status/安全消息的统一来源：400 参数、401 会话、403 权限/CSRF、404 资源、409 上传冲突/文件不匹配、413 大小、415 内容类型、416 Range、429 请求/并发/流量、500 INTERNAL_ERROR、503 存储/配置。内部异常原文和堆栈不返回。requestId 服务端随机生成，不信任客户端传入 ID。响应开始后的流错误只中止流，由媒体层取消上游并结算，不追加 JSON。

登录和 me 返回 `{ data: { user, csrfToken } }`；退出/撤销/关闭播放返回 success:true。完整上传返回 `{ data: { upload, video } }`；导入预览 ID 与条目 ID 由服务端维护，导入提交只接受选中 ID，再次检查授权范围和对象存在性。对应类型均已导出，路由实现留待后续任务。

## 4. 配置和端口

| 环境变量 | 当前默认与行为 |
| --- | --- |
| NODE_ENV | development；允许 test；production 当前明确拒绝启动 |
| API_HOST / API_PORT | 127.0.0.1 / 3000；端口 1～65535，主机需为明确 IP |
| LOG_LEVEL | info；Pino，记录路由模板、状态、耗时、关联 ID，排除原始 URL/请求体/凭证 |
| PLAYBACK_MODE | proxy；其他值报错 |
| STORAGE_DRIVER | mock；枚举 mock/oss，oss 当前未实现并报错，绝不连接真实服务或回退公网 |
| USAGE_TIMEZONE | UTC，仅作本地测试默认；真实预算与时区在正式使用前由用户确定 |
| TRANSFER_LIMIT_BYTES | 未配置；拒绝媒体注册。整数（含 0）为明确限额，unlimited 为显式不限额 |
| MAX_PLAYBACK_SESSIONS | 未配置；拒绝媒体注册。设置后须为正安全整数 |

health 骨架不要求流量/并发配置、不访问数据库或 OSS。配置空白、拼错、越界不静默回退。`.env.example` 没有凭证；在根目录新建 `.env` 可启用，已有 `.env` 不覆盖。dev/start 自动加载根目录 `.env`，进程环境变量优先；缺失 .env 时 Node 会提示并继续使用安全本地默认。

后续 Vite 约定：`host: "127.0.0.1"`、`port: 5173`、`strictPort: true`、`proxy: { "/api": { target: "http://127.0.0.1:3000" } }`。浏览器请求相对 `/api`，Cookie 同源发送；不启用宽松 CORS 代替来源校验。前端改为手机 LAN 验证时，由主控明确调整监听地址和可信来源。Cookie 的开发/生产安全设置留给 CORE-03，不能把本地 HTTP 例外永久用于生产。

端口占用时，正常只读排查（视本机权限使用其一）：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000 | Select-Object LocalAddress,LocalPort,OwningProcess
netstat -ano -p tcp | Select-String ':3000\s'
```

EADDRINUSE 会明确报告占用地址并退出/使开发 watch 等待修改，不终止占用进程或自动换端口。若用户明确改 API_PORT，Vite 代理目标也要同步。

## 5. 可复制命令

在 PowerShell 中执行，Node.js 本轮基线为 22.21.1，支持约束为 `>=22.21.1 <23`；npm 10（本机 10.9.4）。不依赖 Docker、Nginx、SQLite CLI 或用户的 G:\software\SQLite。

```powershell
Set-Location E:\onlineVideo
npm install --ignore-scripts --no-fund
npm run check
```

检查可分别执行：

```powershell
npm run typecheck
npm test
npm run build
npm ls --depth=0
```

开发启动（前台长期运行）：

```powershell
npm run dev:api
```

另一终端健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health
```

编译产物启动（先 build；这是本地运行，不是部署或生产安全装配）：

```powershell
npm run build
npm run start:api
```

单独工作区命令在新安装后先构建 shared：`npm run build -w @online-video/shared`，然后可运行 `npm run typecheck -w @online-video/api` 或 `npm run build -w @online-video/api`。共享源码变化后需要重建 shared；当前 dev:api 只在启动时构建共享包。

所有依赖修改和锁文件更新由主控/后端串行执行。其他代理提交精确版本依赖清单，不并发安装，不直接改 package-lock.json。当前依赖直接版本固定，传递依赖由锁文件固定；`.npmrc` 使用官方 registry、项目内 `.npm-cache`，避免用户全局 Program Files 缓存的写权限问题。已使用 ignore-scripts 安装且实际 tsx 运行通过。全新检出时可使用 `npm ci --ignore-scripts` 按锁安装；已有工作区不要以清理/重装为由擅自执行它，因为 npm ci 会移除现有 node_modules。

## 6. 实际验证与范围

| 检查 | 实际结果 |
| --- | --- |
| npm install --no-fund --ignore-scripts | 成功，新增 57 个包，审计 60 个包、0 漏洞（执行时结果） |
| npm ls --depth=0 | shared/api 正确链接；Fastify 5.12.5、TypeScript 5.9.3、tsx 4.23.15、@types/node 22.20.4 |
| npm run typecheck | shared、无 Node 类型的浏览器消费者、api 及测试均通过 |
| npm test | 7 项通过：健康/404、配置、错误/schema/畸形 JSON/413/415、媒体依赖失败安全、checksum、端口占用、敏感日志过滤 |
| npm run build | shared 与 api 生产编译通过 |
| npm run start:api + 真实 HTTP | 127.0.0.1:3000 成功启动；health=200 且仅返回 data.status=ok，Cache-Control=no-store；未知路由=404 且公共错误结构正确 |
| npm run dev:api + 真实 HTTP | 开发 watch/tsx 启动、源文件变更自动重启、health=200；端口冲突明确报错 |
| 用户测试数据库 | sqlite-test.db 未写入，SHA-256 仍为 E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855 |

测试使用 Node 内置 test runner 与 Fastify inject，避免为此骨架额外引入测试框架；不是完整业务/媒体验收。已生成 dist、依赖和 npm 缓存，未清理或删除文件，未写入/迁移数据库，未连接真实 OSS，未修改服务器、前端实现、媒体实现、其他代理任务板或 TASKS.md。未执行 Git 初始化、分支变更或提交。

尚未验证：真实 SQLite Repository/迁移、登录/TOTP/会话安全业务、真实 OSS/内网/V4 签名、Range 视频传输/流量截断/完整分片上传、FFprobe 格式样例、Vite 真前端、安卓手机、Docker/服务器部署、Node.js 其他主版本及 Linux 原生依赖。它们属于后续任务，不阻塞 CORE-01 骨架交接。

依赖兼容性依据已联网核验：[Node.js 受维护版本](https://nodejs.org/en/about/previous-releases)、[Fastify LTS](https://fastify.dev/docs/latest/Reference/LTS/)、[TypeScript 5.9](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html)；精确包版本/engines 通过官方 npm registry 查询，并以本机实际安装和运行验证。

## 7. 子代理 2、3 的下一步

**子代理 2**：用户确认交接后可从 MEDIA-01 开始，在自有 media 目录实现 Mock StorageAdapter 与适配器验证，按冻结接口推进 Range、计量及上传。Repository/鉴权尚未交付的阶段显式注入测试替身。真实 OSS、缺失生产依赖和本地开发配置的 oss 禁用检查若需调整，向主控提出具体接入需求，不修改 core 或默默启用真实存储。

**子代理 3**：用户确认交接后可从 WEB-01 开始创建 apps/web、React/Vite、API 客户端、路由及契约一致的 Mock。前端仅导入 shared，对业务路由使用 Mock；health 是唯一已可实际调用的接口。上传按后端 partSizeBytes 和逐片 checksum，播放只使用站内 proxy 地址；业务 Mock 不作为真实 API/安卓/OSS 已验结果。

公共 DTO、状态、错误码、checksum、config 和注册接口变更均由主控/后端协调，不能另建不兼容契约。子代理 1 后续 CORE-02 也需要单独启动指令。本轮未启动额外代理；TASKS.md 总状态由主对话主控根据本交接同步，待用户确认后再开始并行开发。

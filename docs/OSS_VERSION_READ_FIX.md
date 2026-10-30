# OSS 指定版本读取权限修复与更新

适用：已配置角色 ARN、对象已经上传到 OSS，但 `/api/uploads/:uploadId/complete` 返回 503。诊断显示普通 HEAD 成功、携带已保存 `versionId` 的 HEAD 返回 403，EC 为 `0003-00000301`。

这不是所有 403 的通用处理。CDN 能播放某个对象，也不能证明服务端 STS 凭据能读取当前任务的指定版本。不要据此删除数据库中的版本号、关闭 Bucket 版本控制、改成公共读写或授予 `oss:*`。

## 1. 角色权限和程序会话权限必须同时具备

临时凭据最终权限是 **ARN 对应 RAM 角色的权限与 AssumeRole 请求中 Policy 的交集**。

- `AliyunSTSAssumeRoleAccess` 只允许调用 `sts:AssumeRole`，不授予 OSS 读取权限。调用方已有此权限时保持不动。
- 在应用实际配置的 ARN 对应 RAM 角色上，确认对象权限包含 `oss:GetObjectVersion`；若已经补上，不重复修改。只加在 AccessKey 所属 RAM 用户上，不能代替角色授权。
- 保持原有 Bucket 和对象前缀，例如 `acs:oss:*:*:xzlbucket/onlineVideo/*`，不扩成所有 Bucket，不增加删除、修改 ACL 等权限。
- 本次代码只给 `read` 会话增加 `oss:GetObjectVersion`。`upload` 仍是 GetObject/PutObject，`import` 仍是 GetObject 和限定前缀的 ListObjects。

只改角色仍会被旧程序的会话策略限制；只改代码而角色未授权也会失败。更新 API 容器后，新进程会重新申请临时凭据，不能只重启仍使用旧代码的镜像。

## 2. 服务器更新范围

以下全部在 **Linux 服务器**执行，不在 Windows PowerShell 执行。实际目录是 `/opt/projectAPP/onlineVideo/PrivateOnlineVideo`，Compose 环境文件是 `../config/compose.env`。

本次无数据库结构变更，不初始化数据库、不重新导入 SQL、不生成密钥或安装码、不执行 `compose down`。保留完整 `data`、`config` 和既有备份；原任务和 OSS 对象不删除。不要改防火墙、重启 Docker、1Panel OpenResty、Redis 或其他应用。

先暂停上传，确认允许本项目 API 短暂中断，并确认有受保护的、包含完整 `data` 和 `config` 的一致性备份。不要用复制运行中 `.db` 的方式代替一致性备份。一般发布和备份说明见[部署说明](DEPLOY_1PANEL.md)；本文只说明本次 API 修复。

### 2.1 核对服务器代码

```bash
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
git status --short
git branch --show-current
git log -1 --oneline
docker compose --env-file ../config/compose.env ps
```

预期分支是 `main`。如果服务器存在未确认的代码或配置改动，先停止更新并核对，不执行 reset、clean、restore 或强制覆盖。孤立的用户执行日志也不加入 Git。

### 2.2 拉取并构建 API

确认工作区和分支符合预期后：

```bash
(
  set -eu
  cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
  git pull --ff-only origin main
  git log -1 --oneline
  docker compose --env-file ../config/compose.env config --quiet
  docker compose --env-file ../config/compose.env build api
)
```

任一步失败就停止，不继续替换容器。正常复用构建缓存，不加 `--no-cache` 或 `--pull`，不清理镜像，不升级依赖，不安装宿主机 Node/npm。构建期间旧容器仍使用原镜像运行。

### 2.3 替换 API 并检查健康状态

只有确认拉到了本次修复提交且 API 镜像构建成功后，才执行下一批：

```bash
(
  set -eu
  cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
  docker compose --env-file ../config/compose.env \
    up -d --no-deps --no-build --pull never --wait --wait-timeout 120 api
  docker compose --env-file ../config/compose.env ps
  curl --fail --show-error --connect-timeout 5 --max-time 20 \
    --retry 3 --retry-delay 5 \
    -w '\nHTTP=%{http_code}\n' http://127.0.0.1:18080/api/health
  curl --fail --show-error --connect-timeout 5 --max-time 20 \
    --retry 3 --retry-delay 5 \
    -w '\nHTTP=%{http_code}\n' https://meetdawn.top/api/health
)
```

只选择 `api` 且指定 `--no-deps`，不重建 Web 镜像或重启其他服务。现有 Web 配置会定期重新解析 API 容器地址，API 切换期间可能有短暂 502。两个接口都应最终返回 `{"data":{"status":"ok"}}`、HTTP 200；不用 `-k`，不对公网开放 18080/3000。

失败时保留现场，只收集本项目状态和日志，不反复重建或初始化：

```bash
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
docker compose --env-file ../config/compose.env ps
docker compose --env-file ../config/compose.env logs --since=10m --tail=100 api web
```

## 3. 验证原失败任务

1. 网站健康检查通过后，用原账号进入原失败上传任务，点击“重试完成”或“重新确认”；不重新选择并上传文件。
2. 确认完成接口返回 200、原任务变为 completed，并且只登记一条视频。原分片和对象继续复用，不再次合并或覆盖已经核验的对象。
3. 检查该视频的封面和播放；这与 API 健康检查分开验收。新上传、大文件、手机、SMTP 和重启持久化仍按各自范围记录，不默认通过。
4. 若仍是 403/503，记录本次时间、请求状态、应用错误码及安全的 OSS EC/requestId，再核对角色实际生效策略；不要盲目增加全量权限。不要分享 AccessKey、Secret、Token、Cookie、完整签名 URL 或数据库内容。

本地测试仅使用隔离内存库、SDK 替身和本机协议服务；通过不代表 Linux 镜像或实际云端已验收。最终以服务器更新和原任务重试结果为准。

## 官方依据

- [STS Policy 拒绝与权限交集：0003-00000301](https://help.aliyun.com/zh/oss/user-guide/0003-00000301)
- [指定版本元数据读取所需 GetObjectVersion](https://help.aliyun.com/zh/oss/developer-reference/getobjectmeta)
- [AliyunSTSAssumeRoleAccess 的权限定义](https://help.aliyun.com/zh/ram/developer-reference/aliyunstsassumeroleaccess)
- [Docker Compose up 参数](https://docs.docker.com/reference/cli/docker/compose/up/)

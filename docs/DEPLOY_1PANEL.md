# Docker 镜像部署与 1Panel 反向代理

适用场景：Windows 本地开发，不安装 Docker；Linux 服务器已有 Docker、Docker Compose 和 1Panel。服务器从 Git 拉取代码，在 Linux 镜像内安装依赖、构建项目。本文默认使用全新的 SQLite 数据库，不迁移本地数据。

本文中的域名 `video.example.com` 是占位示例，必须替换。服务器目录统一使用 `/opt/online-video`；如需换目录，要一起调整 Compose 环境文件里的宿主机路径。除本地提交说明外，命令都在 **Linux 服务器的 SSH 终端**执行，不是在 Windows PowerShell 中执行。

> 部署文件已经提供，不代表你的服务器已通过验收。本地没有 Docker，仍需在实际服务器确认镜像构建、权限、代理网络、真实 OSS/SMTP、大文件及手机访问。不会自动修改旧数据库或云端权限。

## 1. 先理解代码、数据与容器的关系

### 1.1 服务器上的目录：同级并列，不要相互嵌套

```text
/opt/online-video/
├── source/                         Git 拉取的整个项目
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── compose.yaml
│   ├── deploy/                     部署模板、初始化脚本、Web 配置
│   ├── apps/
│   ├── packages/
│   └── docs/
├── data/                           真正的运行数据，不进 Git、不进镜像
│   ├── new-install.db
│   ├── new-install.db.auth.key
│   ├── new-install.db.installation-code.txt
│   └── new-install.db.library.json
├── config/                         服务器专用配置，不放回 source
│   ├── deployment.json
│   └── compose.env
└── backups/                        按需创建；备份也不放进 source
```

`source`、`data`、`config`、`backups` 是兄弟目录。`source/deploy` 则是仓库自带的模板目录，**不是**运行数据目录。

初始时 `data` 是空目录；初始化命令创建 `.db`，API 首次启动创建主密钥和安装码，网页完成设置后创建 `.library.json`。SQLite 运行时可能出现 `-wal`、`-shm` 文件，这是正常现象。

### 1.2 容器内部：项目根目录固定为 /app

镜像构建时，将所需代码及产物放入镜像的 `/app`。运行时不把服务器整个 `source` 挂进去：

| 服务器上的路径 | 容器中的路径 | 用途 |
| --- | --- | --- |
| `/opt/online-video/source` | 构建时生成镜像中的 `/app`，不是运行时挂载 | 项目代码和编译产物 |
| `/opt/online-video/data` | `/app/.local/data` | 可读写的持久化数据目录 |
| `/opt/online-video/config/deployment.json` | `/app/config/deployment.json` | 只读挂载的启动配置 |
| `/opt/online-video/config/compose.env` | 不挂载进容器，由 Compose 读取 | 域名、端口及宿主机挂载路径 |

因此配置：

```json
{
  "databasePath": ".local/data/new-install.db"
}
```

表示：

```text
databasePath: .local/data/new-install.db
  -> 容器内 /app/.local/data/new-install.db
  -> 服务器 /opt/online-video/data/new-install.db
```

两边是同一份文件，不是复制两份；也不是把 `data` 搬到 `source`。数据库路径相对于镜像内项目根目录，不相对于 SSH 当前目录、服务器 `/opt`，也不相对于 `config` 目录。

### 1.3 访问链路与端口

```text
浏览器 https://video.example.com
  -> 1Panel 的 OpenResty：域名、TLS、80/443、对外反向代理
  -> Web 容器：8080，提供前端，/api/* 转给 API
  -> API 容器：3000，仅 Compose 内部网络访问
  -> SQLite / OSS / SMTP

浏览器播放视频 -> 配置好的公共 HTTPS 媒体地址
```

默认仅将 Web 发布为宿主机 `127.0.0.1:18080`，不占 80/443，不公开 API 端口。Web 中的 Nginx 不管理证书。视频上传经过 API，视频播放沿用公共媒体直连方案；不要把站内登录当作媒体地址的私有访问控制。

## 2. 部署文件分别做什么

| 仓库文件 | 作用 |
| --- | --- |
| `Dockerfile` | 多阶段构建，`api`、`web` 两个最终目标；安装 Linux 原生依赖，不使用 Windows 的 node_modules |
| `.dockerignore` | 按白名单提供构建输入，排除真实 .env、数据库、密钥、本地依赖和旧 dist |
| `compose.yaml` | 构建和运行两个服务、健康检查、数据挂载、日志轮转 |
| `deploy/deployment.json.example` | 全新安装的启动 JSON，故意省略 authKeyFile |
| `deploy/compose.env.example` | Compose 参数模板，复制到服务器 config 后修改 |
| `deploy/nginx.conf` | SPA 页面刷新、静态资源、保留 /api 路径的代理、16 MiB 请求限制和上传超时 |
| `deploy/init-db.mjs` | 独立的一次性建库命令，执行完整 SQL 并校验迁移和完整性；拒绝覆盖已有文件 |
| `deploy/compose.1panel.yaml` | 可选：仅当 OpenResty 使用桥接网络时，让 Web 加入其已有网络 |

项目原有 `source/config/deployment.json` 保留用于本地开发。服务器运行时会被外部只读配置挂载覆盖，**不要为了服务器部署修改本地开发库的配置**。

## 3. Windows 本地需要做什么

1. 完成本次要发布的代码检查，将部署文件及准备发布的前端修改正常提交、推送到 Git。
2. 未提交、未推送的本地修改不会出现在服务器。不要为了部署把未完成前端顺手提交；可以先发布现有稳定提交加部署文件。
3. 不上传 Windows 的 `node_modules`、`dist`、`.env`、数据库、key 或本地验收产物。

Windows 无需执行 `docker build`；服务器只需要 Git、Docker、Compose，不必另装 Node.js、npm、SQLite 客户端。首次构建需要访问镜像仓库、Debian 软件源和 npm registry，可能耗时且占用内存。

## 4. 服务器首次准备

以下目录创建和 Docker 命令按具备相应权限的管理员操作。权限不够时使用合适的 `sudo`，不要给数据目录 `chmod 777`。

### 4.1 检查环境

```bash
docker --version
docker compose version
git --version
```

使用 Docker Compose 插件，建议 2.20 或更高版本；本文不是旧的 `docker-compose` 命令。确认 1Panel 已安装 OpenResty、域名已经解析到服务器，且外部能到达网站的 80/443。不要为本项目额外放行 18080 或 3000。

### 4.2 新建目录并拉取代码

若 `/opt/online-video` 已经有项目或数据，先检查，不要直接套用初始化步骤。以下用于新目录；目录如果换名，后续所有宿主机路径也要相应修改。

```bash
install -d -m 0755 /opt/online-video
install -d -m 0755 /opt/online-video/config
install -d -m 0700 -o 1000 -g 1000 /opt/online-video/data

# 默认地址来自项目 README；使用其他代码仓库时先替换这一行。
REPO_URL='https://github.com/yingchunfeng/PrivateOnlineVideo.git'
git clone "$REPO_URL" /opt/online-video/source
cd /opt/online-video/source
git log -1 --oneline
```

API 镜像以 `node` 用户运行，标准 Node 镜像 UID/GID 为 `1000:1000`，因此新数据目录预先归属该用户。这里只针对新建的专用目录，不递归更改其他目录权限。若服务器启用了 Docker userns/rootless 或 SELinux，需要按实际用户映射、挂载标签处理，不能靠放宽到 777 解决。

### 4.3 从模板创建服务器专用配置

```bash
# -n 表示已有目标时不覆盖；已有配置应先查看并手动修改。
cp -n deploy/deployment.json.example ../config/deployment.json
cp -n deploy/compose.env.example ../config/compose.env
chmod 0644 ../config/deployment.json
chmod 0600 ../config/compose.env
```

`deployment.json` 没有秘密，0644 使容器用户可以读取；`config` 目录也需要可进入。真正的 key/安装码在权限受限的 `data` 目录中。

通过 1Panel 文件编辑器或终端编辑 `/opt/online-video/config/compose.env`，至少修改 `APP_ORIGIN`：

```dotenv
APP_ORIGIN=https://video.example.com
WEB_BIND=127.0.0.1
WEB_PORT=18080
DATA_DIR=/opt/online-video/data
DEPLOY_CONFIG_FILE=/opt/online-video/config/deployment.json
IMAGE_TAG=local
```

`APP_ORIGIN` 必须是实际网站的 HTTPS Origin：不能保留示例域名，不能带结尾 `/` 或路径；使用非标准 HTTPS 端口时必须带实际端口。媒体域名、OSS AccessKey 和 SMTP 授权码不填这里，稍后在网页设置。

确认 `/opt/online-video/config/deployment.json` 是：

```json
{
  "databasePath": ".local/data/new-install.db"
}
```

全新安装不要填写 `authKeyFile`，API 才会创建新的伴随密钥；以后可以一直省略该字段，自动使用并保留同名 key。显式填写该字段表示复用已有密钥，不会生成或替换它。

本文所有 Compose 命令都显式使用 `--env-file ../config/compose.env`，不依赖源码目录可能存在的开发 `.env`。JSON 选择数据库，Compose 环境文件选择域名、端口和宿主机挂载目录，两者用途不同。

## 5. 先确定 1Panel OpenResty 的网络模式

这一步只选择网络方案，不修改已有 OpenResty 网络，不重建它，也不影响其他网站。

在 1Panel 的容器列表找到实际 OpenResty 容器名，然后检查：

```bash
# 把下列容器名替换为面板中实际显示的名称。
docker inspect --format '{{.HostConfig.NetworkMode}}' 实际OpenResty容器名
docker inspect --format '{{json .NetworkSettings.Networks}}' 实际OpenResty容器名
```

### 方案 A：OpenResty 使用 host 网络，或直接运行在宿主机

只使用根目录 `compose.yaml`，无需额外配置。1Panel 网站代理到 `http://127.0.0.1:18080`。

### 方案 B：OpenResty 使用用户自定义 bridge 网络

容器内的 `127.0.0.1` 不是宿主机。不要放开 Web 到 `0.0.0.0` 来绕过问题。

1. 从 inspect 输出确认 OpenResty 已连接的实际用户自定义网络。
2. 在 `config/compose.env` 增加 `PANEL_NETWORK=实际网络名`。
3. 下文**每一条** Compose 命令，包括 build、run、up、logs、stop，都加入两个 `-f` 参数：

```bash
docker compose --env-file ../config/compose.env \
  -f compose.yaml -f deploy/compose.1panel.yaml config --quiet
```

4. 1Panel 网站代理到 `http://online-video-web:8080`。只有 Web 加入面板网络，API 仍在本项目默认网络中。

旧的默认 `bridge` 网络不具备本方案所需的用户自定义网络服务名解析。若 inspect 仅显示默认 `bridge`，先按实际环境规划连接方式，不直接套用方案 B。若同一面板网络已有 `online-video-web` 别名，也应先调整别名避免冲突。

下文为便于复制默认展示**方案 A**。使用方案 B 时必须始终带上前述两个 `-f` 参数，后续更新也不能漏掉。

## 6. 构建镜像并初始化新库

所有命令都在 `/opt/online-video/source` 中执行。

### 6.1 校验配置并构建

```bash
cd /opt/online-video/source
docker compose --env-file ../config/compose.env config --quiet
docker compose --env-file ../config/compose.env build --pull
```

构建生成 `online-video-api:local`、`online-video-web:local`。前后端共享依赖构建缓存；后端使用生产依赖和编译后的 JS，前端使用 Vite 生产产物，不启用 Mock。最终 API 镜像不带编译工具链。

若内存不足、镜像拉取或依赖下载失败，应保留错误并处理资源/网络问题，不要拷贝 Windows 的 node_modules，不要关闭 TLS 校验。构建失败不会自动初始化或清空数据库。

### 6.2 只执行一次新库初始化

下面命令**明确创建新的空业务库并执行建表 SQL**。运行前确认配置里的目标是新库，不能指向现有业务数据。

```bash
docker compose --env-file ../config/compose.env \
  run --no-deps api node deploy/init-db.mjs
```

成功输出包含 `migrations=6; integrity=ok`，并创建服务器 `/opt/online-video/data/new-install.db`。无需在服务器另装 SQLite，也无需再手动重复导入 SQL。

初始化脚本不会生成 key、账号或安装码；这些属于下一步 API 首次启动。脚本发现数据库，即使是空文件，或 WAL、key、安装码、分类配置等伴随文件时会拒绝，不覆盖、不删除。失败时保留现场，查明原因后再处理，不能靠删文件硬重试。不要把该命令写成容器每次启动的自动步骤。

本命令不自动删除一次性运行容器，失败时可保留日志排查；面板中出现对应 Exited 容器不代表正式 API 服务失败。

### 6.3 启动并检查

```bash
docker compose --env-file ../config/compose.env up -d --wait
docker compose --env-file ../config/compose.env ps
docker compose --env-file ../config/compose.env logs --tail=100 api web
curl --fail http://127.0.0.1:18080/api/health
```

健康检查应返回 `{"data":{"status":"ok"}}`。此时尚未完成网页初始化也可以健康；健康不等于 OSS 上传、邮件、播放全部验收通过。

第一次 API 启动后会在 `data` 中创建 `.auth.key` 和 `.installation-code.txt`，不需要手工生成 key。后续重启继续复用原文件；已初始化库缺少/不匹配 key 会拒绝启动，而不是恢复初始密码。

Compose 只读挂载启动 JSON，可写挂载数据目录；若挂载源不存在会拒绝启动，不会误创建同名目录来掩盖错误。挂载源 JSON 必须是文件，不能是目录。

## 7. 在 1Panel 创建反向代理网站

在 1Panel 的网站功能中创建“反向代理”网站，按实际版本菜单操作：

1. 主域名填写实际域名，如 `video.example.com`。
2. 代理地址按第 5 节选择：方案 A 为 `http://127.0.0.1:18080`；方案 B 为 `http://online-video-web:8080`。
3. 在面板中申请或选择证书，启用 HTTPS，并将 HTTP 跳转 HTTPS。
4. 网站代理的是整个 `/`，不能只代理 `/api`。Web 容器再区分前端和 API。
5. 保留完整请求路径与查询串，保留浏览器的 `Origin`、Cookie 等正常请求头，不自行改写为容器域名。

检查面板生成的网站配置中已有对应指令；按原位置调整，不重复添加同名 location 或相同指令。服务器级请求体限制和代理 location 内的设置至少应包含以下含义：

```nginx
# 网站 server 内：当前上传按 8 MiB 分片，这里允许 16 MiB 请求。
client_max_body_size 16m;
client_body_timeout 120s;

# 已有的代理 location 内，不要另建重复的 location /。
proxy_set_header Host $http_host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_http_version 1.1;
proxy_request_buffering off;
proxy_read_timeout 180s;
proxy_send_timeout 180s;
```

保存前通过面板检查 OpenResty 配置语法。上传经过面板和 Web 两层，不能只改其中一层；Web 的对应参数已放进镜像配置。16 MiB 是**单个请求**限制，不是整段视频总大小；当前程序的单文件限制约 2 GiB，不能靠修改 Nginx 就提高程序限制。

默认后端未启用 `TRUSTED_PROXIES`，不会信任客户端伪造的转发 IP，鉴权限流看到的是直接连接的 Web 容器 IP。当前单管理员场景保持这个安全默认；确需按真实客户端 IP 限流时，必须按实际代理链配置可信 IP/CIDR，并验证转发头，不能简单设置 `true` 或信任整个公网。

从服务器和外部浏览器分别验证：

```bash
# 用实际域名替换示例；不要用 -k 跳过证书验证。
curl --fail https://video.example.com/api/health
```

本方案由命令行维护 Compose，1Panel 通常会将其识别为 Local 来源，可查看容器状态、日志和进行相应运行管理；不要再在面板新建第二套同名编排，避免重复端口或同时访问同一个 SQLite。Local 编排的文件仍维护在 source 中，面板可编辑能力按实际版本为准。

## 8. 完成首次网页安装与验收

通过受保护的服务器终端查看安装码文件，勿把输出发到聊天、提交到 Git 或截图公开：

```bash
cat /opt/online-video/data/new-install.db.installation-code.txt
```

然后打开实际 HTTPS 网站：

1. 初始密码 `adminadmin` 加一次性安装码进入向导；该密码不能直接访问正常业务。
2. 修改为新的 12～128 字符密码。
3. 填写并保存 OSS、媒体 HTTPS 地址及对象前缀，测试只读连接；根据实际网络选择公网或内网。普通非阿里云同地域服务器不要误选 OSS 内网。
4. 按需配置 SMTP 并发送测试邮件；不配置仍可使用密码登录。
5. 完成安装并重新登录，上传一个小视频、确认登记、封面和播放。
6. 重启服务后确认账号、配置和视频仍在；再单独验收大文件和手机。

详细向导与安全边界见 [NEW_INSTALL.md](NEW_INSTALL.md)。OSS 只读检查通过不代表上传/公共读权限全部通过；SMTP 接受不等于最终收件箱送达。

## 9. 日常更新：不再初始化数据库

更新前暂停上传，确认源码目录没有服务器临时改动，并先按下一节备份。以下命令会更新镜像并可能短暂重建容器，不是零停机发布。

```bash
cd /opt/online-video/source
git status --short
git rev-parse HEAD

# 按输出记下原提交；下面为现有镜像保留一个不会被下一次 build 覆盖的标签。
RELEASE=$(date +%Y%m%d-%H%M%S)
docker image tag online-video-api:local "online-video-api:before-$RELEASE"
docker image tag online-video-web:local "online-video-web:before-$RELEASE"

git pull --ff-only
docker compose --env-file ../config/compose.env config --quiet
docker compose --env-file ../config/compose.env build --pull
docker compose --env-file ../config/compose.env up -d --wait
docker compose --env-file ../config/compose.env ps
curl --fail https://video.example.com/api/health
```

`git status` 若有改动，先查明来源，不用 reset/clean 强行覆盖。Compose 环境文件和启动 JSON 都在 source 外，正常拉代码不会覆盖它们。镜像标签冲突时另选标签，不覆盖旧的回退点。

日常更新**不执行** `init-db.mjs`，不重新导入完整 SQL，不生成新 key，不重做账号初始化。若未来发布涉及数据库结构变更，必须另行阅读升级说明、备份并显式执行对应升级；本部署不自动迁移已有库。

如需仅回退应用镜像，使用先前记下的完整标签，例如：

```bash
# 将日期替换为实际保留的标签；--no-build 防止又构建成新代码。
IMAGE_TAG=before-20261028-120000 docker compose --env-file ../config/compose.env \
  up -d --no-build --wait
```

仅限数据库结构仍兼容时这样回退。回退后若要持续使用该标签，应同步修改服务器 `compose.env` 的 `IMAGE_TAG`，避免下次命令意外又使用 local。数据库回退和恢复涉及覆盖，不在本文自动执行。

## 10. 备份、停机与重启

必须一起备份整个 `data` 和 `config`，尤其是匹配的数据库、主密钥、分类配置、启动 JSON；未完成安装时还需安装码。媒体文件在 OSS，数据库归档不等于备份了 OSS 对象。

最简单的一致性备份是先暂停上传、正常停服务再归档；不要只复制运行中的 `.db` 而忽略 WAL。以下备份会短暂停机，不删除任何数据：

```bash
cd /opt/online-video/source
install -d -m 0700 /opt/online-video/backups
docker compose --env-file ../config/compose.env stop web api

BACKUP_FILE="/opt/online-video/backups/online-video-$(date +%Y%m%d-%H%M%S).tar.gz"
# noclobber 拒绝覆盖同名备份；umask 限制新归档的读取权限。
(umask 077; set -C; tar -czf - -C /opt/online-video data config > "$BACKUP_FILE")

# 先确认上一条命令成功，再检查归档清单；不要把清单/秘密公开。
tar -tzf "$BACKUP_FILE"
docker compose --env-file ../config/compose.env up -d --wait
```

备份失败时保留错误和已有文件，恢复服务前按实际情况检查。归档含解密主密钥，应存到受控备份位置，不放在网站目录；恢复前先确认目标和影响，不直接解包覆盖正在使用的库。

不更新镜像、仅正常重启时可执行：

```bash
docker compose --env-file ../config/compose.env restart api web
docker compose --env-file ../config/compose.env ps
```

API 容器由 init 转发退出信号并关闭 SQLite。不要强杀未知进程，不使用 `down -v`、`system prune --volumes` 或删除 data 来排障。

## 11. 常见问题与排查顺序

| 现象 | 优先检查 |
| --- | --- |
| 初始化提示已有文件 | 确认是否已经初始化，或选错数据库路径；保留文件，不删除后强行重跑 |
| 启动提示数据库不存在 | 是否成功执行一次性初始化，DATA_DIR 与 databasePath 是否对应 |
| 提示 key 缺失或不匹配 | 是否误挂载新目录、显式写了不存在的 authKeyFile；不能生成新 key 替代旧 key |
| `EACCES` / SQLite 只读 | 新 data 目录是否匹配容器 UID/GID，文件/目录权限、userns/SELinux 是否正确 |
| 配置路径变成目录 | 挂载源是否实际是 JSON 文件；create_host_path=false 会提前暴露缺失路径 |
| 1Panel 502、本机 health 正常 | OpenResty 是否为桥接网络、代理目标是否正确；方案 B 是否漏了 override 或网络别名 |
| Web 502、API 不健康 | 先看 API 日志；检查新库结构、密钥、实际 HTTPS Origin，不反复重建空库 |
| 登录/保存时报 CSRF 或 Cookie 问题 | 访问域名是否与 APP_ORIGIN 精确一致、是否 HTTPS、代理是否保留 Origin/Host/Cookie |
| 上传 413 / 504 | 检查 1Panel 与 Web 两层请求体限制和超时，再核对 OSS 网络/权限及 API 错误码 |
| 前端页面刷新 404 | 是否代理了整个站点到 Web，是否使用仓库自带的 SPA Nginx 配置 |
| 重启后数据没了 | DATA_DIR 是否改了、有没有错误创建第二套编排；先查原目录，不重新初始化 |

优先使用 `docker compose ... ps`、`logs --tail=100 api web` 和两段 health 检查定位。API 日志不会打印真实配置秘密；反馈问题时仍需去掉 Cookie、安装码、授权码及 key 内容。

## 12. 验证范围与官方依据

开发机可以在项目根目录执行以下隔离检查；会新建 `.local/tests/docker-deployment-*` 测试目录，不访问现有业务库，也不调用真实 OSS/SMTP：

```text
npm run build -w @online-video/shared
npm run build -w @online-video/api
node --test deploy/test/deployment.test.mjs
```

- 本地可验证：部署脚本语法、初始化安全边界、完整 SQL 与迁移校验、自动生成/复用 key、配置样例及文件编码。
- 本地未安装 Docker，不能把这些本地检查称为镜像构建成功、Nginx 启动成功或服务器上线成功。
- 首次服务器部署仍应完成：两镜像构建、健康检查、HTTPS、首次安装、上传播放、重启持久化、按需邮件、大文件与手机验证。
- Docker：[多阶段构建](https://docs.docker.com/build/building/multi-stage/)、[Compose 服务及挂载](https://docs.docker.com/reference/compose-file/services/)。
- Nginx：[HTTP 代理模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。
- 1Panel：[容器编排](https://github.com/1panel-dev/docs/blob/zh-CN/deploy/v2/user_manual/containers/compose/index.html)、[创建反向代理网站](https://github.com/1panel-dev/docs/blob/zh-CN/deploy/v2/user_manual/websites/website_create/index.html)。

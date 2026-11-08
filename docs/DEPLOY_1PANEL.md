# Docker 镜像部署与 1Panel 反向代理

适用场景：Windows 本地开发，不安装 Docker；Linux 服务器已有 Docker、Docker Compose 和 1Panel。服务器从 Git 拉取代码，在 Linux 镜像内安装依赖、构建项目。本文默认使用全新的 SQLite 数据库，不迁移本地数据。

**当前源码的新部署入口**：一次性初始化仅执行 `docs/sql/NEW_INSTALL_FULL.sql`，包含 v9 / 42 表 / 9 条迁移账本；不需要叠加其余历史 SQL。第 0 节及故障处理中的旧版本、服务器路径和镜像 ID 是历史部署记录，不代表新检出的代码或当前运行容器版本。已有 v5～v8 库不会自动升级；站点设置、访客和首页排序持久化需要先备份、明确目标并执行单独确认的增量迁移，不能运行全量脚本补表。

已有 v8 实例启用首页排序，单独执行 [`docs/sql/UPGRADE_V8_TO_V9.sql`](sql/UPGRADE_V8_TO_V9.sql)，步骤见 [v8→v9 升级说明](sql/README.md#已有-v8-库升级到-v9)。先停 API、备份，再执行增量 SQL 并启动新版本；不要按普通无数据库变更更新直接跳过迁移。首次克隆需按[仓库维护说明](REPOSITORY_HYGIENE.md#只保留本机的内容)从 `.gitignore.example` 创建本机规则；实际 `.gitignore` 不再随版本跟踪。

第 1～6 节的通用首次安装教程使用占位域名 `video.example.com` 和示例目录 `/opt/online-video/source`，新服务器必须替换。第 7、8 节说明面板和安装流程，其中明确标注本次部署的命令，以及第 9、10、12、13 节日常操作，使用第 0 节记录的**本次服务器实际路径和域名**；其他服务器需按实际值替换，不要混用两套路径。除明确标为 Windows 的命令和第 14 节本地检查外，命令都在 **Linux 服务器的 SSH 终端**执行，不是在 Windows PowerShell 中执行。

> 已经正常运行的服务器不要从第 4 节重新操作：更新看第 9 节，备份和重启看第 10 节，查看/修改数据库边界看第 12 节，搬迁服务器看第 13 节。本文不会授权删除文件、重置数据库或修改全局防火墙；涉及停机或配置变更时，应先确认维护窗口和影响范围。

## 0. 本次部署记录与阅读入口

### 0.1 实际目录、域名和配置

```text
/opt/projectAPP/onlineVideo/
├── PrivateOnlineVideo/             Git 仓库；服务器执行 Compose 命令的位置
├── config/
│   ├── compose.env
│   └── deployment.json
├── data/
│   ├── new-install.db              历史手工创建的 0 字节文件，保留，不使用
│   ├── online-video.db             当前实际业务库
│   ├── online-video.db.auth.key
│   ├── online-video.db.installation-code.txt
│   └── online-video.db.library.json
└── backups/                        后续按需创建，放在仓库之外
```

服务器外部的 `config/compose.env` 当前记录如下，仅用于核对，**不是要求覆盖已有文件**：

```dotenv
APP_ORIGIN=https://meetdawn.top
WEB_BIND=127.0.0.1
WEB_PORT=18080
DATA_DIR=/opt/projectAPP/onlineVideo/data
DEPLOY_CONFIG_FILE=/opt/projectAPP/onlineVideo/config/deployment.json
IMAGE_TAG=local
```

服务器外部的 `config/deployment.json`：

```json
{
  "databasePath": ".local/data/online-video.db"
}
```

当前数据库映射为：`/opt/projectAPP/onlineVideo/data/online-video.db` → API 容器 `/app/.local/data/online-video.db`。伴随密钥由首次启动生成并继续复用，不能替换。仓库中的模板仍使用 `new-install.db`，**不能把模板重新覆盖到当前服务器配置**。

| 项目 | 本次记录 |
| --- | --- |
| 仓库 / 分支 | `https://github.com/yingchunfeng/PrivateOnlineVideo.git` / `main` |
| 本次部署代码基线 | 首次为 `0dd6849`；2026-10-30 仅 API 更新至 `5ccdd38`，Web 沿用原镜像 |
| Docker / Compose / firewalld | `26.1.3` / `v2.27.0` / `0.9.11` |
| API / Web 镜像 | `online-video-api:local` / `online-video-web:local` |
| OpenResty 容器 | `1Panel-openresty-jZKP`，已确认使用 host 网络 |
| 网站反向代理 | 整个 `/` → `http://127.0.0.1:18080`，不是 `3000` |
| 安装入口 | `https://meetdawn.top/setup`，安装完成后不需要重新安装 |

### 0.2 已确认的结果和仍需单独验收的项目

- 服务器已成功构建两个镜像；数据库一次性初始化返回 `migrations=6; integrity=ok`，不再执行初始化。
- 用户提供的服务器输出已确认两个正式容器 healthy，localhost 和 `https://meetdawn.top/api/health` 均返回 `{"data":{"status":"ok"}}`、HTTP 200。
- 已将当前项目网桥 `br-554b9a108de6` 绑定到标准 `docker` 防火墙区域，target 为 `ACCEPT`；永久配置核对和一次 reload 已完成，见第 11.2 节。
- 修正 1Panel 代理端口后，用户确认 HTTPS 安装页面可打开，并于 2026-10-30 确认“已经可以正常使用”。这是用户确认，不是本机 Docker 验证。
- 2026-10-30 修复 API 构建 DNS：经用户确认，将默认网桥 `docker0` 临时绑定到已有 `docker` 区域后，构建内 DNS 探针和正式 API 构建成功。**`docker0` 仅有运行时绑定，永久保存及重启验证尚未执行**，与上一条项目网桥的永久绑定不是同一项，见第 11.3 节。
- 本次 API 新镜像为 `sha256:480f51d3b6885a9bebb3e0c5b0685f6a00ea1a3074307b0b9e91ba428386294b`，切换后运行镜像 ID 与目标一致；Web 未重建或重启。随后用户确认原 OSS 问题“当前已经可以了”，本次阻塞按用户确认关闭，见第 11.4 节。
- 尚未逐项留存原完成接口 200、单条登记、封面与播放的独立输出，以及上传限制/转发头配置、按需 SMTP 实际收件、重启持久化、大文件、手机和原有网站访问验收记录；不把用户整体确认扩写为这些项目都已逐项验收。

本机没有 Docker。本轮维护文档不代表执行了服务器更新、备份、数据库查询或重启。`执行结果.txt` 是用户提供的本地日志，不应修改、删除或提交；安装码、密钥、密码和 OSS/SMTP 凭据不要写入该日志。

### 0.3 操作规则

1. 每次只执行一个小节或一小批命令，检查返回结果后再继续；失败就停止，不把整篇文档一次性粘贴执行。
2. 当前服务器所有 Compose 命令都在 `PrivateOnlineVideo` 目录执行，并显式带 `--env-file ../config/compose.env`。
3. 当前仅 1Panel OpenResty 使用 host 网络，API/Web 仍使用 Compose 桥接网络；不需要 `deploy/compose.1panel.yaml` 或 `PANEL_NETWORK`，不要另建第二套编排或默认改成 host 构建网络。
4. 日常更新不运行 `init-db.mjs`、完整 SQL、`account:init` 或自动迁移，不重新生成密钥和安装码。
5. 不执行 `compose down` 来更新，不删除网络、镜像或卷，不重启 Docker、OpenResty、Redis 等无关服务；全局防火墙变更必须另行说明、备份和确认。

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

本地开发使用 `config/deployment.example.json` 创建并保留本机专用 `source/config/deployment.json`。服务器使用 `deploy/deployment.json.example` 创建外部只读配置，运行时挂载到相同容器位置；真实配置不应公开，**不要为了服务器部署覆盖本地配置或把模板覆盖到已有服务器配置**。

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

`cp -n` 只负责不覆盖，不会替你修正模板中的路径。复制后必须逐项编辑外部配置：部署根目录换名时，同时修改 `DATA_DIR`、`DEPLOY_CONFIG_FILE`；数据库换名时，修改下面 JSON 的 `databasePath`。本次实际值见第 0.1 节，不能沿用模板的示例值启动另一个库。

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

构建默认优先使用阿里云 Debian 镜像 `https://mirrors.aliyun.com` 和阿里云镜像站列出的 npm 镜像 `https://registry.npmmirror.com`。仅替换镜像内的 APT 下载地址和 npm 构建命令，不修改宿主机软件源、本地 `.npmrc`、锁文件或数据库；APT 的 Debian 签名校验和 npm 的完整性校验保持启用。npm 包安装脚本另行访问的 GitHub 等地址不保证被加速。

精简 Node 镜像可能没有系统 CA 证书包。构建会在缺少系统证书文件时，用 Node 官方镜像内置的 Mozilla 根证书创建引导信任包；已有系统证书文件不会覆盖。APT 全程通过 HTTPS 校验证书，随后安装 Debian 的 `ca-certificates` 包。若日志出现 `No system certificates available`，应检查是否已拉取包含该引导步骤的 Dockerfile，不要用关闭证书校验或 `trusted=yes` 的方式绕过。参考：[Node.js 内置根证书](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlsrootcertificates)、[Debian HTTPS 传输说明](https://manpages.debian.org/bookworm/apt/apt-transport-https.1.en.html)。

`better-sqlite3` 等原生模块编译需要 Node 头文件，npm registry 设置不会接管 `node-gyp` 对 `nodejs.org` 的独立下载。构建阶段设置 `npm_config_nodedir=/usr/local`，直接复用官方 Node 镜像自带、与运行时版本匹配的 `/usr/local/include/node`，并在两类依赖安装前检查必要文件。该设置不进入最终 API 运行镜像，不需要升级宿主机 Node/npm，也不跳过安装脚本。自定义 `NODE_IMAGE` 时必须提供对应版本的完整头文件；缺失会提前失败，不自动回退到外网下载。参考：[官方 Node 镜像构建文件](https://github.com/nodejs/docker-node/blob/main/22/bookworm-slim/Dockerfile)、[node-gyp 本地头文件配置](https://github.com/nodejs/node-gyp/blob/v11.2.0/lib/configure.js)。

APT 构建步骤使用 IPv4，索引更新最多 180 秒，依赖安装最多 600 秒，并设置网络超时及有限重试。这个限制不涵盖 Docker 基础镜像元数据查询、镜像拉取、npm 安装或项目编译；它们仍可能单独耗时。

如果目标服务器访问这些镜像不稳定，可通过构建参数显式切回官方源，无需修改 Dockerfile：

```bash
docker compose --env-file ../config/compose.env build --pull \
  --build-arg DEBIAN_MIRROR=https://deb.debian.org \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org
```

`DEBIAN_MIRROR` 填镜像根地址，不带末尾 `/`，同时保留原来的 `/debian` 与 `/debian-security` 路径。软件包镜像与 Docker Hub 镜像加速不是同一件事：Node、Nginx 基础镜像仍使用 Dockerfile 中的官方镜像。阿里云文档目前提示传统 ACR 镜像加速器已停止同步最新镜像，不能保证最新标签可用；需要时先核实账号专属地址及具体镜像，或使用受控 ACR 仓库，不套用未知公共代理，也不直接覆盖全局 Docker 配置或重启其他服务。参考：[Debian 镜像](https://developer.aliyun.com/mirror/debian)、[npm 镜像](https://developer.aliyun.com/mirror/NPM)、[ACR 官方镜像加速说明](https://help.aliyun.com/zh/acr/user-guide/accelerate-the-pulls-of-docker-official-images)。

若内存不足、镜像拉取或依赖下载失败，应保留错误并处理资源/网络问题，不要拷贝 Windows 的 node_modules，不要关闭 TLS 校验。构建失败不会自动初始化或清空数据库。

### 6.2 只执行一次新库初始化

下面命令**明确创建新的空业务库并执行建表 SQL**，仅限尚未初始化的新服务器。运行前确认配置里的目标是新库，不能指向现有业务数据。容器部署不要先 `touch` 数据库或用工具创建 0 字节文件：脚本要求数据库及相关伴随文件尚不存在，它自己独占创建文件。

本次服务器的 `online-video.db` 已初始化，**跳过整个第 6.2 节**。历史 0 字节 `new-install.db` 保留不动，不能为了让脚本通过而删除文件或切换回旧名字。

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

## 7. 在 1Panel 配置网站、反向代理和 HTTPS

### 7.1 先查已有网站，不重复创建

进入 1Panel 网站列表，检查主域名及附加/绑定域名中是否已有目标域名。已有网站就进入该网站设置；确认没有绑定后，才创建“反向代理”网站。不要覆盖其他网站，不要另建同域名编排。

本次 `meetdawn.top` 已有网站；当时已启用的代理名称为 `3000`，路径 `/`，实际错误目标为 `http://127.0.0.1:3000`。修复的是这条规则的**后端代理地址**，不是靠修改名称。另一条已停止、目标为 `8888` 的历史规则保持原样，不删除、不启用。

### 7.2 配置现有规则和证书

按实际版本菜单操作，新建网站或编辑现有网站时核对：

1. 主域名填写实际域名，如 `video.example.com`。
2. 代理地址按第 5 节选择：方案 A 为 `http://127.0.0.1:18080`；方案 B 为 `http://online-video-web:8080`。
3. 在面板中申请或选择证书，启用 HTTPS，并将 HTTP 跳转 HTTPS。
4. 网站代理的是整个 `/`，不能只代理 `/api`。Web 容器再区分前端和 API。
5. 保留完整请求路径与查询串，保留浏览器的 `Origin`、Cookie 等正常请求头，不自行改写为容器域名。

本次面板操作顺序：网站设置 → 基本 → 反向代理 → 编辑已启用的 `/` 规则 → 后端代理地址改为 `http://127.0.0.1:18080` → 保持缓存禁用 → 保存并确认成功。`3000` 只是原规则名称，不代表前端端口；`EXPOSE 3000` 也不等于宿主机发布了该端口。

进入该网站的 HTTPS 设置，选择覆盖 `meetdawn.top` 的有效证书，启用 HTTPS 并设置 HTTP 跳转 HTTPS；没有证书时按面板流程申请或导入。证书签发依赖域名解析和所选验证方式，不能从“域名已添加”推定签发成功。DNS API 凭据和证书私钥只在受保护的面板内填写，不放进 Git 或日志。保存时由面板正常检查并应用配置，不手动重启整个 OpenResty 容器。

### 7.3 核对两层上传限制和转发头

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

保存前通过面板检查 OpenResty 配置语法。上传经过面板和 Web 两层，不能只改其中一层；Web 的对应参数已放进镜像配置。16 MiB 是**单个请求**限制，不是整段视频总大小；程序单文件上限以受保护 `/api/settings/limits` 的当前值为准，初始默认为 2 GiB，管理员可在系统设置调整新任务上限。不能靠修改 Nginx 就提高程序限制，也不要把整段视频大小直接作为单个分片请求大小。

默认后端未启用 `TRUSTED_PROXIES`，不会信任客户端伪造的转发 IP，鉴权限流看到的是直接连接的 Web 容器 IP。当前单管理员场景保持这个安全默认；确需按真实客户端 IP 限流时，必须按实际代理链配置可信 IP/CIDR，并验证转发头，不能简单设置 `true` 或信任整个公网。

### 7.4 分层检查，区分 301 与 502

下列检查使用本次实际域名。先在 Linux 服务器确认 Web 入口：

```bash
curl --fail --show-error --connect-timeout 5 --max-time 15 \
  -w '\nHTTP=%{http_code}\n' http://127.0.0.1:18080/api/health
```

再经过本机 OpenResty 检查 HTTP 状态和跳转目标，不依赖公网 DNS。这里用 GET 获取响应头，不使用只请求 HEAD 的 `-I`：

```bash
curl --silent --show-error --connect-timeout 5 --max-time 15 \
  -D - -o /dev/null -H 'Host: meetdawn.top' \
  http://127.0.0.1/api/health
```

启用强制 HTTPS 后，此处返回 301/308 可以是正常现象；应核对 `Location` 指向正确的 HTTPS 域名和路径。只看到 301 既不代表失败，也不代表请求已经到达 API，不要因此撤销 HTTPS 跳转。

最后经过真实域名验证 TLS、网站代理和 API；**不加 `-k`，也先不加 `-L` 隐藏意外跳转**：

```bash
curl --fail --show-error --connect-timeout 5 --max-time 20 \
  -w '\nHTTP=%{http_code}\n' https://meetdawn.top/api/health
```

直接返回 `{"data":{"status":"ok"}}` 且 HTTP 200 才算此项通过。浏览器再打开 `https://meetdawn.top/setup` 或主页，确认没有证书警告、能加载页面；浏览器能显示静态页面不能代替 API 检查。若报 TLS 错误，检查域名、证书链和服务器时间，不跳过校验。页面正常后仍需第 8 节业务验收。

本方案由命令行维护 Compose，1Panel 通常会将其识别为 Local 来源，可查看容器状态、日志和进行相应运行管理；不要再在面板新建第二套同名编排，避免重复端口或同时访问同一个 SQLite。Local 编排的文件仍维护在 source 中，面板可编辑能力按实际版本为准。

## 8. 完成首次网页安装与验收

通过受保护的服务器终端查看安装码文件，勿把输出发到聊天、提交到 Git 或截图公开：

```bash
# 本次实际安装码；其他部署根据实际数据库名替换。
cat /opt/projectAPP/onlineVideo/data/online-video.db.installation-code.txt
```

输出也不要写入 `执行结果.txt`。然后打开实际 HTTPS 网站的 `/setup`，确认浏览器无证书警告后填写：

1. 初始密码 `adminadmin` 加一次性安装码进入向导；该密码不能直接访问正常业务。
2. 修改为新的 12～128 字符密码。
3. 填写并保存 OSS、媒体 HTTPS 地址及对象前缀，测试只读连接；根据实际网络选择公网或内网。普通非阿里云同地域服务器不要误选 OSS 内网。
4. 按需配置 SMTP 并发送测试邮件；不配置仍可使用密码登录。
5. 完成安装并重新登录，上传一个小视频、确认登记、封面和播放。
6. 重启服务后确认账号、配置和视频仍在；再单独验收大文件和手机。

详细向导与安全边界见 [NEW_INSTALL.md](NEW_INSTALL.md)。OSS 只读检查通过不代表上传/公共读权限全部通过；SMTP 接受不等于最终收件箱送达。

改密成功后，默认密码和安装码失效；中途关闭页面时使用新密码继续，不重新生成安装码。完成安装后保留原文件，不删除数据库、密钥或安装码来重做安装。

建议逐项记录“通过 / 未执行 / 失败”和日期：HTTPS health、改密及重新登录、OSS 只读连接、小视频上传/登记/封面/播放、按需 SMTP 接受及实际收件、经确认后重启本项目的持久化、手机、大文件、原有网站访问。测试只能证明实际执行的那一项，不能互相替代。

## 9. 日常更新：不再初始化数据库

### 9.1 先理解：拉代码、构建、替换容器是三件事

```text
Windows 修改代码并提交、推送到 main
  -> Linux git pull --ff-only：只更新服务器源码
  -> docker compose ... build：用服务器源码构建新的 API / Web 镜像
  -> docker compose ... up -d --no-build --pull never --wait：用新镜像重建项目容器
  -> 健康检查、登录和小视频验证
```

`git pull` 不会把代码自动放进运行中的容器；`docker compose restart` 只重启原容器，不会采用新镜像或新的 Compose 环境变量。当前镜像在本机服务器构建，没有发布到镜像仓库，因此不是用 `docker compose pull` 更新应用。

以下流程用于**当前 host 网络部署、外部配置 `IMAGE_TAG=local`、且不涉及数据库结构变更**的普通发布。其他服务器替换实际目录、域名和网络参数。先约定维护窗口、停止创建上传或修改配置等业务写入，直到更新验收结束再恢复；备份和切换会短暂中断本项目，不是零停机发布。

### 9.2 更新前检查与保留回退点

下面这些命令是供将来更新时执行，不是要求当前正常服务立即更新。先检查，不拉代码：

```bash
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
git status --short
git branch --show-current
git rev-parse HEAD
docker compose --env-file ../config/compose.env config --quiet
docker compose --env-file ../config/compose.env config --images
docker compose --env-file ../config/compose.env ps
```

预期在 `main`，工作区没有待处理改动，服务健康，解析后的镜像为两个 `:local`。当前 shell 中导出的 `IMAGE_TAG` 等变量会覆盖环境文件；若镜像名、分支或工作区状态不符合预期，先查明，不执行 reset/clean/restore、切分支或强拉代码。不要把临时文件顺手加入 Git。

在**同一个 SSH 会话**中创建唯一的发布记录目录，后续继续使用 `RELEASE_DIR` 变量：

```bash
install -d -m 0700 /opt/projectAPP/onlineVideo/backups
RELEASE_DIR=$(mktemp -d /opt/projectAPP/onlineVideo/backups/release-$(date +%Y%m%d-%H%M%S)-XXXXXX)
printf '发布记录目录：%s\n' "$RELEASE_DIR"
```

确认目录创建成功，再保存旧提交、Compose 文件和**当前运行容器真正使用的镜像**。不假定 `:local` 标签仍指向运行中的旧镜像：

```bash
(
  set -eu
  umask 077
  set -C
  : "${RELEASE_DIR:?请先创建并核对发布记录目录}"
  rollback_tag=$(basename "$RELEASE_DIR")
  git rev-parse HEAD > "$RELEASE_DIR/commit-before.txt"
  cp -n compose.yaml "$RELEASE_DIR/compose-before.yaml"

  for service in api web; do
    container=$(docker compose --env-file ../config/compose.env ps -q "$service")
    test -n "$container"
    image=$(docker inspect --format '{{.Image}}' "$container")
    target="online-video-$service:$rollback_tag"
    if docker image inspect "$target" >/dev/null 2>&1; then
      echo "回退标签已存在，停止，不能覆盖：$target"
      exit 1
    fi
    docker image tag "$image" "$target"
    printf '%s %s\n' "$service" "$image" >> "$RELEASE_DIR/images-before.txt"
  done

  printf '%s\n' "$rollback_tag" > "$RELEASE_DIR/image-tag.txt"
  printf '回退点已保留：%s\n' "$RELEASE_DIR"
)
```

若失败，保留记录和已有标签，不从头重复覆盖同一目录。回退标签不是数据库备份，也不是独立的镜像离线备份，不能清理相关镜像。**接着先执行第 10.1 节完整备份，确认归档检查通过且旧容器恢复健康后，再继续下一步。**重新连接 SSH 后，需要手动把 `RELEASE_DIR` 设为刚才实际输出的目录，不能照抄虚构日期。

### 9.3 拉取代码并构建新镜像

先确认 Windows 上的代码已经正常提交、推送。服务器执行：

```bash
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
git pull --ff-only
```

成功后查看本次变化和升级说明，再决定是否适用普通更新：

```bash
git log -5 --oneline
git status --short
git diff --stat "$(cat "$RELEASE_DIR/commit-before.txt")" HEAD
docker compose --env-file ../config/compose.env config --quiet
```

若涉及数据库结构、数据迁移、部署路径、Compose 服务或密钥格式变化，暂停，按该版本专门升级方案处理。Compose 环境文件和启动 JSON 都在仓库外，正常拉代码不会覆盖它们。

确认无特殊升级要求后构建：

```bash
docker compose --env-file ../config/compose.env build api web
```

构建完成之前旧容器仍使用原镜像运行；失败时停止，不继续切换。默认复用缓存，不需要删镜像、缓存或加 `--no-cache`。首次部署使用 `build --pull`；日常若还计划刷新 Node/Nginx 基础镜像，可在审查风险后显式使用 `build --pull api web`，这和普通代码更新不是完全相同的变更范围。依赖仍按仓库锁文件安装，不能另行运行宿主机 `npm update`。

### 9.4 用新镜像替换本项目容器并验收

确认两个镜像都构建成功，再执行：

```bash
docker compose --env-file ../config/compose.env \
  up -d --no-build --pull never --wait api web
```

这一步按变化重建本项目容器，继续挂载同一份 `data` 和 `deployment.json`，不会重新初始化数据库。不要先执行 `down`；正常 `up` 不需要主动删除现有网络，也不需要重启 Docker 或 OpenResty。

检查：

```bash
docker compose --env-file ../config/compose.env ps
docker compose --env-file ../config/compose.env logs --tail=100 api web
curl --fail --show-error --connect-timeout 5 --max-time 15 \
  -w '\nHTTP=%{http_code}\n' http://127.0.0.1:18080/api/health
curl --fail --show-error --connect-timeout 5 --max-time 20 \
  -w '\nHTTP=%{http_code}\n' https://meetdawn.top/api/health
```

两个 health 都应直接返回预期 JSON、HTTP 200。浏览器使用原账号登录，确认原视频及设置仍在，按需验证一个小视频的上传、登记、封面和播放；原有网站也应确认访问正常。通过后在受保护的发布记录中记下新提交和验收结果，再恢复业务写入。

日常更新**不执行** `init-db.mjs`，不重新导入完整 SQL，不生成新 key，不重做账号初始化。若未来发布涉及数据库结构变更，必须另行阅读升级说明、备份并显式执行对应升级；本部署不自动迁移已有库。

### 9.5 异常时仅回退应用镜像

先保留错误、容器状态和日志。仅在确认数据库结构仍与旧版本兼容、并同意本项目短暂中断后，才使用已保存的旧 Compose 和镜像标签回退。以下不覆盖源码或数据库：

```bash
(
  set -eu
  : "${RELEASE_DIR:?请设为真实的发布记录目录}"
  cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
  rollback_tag=$(cat "$RELEASE_DIR/image-tag.txt")
  test -n "$rollback_tag"
  docker image inspect "online-video-api:$rollback_tag" "online-video-web:$rollback_tag" >/dev/null
  IMAGE_TAG="$rollback_tag" docker compose --env-file ../config/compose.env \
    --project-directory "$PWD" -f "$RELEASE_DIR/compose-before.yaml" \
    up -d --no-build --pull never --wait api web
)
```

然后重复第 9.4 节 health 和页面检查。此命令的 `IMAGE_TAG` 覆盖仅对该次调用生效；源码和默认 Compose 仍可能是新版本。回退后应记录实际使用的 Compose 文件及标签，暂停后续发布；后续操作继续明确使用该旧文件/标签，不能直接按默认 `:local` 再次 `up`。如需长期调整 `compose.env` 或回退源码，另行备份、确认后操作。

数据库恢复涉及覆盖和可能丢失备份后的数据，不包含在上述回退命令中。不要把旧备份直接解压到正在运行的数据目录，也不要强制回退 Git 来掩盖问题。

## 10. 备份、停机与重启

必须一起备份整个 `data` 和 `config`，尤其是匹配的数据库、主密钥、分类配置、启动 JSON；未完成安装时还需安装码。媒体文件在 OSS，数据库归档不等于备份了 OSS 对象。

### 10.1 推荐：短暂停本项目，生成完整一致性归档

先暂停上传和其他业务写入，并确认允许本项目短暂停机。最简单的一致性备份是正常停服务再归档；不要只复制运行中的 `.db` 而忽略 WAL。以下使用本次实际路径，只停止 `web api`，不操作 OpenResty、Redis、Docker 服务或其他应用。

在 Linux 服务器、同一 SSH 会话中先准备唯一目录：

```bash
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
install -d -m 0700 /opt/projectAPP/onlineVideo/backups
BACKUP_DIR=$(mktemp -d /opt/projectAPP/onlineVideo/backups/offline-$(date +%Y%m%d-%H%M%S)-XXXXXX)
printf '备份目录：%s\n' "$BACKUP_DIR"
```

确认路径正确后执行备份。此小节故意使用子 shell，使失败时停止后续步骤，但不退出 SSH：

```bash
(
  set -eu
  umask 077
  : "${BACKUP_DIR:?请先创建并核对备份目录}"
  cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
  docker compose --env-file ../config/compose.env stop web api
  (
    set -C
    tar -czf - -C /opt/projectAPP/onlineVideo data config > "$BACKUP_DIR/data-config.tar.gz"
  )
  gzip -t "$BACKUP_DIR/data-config.tar.gz"
  tar -tzf "$BACKUP_DIR/data-config.tar.gz" > /dev/null
  sha256sum "$BACKUP_DIR/data-config.tar.gz" > "$BACKUP_DIR/SHA256SUMS"
  printf '归档已生成并通过压缩/目录检查：%s\n' "$BACKUP_DIR/data-config.tar.gz"
  docker compose --env-file ../config/compose.env start --wait api web
)
```

这里用 `start` 恢复刚才已有的容器，不构建、不换镜像、不创建新网络。成功后再检查 `ps` 和第 9.4 节两个 health；压缩与目录检查不是数据库恢复演练，也不能替代离机备份。

如果归档或检查失败，后面的恢复步骤不会自动执行，项目可能仍处于停止状态。保留错误和不完整归档，不删除后硬重试；先确认磁盘、目录和配置未变，若只是备份失败且原容器可恢复，单独执行下列命令恢复原服务，再另建新的备份目录处理失败原因：

```bash
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
docker compose --env-file ../config/compose.env start --wait api web
```

归档包含解密主密钥，应放在受控目录，另存一份受保护的离机备份；不放到网站目录、公共 OSS、Git 或聊天中。备份时应记录对应提交；发布时还应保留第 9.2 节镜像标签和旧 Compose。恢复前先确认目标、停机和覆盖影响，单独制定恢复步骤，不直接解包覆盖正在使用的库。

### 10.2 仅重启本项目，不更新代码或镜像

需要用户确认维护窗口后才执行；这也是“重启持久化验收”的操作，不等于已经验收通过：

```bash
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
docker compose --env-file ../config/compose.env restart api web
docker compose --env-file ../config/compose.env ps
```

等待容器重新 healthy 后，检查两个 health、原密码登录、原设置和视频是否保留。API 容器由 init 转发退出信号并关闭 SQLite；`restart` 不会应用新镜像或修改后的环境变量。不要强杀未知进程，不使用 `down -v`、`system prune --volumes` 或删除 data 来排障。

## 11. 常见问题与排查顺序

### 11.1 先按层定位，不先改全局配置

| 现象 | 优先检查 |
| --- | --- |
| 初始化提示已有文件 | 确认是否已经初始化，或选错数据库路径；保留文件，不删除后强行重跑 |
| 启动提示数据库不存在 | 是否成功执行一次性初始化，DATA_DIR 与 databasePath 是否对应 |
| 提示 key 缺失或不匹配 | 是否误挂载新目录、显式写了不存在的 authKeyFile；不能生成新 key 替代旧 key |
| `EACCES` / SQLite 只读 | 新 data 目录是否匹配容器 UID/GID，文件/目录权限、userns/SELinux 是否正确 |
| 配置路径变成目录 | 挂载源是否实际是 JSON 文件；create_host_path=false 会提前暴露缺失路径 |
| 1Panel 502、本机 18080 health 正常 | 先查是否错代理到宿主机 3000；当前 host 网络应代理 18080，再查 OpenResty 网络和网站配置 |
| Web 502、API 不健康 | 先看 API 日志；检查新库结构、密钥、实际 HTTPS Origin，不反复重建空库 |
| Web 502、API healthy | healthy 只测 API 自己；另查 Web 到 API 的 DNS、监听、同网段连通性和 firewalld 网桥归属，见 11.2 |
| 构建 APT 提示 `Temporary failure resolving` | 比较宿主机、运行容器与构建环境的 DNS 和路由，再查实际构建网桥的防火墙归属，见 11.3 |
| HTTP health 返回 301/308 | 查看 `Location` 是否正常跳 HTTPS，再直接请求 HTTPS health；不把跳转当成 API 200 |
| HTTPS 页面打开但登录/API 失败 | 另测 HTTPS `/api/health`，检查转发头、Origin、Cookie、证书和 API 日志，不只看静态页面 |
| 登录/保存时报 CSRF 或 Cookie 问题 | 访问域名是否与 APP_ORIGIN 精确一致、是否 HTTPS、代理是否保留 Origin/Host/Cookie |
| 上传 413 / 504 | 检查 1Panel 与 Web 两层请求体限制和超时，再核对 OSS 网络/权限及 API 错误码 |
| 所有分片已上传，但完成确认 503 | 查普通 HEAD 与指定 `versionId` HEAD 的差异；会话策略拒绝与角色授权需分别核对，见 11.4 |
| 前端页面刷新 404 | 是否代理了整个站点到 Web，是否使用仓库自带的 SPA Nginx 配置 |
| 重启后数据没了 | DATA_DIR 是否改了、有没有错误创建第二套编排；先查原目录，不重新初始化 |

优先使用 `docker compose ... ps`、`logs --tail=100 api web` 和两段 health 检查定位。API 日志不会打印真实配置秘密；反馈问题时仍需去掉 Cookie、安装码、授权码及 key 内容。

### 11.2 本次 firewalld / Docker 网桥故障记录

本次曾发生 API 自己 healthy、Web 请求 API 返回 502。已确认 API DNS 为 `172.21.0.2`、监听和同一 Compose 网络均正确，真正原因是 firewalld 将项目网桥转发流量归入 `public`，以 `admin-prohibited` 拒绝。这个 IP 只是历史值，不能写死到代理配置。

若以后重现，先执行只读诊断，不重新建库或盲目改防火墙：

```bash
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
docker compose --env-file ../config/compose.env ps
docker compose --env-file ../config/compose.env logs --tail=100 api web
docker compose --env-file ../config/compose.env exec -T api node -e \
  "fetch('http://127.0.0.1:3000/api/health', {signal: AbortSignal.timeout(5000)}).then(async r => console.log(r.status, await r.text())).catch(e => { console.error(e.message); process.exitCode = 1; })"
docker compose --env-file ../config/compose.env exec -T web \
  wget -T 5 -S -O - http://api:3000/api/health
docker network inspect --format 'id={{.Id}} options={{json .Options}} containers={{json .Containers}}' online-video_default
```

API 自测成功但 Web 内请求失败时，再核对 firewalld。当前部署可只读查看：

```bash
firewall-cmd --get-active-zones
firewall-cmd --zone=docker --list-all
firewall-cmd --permanent --zone=docker --list-all
ip link show br-554b9a108de6
firewall-cmd --permanent --zone=docker --query-interface=br-554b9a108de6
```

最后两条中的网桥名是本次值。自定义桥名看网络 `Options`；默认 Compose 网桥通常是 `br-` 加网络 ID 前 12 位。若 inspect 显示网络已变化，应核对新网桥，不能照搬旧接口名。

**本次已完成的修复，不是要求再次执行：**

- 用户确认影响后，先备份 firewalld 配置、iptables/nftables、项目网络及运行时/永久配置快照，备份目录为 `/root/online-video-fw-wz04RZ`，保留不动。
- 核对运行时和永久配置差异后，创建标准 `docker` 区域，target 设为 `ACCEPT`，永久绑定 `br-554b9a108de6`；配置检查通过后只执行了一次 reload。
- 生效结果为 `docker: interfaces=br-554b9a108de6, target=ACCEPT`；`public: interfaces=eth0`；永久接口查询为 `yes`；随后两个项目容器 healthy，18080 health 返回 200。
- 临时 trusted 测试已撤销，没有永久加入 trusted，也没有额外创建出站 policy。使用标准区域是为兼容 Docker 的桥接网络恢复行为，避免自定义区域引起 `ZONE_CONFLICT`。

`ACCEPT` 的区域放行范围较宽，不能称为“只开放了 3000”；Docker 自身的隔离规则仍保留。该区域显示 `forward: no`、`masquerade: no` 时，不能只凭这两个字段判定失败，应同时看 target、实际规则和请求结果。当前记录不要求手动补建 Docker 官方较新文档提及的其他 policy。

新服务器或后续新故障应先查已有标准 `docker` 区域和网桥归属；若确需调整，全局防火墙变更必须重新说明影响、检查已有网站、备份并获得确认后另行制定命令。因此本节故意不提供可直接粘贴的建区域或 reload 脚本，不能把上次授权当成长期授权。

不要重复 `--new-zone=docker` 或 reload；不关闭防火墙，不永久加入 trusted，不把 FORWARD 全局改为 ACCEPT，不用 `--runtime-to-permanent` 批量覆盖永久配置，不重启 Docker。正常更新不执行 `compose down`；以后如果主动重建了网络，必须重新核对网桥归属。备份也不能未经核对整表恢复。其他容器仍运行只证明进程状态，不证明其他网站 HTTP 已验收。

### 11.3 本次 API 构建 DNS 故障与默认网桥修复

2026-10-30，服务器已拉取 `5ccdd38`，但 `docker compose --env-file ../config/compose.env build api` 在 APT 更新阶段报 `Temporary failure resolving 'mirrors.aliyun.com'`，退出码 100。此前的 CA 信任引导和复用镜像内 Node 头文件修复已在 Dockerfile 中，本次不重复处理，也不因构建失败重新初始化数据库。

**诊断结果：运行容器与构建环境不是同一条 DNS/网络路径。**

| 检查位置 | 实际结果 |
| --- | --- |
| 宿主机 | 可解析 `mirrors.aliyun.com`；DNS 为 `100.100.2.136`、`100.100.2.138` |
| 现有 API 容器 | 可解析；使用 Docker 内置 DNS `127.0.0.11`，上游为上述两个 DNS |
| 默认构建器 | `docker` 驱动，BuildKit `v0.13.2`；探针地址 `172.17.0.3`，默认网关 `172.17.0.1`，使用 `docker0` |
| 构建内 DNS | 同样使用上述两个上游 DNS，但解析立即返回 `EAI_AGAIN` |
| 防火墙 | `docker0` 为 `no zone`，落入默认 `public`；当时 `docker` 区域只绑定了项目网桥 |
| 转发与 NAT | 默认区域选择路径进入 `public`，转发主链末尾有 `admin-prohibited`；`172.17.0.0/16` 的 MASQUERADE 已存在，不是缺少 NAT 规则 |

因此不能只看现有 API healthy 或 DNS 成功就排除构建网络问题，也不能只看到 `no zone` 就直接修改。先比较上述证据，再经用户确认做最小变更的对照验证。

以后遇到同类问题，可先只读核对当前环境；下列命令不修改网络：

```bash
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
getent ahostsv4 mirrors.aliyun.com
cat /etc/resolv.conf
docker buildx inspect default
docker network inspect bridge --format 'IPAM={{json .IPAM.Config}} Options={{json .Options}}'
firewall-cmd --get-active-zones
firewall-cmd --get-zone-of-interface=docker0
firewall-cmd --permanent --zone=docker --query-interface=docker0
```

注意：本次 firewalld 的 `no zone` 写到标准错误。脚本如需捕获，应使用 `CURRENT_ZONE="$(firewall-cmd --get-zone-of-interface=docker0 2>&1 || true)"`，再明确判断是否恰为 `no zone`；不能把空值或其他查询错误当成允许修改的依据。查询永久绑定返回 `no` 时属于诊断结果，不要放在 `set -e` 流程中不加处理地继续执行变更。

**本次已执行的修复记录，不是新服务器的自动操作授权：**

1. 用户同意后，将 firewalld 配置、运行时/永久区域、nftables、iptables 和默认 bridge 信息备份到 `/root/online-video-build-fw-3x50tM`。该目录和此前 `/root/online-video-fw-wz04RZ` 均保留，不未经核对恢复整表。
2. 在确认 `docker0` 未绑定、已有 `docker` 区域 target 为 `ACCEPT` 后，仅运行 `firewall-cmd --zone=docker --add-interface=docker0`。它影响默认 bridge 上所有容器，不只本项目或 DNS；Docker 自身隔离规则仍保留。没有改 `eth0/public`、NAT、全局 DNS、出站 policy 或端口映射。
3. 用本地已有 API 镜像、通过标准输入 Dockerfile 执行默认构建网络 DNS 探针，不启动应用、不挂载数据库。日志中的 RUN 实际执行并返回 `DNS_OK`，不是 `CACHED`；对照验证临时绑定有效。该探针使用 `docker build`，不能将其专用参数直接套给 Compose。
4. 仅重新构建 API，成功后才允许短暂中断本项目 API 并替换容器；没有清理镜像或缓存，没有重建 Web，也没有重启 Docker、OpenResty、Redis 或其他应用。

本次应用更新使用以下两步，**分批执行，构建失败不得继续切换**：

```bash
# 第一步：Linux 服务器构建，仅 API；不加 --pull 或 --no-cache。
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
docker compose --env-file ../config/compose.env build api
```

```bash
# 第二步：仅在构建成功、确认维护窗口后执行。
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
docker compose --env-file ../config/compose.env \
  up -d --no-deps --no-build --pull never --wait --wait-timeout 120 api
```

构建完成但尚未切换时，`compose ps` 可能显示旧 API 的裸 `sha256`，这是标签已指向新镜像、旧容器仍使用原镜像的正常现象。切换后应比对 `docker image inspect online-video-api:local` 的 `.Id` 与运行容器的 `.Image`，再检查 localhost 和 HTTPS 两段 health；不用 `-k`，不开放 18080/3000。

**后续是否会复发：**正常 `git pull` 或 `compose build api` 不会主动删除已生效的绑定，无需每次更新重复调整。但本次 `docker0` 绑定尚未永久保存，firewalld reload、服务或服务器重启后可能丢失。若用户另行确认持久化，应只将 `docker0 -> docker` 这一项同时保留在运行时与永久配置中，分别查询并检查配置，不用 `--runtime-to-permanent`，无需为此再 reload。本次没有执行该永久保存或重启验证，不能写成已完成；以后修改 Docker/防火墙或网络结构仍需重新核对。

服务器大量 Git `M` 也曾被核对为 `100644 -> 100755` 的可执行位差异。仅在确认忽略可执行位后的工作区和暂存区 diff 均为空时，使用命令级 `git -c core.fileMode=false pull --ff-only origin main`；不 reset、restore、批量 chmod 或永久关闭文件模式检查。若存在实际内容变更，停止并先确认。

### 11.4 本次 OSS 指定版本读取失败与修复上线

本次原失败任务为 `bb0d95c5cbe33923d8481706c8f5d0c8fc02c693164c89eb1a50380e128b8e0d`。所有字节和分片已上传，对象已核验，数据库已保存 `versionId`，但完成接口返回 503。普通 HEAD 为 200，指定已保存 `versionId` 的 HEAD 为 403，OSS EC 为 `0003-00000301`，说明 STS 会话 Policy 拒绝请求。

- 临时凭据权限是 ARN 对应角色权限与 AssumeRole 会话 Policy 的交集；只给 AccessKey 所属用户加权限不能代替角色授权，`AliyunSTSAssumeRoleAccess` 也不能代替 OSS 权限。
- 角色的对象策略需有 `oss:GetObjectVersion`，仍限定原 Bucket/对象前缀。原程序 `read` 会话仅有 `oss:GetObject`，因此只补角色权限仍会失败。
- 修复提交 `5ccdd38` 仅给 `read` STS 会话补上 `oss:GetObjectVersion`，上传/导入会话权限、Bucket 与前缀限制不变；代码、测试及详细操作见 [OSS 指定版本读取修复](OSS_VERSION_READ_FIX.md)。不授予 `oss:*`，不关闭版本控制、不删除数据库版本号、不改公共读写或更换密钥绕过问题。
- 本地相关测试 44 项、API 类型检查和构建已通过；本次服务器 API 构建和镜像替换也已通过。运行镜像 ID 见第 0.2 节，localhost 和 HTTPS health 均为 200，Web 沿用原容器。
- 更新后让原账号对原失败任务重试完成确认，不重新上传文件。用户随后确认“当前已经可以了”，本次 OSS 阻塞按此确认关闭；未单独留存完成接口 200、只登记一条、封面及播放的逐项输出，不补写这些机器验收记录。CDN 某个视频可播放与 STS 指定版本读取仍是两项独立证据。

本次无数据库结构变更，没有重新运行 `deploy/init-db.mjs`、导入 SQL、生成密钥/安装码或覆盖数据库。健康检查不替代 OSS 验收；后续若复发，先收集新时间、应用状态码/错误码及脱敏 OSS EC/requestId，保留原任务和对象，不重复上传或扩大权限。

## 12. SQLite 数据库怎么查看和连接

### 12.1 不需要额外部署数据库服务

本项目使用 **SQLite 文件数据库**，不是 MySQL/PostgreSQL 服务。当前文件在：

```text
服务器：/opt/projectAPP/onlineVideo/data/online-video.db
容器内：/app/.local/data/online-video.db
```

没有数据库监听端口，也没有数据库连接用户名/密码；应用管理员密码不是数据库密码。数据目录权限和 SSH/系统权限负责保护文件。OSS/SMTP 等敏感字段另外使用伴随 `.auth.key` 加密，不能因为能打开数据库就删除、替换密钥或期望看到明文凭据。

不需要在 1Panel 安装 MySQL、phpMyAdmin 或新的数据库 Web 管理站点，也不要为此开放 3000、18080 或“数据库端口”。推荐：偶尔排查用现有 API 容器只读查询；想用图形界面就在 Windows 上用 Navicat 的 SQLite 连接或其他支持 SQLite 的桌面工具打开**一致性副本**。

### 12.2 方法 A：借用现有 API 容器，只读查看，不安装工具

Linux 服务器执行，API 必须正在运行。下面只显示完整性快检、迁移版本和表名，不读取密码哈希、会话或加密配置内容：

```bash
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
docker compose --env-file ../config/compose.env exec -T api node --input-type=module <<'NODE'
import Database from "better-sqlite3";

const db = new Database("/app/.local/data/online-video.db", {
  readonly: true,
  fileMustExist: true
});
try {
  console.log("quick_check:", db.pragma("quick_check", { simple: true }));
  console.table(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all());
  console.table(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all());
} finally {
  db.close();
}
NODE
```

`readonly: true` 禁止此连接写入；目标库不存在就报错，不创建新库。其他部署要同时核对实际 JSON 与容器路径。遇到锁或权限错误应保留提示并检查，不能删除 WAL/SHM、放宽到 777 或去掉只读保护来重试。大型库完整性检查可能耗时，不要高频执行。

### 12.3 方法 B：导出一致性副本，在 Windows 图形化查看

最简单的方式是执行第 10.1 节离线备份，再通过受保护的 SFTP/1Panel 文件功能下载归档，在 Windows 的**新建受控目录**中解压。若副本仍有 WAL/SHM 等伴随文件，保持与 `.db` 同目录，不遗漏、不混入其他版本。只用图形工具打开副本，不回传覆盖生产文件。

如果只是想查看数据库且不希望停服务，也可用容器里已有的 SQLite backup API 生成在线一致性副本，不需要安装宿主机 Node 或 SQLite。下面只读打开源库，写入一个唯一的新目录，不覆盖生产库或已有副本。它是诊断导出，**不是包含密钥、分类配置和外部配置的完整恢复备份**：

```bash
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
docker compose --env-file ../config/compose.env exec -T api node --input-type=module <<'NODE'
import { chmodSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

process.umask(0o077);
const db = new Database("/app/.local/data/online-video.db", {
  readonly: true,
  fileMustExist: true
});
try {
  const dir = mkdtempSync("/app/.local/data/sqlite-view-");
  const destination = join(dir, "online-video.db");
  await db.backup(destination);
  chmodSync(destination, 0o600);
  const copy = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    if (copy.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new Error("Export integrity check failed; preserve files and investigate.");
    }
  } finally {
    copy.close();
  }
  console.log("Server export:", destination.replace("/app/.local/data/", "/opt/projectAPP/onlineVideo/data/"));
} finally {
  db.close();
}
NODE
```

成功时输出服务器上的 `.../data/sqlite-view-随机字符/online-video.db`。通过有权限的 SSH/SFTP 或 1Panel 文件功能下载这个**导出文件**，不要直接下载正在运行的生产 `.db`。API 备份成功生成的是普通 SQLite 一致性副本，不需要去拼接生产 WAL；持续繁忙写入会让备份重试，应选业务空闲时执行。失败时保留错误和现场，不自动清理文件；导出目录会占空间，后续清理需单独确认。

Windows 图形工具操作：

1. 打开支持 SQLite 的桌面客户端，新建 SQLite 连接，选择“现有数据库文件”，不要创建新库。
2. 文件路径选择刚下载/解压的副本，不填服务器 IP、端口或应用登录密码；支持只读模式时启用只读。
3. 先查看表结构，再按需要查看有限行数。不要把账号哈希、会话、安装资料或配置截图发到聊天。
4. 副本不是实时连接，生产变化不会自动同步；在副本里编辑也不会自动修改服务器。不要把修改后的副本直接上传覆盖。

不要把生产数据目录挂到 Windows 网络共享来“远程直连”SQLite；跨网络文件锁和 WAL 一致性风险不能靠 SSH 隧道解决。若只是查看数据，无需在服务器部署数据库连接工具。确需修改生产数据时，另行明确字段、SQL、备份、维护窗口和验证，不能在只读排查过程中顺手执行写操作。

### 12.4 能否下载到本地修改，再上传覆盖生产库

**第 12.3 节的副本用于查看，不是“下载 → 随意修改 → 上传覆盖”的更新机制。** 下载后的副本不会同步生产变化；如果服务器继续运行，再上传会丢失这段时间的上传记录、设置、登录状态和其他写入。只复制 `.db` 还可能遗漏 WAL 中尚未合并的数据，直接覆盖正在打开的数据库也会破坏文件与日志的对应关系。

- 改视频信息、分类/标签、OSS/SMTP 等业务配置，优先使用网页功能，保留应用校验、加密和关联更新逻辑。
- 版本发布需要调整表结构时，使用该版本经审查的迁移方案；不拿本地开发库覆盖生产，也不重新导入完整建库 SQL。
- 确需人工修复数据时，优先先提供明确的只读诊断与最小 SQL 方案，经确认并备份后在维护窗口执行，避免整库搬回搬去。

技术上可以做离线数据库维护，但必须单独确认目标和影响，并至少满足以下步骤；本节不提供可直接覆盖生产文件的命令：

1. 明确要改的记录、关联约束、影响范围和回退标准，先停止本项目 API/Web 以及其他可能访问该库的写入者。
2. 保存第 10.1 节完整一致性备份，保留原库、匹配主密钥、分类配置和相关日志；从这个停止写入后的确定时间点开始维护，不能拿几天前下载的副本覆盖最新数据。
3. 在独立副本中进行经确认的修改，关闭图形客户端后，用 SQLite backup API 等方式形成完整一致性候选库，不把副本的 WAL/SHM 与生产旧日志混配；检查 `integrity_check`、外键和目标业务关联。
4. 通过单独确认的切库/恢复方案启用候选库，明确使用原来匹配的 `.auth.key`、对应 `.library.json` 与启动 JSON；默认保留原文件，不直接覆盖或删除原库。路径改名也必须核对所有伴随文件，不能触发生成新密钥或安装流程。
5. 启动并检查 health、原账号登录、相关视频/配置和实际修复效果；失败时按原回退点恢复。恢复业务写入后若再回退，必须评估新写入的损失，不能直接换回旧快照。

不要在图形工具中直接编辑密文、密码哈希、迁移账本或安装状态。这里说明的是维护边界，不代表已授权或已执行生产数据库写操作。

## 13. 搬迁到另一台服务器：镜像、数据、配置必须配套

### 13.1 除两个镜像和数据库，还要带走什么

| 内容 | 是否需要 | 说明 |
| --- | --- | --- |
| 当前运行的 API、Web 镜像 | 必须 | 使用 `docker image save` 导出镜像，目标机 `docker image load`；不是导出容器文件系统 |
| 整个服务器 `data/` | 必须 | 包括 `online-video.db`、匹配的 `.auth.key`、`.library.json`、保留的安装码，以及当时存在的 WAL/SHM/journal；停写后一致归档，不只下载 `.db` |
| 整个服务器外部 `config/` | 必须 | 包括 `compose.env`、`deployment.json`；换目录/域名时只在新服务器副本中逐项调整 |
| 对应版本 `compose.yaml` | 必须 | 定义端口、环境、健康检查和挂载；使用 bridge 方案时还要配套 override，本次 host 方案不需要 |
| 对应提交源码和发布记录 | 推荐一并保留，本节命令会打包 | 用 Git bundle 保留 `main` 及历史，目标机可恢复仓库以便以后更新；记录提交、镜像 ID/标签和平台 |
| 1Panel 网站配置、证书安排 | 必须准备 | 记录域名、整站代理目标、HTTPS 跳转、上传限制、超时和转发头；证书可安全导出证书及私钥，或在新机重新签发，不能只带公钥证书 |
| DNS、云安全组和依赖访问条件 | 必须核对 | A/AAAA 指向新机；80/443、SSH/面板管理策略按实际规划；不公开 18080、3000 |
| OSS 视频和封面对象 | 必须继续可访问，但不在本地包内 | 保留原 Bucket/地域/媒体域名/前缀及权限；如果同时更换 OSS，要另做对象和地址迁移，不能只搬数据库 |
| SMTP、RAM/STS、内网条件 | 必须复核 | 配置可随原库及密钥恢复，但新 IP 白名单、ECS 角色、同地域内网、出站限制等不会被镜像自动迁移 |
| 历史备份与恢复资料 | 建议另存受保护离机副本 | 不和迁移包唯一副本一起丢弃；旧服务器和原始数据保留到验收及回退窗口结束 |

无需搬走 Windows `node_modules`、宿主机 npm/Node、旧容器 ID、Docker 网桥/IP、整个 `/var/lib/docker`、其他站点数据库或 Redis。**不要把旧机的 iptables/nftables/firewalld 整表恢复到新机**，新网桥需在新环境重新核对。

下列是将来迁移时的分批操作说明，本轮不执行。适用于源机 `main` 对应当前镜像的构建提交、host 网络、目标 Linux 平台与镜像兼容、使用 root/相应管理员权限，以及**新目标目录尚不存在**。先确认维护窗口、磁盘空间和传输方式。Docker 26 的示例不使用较新版本才有的镜像 `--platform` 参数；跨 CPU 架构不能指望 save/load 自动转换，应另行构建并验证匹配平台的镜像。

### 13.2 旧服务器：先导出镜像和对应源码，暂不停业务

先执行第 9.2 节只读检查，确认工作区、分支和实际发布提交。源码若曾拉取但尚未发布，不能把当前 HEAD 当成运行镜像版本，应先按发布记录核对。然后在同一 SSH 会话中准备新目录：

```bash
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
install -d -m 0700 /opt/projectAPP/onlineVideo/backups
MIGRATE_DIR=$(mktemp -d /opt/projectAPP/onlineVideo/backups/migrate-$(date +%Y%m%d-%H%M%S)-XXXXXX)
printf '迁移包目录：%s\n' "$MIGRATE_DIR"
```

确认目录创建成功后执行；新建唯一镜像标签，不覆盖 `:local` 或旧回退标签：

```bash
(
  set -euo pipefail
  umask 077
  set -C
  : "${MIGRATE_DIR:?请先创建并核对迁移包目录}"
  test "$(git branch --show-current)" = main
  test "$(git rev-parse --is-shallow-repository)" = false
  image_tag=$(basename "$MIGRATE_DIR")
  git rev-parse HEAD > "$MIGRATE_DIR/commit.txt"
  git bundle create "$MIGRATE_DIR/source.bundle" refs/heads/main
  cp -n compose.yaml "$MIGRATE_DIR/compose.yaml"

  for service in api web; do
    container=$(docker compose --env-file ../config/compose.env ps -q "$service")
    test -n "$container"
    image=$(docker inspect --format '{{.Image}}' "$container")
    target="online-video-$service:$image_tag"
    if docker image inspect "$target" >/dev/null 2>&1; then
      echo "迁移标签已存在，停止，不能覆盖：$target"
      exit 1
    fi
    docker image tag "$image" "$target"
    docker image inspect --format '{{.Os}}/{{.Architecture}} {{.Id}}' "$target" >> "$MIGRATE_DIR/images.txt"
  done

  printf '%s\n' "$image_tag" > "$MIGRATE_DIR/image-tag.txt"
  docker image save "online-video-api:$image_tag" "online-video-web:$image_tag" \
    | gzip > "$MIGRATE_DIR/images.tar.gz"
  gzip -t "$MIGRATE_DIR/images.tar.gz"
  printf '镜像和源码导出完成：%s\n' "$MIGRATE_DIR"
)
```

遇到任何失败都保留现场，不重复覆盖同一目录。浅克隆仓库应另行确认源码打包方式，不在此处自动拉全历史。迁移标签保留的是运行镜像；Git bundle 是提交内容，不包含未提交文件、外部配置或数据。此时镜像不含绑定挂载的 `data/config`，迁移包还不完整。

通过 1Panel 受保护的站点/证书管理功能，另外保存该站点的配置记录和证书安排。只处理本项目，不复制覆盖其他站点的 OpenResty 全局配置；已有证书私钥和 DNS API 凭据不可发到聊天或放公共位置。

### 13.3 旧服务器：确认停写窗口后，制作最终数据包

确认新机准备条件和维护窗口后暂停上传等业务，只停止本项目，生成最终一致性归档。**迁移期间旧机保持停止，不执行第 10.1 节的自动恢复命令**，避免归档后又产生新数据：

```bash
(
  set -eu
  umask 077
  : "${MIGRATE_DIR:?请设为真实的迁移包目录}"
  cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
  docker compose --env-file ../config/compose.env stop web api
  (
    set -C
    tar -czf - -C /opt/projectAPP/onlineVideo data config > "$MIGRATE_DIR/data-config.tar.gz"
  )
  gzip -t "$MIGRATE_DIR/data-config.tar.gz"
  tar -tzf "$MIGRATE_DIR/data-config.tar.gz" > /dev/null
  cd "$MIGRATE_DIR"
  (
    set -C
    sha256sum images.tar.gz data-config.tar.gz source.bundle compose.yaml \
      commit.txt image-tag.txt images.txt > SHA256SUMS
  )
  printf '迁移包完成；旧机仍保持停止：%s\n' "$MIGRATE_DIR"
)
```

完整下载/传输该目录中的 8 个文件：`images.tar.gz`、`data-config.tar.gz`、`source.bundle`、`compose.yaml`、`commit.txt`、`image-tag.txt`、`images.txt`、`SHA256SUMS`；再带上单独安全保存的网站配置记录和证书材料（或确认重签方案）。可经可信 SFTP 或受控 SSH 传输，先核对目标主机指纹。整个包包含密钥和生产数据，不能放 Git、网站下载目录或公共 OSS。

若决定中止迁移，先确认新机还没有接收业务写入，再按第 10.1 节的恢复命令启动旧容器。新机已接收写入后不能直接启动旧快照回退，否则会产生两套不一致的数据，必须先处理增量和切换方案。

### 13.4 新服务器：校验包，恢复到全新目录

先准备兼容的 Docker/Compose、Git 和 1Panel/OpenResty，检查平台、磁盘、系统时间、域名/证书方案和 OSS/SMTP 网络条件。本节不安装、重启或重配新服务器上的其他服务。新机 OpenResty 如果不是 host 网络，应先按第 5 节单独确认网络方案，不能机械照抄。

通过受控传输把迁移包放到新机的受保护目录。设置 `MIGRATE_DIR` 为实际绝对路径，再逐批执行；下列检查不导入或解包：

```bash
# 新服务器：把路径替换为收到迁移包的真实目录。
MIGRATE_DIR=/root/online-video-migration-实际目录
cd "$MIGRATE_DIR"
sha256sum -c SHA256SUMS
cat images.txt
docker info --format '{{.OSType}}/{{.Architecture}}'
docker compose version
```

确认校验全部通过且镜像平台兼容后，导入镜像；load 可能改动同名镜像标签，因此必须先确认这是本项目的唯一新迁移标签，不覆盖已有同名部署：

```bash
docker image load -i "$MIGRATE_DIR/images.tar.gz"
```

仅限 `/opt/projectAPP/onlineVideo` **尚不存在**的新目标，恢复到独立空目录，不覆盖已有数据、源码或配置。下面的拒绝检查失败时应停止，重新规划新路径，而不是删除旧目录：

```bash
(
  set -eu
  umask 077
  : "${MIGRATE_DIR:?请设为新服务器上的真实迁移包目录}"
  if [ -e /opt/projectAPP/onlineVideo ] || [ -L /opt/projectAPP/onlineVideo ]; then
    echo '目标已存在，停止；不覆盖、不删除。'
    exit 1
  fi
  install -d -m 0755 /opt/projectAPP/onlineVideo
  git clone --branch main "$MIGRATE_DIR/source.bundle" /opt/projectAPP/onlineVideo/PrivateOnlineVideo
  cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
  test "$(git rev-parse HEAD)" = "$(cat "$MIGRATE_DIR/commit.txt")"
  cmp compose.yaml "$MIGRATE_DIR/compose.yaml"
  git remote set-url origin https://github.com/yingchunfeng/PrivateOnlineVideo.git
  tar --extract --gzip --file "$MIGRATE_DIR/data-config.tar.gz" \
    --directory /opt/projectAPP/onlineVideo --keep-old-files --numeric-owner --same-owner
)
```

本节的克隆和 origin 设置只操作**新建仓库**，不切换旧服务器或本机分支。恢复会保留归档中的权限和 UID/GID；本次 API 使用 1000:1000，data 为 700，数据库和主密钥为 600。若新机启用 rootless/userns/SELinux，要另行匹配映射和标签，不递归乱改所有权或设成 777。脚本中断时保留已恢复内容，先核对进度，不从头删除后重来。

### 13.5 新服务器：调整外部配置，启动与切换域名

1. 仅在新服务器备份并编辑恢复后的 `config/compose.env`，把 `IMAGE_TAG` 改为包中 `image-tag.txt` 的实际值；保留正确的 `DATA_DIR`、`DEPLOY_CONFIG_FILE` 和 HTTPS `APP_ORIGIN`。不要覆盖成模板的 `new-install.db`。换域名时同步 Origin、DNS、证书和站点绑定；媒体 Origin 不应随管理域名随意改变。
2. 核对 `deployment.json` 仍指向 `.local/data/online-video.db`，原密钥和 `.library.json` 都在。不要运行 `init-db.mjs`、完整 SQL、迁移或安装向导，不重新生成账号/密钥/安装码。
3. 按第 7 节在新机核对/配置整站代理、证书、HTTPS 跳转和上传参数。新的项目网桥会不同，只有出现连通问题才按第 11.2 节诊断；修改全局防火墙需要重新确认，不复制旧机整表规则。

配置核对完成后，仅启动本项目：

```bash
cd /opt/projectAPP/onlineVideo/PrivateOnlineVideo
docker compose --env-file ../config/compose.env config --quiet
docker compose --env-file ../config/compose.env config --images
```

确认解析出的两个镜像标签与迁移包一致，且镜像已经 load；检查数据、密钥、配置存在后再运行：

```bash
docker compose --env-file ../config/compose.env \
  up -d --no-build --pull never --wait api web
docker compose --env-file ../config/compose.env ps
curl --fail --show-error --connect-timeout 5 --max-time 15 \
  -w '\nHTTP=%{http_code}\n' http://127.0.0.1:18080/api/health
```

域名切换前，可在新机使用下面的本机定向 HTTPS 检查，仍校验证书，不依赖公网 DNS 已完成更新；要求新机 OpenResty 已监听 host 的 443 并配置好此域名：

```bash
curl --fail --show-error --connect-timeout 5 --max-time 20 \
  --resolve meetdawn.top:443:127.0.0.1 \
  -w '\nHTTP=%{http_code}\n' https://meetdawn.top/api/health
```

检查通过后，按实际 DNS 服务商修改 A/AAAA 到新机，核对缓存和 IPv6，浏览器再次确认正确证书、原账号登录、原设置/视频、OSS 小视频上传/登记/封面/播放和按需 SMTP 实际收件。RAM/STS 白名单、内网选择、SMTP 出站或新机时间错误需要按具体错误处理，不重置业务库。

再经确认仅重启本项目验证持久化，手机和大文件仍单列。旧服务器保留停止状态及完整回退材料，验收和回退窗口结束前不删除原库、密钥、镜像或备份，也不要同时让两个管理站点接收写入。用迁移标签上线后，今后构建更新会写入该标签；若计划恢复 `IMAGE_TAG=local`，应单独保留回退点、调整配置并按第 9 节重新发布，不能误覆盖唯一迁移镜像。

## 14. 验证范围与官方依据

开发机可以在项目根目录执行以下隔离检查；会新建 `.local/tests/docker-deployment-*` 测试目录，不访问现有业务库，也不调用真实 OSS/SMTP：

```text
node --test deploy/test/build-config.test.mjs
npm run build -w @online-video/shared
npm run build -w @online-video/api
node --test deploy/test/deployment.test.mjs
```

- 本地可验证：部署脚本语法、初始化安全边界、完整 SQL 与迁移校验、自动生成/复用 key、配置样例及文件编码。
- 本地未安装 Docker，不能把这些本地检查称为镜像构建成功、Nginx 启动成功或服务器上线成功。
- 本次服务器构建、容器健康、OSS 修复后的用户确认见第 0.2、11.3、11.4 节；这不替代其中单列的逐项业务输出、重启持久化、按需邮件、大文件与手机验收记录。
- Docker：[多阶段构建](https://docs.docker.com/build/building/multi-stage/)、[Compose 服务及挂载](https://docs.docker.com/reference/compose-file/services/)。
- Docker 更新：[build](https://docs.docker.com/reference/cli/docker/compose/build/)、[up](https://docs.docker.com/reference/cli/docker/compose/up/)、[start](https://docs.docker.com/reference/cli/docker/compose/start/)、[restart](https://docs.docker.com/reference/cli/docker/compose/restart/)、[firewalld 集成](https://docs.docker.com/engine/network/packet-filtering-firewalls/#integration-with-firewalld)。官方在线文档可能对应较新版本，本次运行版本见第 0 节，不据此要求升级或补建 policy。
- firewalld：[运行时与永久配置](https://firewalld.org/documentation/man-pages/firewall-cmd.html)、[本次 0.9.11 版本手册](https://github.com/firewalld/firewalld/blob/v0.9.11/doc/xml/firewall-cmd.xml.in)。单项持久化不等于已执行 reload 或重启验收。
- Docker 迁移：[image save](https://docs.docker.com/reference/cli/docker/image/save/)、[image load](https://docs.docker.com/reference/cli/docker/image/load/)、[container export 不包含卷数据](https://docs.docker.com/reference/cli/docker/container/export/)。镜像只保留自身层，不代替外部绑定挂载目录的备份。
- Git：[bundle 离线传输仓库](https://git-scm.com/docs/git-bundle)。迁移包使用完整分支，不使用依赖旧机对象的增量 bundle。
- Nginx：[HTTP 代理模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。
- 1Panel：[容器编排](https://github.com/1panel-dev/docs/blob/zh-CN/deploy/v2/user_manual/containers/compose/index.html)、[创建反向代理网站](https://github.com/1panel-dev/docs/blob/zh-CN/deploy/v2/user_manual/websites/website_create/index.html)。
- SQLite：[安全备份与文件锁风险](https://www.sqlite.org/howtocorrupt.html)、[在线备份 API](https://www.sqlite.org/backup.html)；[better-sqlite3 连接与备份 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)。项目已包含该依赖，不需要为查询再安装。

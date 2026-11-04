# 仓库公开与本地资源维护

## 可以提交的内容

- 源码、共享类型、测试源码及固定测试素材、迁移文件、锁文件和部署脚本。
- `README.md`、`apps/web/README.md`，以及安装、部署、API、数据库、账号、OSS 和邮件等维护指南。
- `config/deployment.example.json`、`config/library.example.json`、`.env.example`、`deploy/deployment.json.example` 等不含秘密的配置模板。
- 新部署的唯一 SQL 入口 `docs/sql/NEW_INSTALL_FULL.sql`。另两份历史 SQL 仍被回归测试读取，不能作为普通生成文件清理。

## 只保留本机的内容

`.gitignore` 排除以下内容，但不会删除本地文件：

- 数据库及 WAL/SHM、应用主密钥、安装码、恢复资料、备份和 `.local/`。
- 真实 `.env`、私钥/证书容器、`config/deployment.json`、`config/library.json`。后两者即使只有路径或域名，也属于部署实例配置，不宜当作公共模板维护。
- 编辑器和助手的本机配置，以及需求、阶段计划、原型、历史交接和视觉探索记录。
- npm 缓存、构建输出、浏览器截图/报告和 TypeScript 增量缓存。
- `apps/web/test/stage2-real-oss.test.ts` 等依赖具体本机历史授权的专用实云验收入口，以及测试的 `output/`、`reports/`、`artifacts/`、`screenshots/`、覆盖率和 Playwright 报告；不据此排除普通自动化回归源码。

默认数据库配置入口不读取 `.env` 或旧 `config/library.json`。源码新安装从 `config/deployment.example.json` 创建本机配置；旧 `.env` 入口才需要自行准备 `config/library.json`，可参考 `config/library.example.json`。**模板不是现有配置的替换文件，不能直接覆盖已经运行的实例。**

业务数据库虽然对 OSS/SMTP 凭据加密，仍包含账号和业务信息；数据库、对应主密钥、伴随 `.library.json` 与安装/恢复资料均不得公开。不要将秘密放进 `VITE_*`，这些变量可能进入浏览器构建产物。

## 忽略不等于取消跟踪

新增 `.gitignore` 只阻止尚未跟踪的文件被普通 `git add` 收入。已经提交过的文件依然被跟踪，仍会存在于当前版本和历史提交；加忽略规则不会撤回 GitHub 上的内容。

公开前可在项目根目录只读核对：

```powershell
git status --short
git ls-files -ci --exclude-standard
git ls-files -- .env config/deployment.json config/library.json '*.auth.key' '*.db' '*.pem'
```

`git ls-files -ci --exclude-standard` 的结果是“现已匹配忽略规则，但仍被跟踪”的清单。逐份确认后，才可以单独授权取消跟踪；取消跟踪应保留本地文件，并检查新的克隆只依赖公开模板和维护文档。不要用删除文件或覆盖本机配置来替代取消跟踪。

普通取消跟踪也不会清除历史。如果发现真实密钥曾公开，应先撤销/轮换凭据、评估访问日志，再另行确认历史清理方案。不能只改 `.gitignore` 或删除最新版本后就认定秘密安全。

## 本地资源清理边界

| 类型 | 处理原则 |
| --- | --- |
| 隔离测试生成的 UUID 目录及临时 SQLite 库 | 可列为候选；核对生成代码、文件清单、占用情况和授权后再处理 |
| 旧浏览器截图/日志/报告 | 可按批次审阅；先排除固定样例、迁移证据、授权记录和当前验收证据 |
| `.npm-cache/` | 可重建的下载缓存，但离线安装可能依赖它；需要单独确认 |
| `dist/` | 可重建，但可能是运行入口或正在使用的发布包；不能运行中直接清空 |
| 普通 `apps/*/test/` 回归源码、固定媒体、`mock-media-plugin.ts`、`release-build.ts`、`release-policy.ts` | 继续跟踪并保留；部分文件直接参与开发启动或构建，不能整个忽略测试目录 |
| `.local/data/`、`secrets/`、`backups/`、`tools/`、账号恢复文件 | 默认保护；不是测试垃圾 |

实际清理前应固定绝对路径、大小、修改时间和 SHA-256 清单，检查路径仍在工作区内且没有重解析点，确认不是运行中的数据库/发布目录。获得针对该清单的明确授权后才执行；之后重新生成的同名目录不沿用旧授权。

本轮审计、清单及经确认执行的本地清理记录保存在被忽略的 `.local/repository-review-20261103/`，不作为公开部署依赖。本机配置、开发阶段文件和上述专用实云验收脚本取消跟踪时保留本地副本，不改写 Git 历史。以后应重新检查实际仓库和资源状态，而不是将这份审阅当作永久安全保证。

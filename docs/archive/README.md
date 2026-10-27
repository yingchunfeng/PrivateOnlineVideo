# 历史文档归档

整理日期：2026-10-26。用户已确认采用方案 A：归档旧阶段文档、修正引用，并清理限定范围内的历史测试产物。

**当前工作入口：[未完成工作清单与已确认完成记录](../task/UNFINISHED_WORK.md)。** 本目录仅用于查阅历史设计、任务分工和验收过程；其中旧 TODO、执行提示词、迁移及云操作授权不代表当前任务或新的操作授权。

## 1. 已归档的 24 份文档

原 `docs/` 下的历史文档移入本目录，原 `docs/task/` 文件保留 `task/` 子目录。原 `.ai/demand/` 的 9 份本地任务板移入本目录的 `.ai/demand/`，沿用既有 `.ai/` 忽略规则，不改变其仅本地保存的边界；新克隆环境可能没有这些文件。

### 阶段规划与总看板（原 `docs/task/`）

- [旧总任务看板](task/TASKS.md)
- [CORE-01 规划](task/CORE-01.md)
- [第二阶段计划](task/STAGE2.md)
- [第二阶段架构评审](task/STAGE2_ARCHITECTURE_REVIEW.md)
- [第三阶段旧计划](task/STAGE3.md)
- [OSS 与框架调整历史](task/OSS和框架调整相关.md)

### 交接与验收（原 `docs/`）

- [CORE-01 交接](CORE01_HANDOFF.md)
- [并行开发交接](PARALLEL_DEVELOPMENT_HANDOFF.md)
- [旧 OSS 本地验收计划](OSS_LOCAL_TEST_PLAN.md)
- [第二阶段 API 契约](STAGE2_API_CONTRACT.md)
- [第二阶段后端交接](STAGE2_BACKEND_HANDOFF.md)
- [第二阶段实云验收计划](STAGE2_CLOUD_ACCEPTANCE_PLAN.md)
- [第二阶段完成审计](STAGE2_COMPLETION_AUDIT.md)
- [第二阶段联调记录](STAGE2_INTEGRATION.md)
- [第二阶段运行操作计划](STAGE2_OPERATIONS_PLAN.md)

### 本地代理任务板（原 `.ai/demand/`）

- 第一阶段：[后端](.ai/demand/01-backend.md)、[媒体](.ai/demand/02-media.md)、[前端](.ai/demand/03-frontend.md)
- 第二阶段：[后端](.ai/demand/stage2/01-backend.md)、[媒体](.ai/demand/stage2/02-media.md)、[前端](.ai/demand/stage2/03-frontend.md)
- 第三阶段：[部署](.ai/demand/stage3/01-deployment.md)、[OSS 运维](.ai/demand/stage3/02-oss-operations.md)、[安卓验收](.ai/demand/stage3/03-acceptance.md)

## 2. 本次测试产物清理记录

| 原位置 | 实际清理范围 | 结果 |
| --- | --- | --- |
| `.local/isolated-upgrade-media-*` | 本次盘点的 121 个随机隔离目录及其中 121 个测试数据库 | 已删除，约 38.49 MiB |
| `apps/web/qa/` | 151 个历史截图、JSON 报告和日志，以及该输出目录 | 已删除，约 25.49 MiB |

共清理 272 个文件，约 **63.98 MiB**。删除前核对了工作区绝对路径、重解析点、文件占用和前后内容快照；无跳过或失败目标，没有终止任何进程。系统限制了进程命令行查询，因此未将“文件可独占打开”表述为所有测试进程均已停止。

这些旧 QA 产物不再存在；相关文档中的可点击证据链接已改为带清理说明的历史路径。测试源码保留，后续运行仍会创建新的输出目录。本次没有改变测试产物或配置备份的自动保留策略。

## 3. 保留范围与兼容说明

- 正式数据库、密钥、账号/恢复资料、数据库备份、`.env`、当前配置及 30 份配置备份均保留。
- `.local/tests/`、`.local/acceptance/`、固定视频样例、`.local/tools/`、根目录 `sqlite-test.db`、缓存与构建产物均未清理。
- 业务源码、测试源码、包脚本、锁文件、数据库迁移和 `docs/sql/` 中的 SQL 均未修改；仅相关 Markdown 链接随文档归档调整。
- `permission-probe.ts` 中的 `docs/STAGE2_CLOUD_ACCEPTANCE_PLAN.md` 是旧授权记录的精确身份标识，不是运行时读取文档的路径。因此该字符串和已有授权 JSON 保持原样，不因归档改写。
- 归档文档内代码块、普通文本中的旧工程路径可作为历史记录保留；实际查阅位置以本索引和已修正的 Markdown 链接为准。

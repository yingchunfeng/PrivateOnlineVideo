# SQLite 完整建表与已有库升级说明

## 唯一新部署入口（v9）

**新空库只执行 [NEW_INSTALL_FULL.sql](NEW_INSTALL_FULL.sql) 这一份，不叠加任何增量或历史 SQL。** 该文件由 0001～0009 的迁移链生成最终结构，包含 42 张表、9 条带 SHA-256 校验的迁移账本，以及 QQ/163 邮箱类型种子。站点设置、访客凭证、访客会话及首页排序表已经包含在内，不包含账号、安装码、应用主密钥或 OSS/SMTP 凭据。

导入后按[新部署指南](../NEW_INSTALL.md)启动首次安装向导，使用本机一次性安装码和初始密码设置账号。**不得在现有数据库执行全量 SQL，也不需要先执行旧 SQL 或 `account:init`。** 服务启动不会自动迁移旧库；旧库升级必须先核对目标、做好一致性备份，再明确授权增量迁移。

| 文件 | 当前用途 | 新部署是否执行 |
| --- | --- | --- |
| [NEW_INSTALL_FULL.sql](NEW_INSTALL_FULL.sql) | 当前 v9 完整结构；新空库唯一入口 | 只执行这一份 |
| [UPGRADE_V8_TO_V9.sql](UPGRADE_V8_TO_V9.sql) | 已有 v8 库升级首页排序，包含旧账本校验和 v9 账本追加 | 不执行；仅既有 v8 库使用 |
| [01_EMPTY_DATABASE_FULL.sql](01_EMPTY_DATABASE_FULL.sql) | 历史第二阶段结构，兼容结构回归测试 | 不执行 |
| [STAGE2_PENDING.sql](STAGE2_PENDING.sql) | 历史 v1→v2 变更快照，兼容迁移校验测试 | 不执行 |

两份历史文件保留是因为 `apps/api/test/stage2-backend.test.ts` 仍读取它们核对历史结构和迁移校验；它们不是需要追加执行的安装步骤。不要拼接全量、增量和历史文件，避免重复建表、重复 ALTER 和账本不一致。

## 已有 v8 库升级到 v9

仅使用 [UPGRADE_V8_TO_V9.sql](UPGRADE_V8_TO_V9.sql)。该文件从当前 0009 原始迁移生成，只新增 `homepage_settings` 空表，并追加第 9 条迁移账本；原有账号、视频、任务、站点设置和前 8 条账本不变。不提供重置、清空或重新初始化步骤。

1. 核对实际数据库路径和版本，停止 API 与上传任务，并先使用 SQLite 在线备份接口、备份命令或停库后的一致性备份流程做好备份；同时保留配套密钥和 `.library.json`。本 SQL 本身不会创建备份，不要在运行中只复制 `.db` 而漏掉 WAL。
2. 连接正确的既有 v8 数据库，使用没有未提交事务的新连接。必须开启“遇错停止”，整份执行增量 SQL；不要只选中建表语句执行。
3. 脚本在同一事务中验证 1～8 的版本和 SHA-256、目标表尚不存在，以及外键/完整性检查；条件不满足即拒绝。新空库、v5～v7、已升级 v9 或半升级库均不适用，不应通过改账本或加 `IF NOT EXISTS` 强行执行。
4. 成功后，外键检查无异常行，完整性检查为 `ok`，账本为 1～9；标准数据库有 42 张表，`homepage_settings` 为空，开关默认值由应用读取时提供。若报错立即停止；若该连接仍在事务中，执行 `ROLLBACK;` 后保留原库与错误排查，不继续运行余下语句。
5. 按正常更新流程构建并启动新版本，在“配置管理 → 首页排序”检查开关与拖拽保存。重新启动不会自动补迁移，切换代码版本也不会回滚数据库结构。

`apps/api/src/db/migrations/0009-homepage-settings.sql` 是受控迁移程序使用的**原始建表片段**，单独执行不包含账本追加，不是完整的手工升级脚本。已有 v5～v7 库应另行确认完整迁移范围，不能直接套用 v8→v9 脚本；原 `db:migrate --database ... --apply` 入口仍保留，执行它同样需要单独授权。

## 导入及验证

1. 在 SQLite 客户端中新建独立空 `.db`，例如 `.local/data/new-install.db`；确认不是已有业务库或旧测试库。
2. 设置遇错停止，完整执行 `NEW_INSTALL_FULL.sql`。不要只选择部分语句，也不要选择遇错继续。
3. 末尾 `PRAGMA foreign_key_check` 应无异常行，`PRAGMA integrity_check` 应返回 `ok`。若出错，在同一连接执行 `ROLLBACK;` 后保留错误排查，不继续执行或清空旧数据。
4. 使用以下只读语句核对版本和表数，然后按新部署指南启动安装向导。

```sql
SELECT count(*) AS table_count FROM sqlite_master
WHERE type = 'table' AND name NOT LIKE 'sqlite_%'; -- 42
SELECT version FROM schema_migrations ORDER BY version; -- 1 至 9
```

Linux 容器部署的首次初始化由 `deploy/init-db.mjs` 导入同一份 SQL，步骤见[1Panel 部署指南](../DEPLOY_1PANEL.md)。不要在初始化后再次手动导入。脚本不会包含个人数据，也不是业务数据库备份。

## 生成及回归测试

生成器始终从迁移后的内存空库导出最终结构，不连接磁盘业务库。默认只输出 SQL；指定 `--output` 时仅允许创建不存在的新文件，不覆盖已有文件：

```powershell
npm run db:export-full -w @online-video/api
# 如需保存，使用一个不存在的文件名，核对后再决定是否更新发布文件。
npm run db:export-full -w @online-video/api -- --output ../../.local/new-install-review.sql
```

发布文件与生成器逐字节一致、结构/种子/迁移账本一致，以及重复导入和非空库拒绝，由以下内存测试覆盖：

```powershell
cd apps/api
node --import tsx --test test/full-install-sql.test.ts
```

v8→v9 增量交付件同样由迁移来源生成，导出只读入迁移文件、不连接磁盘业务库；`--output` 仅创建不存在的新文件：

```powershell
npm run db:export-homepage-upgrade -w @online-video/api
npm run db:export-homepage-upgrade -w @online-video/api -- --output ../../.local/homepage-upgrade-review.sql
node --import tsx --test apps/api/test/full-install-sql.test.ts apps/api/test/homepage-upgrade-sql.test.ts
```

增量回归覆盖交付文件逐字节一致、旧表数据/账本保留、新旧最终结构一致、版本/校验错误拒绝和中途失败后的事务回滚。以上测试仅使用内存数据库，不替代实际目标库的备份和上线验收。

## 历史快照的保留边界

`01_EMPTY_DATABASE_FULL.sql` 和 `STAGE2_PENDING.sql` 只保留历史结构与回归校验用途，不作为部署指南。现有库的升级使用受控迁移流程；已执行的迁移内容与校验和不可修改。当前账号与数据库操作分别参考[账号说明](../ACCOUNT.md)和[数据库说明](../DATABASE.md)，不沿用旧阶段的建库或初始化命令。

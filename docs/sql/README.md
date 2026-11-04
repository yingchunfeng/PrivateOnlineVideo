# SQLite 完整建表与已有库升级说明

## 唯一新部署入口（v8）

**新空库只执行 [NEW_INSTALL_FULL.sql](NEW_INSTALL_FULL.sql) 这一份即可，不再执行另两份 SQL。** 该文件由 0001～0008 的迁移链生成最终结构，包含 41 张表、8 条带 SHA-256 校验的迁移账本，以及 QQ/163 邮箱类型种子。站点设置、访客凭证和访客会话表已经包含在内，不包含账号、安装码、应用主密钥或 OSS/SMTP 凭据。

导入后按[新部署指南](../NEW_INSTALL.md)启动首次安装向导，使用本机一次性安装码和初始密码设置账号。**不得在现有数据库执行全量 SQL，也不需要先执行旧 SQL 或 `account:init`。** 服务启动不会自动迁移旧库；旧库升级必须先核对目标、做好一致性备份，再明确授权增量迁移。

| 文件 | 当前用途 | 新部署是否执行 |
| --- | --- | --- |
| [NEW_INSTALL_FULL.sql](NEW_INSTALL_FULL.sql) | 当前 v8 完整结构；新空库唯一入口 | 只执行这一份 |
| [01_EMPTY_DATABASE_FULL.sql](01_EMPTY_DATABASE_FULL.sql) | 历史第二阶段结构，兼容结构回归测试 | 不执行 |
| [STAGE2_PENDING.sql](STAGE2_PENDING.sql) | 历史 v1→v2 变更快照，兼容迁移校验测试 | 不执行 |

另两份保留是因为 `apps/api/test/stage2-backend.test.ts` 仍读取它们核对历史结构和迁移校验；它们不是需要追加执行的安装步骤。不要把三个文件直接拼接，避免重复建表、重复 ALTER 和账本不一致。

## 导入及验证

1. 在 SQLite 客户端中新建独立空 `.db`，例如 `.local/data/new-install.db`；确认不是已有业务库或旧测试库。
2. 设置遇错停止，完整执行 `NEW_INSTALL_FULL.sql`。不要只选择部分语句，也不要选择遇错继续。
3. 末尾 `PRAGMA foreign_key_check` 应无异常行，`PRAGMA integrity_check` 应返回 `ok`。若出错，在同一连接执行 `ROLLBACK;` 后保留错误排查，不继续执行或清空旧数据。
4. 使用以下只读语句核对版本和表数，然后按新部署指南启动安装向导。

```sql
SELECT count(*) AS table_count FROM sqlite_master
WHERE type = 'table' AND name NOT LIKE 'sqlite_%'; -- 41
SELECT version FROM schema_migrations ORDER BY version; -- 1 至 8
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

## 历史快照的保留边界

`01_EMPTY_DATABASE_FULL.sql` 和 `STAGE2_PENDING.sql` 只保留历史结构与回归校验用途，不作为部署指南。现有库的升级使用受控迁移流程；已执行的迁移内容与校验和不可修改。当前账号与数据库操作分别参考[账号说明](../ACCOUNT.md)和[数据库说明](../DATABASE.md)，不沿用旧阶段的建库或初始化命令。

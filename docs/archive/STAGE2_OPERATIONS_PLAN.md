# 第二阶段实际操作目标与授权边界

> **历史归档（2026-10-26）**：原位置 `docs/STAGE2_OPERATIONS_PLAN.md`。以下保留历史设计与完成记录，不作为当前任务指令；当前工作见[未完成工作清单](../task/UNFINISHED_WORK.md)，归档范围见[归档索引](README.md)。

日期：2026-10-02。正式库已按具体授权升级并核验；实云小样例与权限变更尚未执行。

## 正式数据库升级

目标仅为 `E:/onlineVideo/.local/data/video-library.db`。迁移前ledger=1，当前已升级为2、本人账号仍1条、所有旧列数据保留且完整性正常；`sqlite-test.db` 保留24表空账号/空ledger，不作为目标。

升级SQL：[0002-library-organizing.sql](../../apps/api/src/db/migrations/0002-library-organizing.sql)，规范LF后SHA-256为 `ed502f9ad6854fc43178fc5ec37d65476bdb0475d151adbdd2a36c0bf42e151a`。新增组织/对象/关系及授权审计；保留0001、全部旧列和历史数据，仅将旧 `videos_owner_object` key唯一索引替换为完整对象/原片资产唯一约束。无删表、删数据、重新初始化账号或云操作。

原库只读备份及隔离副本升级证据见 [主控记录](STAGE2_INTEGRATION.md#正式库副本验证)。正式命令会再创建新的 `.local/backups/before-migration-*.db` 一致性快照，再事务执行0002并写ledger/SHA，失败回滚且保留备份：

```powershell
npm run db:migrate -w @online-video/api -- --database E:/onlineVideo/.local/data/video-library.db --apply
```

按照用户全局规则和STAGE2 G2，用户已明确回复“授权备份并升级该正式库”，上述命令已成功执行。备份为 `.local/backups/before-migration-1790950813946-71816f51-c74c-4667-a682-782f49db3d0d.db`，同名验证JSON证明旧列内容与行数不变、完整性/外键通过。迁移授权不代表授权实云写入或权限修改。

## 本机实云小样例

用户提供样例 `E:/onlineVideo/docs/ces.mp4`，329035字节，SHA-256为 `dcda48cac1f42ff40775c03200af183a41c2fd067af08f3b4b3722df7fafba2a`。拟在 `xzlbucket / cn-hangzhou / onlineVideo/acceptance/local/` 的唯一run-id子目录上传一个服务端UUID新对象，经站内分片/登记流程，不覆盖现有对象。

用户授权的独立兼容副本已生成：`.local/acceptance/samples/ces-h264-aac-20261002.mp4`，460063字节、SHA-256 `f7083ce3ecc34bf2639622d4144f545022570e9601f5f9fc447257fc459d12a4`，受控真实FFprobe识别ready/h264-aac。若同时验原片不兼容提示和兼容播放，实云范围应明确为这两份小样例、最多两个唯一新对象；生成副本授权不代表云上传授权。

拟用既有受保护AK/角色ARN取得用途收窄的STS，使用显式公网Endpoint及固定HTTPS媒体域名。具体两样例/新对象private ACL/业务登记/有限权限探针/公网费用范围见[本轮实云执行清单](STAGE2_CLOUD_ACCEPTANCE_PLAN.md)。对象、分片、数据库记录和测试产物全部保留。

用户现已明确Bucket ACL公共读；官方文档支持新对象Complete时独立private ACL，方案保留整个Bucket和既有公开样例。代码与受控清单允许用本次新对象做私有验收，无需用户先提供旧私有视频；仍需本轮新对象ACL/实云读写/公网费用及业务登记具体授权。兼容副本和FFprobe均已就绪；不默认修改Bucket Policy/RAM/CORS/版本控制，若匿名仍成功则停止并核对其它授权。

脚本和授权清单格式见 [OSS_ACCEPTANCE](../../apps/api/src/modules/media/OSS_ACCEPTANCE.md)。其CLI只是部分实云证据，完整验收还包括浏览器Network/CORS、续签恢复、撤销边界、应用重启及权限实效。未分析保持processing，实际不兼容则unsupported，不能宣称可播。工具来源已通过Exa核对[FFmpeg官网](https://ffmpeg.org/download.html)列出的[Gyan构建](https://www.gyan.dev/ffmpeg/builds/)及[9.0.2作者镜像](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2)，当前校验文件通过TLS直接读取后与完整包比对。

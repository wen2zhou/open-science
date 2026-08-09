---
decision_id: SUB-DEC-0005
title: Attempt initiating Turn 关联的 rollback 可读性
status: accepted
affects_specs:
  - SUB-DELEGATE-WAIT
compatibility: persistence-impact
supersedes: []
---

# Attempt initiating Turn 关联的 rollback 可读性

## 背景与当前行为

S2 的 Turn-scoped Cancel 需要每个新 initial 或 continuation Attempt 在 admission commit 时 durable 关联唯一 initiating root Message/Conversation Turn。当前 persisted Attempt 没有该关系，Attempt sanitizer 又使用严格字段白名单；若直接给现有 Attempt object 增加字段，旧版本可能拒绝整个 delegated-work runtime context，而不只是忽略未知字段。

S2 草案当前要求 old-data fixture、兼容读取与 rollback 证据，但没有决定新版本写入的数据是否必须继续被发布前版本读取。这会把数据恢复选择留给实现细节，不能直接进入 writer 阶段。

## 决策

1. S2 MAY 直接扩展 persisted Attempt schema，以保存stable initiating Turn association；新reader MUST 兼容缺失该字段的旧数据。
2. 新版本一旦向Session写入S2 Attempt数据，该Session不支持直接降级到发布前版本。发布前reader MAY 因严格字段白名单拒绝或丢弃delegated-work runtime context；该直接降级路径不属于S2兼容承诺。
3. S2发布前 MUST 明确version-gated rollback：需要降级时，用户必须恢复升级前备份，并承担备份之后Session变更丢失。S2不新增降级migration或字段清理工具，也不得声称新写数据可由发布前reader安全读取。
4. 新版本 MUST 在读取或升级旧Session前保留可恢复的升级前备份路径；实现证据 MUST 证明备份不会被S2写入覆盖，并记录恢复步骤。
5. 不对缺失关联的旧terminal Attempt做推断或backfill。升级时遗留running Attempt仍按`runtime_interrupted`收口；升级后新initial/continuation Attempt MUST 建立可信关联。

## 备选方案

- **旧reader兼容表示**：复用已有记录或设计可被旧reader安全忽略的envelope。rollback风险更低，但会约束S2的持久化形态并扩大实现与验证范围。
- **全量 backfill**：升级时为旧 Attempt 推断 initiating Turn。当前记录不足以可靠区分 continuation 发起 Turn，可能把 Cancel 权限绑定到错误 Turn。
- **仅内存关联**：不改变持久化。无法覆盖 restart、并发 admission 与 durable cancellation fence，不满足 S2。

## 兼容与迁移

- 新reader MUST兼容缺失关联的旧terminal Attempt；Host control对无法证明的关联fail-closed。
- 含S2新Attempt数据的Session不能直接由发布前reader打开后继续工作。rollback必须恢复升级前备份，备份之后的Session变更不会被迁回。
- S2不交付downgrade migration、字段清理工具或跨版本双写。

## Conformance 场景

1. 发布前old-data fixture在新reader中可读；缺失initiating Turn的旧terminal Attempt不被猜测补齐。
2. 新版本reload后能以stable initiating Turn关联执行Turn-scoped Cancel；steer不改写关联。
3. 在首次S2 schema写入前可定位并保留升级前备份；S2写入不会覆盖该备份。
4. 从升级前备份恢复后，发布前版本可读取备份中的Session、Message、Artifact与delegated-work历史；恢复步骤明确标注备份之后的变更会丢失。

## 后续影响

- Session Record Adapter、sanitizer、old-data fixture、升级前备份/恢复证据与production-composed Cancel race属于S2必需证据。

## S2 rollback 操作

- 升级前备份位于原Session文件旁：`sessions/<projectId>/<sessionId>.json.pre-s2-backup`。它在首次包含`initiatingTurnMessageId`的Session写入前以create-once方式复制，后续S2写入MUST NOT覆盖。
- 普通Session扫描只读取`*.json` authority，MUST忽略`*.json.pre-s2-backup`；备份仅用于人工version-gated rollback。
- 需要降级时，先完全退出应用并另存当前S2 Session文件，再把对应`.json.pre-s2-backup`复制恢复为原`.json`路径，然后启动发布前版本。不得让发布前版本直接打开含S2 schema的当前文件。
- 恢复点固定在首次S2 schema写入之前；该备份之后的Message、Artifact、permission状态、Attempt与其他Session变更不会被迁回，MUST视为明确的数据丢失窗口。
- S2不提供downgrade migration、字段清理或新旧schema双写；若备份缺失而authority已含S2字段，Repository MUST拒绝继续覆盖该Session。

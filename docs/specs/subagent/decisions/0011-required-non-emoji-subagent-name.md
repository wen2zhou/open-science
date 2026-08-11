---
decision_id: SUB-DEC-0011
title: Subagent 名称必填且禁止 emoji
status: superseded
affects_specs:
  - SUB-SUBAGENT-NAMING
compatibility: behavior-change
supersedes:
  - SUB-DEC-0010
superseded_by:
  - SUB-DEC-0012
---

# Subagent 名称必填且禁止 emoji

## 背景与当前行为

`SUB-DEC-0010` 接受了 optional `name`、从 `task` 自动生成名称并为自动名称追加数字 suffix 的行为。产品要求进一步收紧 caller 责任：Main Agent 必须在派发时明确命名每个 Subagent，且新名称不得包含 emoji。

名称仍是稳定的人类可读标签，不替代 `frame_id` 或 `attempt_id` 控制 identity。同一 parent Agent Frame 的 durable sibling 唯一性、80 Unicode code point 上限与历史数据兼容继续保留。

## 决策

1. 每个 `host.delegate()` request 的 `task` 与 `name` 均 MUST 显式提供。单 request 或 batch 中任一项省略 `name`，整次 atomic delegation MUST 在 capacity reservation、backend lease claim 与 durable child creation 前拒绝。
2. 系统 MUST NOT 从 `task` 生成 Subagent name，也 MUST NOT 为名称冲突自动追加 suffix。caller 必须提供最终显示名称。
3. 新显式 `name` MUST 经过 NFC、首尾空白移除与连续 Unicode `White_Space` 折叠，并继续受 80 Unicode code point 上限约束。
4. 名称 MAY 使用 Unicode letters、marks、numbers、空格、标点与非 emoji 符号；名称 MUST NOT 包含 emoji sequence。至少包含 `Extended_Pictographic`、`Regional_Indicator`、`Emoji_Modifier`、emoji variation selector `U+FE0F` 或 keycap combining mark `U+20E3` 的输入 MUST 拒绝。该规则必须覆盖单 code point、ZWJ、skin-tone、flag 与 keycap emoji，不得仅按 UTF-16 surrogate 或少量范围判断。
5. 规范化后为空、包含换行、C0/C1 control character、emoji 或超过上限的 `name`，整批 MUST 以 `admission_rejection` 拒绝，不得静默删除字符、截断或改名。
6. 同一 parent Agent Frame 生命周期内，新 direct child 的最终名称 MUST 继续按 NFC、collapsed whitespace 与 Unicode lowercase key 唯一。batch 内或与 durable sibling 冲突时，整批 MUST 拒绝。
7. 名称校验、occupied-name 检查与 durable child creation MUST 保持同一 admission linearization boundary；并发/CAS retry 不得提交同名 sibling，失败路径仍须释放 capacity reservation 与 backend lease。
8. 旧 Session 中缺失、自动生成、重复、超长或含 emoji 的名称 MUST 继续原样读取，不得 migration、backfill、sanitize rewrite 或丢弃 Frame。旧可读 sibling 名称继续参与 occupied-name 比较。

## 备选方案

- 保持 optional `name` 并继续从 task 派生：不符合明确命名每个 Subagent 的产品要求。
- 只在 Help 中提示：无法约束非模型 caller、旧 prompt 或并发 Adapter。
- 自动删除 emoji：会静默改变 caller 选择并可能制造冲突。
- 只拒绝 `Extended_Pictographic`：不能覆盖 flag、modifier、variation 与 keycap。
- 对重名继续自动加 suffix：会掩盖 caller 提供的重复显式名称。

## 兼容与迁移

- Host request schema 的 required fields 从仅 `task` 变为 `task + name`。
- durable representation 不变，名称仍存于 `conversationGraph.frames[].delegateName`；无 schema version 或 migration。
- 回滚可读取新版本产生的名称，但会恢复 optional/automatic name 行为。
- 旧 Session 的历史名称只读兼容；新规则仅适用于 initial delegation，continuation 不重新校验或占用名称。

## Conformance 场景

1. single 与 batch 任一项缺失 `name`，整次调用在所有 side effect 前拒绝。
2. 中文、拉丁字母、数字、标点与非 emoji 符号可接纳并投影规范化名称。
3. single-code-point、ZWJ、skin-tone、flag 与 keycap emoji 均整批拒绝。
4. 80-code-point 边界通过；81、空、newline、C0/C1 与 sibling 重名拒绝。
5. 并发/CAS retry 只能提交一个同名 request，失败项不留下 durable state 或资源。
6. legacy missing/emoji/duplicate/overlong fixture 可读取且不改写。
7. Host contract、`host.help('delegate')` 与 REPL validation 均声明 `name` required、max 80、no emoji、unique；不得描述 task-derived default 或 automatic suffix。

## 后续影响

`subagent-naming.md` 以本 decision 替换 `SUB-DEC-0010` 的 optional/automatic 条款。Owner Module、Session persistence invariant 与 Renderer persisted-name projection 不变。production-composed gate 覆盖 required/no-emoji rejection 与 restart projection；不新增 Renderer 命名逻辑。

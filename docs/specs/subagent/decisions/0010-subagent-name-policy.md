---
decision_id: SUB-DEC-0010
title: Subagent 名称生成、长度与 sibling 唯一性
status: superseded
affects_specs:
  - SUB-SUBAGENT-NAMING
compatibility: behavior-change
supersedes: []
superseded_by:
  - SUB-DEC-0011
---

# Subagent 名称生成、长度与 sibling 唯一性

## 背景与当前行为

`host.delegate()` 要求 `task`，但 `name` 可省略。当前 admission 在省略 `name` 时直接把完整 `task` 作为 Subagent 名称，没有长度上限；它只会为同一批中省略 `name` 且 `task` 完全相同的 child 追加数字后缀。显式同名以及多次 `host.delegate()` 之间的同名均可进入 durable Agent Frame，导致 receipts、`children()`、`collect()` 与 Renderer 同时出现难以区分的 Subagent。

Subagent 的控制 identity 仍是 `frame_id` 与 `attempt_id`，但 `name` 是调用结果、历史恢复与 UI 的稳定人类可读标签，因此需要受控长度和 durable sibling 唯一性。

## 决策

1. `name` 继续 MAY 省略，不把显式命名变成派发前置条件。
2. 新 admission 的最终 Subagent name MUST 不超过 80 个 Unicode code point。
3. 显式 `name` MUST 经过 NFC、首尾空白移除与连续 Unicode whitespace 折叠；它 MAY 使用可显示 Unicode、空格、标点和 emoji，不采用 identifier 风格的字符白名单。归一化后为空、包含 C0/C1 control character、换行或超过 80 个 Unicode code point时，整次 atomic delegation MUST 在 durable child creation 前拒绝。显式名称不得被静默截断或改写语义。
4. 省略 `name` 时，系统 MUST 从 `task` 的首个非空逻辑行生成名称：折叠该行连续 whitespace，必要时以 `…` 截断到 80 个 Unicode code point；完整 `task` 与 child prompt MUST 保持不变。
5. 同一 parent Agent Frame 生命周期内，所有 direct child Frame 的最终名称 MUST 唯一。比较 key 使用 NFC、whitespace 折叠与 Unicode lowercase；显示值保留其规范化后的原始大小写。
6. batch 内全部显式名称 MUST 先占用名称空间。两个显式名称具有相同唯一性 key 时，整批 MUST 拒绝；显式名称与既有 sibling 冲突时，本次 delegation MUST 拒绝。
7. 自动生成名称发生冲突时 MUST 按 request order 追加 ` (2)`、` (3)` 等最小可用正整数后缀，并在追加前缩短 base，使最终名称始终不超过 80 个 Unicode code point。自动名称不得抢占同一批稍后出现的显式名称。
8. 名称检查与 durable child creation MUST 属于同一 admission linearization boundary。并发调用不得提交两个同名 sibling；失败的 atomic batch MUST 不留下部分 Frame、Attempt、Message、capacity reservation 或 backend lease。
9. continuation 复用原 Agent Frame 与名称，不重新占用名称。`name` MUST NOT 替代 `frame_id` 或 `attempt_id` 成为控制 identity。

## 备选方案

- 强制 caller 总是显式提供 `name`：能避免直接复制 `task`，但增加每次委派的样板负担，也不能自行解决同名竞态。
- 对显式名称自动加后缀：调用成功率更高，但会静默改变 caller 明确选择的标签；本决策只对系统生成名称自动消歧。
- 只保证单个 request array 内唯一：实现简单，但顺序多次派发、重启恢复和并发调用仍会产生同名 sibling。
- 对 `name` 使用 ASCII identifier 规则：不适合研究任务中的中文、领域符号和自然语言短标题。
- 回收 terminal 或 inactive child 的名称：会让同一 durable parent history 中再次出现同名 Frame，削弱历史、分支与恢复场景的可读性。

## 兼容与迁移

- 这是 prospective behavior change：过去可接受的超长显式名称、控制字符名称和同名 sibling admission 现在会拒绝；省略 `name` 的长 task 将得到短名称。
- durable 形态不变，名称仍保存为 `conversationGraph.frames[].delegateName`；无 schema version、migration 或 backfill。
- 旧 Session 中缺失、重复或超过 80 个 Unicode code point 的名称 MUST 继续原样读取，不得在 load、sanitize 或 save 时重命名、丢弃 Frame 或改写历史。
- 旧名称即使不符合新格式，也参与新 admission 的 occupied-name 计算；旧记录之间的既有冲突不导致 Session 不可读。
- rollback 可以读取新版本写入的名称，但会恢复旧的生成与唯一性行为。

## Conformance 场景

1. 省略 `name` 且 `task` 为多行长文本时，receipt 与 durable Frame 返回首个非空行的最多 80-code-point 名称，child 仍收到完整 task。
2. 中文、标点和 emoji 的显式名称可接纳；空白被折叠；空、换行、control character 或 81-code-point 名称整批拒绝且无 durable side effect。
3. batch 中显式同名，或显式名称与既有 running/terminal sibling 同名时，整批拒绝。
4. 同 task 的省略名称在 batch、顺序多次调用、重启后调用与并发调用中得到确定的最小可用后缀，且每个最终名称不超过 80 个 Unicode code point。
5. 大小写、NFC 与 whitespace 等价的名称视为冲突，但显示保留被接纳名称的大小写。
6. 旧重复、缺失与超长名称 fixture 可读取；新自动名称避开其 occupied keys；无 migration 或历史 rewrite。
7. receipts、`children()`、`collect()`、Session reopen 与 Renderer 投影同一个最终 durable name。

## 后续影响

- 新增 `subagent-naming.md`，由现有 delegated-work admission 与 Session persistence command 共同守住 Interface 与 durable invariant。
- 更新 Host SDK machine-readable contract 与 `host.help('delegate')`，声明 `name` optional、80-code-point 上限、自动生成和 sibling 唯一性。
- production-composed gate 覆盖顺序、并发与重启 admission；Renderer 无需新增命名逻辑。

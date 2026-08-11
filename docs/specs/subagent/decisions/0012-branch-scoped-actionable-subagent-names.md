---
decision_id: SUB-DEC-0012
title: Subagent 名称采用 48-code-point 与当前 branch 唯一性
status: accepted
affects_specs:
  - SUB-SUBAGENT-NAMING
compatibility: behavior-change
supersedes:
  - SUB-DEC-0011
---

# Subagent 名称采用 48-code-point 与当前 branch 唯一性

## 背景与当前行为

`SUB-DEC-0011` 要求每个 `host.delegate()` request 显式提供 non-emoji `name`，并以 80 Unicode code points 与 parent Agent Frame durable lifetime 作为长度和唯一性边界。该规则仍过宽且过重：80 code points 不符合短标签用途；inactive Message Branch 占名会造成 Agent 无法从当前 inventory 解释的冲突，也阻止不同研究分支复用自然名称。

现有 runtime 会返回缺失、emoji、超长或 conflict 的明确错误，但部分信息只描述失败原因，没有统一给出 Agent 可执行的修正动作、当前 branch scope 与等价比较规则。

## 决策

1. initial `host.delegate()` request 的 `name` 继续 MUST 显式提供；系统 MUST NOT 从 `task` 派生、截断、删除字符或自动追加 suffix。
2. 新名称 MUST 不超过 48 Unicode code points，并继续执行 NFC、Unicode `White_Space` collapse、single-line、C0/C1 control 与 emoji sequence 校验。
3. 唯一性范围 MUST 是 caller 当前 active root Message Branch。只比较同一 Session、同一 parent root Agent Frame，且 child `originMessageId` 仍位于当前 active root branch message path 的 direct child Frame。
4. 当前 branch 内 running 与 terminal child均 MUST 占名；inactive branch child与其他 Session MUST NOT 占名。
5. 当前 branch uniqueness key 继续使用 NFC、collapsed Unicode whitespace 与 Unicode lowercase。batch 内名称也 MUST 互不冲突；任一冲突拒绝整个 atomic batch。
6. 名称校验与 branch-scoped occupied-name 检查 MUST 位于 durable admission linearization boundary。branch switch、CAS retry 与并发 admission MUST 根据 commit 时最新 active branch 重新验证。
7. `host.help('delegate')` MUST 让 Agent 感知：`name` required、1–48 Unicode code points、no emoji、current-branch unique、不自动改名，以及大小写/规范化空白等价。
8. 每个可由 Agent 修复的 name rejection MUST 提供 actionable、secret-free 信息：指出失败字段或名称、当前限制与修正动作。至少覆盖 missing、empty、newline/control、emoji、too-long 与 current-branch conflict；conflict MUST 明确要求换名后重试。
9. runtime error 仍使用 `host.delegate:` boundary prefix，不暴露 inactive branch name、Frame ID、Attempt ID 或其他 Session 数据。
10. legacy 名称继续原样读取，不 migration 或 rewrite。只有当前 active branch path 上可读 sibling name 参与新 admission 冲突检查。

## 备选方案

- 继续使用 80 code points：允许接近句子的标签，不利于 Agent 生成简洁名称。
- 使用 32 code points：更紧凑，但对自然语言研究标签余量较小。
- parent lifetime 唯一：让 inactive branch 产生不可发现冲突。
- 只检查 batch：跨多次调用仍会在同一可见 branch 产生同名 Subagent。
- 自动 suffix：隐藏 Agent 的重复命名错误并改变 caller 明确选择的名称。
- 在错误中列出全部 sibling：可能扩大历史或 inactive branch 信息暴露；Agent 可用 `host.children()` 获取当前 inventory。

## 兼容与迁移

- Host request shape 不变，`name` 仍 required；最大长度从 80 收紧到 48。
- uniqueness 从 parent lifetime 缩到 current active root Message Branch，跨 branch 同名从拒绝变为接纳。
- durable representation、Conversation Graph schema 与 runtime records 不变；无 migration 或 backfill。
- rollback 可读取所有名称，但会恢复 80-code-point 与 parent-lifetime uniqueness。

## Conformance 场景

1. 48 code points 接纳，49 拒绝；错误要求缩短到 48 后重试。
2. missing、empty、newline/control 与各类 emoji 错误分别给出明确修正动作。
3. 同 batch 或当前 branch existing running/terminal child 的等价名称整批拒绝；错误说明 current branch conflict、比较规则和换名重试。
4. child 的 origin message 从 active path 分叉后，同一 Session 的新 active branch可复用其名称。
5. 不同 Session 可使用相同名称。
6. branch switch/CAS 并发以 durable commit 时 active branch 为准。
7. Help schema、constraints、examples 与 errors 提供 required/max/no-emoji/current-branch/no-auto-rename/actionable guidance。
8. legacy invalid-name fixture 可读取且不改写；inactive branch legacy name 不参与新冲突。

## 后续影响

`subagent-naming.md` 以本 decision 替换 `SUB-DEC-0011` 的 80-code-point 与 parent-lifetime scope。Owner Module 仍为 `DelegatedWorkAdmissionPolicy`，Session persistence command 负责 branch-scoped atomic invariant；Host Help 与 runtime errors 是 Agent-facing Adapter。

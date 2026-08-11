---
spec_id: SUB-SUBAGENT-NAMING
title: S11 必填、简短、非 emoji 且 branch 唯一的 Subagent 名称
decision_status: accepted
implementation_status: conformant
compatibility: behavior-change
owner_module: DelegatedWorkAdmissionPolicy
supersedes: []
last_verified_sha: 9ea31dc4
---

# S11 必填、简短、非 emoji 且 branch 唯一的 Subagent 名称

## 用户场景

Main Agent 必须为每个 child 提供简短、明确且在当前 Message Branch 可区分的名称。错误信息必须让 Agent 知道如何修正，而不是只报告 admission 失败。

## 范围与非目标

- `name` required；接受宽松 non-emoji Unicode，最长 48 Unicode code points。
- 缺失、emoji、非法格式和当前 branch sibling 重名整批原子拒绝并给出 actionable guidance。
- 当前 branch 内 running/terminal child 占名；inactive branch 与其他 Session 可复用名称。
- Host SDK contract/help、runtime errors 与最终 persisted name 投影一致。
- 不从 task 派生名称，不自动截断、删除 emoji 或追加 suffix。
- 不改变 Frame/Attempt identity、authorization、continuation、terminal 或 Renderer 命名逻辑。
- 不迁移或清理历史名称。

## 规范性契约

- **NAME-001 — required name（stable）**：single request 与 batch 每一项 MUST 同时包含非空 `task` 和显式 `name`。缺失 MUST 在 side effect 前以 actionable `admission_rejection` 拒绝整个调用。系统 MUST NOT 从 task 生成 name。
- **NAME-002 — 宽松简短非 emoji 名称（stable）**：新 `name` MUST 接受符合 `SUB-DEC-0012` 的 Unicode letters、marks、numbers、空格、标点与非 emoji 符号；MUST 拒绝 emoji sequence、规范化后为空、newline、C0/C1 control 或超过 48 Unicode code points 的值。系统 MUST NOT 静默删除、截断或改名。
- **NAME-003 — current-branch sibling 唯一性（stable）**：名称只须在 caller 当前 active root Message Branch 内按 NFC、collapsed Unicode whitespace 与 Unicode lowercase key 唯一；同 branch running/terminal child 占名，inactive branch 与其他 Session 不占名。任一同 branch/batch 冲突 MUST 拒绝整个 batch且不得自动 suffix。
- **NAME-004 — 原子、竞态与 branch switch（stable）**：校验、current-branch occupied-name 读取与 durable creation MUST 在同一 admission linearization boundary 内完成；并发、CAS retry、restart 与 branch switch 按 commit 时最新 active branch 验证。失败 batch MUST 不留下部分 durable state或资源。
- **NAME-005 — 稳定投影（stable）**：receipt、`children()`、`collect()`、Session reopen 与 Renderer MUST 投影同一个 normalized persisted name。continuation 保留原名；控制继续使用 Frame/Attempt handles。
- **NAME-006 — 历史与 rollback（stable）**：legacy 名称 MUST 继续可读且不得 rewrite。只有当前 active branch path 上的可读 sibling name 参与 occupied-name 计算；本阶段 MUST 不新增 migration 或 schema version。
- **NAME-007 — Agent-facing 发现与修正（stable）**：contract 与 `host.help('delegate')` MUST 描述 required、48-code-point、no emoji、current-branch uniqueness、等价比较与不自动改名。missing、empty、newline/control、emoji、too-long 与 conflict errors MUST 指明修正动作；conflict MUST 要求换名后重试。

## Interface 与语义

```js
await host.delegate(
  { name: 'Source audit 2', task: 'Trace the primary source and return citations.' },
  { wait: false }
)
```

错误继续带 `host.delegate:` prefix。错误 MAY 回显本次 rejected name，但 MUST NOT 泄漏 inactive branch、其他 Session、Frame 或 Attempt identity。

## 兼容性与持久化

- request shape 不变；最大长度从 80 收紧至 48。
- uniqueness 从 parent lifetime 缩到 current active root Message Branch。
- durable representation 不变；无 migration 或 sanitizer rewrite。

## Conformance 场景

| 场景                                                                       | 条款               | 验证面                    |
| -------------------------------------------------------------------------- | ------------------ | ------------------------- |
| missing 与48/49边界给出明确修正动作                                        | NAME-001、002、007 | Host contract + Owner     |
| 各类emoji、empty、newline/control分别给出修正动作                          | NAME-002、007      | Owner + Host Adapter      |
| 当前branch batch/running/terminal冲突拒绝；inactive branch/其他Session复用 | NAME-003           | Durable command           |
| branch switch/CAS按commit时branch验证且失败资源释放                        | NAME-004           | Persistence Adapter       |
| receipt/children/collect/reopen/Renderer一致                               | NAME-005           | Consumers                 |
| legacy invalid names可读、inactive branch不占名且无rewrite                 | NAME-006           | Persistence compatibility |
| Help完整说明规则、等价比较、no-auto-rename与retry                          | NAME-007           | Host Help contract        |

## 开放决策

无。若调整48上限、允许自动命名、重命名或按名称寻址，需要独立 accepted decision。

## 实现证据

`DelegatedWorkAdmissionPolicy` 已统一执行 required、1–48、non-emoji、newline/control 与规范化规则；Session persistence coordinator 在同一个 serialized revision mutation 内，从 commit 时最新 parent active path 计算 occupied names，因此同 branch running/terminal、batch、并发 adapter 与 CAS retry 共享一个原子边界。in-memory owner 以当前 snapshot 的 `originMessageIds` 过滤 occupied records；不具 durable branch model 的旧 exported `DelegatedWork` 保留 shared memory admission scope，仅同步 48 上限与 actionable errors。

实现同时更新 Host schema/help 与 production E2E fixture callers；未新增 Renderer 命名逻辑，既有 receipt、children、collect、reopen 与 Renderer projection 继续读取 persisted normalized name。legacy duplicate、missing、control 与 overlong fixtures 保持可读且无 rewrite。

最终 Test Impact Set：

- `NAME-001..007 -> npm test -- src/main/delegated-work/delegated-work.contract.test.ts src/main/delegated-work/durable-delegated-work.test.ts src/main/delegated-work/session-record-adapter.test.ts src/main/delegated-work/production-composition.test.ts src/main/session-persistence/delegated-work-records.test.ts src/main/host-sdk/delegate-contract.test.ts src/main/host-sdk/help.test.ts src/main/notebook/repl-loop.integration.test.ts -> 8 files passed; 173 passed / 30 skipped`。
- `production branch journey -> npx playwright test e2e/subagent-release-gate.spec.ts --grep "stops only the active branch" -> 1 passed`。该 journey 首次暴露旧 fixture 使用 55–56-code-point task 作为 name；caller 改为显式短标签后通过。
- `affected model lane -> npx playwright test e2e/subagent-model-release-gate.spec.ts -> 2 passed`。该 lane 证明同 branch 的 terminal、batch、continuation、inherited 与 Specialist callers 使用各自显式短名，且 durable projection/lookup 与 fixture expectation 一致。
- `Node contract -> npm run typecheck:node -> passed`。
- `repository lint -> npm run lint -> exit 0；107 个 warnings 均为未修改基线，当前 diff 文件无 warning`。
- `production build -> npm run build:e2e -> passed`。

额外尝试 `npx playwright test e2e/subagent-release-gate.spec.ts --grep "projects real production-composed delegation"` 在既有 permission UI strict locator 上失败：同一 `permission-card` 同时出现在 conversation 与 composer scroll，和本阶段 naming admission 无关。S11 因此标记 `conformant`，不标记 `certified`；production-composed naming 自身由 `production-composition.test.ts` 与已通过的 branch journey 覆盖。

以上 final impact、typecheck、lint 与 model lane 均在最后一次 material runtime/test edit 和 `9ea31dc4` candidate 后运行或完成；branch journey 与 build 在相同 runtime implementation 上通过，后续只修正受影响 fixture label、增加 CAS conformance test 和写入 evidence。Review 中的 task/name data-clump 作为 non-actionable maintenance judgement 保留：task 与 name 是有意独立的 public contract fields，fake provider 与 Playwright 运行在不同 process，UI expectation 必须以公开 persisted name 复核而不能共享内存 fixture object；当前所有超过48的 caller 已改为显式短标签并由两个 production E2E lanes 覆盖。

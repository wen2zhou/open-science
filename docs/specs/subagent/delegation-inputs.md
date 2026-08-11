---
spec_id: SUB-DELEGATION-INPUTS
title: S12 Subagent 完整 task 与输入文件可发现性
decision_status: accepted
implementation_status: conformant
compatibility: breaking
owner_module: DurableDelegatedWork
supersedes: []
last_verified_sha:
---

# S12 Subagent 完整 `task` 与输入文件可发现性

## 用户场景

Main Agent用一个完整`task`描述Subagent目标、背景、约束和交付要求，并为需要文件的child显式选择不可变Project File Version。系统拒绝已经移除的`context`字段；合法输入被物化到隔离Frame workspace后，provider实际收到的首个prompt会指向`./inputs/`，使Subagent无需猜测文件位置即可开始工作。

## 范围与非目标

本阶段覆盖：

- 从公开`host.delegate` Interface及内部新写路径删除`context`；
- 保留既有`inputs` Version校验、顺序、持久化和workspace物化；
- 在共享ACP执行Module集中构造input提示，并接通三个production Adapter；
- Host Help、RPC、persistence和production-composed验证。

非目标：

- 自动复制parent transcript或parent全部Project Files；
- 新增Project File picker、manifest response字段或重命名`inputs`；
- 改变Version identity、workspace命名、文件权限或Artifact Provenance；
- 兼容旧`context`调用或旧`delegatedContext`数据；
- 改变structured output、父子消息、identity、model routing或result shape。

依赖：[`SUB-DEC-0013`](decisions/0013-remove-delegate-context.md)（`accepted`）。

## 实现前行为

- `context`经过Host、admission、durable persistence和execution input传递，但共享ACP默认prompt不消费它；durable Message却显示`task + Context`。
- `inputs`在admission前校验为同Project/Session的immutable Upload/Artifact Version，并按request顺序复制到Frame `cwd/inputs/`；文件与目录分别去除写权限。
- 默认provider prompt只包含`task`与可选structured-output指令，不提示`./inputs/`。
- Codex、Claude Code和OpenCode production execution共用相同ACP执行Module。

## 规范性契约

- **DINPUT-001 — 单一文本说明（stable）**：`task` MUST是完整、自包含的Subagent文本说明；公开request、Host Help、durable child、execution input和新写Session metadata MUST不再提供`context`。
- **DINPUT-002 — removed字段拒绝（stable）**：single或batch任一request出现own `context` property时，整个delegate调用 MUST在capacity reservation、workspace准备、Frame/Attempt/Message创建和provider dispatch前拒绝，并给出将文本合入`task`的可修正提示；MUST NOT静默忽略或自动合并。
- **DINPUT-003 — inputs语义保持（stable）**：`inputs` MUST继续只接受可解析的immutable Upload Version或Artifact Version identity，并保持既有Project/Session scope、request顺序、durable记录和Frame workspace物化语义。
- **DINPUT-004 — provider可发现性（stable）**：每个新Attempt的`inputs`非空时，其首个provider prompt MUST在`task`之后提示只读副本位于相对目录`./inputs/`并要求检查相关文件；`inputs`为空时 MUST不加入该提示。
- **DINPUT-005 — prompt最小披露（stable）**：input提示 MUST不包含绝对`workspaceCwd`、data root、Frame ID或Version identity。provider MAY通过workspace读取实际ordinal-prefixed文件名。
- **DINPUT-006 — prompt组合（stable）**：首个prompt MUST按`task`、可选input提示、可选structured-output指令的顺序组合；structured-output指令保持最后。同一Attempt内后续`send_message` payload MUST原样作为后续prompt，不重复input提示。
- **DINPUT-007 — provider一致性（stable）**：Codex、Claude Code和OpenCode production Adapter MUST通过共享ACP prompt行为满足`DINPUT-004..006`，不得在各Adapter复制或漂移文案。
- **DINPUT-008 — persistence边界（stable）**：新Session写入 MUST不包含`delegatedContext`或等价独立context metadata；本阶段 MUST不新增migration、schema version或old-data恢复承诺。

## Interface 与语义

公开Interface为：

```ts
host.delegate(
  request: {
    task: string
    name: string
    profile?: string
    inputs?: string[]
    output_schema?: JsonSchema
  } | readonly request[],
  options?: { wait?: boolean; timeout_seconds?: number }
)
```

`task`可以使用自然语言标题组织Goal、Background、Constraints和Deliverable，但系统不解析这些标题。`inputs`是结构化Version引用，不是`task`内路径文本的别名。

## 兼容性与持久化

- `context`删除为明确breaking change，不兼容旧caller。
- 新writer停止写`delegatedContext`；无migration、backfill、alias或feature flag。
- `delegatedInputVersionIds`及workspace文件布局保持不变。
- 无`context`且无`inputs`的调用保持既有task-only provider prompt；带`inputs`调用的provider prompt、token usage和cache key按设计改变。

## Conformance 场景

| 条款 | 场景 | 证据层 |
| --- | --- | --- |
| `DINPUT-001..002` | schema/help不再列context；single/batch显式context整批无副作用拒绝 | Host + Admission Interface |
| `DINPUT-003` | invalid Version整批拒绝；合法Version按序物化为只读文件 | Workspace + Durable owner |
| `DINPUT-004..006` | task-only、inputs、schema、inputs+schema及continuation prompt矩阵 | ACP execution Interface |
| `DINPUT-005` | provider prompt不含绝对cwd、Frame ID或Version identity | Adapter contract |
| `DINPUT-007` | 三framework经production factory收到相同prompt语义 | Provider matrix |
| `DINPUT-008` | 新Session Message无delegatedContext且inputs可reopen重建 | Persistence integration |
| `DINPUT-001..008` | 真实Host RPC委派输入、child读取`./inputs/`并完成 | production-composed E2E |

## 开放决策

无。字段删除与不兼容策略已由`SUB-DEC-0013`接受。

## 实现证据

### 已交付实现

- Owner/Interface：`DurableDelegatedWork`及公开`host.delegate` request不再声明、保存或传递`context`；Host schema与Help要求调用方提供完整、自包含的`task`。
- admission：single或batch中任一own `context` property（包括值为`undefined`）在capacity、workspace及durable mutation前整批拒绝；继承自prototype的同名属性不被误判。
- persistence：in-memory与Session-backed writer只保存`delegatedTask`及可选`delegatedInputVersionIds`；reader与shared sanitizer不再恢复独立`delegatedContext`。
- execution：共享ACP Module统一按`task → ./inputs/只读提示 → structured-output指令`构造首prompt；同一Attempt后续消息保持原文，新continuation Attempt重新获得input提示。
- production Adapters：Codex、Claude Code与OpenCode通过同一共享composer取得相同语义；production composition同时验证真实只读文件、prompt顺序、schema末尾及不披露absolute cwd/Version identity。

### Final Test Impact Set

```text
npm test -- --run src/main/delegated-work/delegated-work.contract.test.ts src/main/delegated-work/durable-delegated-work.test.ts src/main/delegated-work/acp-execution.test.ts src/main/delegated-work/session-record-adapter.test.ts src/main/delegated-work/production-composition.test.ts src/main/host-sdk/delegate-contract.test.ts src/main/host-sdk/help.test.ts
  -> 7 files / 197 tests passed
npm test -- --run src/main/delegated-work/production-composition.test.ts
  -> 1 file / 31 tests passed（含Codex、Claude Code、OpenCode矩阵）
npm run typecheck
  -> passed
npm run lint
  -> passed
npm run build:e2e
  -> passed
npm test
  -> 被未修改Renderer基线阻塞；单独复现为session-store-persistence-owner.ts 716行超过710行、Electron surface 338超过337、Web callable surface 276超过275
npx playwright test e2e/subagent-release-gate.spec.ts
  -> 既有Renderer permission-card重复投影导致strict locator命中2项；S12 production composition gate已独立通过
```

本阶段达到`conformant`。完整desktop release gate受上述既有Renderer blocker影响，暂不标记`certified`；未覆盖风险为真实provider模型是否会按提示主动读取相关文件，当前只证明prompt和只读文件均已送达。

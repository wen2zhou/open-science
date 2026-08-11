---
spec_id: SUB-IDENTITY-RESOLUTION
title: S4 Subagent 默认身份继承
decision_status: accepted
implementation_status: conformant
compatibility: behavior-change
owner_module: DelegatedWorkAdmissionPolicy
supersedes: []
last_verified_sha: fc3f415103e2634be48495db057bac8d32eb3507
---

# S4 Subagent 默认身份继承

## 用户场景

用户让一个 Specialist 承担 root research conversation。该 Specialist把多个同领域子任务交给Subagent时，可以省略每个task重复的`profile`；系统根据发起Host invocation的父runtime选择同一个Specialist，并在结果、历史和重启后UI中显示稳定的child身份。Main Agent父runtime省略`profile`时仍得到Main Agent child。

## 范围与非目标

本阶段只改变initial `host.delegate()` request省略`profile`时的身份解析，并把结果接通现有Host SDK、local RPC、durable Attempt、runtime Adapter与Renderer projection。

依赖：

- [`SUB-DEC-0001`](decisions/0001-default-subagent-identity.md)（`accepted`）。

非目标：

- nested delegation、per-task model routing、Scheduler、structured output或lifecycle taxonomy；
- terminal continuation的identity规则；
- 复制父runtime的revision、instructions、Skills、Connectors或完整capability snapshot；
- 新增显式Main Agent sentinel、修改Host result shape或暴露caller可控制的parent identity；
- Specialist handoff/switch机制、catalog管理或provider startup error语义。

## 当前行为

- `DurableDelegateRequest.profile`可省略；`DelegatedWorkAdmissionPolicy.resolve()`当前对`undefined`直接返回`{ kind: 'main' }`。
- explicit `profile`在reservation与durable mutation前解析；batch identity解析保持all-or-nothing。
- 初始Attempt已持久化`resolvedAgent`：Main或`{ kind: 'specialist', profileId, revision, displayName }`。Frame、Runtime Segment、Host result和Renderer label已消费该snapshot。
- Notebook RPC server持有由ACP runtime注册的Session→Specialist stable ID，Agent控制的RPC body不能设置该map；`AuthenticatedDelegateCaller`当前尚未携带这项可信context。
- terminal continuation沿用previous Attempt kind；Specialist continuation按previous stable ID重新解析。

## 规范性契约

- **IDENT-001 — explicit优先（stable）**：task显式提供`profile`时，admission MUST 保持现有stable ID / 唯一精确公开名称解析、可用性校验和错误语义；显式值 MUST 覆盖继承默认。
- **IDENT-002 — Main默认（stable）**：task省略`profile`且父runtime为Main Agent时，initial child MUST 解析为`{ kind: 'main' }`，MUST NOT 调用Specialist resolver。
- **IDENT-003 — Specialist继承（stable）**：task省略`profile`且父runtime为Specialist时，initial child MUST 使用父runtime的stable profile ID，并在admission时通过stable-ID resolver生成child自己的`resolvedAgent`snapshot。
- **IDENT-004 — 可信来源（stable）**：父runtime身份 MUST 来自app-owned authenticated Host capability或同等可信context；Agent控制的request/RPC参数 MUST NOT 设置或覆盖它。caller无可信Specialist ID时 MUST 视为Main Agent。
- **IDENT-005 — batch快照与顺序（stable）**：每次delegate调用 MUST 在解析task前固定一次父runtime identity；同batch所有省略项 MUST 使用该固定identity，显式项分别解析，最终child与结果保持request顺序。
- **IDENT-006 — atomic fail-closed（stable）**：全部inherited与explicit identity MUST 在capacity reservation、workspace准备和durable mutation前完成校验；任一不可用 MUST 保持整批无child且不得回退Main Agent。
- **IDENT-007 — durable child snapshot（stable）**：admitted Attempt MUST 持久化最终child `resolvedAgent`snapshot；runtime input、Host projection、Frame/Runtime Segment label与重启读取 MUST 使用该snapshot。后续Session switch或catalog rename MUST NOT 改写历史Attempt。
- **IDENT-008 — continuation稳定（stable）**：terminal continuation MUST 保持previous Attempt identity规则，MUST NOT 因当前父runtime不同而重新应用initial inheritance。
- **IDENT-009 — Interface兼容（stable）**：Host `profile?` request field、single/batch shape、response shape、authorization和direct-child topology MUST 保持不变；S4 MUST NOT 引入Main Agent sentinel。本条款只约束S4的`profile`语义；组合当前`SUB-DEC-0011`后，每个request仍 MUST 显式提供required、non-emoji `name`。

## Interface 与语义

外部Interface仍为：

```ts
host.delegate(
  request: { task: string; name: string; profile?: string; context?: string; inputs?: string[] }
    | readonly request[],
  options?: { wait?: boolean }
)
```

`name`遵循`SUB-DEC-0011`：每项必须显式提供、不得包含emoji且必须满足80-code-point与durable sibling唯一性规则。`profile`省略只表示采用受信任parent default，不是Agent提交一个空identity。空字符串仍按现有invalid explicit profile拒绝。

父identity在一次Host invocation进入delegated-work owner前固定；batch每项不重复读取可变Session binding。Specialist继承等价于对父stable ID进行一次child admission resolution，因此child snapshot可以反映admission时比父runtime更新的revision/displayName，但identity stable ID相同。

## 兼容性与持久化

- `compatibility: behavior-change`，仅父为Specialist且省略`profile`的未来initial admission改变默认。
- 复用现有`resolvedAgent`JSON representation，无SQLite、Prisma、Session schema version或migration影响。
- 旧`{ kind: 'main' }`与explicit Specialist历史保持原样；不得根据当前Session binding回填来源。
- 新继承记录没有额外provenance字段，旧reader按普通Specialist Attempt读取。rollback不需要data restore或version gate。
- provider创建child Agent Session时仍通过stable `profileId`读取live Specialist内容；S4只冻结durable identity snapshot，不承诺冻结完整capability内容。

## Conformance 场景

| 条款             | 场景                                                                                                       | 证据层                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `IDENT-001..003` | Main default、Specialist inherited、explicit override                                                      | Owner Module Interface tests       |
| `IDENT-004`      | Agent伪造parent identity被忽略；runtime注册identity被注入caller                                            | local RPC contract/integration     |
| `IDENT-005..006` | mixed batch固定一次父identity；inherited不可用整批无副作用                                                 | Admission/records tests            |
| `IDENT-007`      | inherited snapshot进入execution input、Session JSON、Host result、Frame/Runtime Segment与reopen projection | Adapter/persistence/consumer tests |
| `IDENT-008`      | 父identity切换后continuation仍沿用previous Attempt                                                         | Durable orchestration regression   |
| `IDENT-009`      | Host contract/help与RPC parser shape不变                                                                   | Host SDK tests                     |
| `IDENT-001..009` | Specialist root省略profile真实委派并在app重启后保持label                                                   | production-composed E2E            |

## 开放决策

无。显式Main Agent选择、完整父snapshot复制与nested delegation均不属于S4，未来若进入实现需独立decision。

## 实现证据

S4 candidate位于`codex/s4-specialist-inheritance`；最终commit SHA由本次实现回执与Git历史标识。本阶段没有schema、migration或历史数据回填。

条款映射：

- `IDENT-001..003`：`DelegatedWorkAdmissionPolicy.admit()`按一次受信任parent stable ID生成省略项snapshot，Main default不调用resolver，explicit reference保持优先；Owner Interface tests覆盖single/mixed batch与runtime input。
- `IDENT-004..006`：`NotebookLocalRpcServer`只从app-owned `sessionSpecialists`把固定parent ID注入`AuthenticatedDelegateCaller`；Agent body伪造无效；全部identity resolution仍位于reservation、workspace与durable admission之前。
- `IDENT-007`：复用既有`resolvedAgent` representation；Session record Adapter、Frame/Runtime Segment、Host projection、execution input和restart Renderer均读取child admission snapshot。
- `IDENT-008`：continuation regression证明当前parent identity改变后仍按previous Attempt stable ID重解析，不重新应用initial inheritance。
- `IDENT-009`：S4保持Host `profile?`、result shape与RPC parser语义；当前组合Interface同时遵循后续`SUB-DEC-0011`的required explicit non-emoji name，没有Main sentinel或topology变化。

最后一次material edit后的Test Impact Set：

- `npm run typecheck:node`：通过。
- `npx vitest run src/main/delegated-work/durable-delegated-work.test.ts src/main/delegated-work/session-record-adapter.test.ts src/main/notebook/local-rpc-server.delegated-work.test.ts src/main/host-sdk/delegate-contract.test.ts src/main/host-sdk/help.test.ts src/main/notebook/repl-loop.integration.test.ts src/main/delegated-work/durable-delegated-work.architecture.test.ts`：通过，`101 passed`、`30 skipped`。
- changed-file `npx eslint ...`：通过。完整`npm run lint`被未修改的`src/main/delegated-work/specialist-runtime-consumption.test.ts:54`既有`explicit-function-return-type`错误阻断；S4 changed files无lint finding。
- `npm test`：完成，`12461 passed`、`191 skipped`、`9 failed`；9项均来自未修改的cross-framework certification shared contract对既有重复空`reviewScopes`的断言，独立运行`src/main/delegated-work/certification-contract.test.ts`可稳定复现，S4 targeted lanes与architecture gate通过。
- `npm run build:e2e && npx playwright test e2e/subagent-release-gate.spec.ts`：通过，`4 passed`。新增production-composed场景创建真实root Specialist，省略`profile`委派，验证child label，并在app restart后重新读取同一durable label。

既有scalable Subagent UI gate同时对齐当前公开可访问性结构：summary trigger当前名称为`24 subagents, 6 running`，展开后的child buttons不再投影为旧`Subagent summary` region。preview关闭后的focus恢复覆盖迁移到S4 production场景的稳定single-child trigger；multi-child弹出列表的row会在打开preview时卸载，不能作为关闭后的稳定focus target。该测试维护不改变产品行为。

production-composed release gate已通过，但required完整`npm run lint`仍被上述未修改基线错误阻断，因此本spec达到`conformant`，暂不标记`certified`。未覆盖风险为真实外部provider启动差异、Windows named-pipe transport与跨平台视觉细节；这些不改变已由production composition、authenticated RPC、durable record与Renderer restart路径证明的S4合同。

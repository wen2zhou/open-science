---
spec_id: SUB-DELEGATED-WAIT
title: S1 有界 collect 与可恢复结果观察
decision_status: accepted
implementation_status: certified
compatibility: behavior-change
owner_module: DelegatedWorkReadModel
supersedes: []
---

# S1 有界 `collect` 与可恢复结果观察

## 用户场景

Main Agent 通过 `wait:false` 启动一个或多个 Subagent。调用 `host.collect` 时，有的 Attempts 已终态，有的仍在运行或等待权限。Main Agent 需要在有限时间内拿到同一批 child 的最新 durable observation，在同一 Conversation Turn 内继续其他工作并稍后再次收集；后台 child 不被 timeout 取消。

该阶段还解决 handles 跨 REPL cells 丢失后的恢复：cell 内 lexical `const` 不跨 cell 持久化，canonical 示例使用 `globalThis`；若变量仍丢失，Main Agent可用 `host.children()` 重新发现 current Attempt inventory。

## 依赖与状态

- 依赖 accepted decisions：[`SUB-DEC-0002`](decisions/0002-bounded-wait-interface.md) 与 [`SUB-DEC-0003`](decisions/0003-cross-turn-child-control.md) 的 read-side authorization 子集。
- 本 spec 的 `COLLECT-001..017` 均为本阶段已接受的 `stable` 实现合同。
- Owner Module 是现有 `DelegatedWorkReadModel`；目标 Interface 是外部 `DurableDelegatedWork.collect` 及其 Host SDK Adapter。
- production、in-memory/test records 是同一 durable-read seam 的 Adapters/consumers；不新增 Scheduler 或 execution seam。

## 范围与非目标

### 范围

- 为 `host.collect` 增加有限默认等待与显式 timeout。
- 在同一 durable snapshot 中投影 terminal result 或最小 running observation。
- 稳定 caller order、重复 selector、Attempt pinning、deadline race 和 fail-closed authorization。
- 对每次 observation snapshot 持续执行 active Message Branch authorization；branch 切换只终止读取，不停止 child。
- 在同一 Turn 的多个 REPL cells中用`host.children()`恢复current Attempt handles。
- 接通 Host contract、Help、local RPC、REPL mapper、production composition 与独立production-composed验证。

### 非目标

- 跨 Conversation Turn 的 Composer入口、child control、permission交互与Cancel/Stop拓扑；这些属于S2。
- S3 的 queued、processing、awaiting permission 等 lifecycle taxonomy。
- Attempt Deadline、Durable Scheduler、provider capacity policy或 nested delegation。
- 普通 `const`/`let`/`var` 的跨 REPL cell lexical persistence。
- 运行中的 child 跨应用重启继续执行。
- durable collection-consumption relation或 Artifact ownership转移。
- 跨重启 exact Delegation Command replay。
- structured output、usage/cost或新的 result schema envelope。

## 当前行为

- `DurableDelegatedWork.collect(caller, frameIds)` 只接受非空 frame ID 数组，不接受 options或 Attempt handle。
- `DelegatedWorkReadModel.collect` 每轮读取 authenticated durable snapshot；只有全部 child 可投影 terminal result时才返回，否则固定间隔无限轮询。
- 结果按 caller提供的 frame ID 顺序返回；重复 ID 自然重复输出。
- 当前 projection 每轮读取 Frame 的 current Attempt，collect期间的 continuation可移动等待目标。
- 空数组拒绝；任一 unknown、跨 Session或非 direct-child ID使整批授权失败。
- 当前 child选择没有校验其`originMessageId`是否仍在root active branch ancestry；知道Frame ID的合法root caller可能读取inactive branch child。
- `originBindingState:"legacy-unavailable"`或缺失`originMessageId`的历史child无法证明其root branch ownership。
- terminal child statuses为 `completed | cancelled | error`；running 当前返回 `undefined`。
- `host.children()` 当前读取root direct children并投影current Attempt，但尚未形成精确的恢复Interface。
- control REPL进程和 `globalThis` 持久，但每个 cell被 async IIFE包裹；cell内 lexical声明不会跨 cell保留。
- app restart把遗留 running Attempt收口为 `cancelled/runtime_interrupted`，不会恢复执行。

## 规范性契约

- **COLLECT-001 — timeout输入（stable）**：`host.collect(selectors, options?)`的`options.timeout_seconds` MUST 接受`0..1800`的finite number；省略时 MUST 使用30秒。非法值 MUST 在启动waiter或产生写入前整批拒绝。
- **COLLECT-002 — selector与pair归属（stable）**：`selectors` MUST 是非空数组；每项 MUST 是frame ID string或`{frame_id, attempt_id}`。handle中的Attempt MUST 属于同一selector命名的direct-child Frame；实现 MUST 先授权Frame再解析其Attempt。错配pair、unknown Attempt或跨Frame/Session组合 MUST 整批拒绝。
- **COLLECT-003 — 单snapshot pinning（stable）**：格式校验后，Owner Module MUST 用一个authenticated durable snapshot同时授权整批Frames并固定全部目标Attempts。string固定该snapshot中Frame的current Attempt；handle固定同Frame内指定Attempt；重复string在该批中必须固定同一Attempt。后续continuation不得移动目标。
- **COLLECT-004 — 等待起点（stable）**：等待预算 MUST 在单snapshot授权与Attempt pinning完成后启动。
- **COLLECT-005 — 完成条件（stable）**：任一deciding snapshot发现全部pinned Attempts durable terminal时，调用 MUST 返回且不得刻意等待到deadline；否则 MUST 等到deadline并基于一次最终durable snapshot形成整批observation。
- **COLLECT-006 — deadline线性化（stable）**：只有在deciding snapshot中已durable terminal的Attempt MAY 返回terminal result；其余 MUST 返回running observation。snapshot之后才提交的终态只能由后续collect观察。
- **COLLECT-007 — 顺序与重复（stable）**：返回array MUST 与selectors等长、按caller顺序位置匹配；重复selector MUST 在对应位置重复返回，不得去重或按完成顺序重排。
- **COLLECT-008 — running observation（stable）**：running项 MUST 只包含`frame_id`、`attempt_id`、`name`、`agent_name`、`status:"running"`；MUST NOT 伪造`artifacts_created`、response、error或细粒度lifecycle字段。
- **COLLECT-009 — terminal result（stable）**：terminal项 MUST 保持当前`completed | cancelled | error`及既有字段语义；`artifacts_created`仅从pinned Attempt的durable terminal evidence投影。
- **COLLECT-010 — pinned evidence归属（stable）**：历史或current Attempt的terminal Message、Artifact与Provenance MUST 通过stable durable ownership关联定位；MUST NOT 按user Message或Attempt数组位置推断。running Attempt内追加steer Message不得错配后续Attempt evidence。
- **COLLECT-011 — timeout隔离（stable）**：wait expiry MUST NOT cancel、stop、terminalize、fence、释放execution slot、清permission、修改Session revision或写入deadline。child随后完成时，新collect MUST 能投影其durable结果。
- **COLLECT-012 — 性能承诺（stable）**：timeout只界定等待child终态的时间；最终snapshot、Artifact投影与RPC序列化 MAY 产生必要尾部开销。实现 MUST 使用单调elapsed-time语义，poll interval不得成为caller契约。
- **COLLECT-013 — fail-closed authorization（stable）**：空数组、malformed selector、错配pair、unknown Attempt、其他Session、非root Main、非direct child、origin不在当前root active branch ancestry或无法证明origin的legacy child MUST 使整批调用失败；不得返回合法槽位的部分信息。direct legacy selector MUST 返回可诊断的安全错误，且不得猜测branch归属。
- **COLLECT-014 — current inventory discovery（stable）**：`host.children()` MUST 从一次authenticated snapshot列出当前active branch上caller可访问的全部root direct children，包含running与terminal，保持全Session durable admission顺序的active-branch子序列。每项 MUST 包含current Attempt的`frame_id`、`attempt_id`、`name`、`agent_name`和粗粒度`status`。它 MUST 不列出inactive branch或无法证明origin的legacy child；只恢复current Attempt inventory，MUST NOT 承诺历史Attempt或原batch correlation。
- **COLLECT-015 — 跨cell canonical flow（stable）**：Host Help与production-composed例程 MUST 展示用`globalThis`跨REPL cells保存handles；本阶段 MUST NOT 宣称普通lexical声明跨cell持久。
- **COLLECT-016 — restart（stable）**：waiter与deadline MUST NOT 持久化。restart recovery后的collect MUST 返回既有`cancelled/runtime_interrupted` terminal result，而不是虚假running或自动重启child。
- **COLLECT-017 — 持续branch authorization（stable）**：COLLECT-003的初始batch snapshot与其后每个deciding snapshot MUST 同时重新验证caller和全部pinned children仍获当前active branch授权。等待期间branch切换或authorization失效时，整批调用 MUST 以authorization error结束；MUST NOT 返回partial observations或停止、取消child。切回原branch后的新调用可重新授权。

## Interface 与语义

### Host SDK

```js
await host.collect(['frame-id', { frame_id: 'frame-id', attempt_id: 'attempt-id' }], {
  timeout_seconds: 30
})
```

返回 bare array：

```js
;[
  {
    frame_id: 'frame-a',
    attempt_id: 'attempt-a',
    name: 'Source check',
    agent_name: 'Main Agent',
    status: 'completed',
    response: '...',
    artifacts_created: []
  },
  {
    frame_id: 'frame-b',
    attempt_id: 'attempt-b',
    name: 'Long analysis',
    agent_name: 'Evidence Analyst',
    status: 'running'
  }
]
```

Canonical跨cell流程：

```js
// cell 1
const requests = [
  { name: 'Registry search', task: 'Search trial registries' },
  { name: 'Analysis audit', task: 'Audit the analysis' }
]
globalThis.pendingDelegation = await host.delegate(requests, { wait: false })

// cell 2
const selectors = globalThis.pendingDelegation.children.map((child) => ({
  frame_id: child.frame_id,
  attempt_id: child.attempt_id
}))
await host.collect(selectors, { timeout_seconds: 30 })
```

### Module Interface

具体TypeScript类型可由实现调整，但外部语义要求 `collect(caller, selectors, options)` 将selector校验、单snapshot Attempt pinning、bounded observation和projection封装在Owner Module内。Host/local RPC不得各自实现timer或竞态规则。

### Error 模式

- caller输入/授权错误：整批throw；Host边界保留method-scoped安全错误，不暴露secret或伪造owner字段。
- child execution error：该Attempt的terminal result，不使sibling失败。
- snapshot/Artifact projection/storage failure：整批throw，不得降级为running。
- timeout：正常observation返回，不是error。

## 兼容性与持久化

- `collect`默认从无限等待改为30秒，属于behavior change，受`SUB-DEC-0002`约束。
- string frame selectors继续兼容；Attempt handle为additive输入。
- 顶层array继续兼容；调用方必须新增running分支。
- 无新durable字段、migration或old-data rewrite。Wait expiry不增加Session revision。
- active-branch授权使用现有Conversation Graph与可信`originMessageId`；`legacy-unavailable`不做不可靠backfill。旧transcript、Artifact和terminal UI数据继续只读可见，但Host discovery/control fail-closed。
- pinned historical evidence可能要求修正现有projection关联，但不得改变既有Artifact ownership。
- rollout必须原子更新Main Module、production composition、local RPC、REPL mapper、Host contract/Help和tests。
- rollback可读取旧数据，但会恢复无限等待并拒绝Attempt handles；不能描述为行为无损。

## Conformance 场景

| 场景                                                                        | 条款             | 验证面                             |
| --------------------------------------------------------------------------- | ---------------- | ---------------------------------- |
| 两个Attempts一终态一running，deadline返回mixed且同序                        | COLLECT-005..009 | Read Model Interface               |
| 全部提前终态，未刻意等待满timeout                                           | COLLECT-005      | fake monotonic clock               |
| timeout=0、默认30、最大1800与非法数值                                       | COLLECT-001、004 | Host contract/local RPC            |
| deadline与terminal commit同刻，仅最终snapshot决定                           | COLLECT-006      | deterministic records race         |
| timeout后execution未cancel，稍后collect终态                                 | COLLECT-011      | Durable Module + execution Adapter |
| 单batch snapshot固定string/handle；错配pair拒绝；并发continuation不移动     | COLLECT-002、003 | Interface race test                |
| duplicate strings在并发continuation下固定同一Attempt                        | COLLECT-003、007 | Read Model contract                |
| `children()`返回current inventory最小shape与admission顺序                   | COLLECT-014      | Host/Read Model                    |
| inactive branch selector整批拒绝；`children()`仅列active-branch子序列       | COLLECT-013、014 | Read Model authorization           |
| 等待中branch切换使collect失败但child继续；切回后新调用可访问                | COLLECT-017      | deterministic branch race          |
| legacy-unavailable child不列出，direct selector可诊断地fail-closed          | COLLECT-013、014 | old-data persistence fixture       |
| running Attempt被steer后再continuation，历史/current Attempt evidence不串位 | COLLECT-010      | projection/provenance test         |
| 两个真实REPL cells以`globalThis`保存并collect                               | COLLECT-015      | REPL integration                   |
| restart后返回`cancelled/runtime_interrupted`                                | COLLECT-016      | persistence/recovery fixture       |
| running项不带terminal-only字段                                              | COLLECT-008      | REPL snake_case mapper             |

## 开放决策

无。`SUB-DEC-0002`与`SUB-DEC-0003`已`accepted`。S1仅交付read-side active-branch authorization；跨Turn入口、control、permission与UI仍由S2交付。

## 实现证据

### 已交付影响面

- Owner Module：`src/main/delegated-work/delegated-work-read-model.ts`
- Interface/types：`durable-delegated-work.ts`、`delegated-work-record-types.ts`
- Adapters/consumers：`production-composition.ts`、`local-rpc-server.ts`、`resources/notebook/repl_loop.js`、Host contract/Help
- persistence/read Adapter：`session-record-adapter.ts`
- Artifact projection：`delegated-work-projection.ts`
- Renderer不变；S1不依赖S2 UI即可交付。

### 认证结果（2026-08-09）

- `COLLECT-001..009`：由 `DelegatedWorkReadModel`、显式 pinned Attempt projection、Host contract/local RPC 与 REPL mapper 覆盖；terminal/running mixed、顺序、重复、历史 handle、0/default/1800、非法和 non-finite timeout 均通过。
- `COLLECT-010..012`：projection 以 `terminalMessageId`、`responseToMessageId` 与 `runtimeSegmentIds` 定位 evidence；wait budget 使用 monotonic elapsed，expiry不写 Session 或终止 child，后续 collect 可取得终态。
- `COLLECT-013..017`：Session snapshot保留可信 `originBindingState`；legacy/inactive branch fail-closed；每个 deciding snapshot重验整批授权；restart、两真实 REPL cells与production branch-switch race均通过。
- 候选身份由紧随本文档的 Git commit记录；本文档不写入自引用 SHA。

最终 Test Impact Set：

```text
npm test -- src/main/delegated-work/durable-delegated-work.test.ts
npm test -- src/main/delegated-work/session-record-adapter.test.ts
npm test -- src/main/delegated-work/production-composition.test.ts
npm test -- src/main/notebook/local-rpc-server.delegated-work.test.ts
RUN_KERNEL=1 npm test -- src/main/notebook/repl-loop.integration.test.ts
npm test -- src/main/host-sdk/delegate-contract.test.ts src/main/host-sdk/help.test.ts
npm run typecheck:node
npm run lint
npm test
npm run build:e2e
npx playwright test e2e/subagent-release-gate.spec.ts
```

除全仓 `npm run lint` 外，上述命令均在最后行为编辑后通过。全仓 lint 被固定基线中未修改的 `src/main/delegated-work/specialist-runtime-consumption.test.ts:54` 既有 `explicit-function-return-type` error阻塞；对本候选全部变更源运行focused ESLint为0 errors（`repl_loop.js`按仓库配置被ignore）。Playwright release gate通过真实production composition覆盖同一Conversation Turn内跨cell `globalThis` handle、bounded mixed observation、running child继续与再次collect终态；production composition test覆盖等待中active-branch切换、整批授权失败、child继续和切回恢复。因此本候选达到`certified`，并把基线lint债务保留为未覆盖风险。

兼容性与持久化结论：没有新增durable字段、migration、rewrite或backfill；snapshot仅携带Conversation Graph已有的可信origin binding。旧transcript、Artifact和terminal UI继续可读，legacy Host discovery/control按合同fail-closed。rollback物理可读旧数据，但恢复无限collect、拒绝options/Attempt handles并重新放宽inactive branch访问，属于有损行为回退。

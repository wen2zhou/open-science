---
spec_id: SUB-DELEGATE-WAIT
title: S2 有界 delegate wait 与跨 Turn 后台 child
decision_status: accepted
implementation_status: conformant
compatibility: persistence-impact
owner_module: DurableDelegatedWork
supersedes: []
last_verified_sha: 0d2deb0a
---

# S2 有界 `delegate` wait 与跨 Turn 后台 child

## 用户场景

Main Agent 在Turn A原子委派一批Subagent，并选择等待有限时间。deadline到达后，它收到已完成结果与仍running的stable observations，继续工作或正常结束Turn A；running children不被取消。用户随后发起Turn B，Main Agent可通过Attempt handles或`host.children()`发现current inventory，继续collect、steer、stop或创建continuation。

当root Main已idle但child仍running时，用户必须同时拥有开启新Turn和停止后台Subagent的可见控制。取消Turn B不得误杀Turn A留下的后台工作。

## 依赖与状态

- accepted + conformant实现前置：S1 `SUB-DELEGATED-WAIT`的observation、selector、deadline和current inventory语义。
- 依赖 decisions：
  - accepted：[`SUB-DEC-0002`](decisions/0002-bounded-wait-interface.md)
  - accepted：[`SUB-DEC-0003`](decisions/0003-cross-turn-child-control.md)
  - accepted：[`SUB-DEC-0004`](decisions/0004-turn-scoped-cancellation.md)
  - accepted：[`SUB-DEC-0005`](decisions/0005-attempt-turn-link-rollback.md)
- 本spec的`DELEGATE-001..020`均为本阶段已接受的`stable`实现合同。
- Owner Module是现有`DurableDelegatedWork`；目标Interface是`delegate`。`DelegatedWorkReadModel`提供S1内部observation能力；Renderer Composer、Runtime Coordinator、permission projection与persistence Adapter是本阶段必须接通的consumers/Adapters。

## 范围与非目标

### 范围

- `host.delegate`显式有限等待，复用S1 mixed observation与race语义。
- 保留batch atomic admission和无timeout默认。
- Turn A正常结束后child继续；同branch Turn B/C可重新发现、collect和控制。
- active root branch统一约束children、collect、stop、steer、continuation与delegated permission。
- Composer在root idle + running child时同时显示Send与branch-scoped Stop。
- 修复Session-wide Cancel误杀旧Turn children：改为Turn-scoped cancellation与admission fence。
- production-composed两TurnE2E与release gate。

### 非目标

- 更改省略timeout时的`delegate`默认。
- durable Scheduler、排队 admission、Attempt Deadline或provider limits。
- S3 lifecycle细分与S5 delivery receipt可靠性。
- nested delegation、Specialist继承、model routing或structured output。
- running child跨app restart继续执行。
- 跨Session/inactive branch控制。
- durable Delegation Command record/exact replay、durable collect consumption edge或Artifact reparent。
- 从`host.children()`恢复历史Attempt或丢失响应的原batch correlation。
- 普通REPL lexical声明跨cell持久。

## 当前行为

- `delegate`options只有`wait?: boolean`。省略或`wait:true`无限等待全部completions并返回`kind:"results"`；`wait:false`在durable admission/launch后返回`kind:"receipts"`。
- batch admission已有全有或全无和live caller invocation内Promise缓存；没有durable Delegation Command record。
- `kind:"results"`的children全是terminal；`kind:"receipts"`的children全是running receipts。
- Host contract、Help、local RPC与REPL mapper没有timeout或`kind:"observations"`。
- 正常root Turn结束不会自动stop detached child；restart或明确Session stop会terminalize它。
- durable authorization已允许active root caller访问同root direct child，但尚未按child origin Message过滤active branch；legacy Frame可能没有origin Message。
- delegated permission当前按Session聚合，response不重新验证child branch。
- Renderer底层send admission不看running child；可见Composer却用`hasRunningSubagents`把Send替换为Cancel，造成鼠标/Enter行为不一致。
- 当前`cancelPrompt`级联Session全部running children，且Attempt record没有稳定的initiating Turn identity。

## 规范性契约

- **DELEGATE-001 — options兼容（stable）**：省略`timeout_seconds`时，`delegate` MUST 保持当前all-settled等待与`kind:"results"`；显式`timeout_seconds` MUST 启用bounded wait并隐含`wait:true`。
- **DELEGATE-002 — 参数冲突（stable）**：`wait:false`与`timeout_seconds`同时出现 MUST 在capacity reservation、workspace准备或durable admission前整批拒绝。`timeout_seconds`范围和错误语义 MUST 复用`COLLECT-001`。
- **DELEGATE-003 — launch-established线性化（stable）**：timeout MUST 是Delegated Wait而非admission deadline。系统 MUST 先完成请求校验、capacity reservation和atomic durable admission。每个admitted Attempt还必须达到以下其一：execution Adapter已返回stable running handle，或startup failure已durable terminal；整批达到该launch-established点后才启动等待预算。
- **DELEGATE-004 — atomic failure（stable）**：capacity、framework、Specialist、input或workspace admission失败 MUST 保持整批无child；不得以running observation掩盖admission失败。launch阶段的per-child startup failure在admission已commit后按terminal error投影，不回滚siblings。
- **DELEGATE-005 — timed outcome（stable）**：显式timed调用 MUST 始终返回`{kind:"observations", children}`，不因全部child提前终态而变为`results`；不得添加计时metadata。
- **DELEGATE-006 — observation复用（stable）**：children MUST 按request/admission顺序返回，并逐项使用S1 terminal result或running observation shape、最终snapshot和deadline线性化规则。
- **DELEGATE-007 — zero timeout（stable）**：`timeout_seconds:0` MUST 在整批launch-established后只读取一次observation；它与`wait:false`不同，MAY 包含startup或极快completion的terminal result。
- **DELEGATE-008 — child独立性（stable）**：wait expiry与Turn A正常完成 MUST NOT cancel、stop或fence任何仍running child。Turn B/C MUST 可通过stable handles或`host.children()` current inventory继续收集。
- **DELEGATE-009 — active-branch跨Turn控制（stable）**：同Session、当前active Message Branch上的后续root Turns MUST 拥有早先Turn direct children的collect、stop、steer与terminal continuation权，遵守`SUB-DEC-0003`；跨Turncollect不得转移ownership。
- **DELEGATE-010 —持续branch授权（stable）**：children/control/permission的每次projection与提交 MUST 重新验证caller和child origin仍在active root ancestry。branch切换后旧child与permission card消失，stale control/response fail-closed；切回时仍有效的状态可恢复。
- **DELEGATE-011 — legacy origin（stable）**：无法证明origin的`legacy-unavailable` child MUST 从Host discovery/control fail-closed并给出可诊断错误；不得按Session-root猜测放行。旧Session其余历史数据必须保持可读。
- **DELEGATE-012 — current inventory边界（stable）**：S2对`host.children()`增加active-branch过滤，但保持S1最小shape与order。它只恢复current Attempts，不承诺historical handle或原batch correlation。
- **DELEGATE-013 — Composer并发（stable）**：root idle且有running children时，Composer MUST 同时显示Send与独立“Stop subagents”；鼠标和Enter MUST 使用同一send gate。
- **DELEGATE-014 — permission并存（stable）**：delegated permission pending MUST NOT 阻止新Turn。Stop未pending时，Permission card、Send与Stop MUST 可同时操作；S1/S2 observation仍只显示generic running。
- **DELEGATE-015 — initiating Turn durable identity（stable）**：每个新initial或continuation Attempt MUST 在admission commit时durable关联唯一initiating root Message/Conversation Turn；running Attempt的后续steer不得改写。不得按user Message数组位置推断。
- **DELEGATE-016 — Turn-scoped Cancel与fence（stable）**：Cancel current Turn MUST 先建立该Turn的cancellation fence，再与initial/continuation admission线性化。fence前已admit的本Turnrunning Attempts必须取消，fence后本Turnadmission必须拒绝；旧Turn Attempts继续。Turn Cancel写`main_agent_stop`。
- **DELEGATE-017 — continuation归属（stable）**：后续Turn在旧Frame上创建的continuation Attempt归该后续Turn；Cancel该Turn MUST 取消该Attempt，但不得取消旧Attempt历史。仅collect或steer旧Attempt不改变initiating Turn。
- **DELEGATE-018 — branch-scoped Stop targets（stable）**：“Stop subagents” MUST 在一个authenticated snapshot固定active branch identity与当时的running direct-child Attempt集合，随后只停止该集合；branch切换或新admission不得重定向/扩大targets。inactive branch不受影响，结果写`main_agent_stop`。
- **DELEGATE-019 — Stop error isolation（stable）**：branch Stop不承诺all-or-nothing rollback。每个成功stop保留terminal结果；失败项可按最新inventory重试。Stop pending时Send/Enter禁用；operation settle后解除gate，aggregate failure必须可见。
- **DELEGATE-020 — recovery与shutdown（stable）**：live caller invocation的重复Host request保持现有Promise缓存；RPC响应丢失后caller SHOULD 用current inventory恢复，但不承诺原batch。graceful app shutdown、Session删除或明确Session-wide stop MUST 全量停止并写`session_stop`；crash/restart recovery写`runtime_interrupted`且不恢复permission。

## Interface 与语义

### Host SDK

```js
const outcome = await host.delegate(
  [
    { name: 'Sources', task: 'Trace the primary sources' },
    { name: 'Audit', task: 'Audit the analysis' }
  ],
  { timeout_seconds: 30 }
)

// outcome.kind === "observations"
```

跨cell canonical flow：

```js
// cell 1
globalThis.delegation = await host.delegate(requests, { timeout_seconds: 30 })

// cell 2 or later Turn
const pending = globalThis.delegation.children
  .filter((child) => child.status === 'running')
  .map((child) => ({ frame_id: child.frame_id, attempt_id: child.attempt_id }))
await host.collect(pending, { timeout_seconds: 30 })
```

若Agent Session或变量已丢失，可用`host.children()`恢复current inventory；如果原Attempt已被continuation替换或无法识别原batch，Interface MUST 明确返回当前inventory而不是伪造恢复成功。

### Stop topology

```text
Cancel Turn B
  -> 先建立B cancellation fence
  -> B root Attempt
  -> fence前已admit的B initial/continuation Attempts
  -/-> A发起且仍running的Attempts

Stop subagents
  -> 固定一次authenticated snapshot中的active-branch running Attempts

Session stop / graceful shutdown
  -> Session全部running child Attempts

Crash / restart
  -> recovery terminalizes为runtime_interrupted
```

Attempt initiating Turn必须来自stable durable association；对running Attempt的steer只增加message source，不转移initiating Turn。

## 兼容性与持久化

- `delegate`无timeout默认和现有`receipts/results`保持；`timeout_seconds`与`observations`为additive caller branch。
- Cancel从Session-wide改为Turn-scoped，是已确认的bug fix与terminal topology行为变更，受`SUB-DEC-0004`约束。
- active-branch授权收紧受`SUB-DEC-0003`约束。
- wait、collection与durable Delegation Command records仍不新增；child Frame/Message/Artifact/Provenance保持原归属。
- 新Attempt必须增加或建立stable initiating-Turn durable association，因此本阶段有additive persistence impact。旧terminal Attempts无需backfill；升级启动时旧running Attempts先按`runtime_interrupted`恢复；旧Frame上的新continuation必须写入新关联。根据`SUB-DEC-0005`，新reader必须兼容旧数据；含S2新数据的Session不支持直接降级，rollback依赖升级前备份恢复，且会丢失备份之后的Session变更。
- `legacy-unavailable` origin不做不可靠backfill；Host control fail-closed，但旧Session历史UI保持可读。
- old-data fixtures、兼容读取、sanitizer与升级前备份/恢复证据是conformance必需项；downgrade migration不属于S2。
- UI、Runtime Coordinator、Delegated Work stop owner、permission owner、Host contract/Help和production composition必须同版本发布。只开放Send但保留Session cascade不符合spec。

## Conformance 场景

| 场景                                                                               | 条款              | 验证面                                |
| ---------------------------------------------------------------------------------- | ----------------- | ------------------------------------- |
| atomic batch一终态一running，deadline返回observations                              | DELEGATE-003..007 | Durable Module Interface              |
| timer不早于整批launch-established；timeout=0返回前每项已有handle或startup terminal | DELEGATE-003、007 | execution Adapter race                |
| 全部提前终态仍为observations                                                       | DELEGATE-005      | Host contract/REPL mapper             |
| `wait:false+timeout`无admission                                                    | DELEGATE-002      | Admission/records                     |
| Turn A正常结束，child未cancel，Turn B新invocationcollect                           | DELEGATE-008、009 | production composition/local RPC      |
| branch切换撤销children/control/permission，切回恢复仍pending状态                   | DELEGATE-010      | production branch journey             |
| legacy-unavailable child Host fail-closed，旧Session其余数据可读                   | DELEGATE-011      | old-data persistence fixture          |
| `children()`只恢复active-branch current inventory                                  | DELEGATE-012      | Host mapper/Read Model                |
| root idle+child running同时显示Send与Stop，点击和Enter一致                         | DELEGATE-013      | Renderer interaction                  |
| child awaiting permission时仍可发Turn B；stale branch response拒绝                 | DELEGATE-010、014 | Renderer + permission Adapter         |
| Cancel B fence覆盖initial/continuation admission race，A child继续                 | DELEGATE-015..017 | Runtime Coordinator + durable results |
| B仅steer A Attempt后Cancel，A继续                                                  | DELEGATE-015..017 | caller source race                    |
| branch Stop固定target snapshot，切branch/新admission不扩大targets                  | DELEGATE-018      | stop owner/authorization race         |
| branch Stop partial failure保留成功、失败可重试、Send gate恢复                     | DELEGATE-019      | Renderer + stop Adapter               |
| collect不重挂Artifact；Turn B新产物归B                                             | DELEGATE-009      | provenance evidence                   |
| graceful shutdown写session_stop；crash/restart写runtime_interrupted                | DELEGATE-020      | recovery fixture                      |

## 开放决策

无。`SUB-DEC-0002..0005`与本spec均已`accepted`；S1已达到`accepted + certified`，S2可以进入实现。

## 实现证据

### 预期影响面

- Owner Module：`src/main/delegated-work/durable-delegated-work.ts`
- S1依赖：`delegated-work-read-model.ts`与result/selector types
- Runtime/stop：`src/main/acp/runtime-coordinator.ts`、production composition
- Host Adapters：Host contract/Help、local RPC、`resources/notebook/repl_loop.js`
- Renderer：`ConversationPanel.tsx`、Subagent projection、workspace runtime wiring
- permission：production permission owner与Renderer projection/response
- persistence：Attempt initiating-Turn association、Session Record Adapter、sanitizer与old-data fixtures

### 计划 Test Impact Set

```text
npm test -- src/main/delegated-work/durable-delegated-work.test.ts
npm test -- src/main/delegated-work/production-composition.test.ts
npm test -- src/main/notebook/local-rpc-server.delegated-work.test.ts
npm test -- src/main/notebook/repl-loop.integration.test.ts
npm test -- src/renderer/src/pages/workspace/ConversationPanel.interaction.test.tsx
npm run typecheck
npm run build:e2e
npm run test:e2e -- e2e/subagent-release-gate.spec.ts
```

`certified` release gate MUST production-compose以下journeys，不能只依赖unit/interaction fakes：

1. Turn A timed delegate结束、后台child继续、可见Send开启Turn B并collect；
2. delegated permission card与Send/Stop并存，branch切换后stale response fail-closed；
3. Cancel B保留A child，并覆盖B child/continuation admission race；
4. branch Stop不影响inactive branch，partial failure可见且Send gate恢复；
5. 鼠标与Enter使用相同send gate。

### S2 实现结果（2026-08-09）

- `DELEGATE-001..008`：Host contract、Help、真实REPL mapper与`DurableDelegatedWork`已接通timed delegate；等待预算在整批launch-established后开始，pre-handle Cancel会先durable terminalize再开放observation。
- `DELEGATE-009..012`：Read Model、control与permission response每次按active root branch重验；legacy origin继续保留历史UI，但Host discovery/control fail-closed。
- `DELEGATE-013..019`：Renderer同时显示Send与branch-scoped Stop；mouse/Enter共享Stop pending gate；Runtime Coordinator先建立Turn fence，再并行收口root与本Turn pinned children；production composition覆盖pre-work fence、inactive branch Stop与partial failure重试。
- `DELEGATE-015、020`：新initial/continuation Attempt写入`initiatingTurnMessageId`；新reader兼容缺失字段的旧terminal Attempt；Session-wide stop与restart原因保持独立。
- `SUB-DEC-0005`：首次写入S2 Attempt schema前，Repository以`COPYFILE_EXCL`建立create-once `*.json.pre-s2-backup`；普通Session扫描忽略该后缀，后续S2保存不会覆盖备份。

最终证据与candidate由包含本文档的紧随Git commit及handoff记录；最终验证保留S4基线`c503a521`及workspace集成parent`0d2deb0a`。当前实现状态为`conformant`：accepted Interface、Adapter、persistence、Renderer行为与production composition gates通过；Playwright桌面journey覆盖timed两Turn、permission和Turn Cancel，但尚未在桌面层自然注入inactive-branch Stop与partial-failure。根据本spec的certified release gate，这两条未进入同一production-composed desktop journey前不得标`certified`。

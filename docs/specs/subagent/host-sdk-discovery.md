---
spec_id: SUB-HOST-SDK-DISCOVERY
title: S9 角色感知的 Subagent Host SDK 发现与指南
decision_status: accepted
implementation_status: conformant
compatibility: additive
owner_module: HostSdkHelpRegistry
supersedes: []
---

# S9 角色感知的 Subagent Host SDK 发现与指南

## 用户场景

Main Agent 需要委派、恢复、观察、通信或停止 Subagent，但不应依赖系统提示词记住全部调用形状。Delegate child 也需要从同一个 `host.help()` 入口发现自己可用的父向消息和 structured output 能力，并能看到 root-only 方法及其不可用原因，而不是通过猜测方法名判断权限。

无参数 `host.help()` 当前只列出已注册 topic。真实 REPL 已暴露八个 Subagent operation，其中 `host.children` 与 `host.stop_child` 没有 Help topic。production delegated Notebook capability 还没有给 child 接通 `hostSdkHelp` 或 `delegatedWorkCall`，与系统提示词和 S5 已接受的 child→parent messaging 合同不一致。

## 依赖与状态

- accepted + certified：S1/S2 的 `children`、`collect`、`stop_child`、active-branch authorization 与跨 Turn control。
- accepted + certified：S5 的 `send_message`、`message_receipt`、`resolve_message` 及 child→parent route。
- accepted + conformant：S6 的 child-only `submit_output`。
- accepted：`SUB-DEC-0014` 与 S13 的低 token、任务导向 Help；其字段描述与查询纪律替代本 spec 原有 exhaustive Help 投影要求，但不改变 S9 的 operation 目录、availability 与 capability 合同。
- Owner Module 是现有 `HostSdkHelpRegistry`；目标 Interface 是 `host.help(query?)`。
- `resources/notebook/repl_loop.js` 是公开 Host SDK Adapter；Notebook system prompt、`repl_execute` description、local RPC capability 与 production delegated runtime 是 consumers/Adapters。
- 本 spec 只提出发现与既有能力接线合同；本 spec 已由用户接受，可进入实现。

## 范围与非目标

### 范围

- 让 `host.help()` 覆盖 REPL 实际发布的全部八个 Subagent operation。
- `host.children` 与 `host.stop_child` 获得 machine-readable topic、扁平调用/结果字段说明与 role-aware availability。
- Main 与 Delegate 看见同一发布目录；不可用 topic 保留在目录中并给出安全原因。
- `help('delegate')` 作为生命周期入口，导航到 dispatch 后的发现、收集、停止、消息、receipt 与 structured-output flow。
- System prompt 和 `repl_execute` description 只保留发现导航，不复制易漂移的完整方法合同。
- Help 的 operation availability 与真实 production composition/provisioning 一致。
- 修复 production child 无法经 delegated Notebook capability 调用 `host.help()`，以及 S5 已接受但实际 capability 未接通的 `send_message('parent', ...)` / `message_receipt` 路径。
- 建立公开 Host Subagent operation 与 Help registry 的 drift gate。

### 非目标

- 允许 nested delegation，或让 child 调用 `children`、`collect`、`stop_child`、`resolve_message`。
- 新增 `continue_child`、`acknowledge_message`、公开 `stop_children` 或 sibling control。
- 重命名 `stop_child`、改变其数组参数或既有 response shape。
- 改变 active Message Branch、direct-child、receipt、continuation、structured output 或 terminal 语义。
- 为 `host.agents`、`host.skills`、`host.compute` 或全部 Host SDK namespace 建立统一文档系统。
- 改变 Session persistence、Conversation Graph、Attempt records 或 migration。

## 当前行为

- `resources/notebook/repl_loop.js` 的公开 `host` 对象包含八个 Subagent operations：`delegate`、`children`、`collect`、`stop_child`、`send_message`、`message_receipt`、`resolve_message`、`submit_output`；另有发现元操作 `help`。
- `src/main/host-sdk/help.ts` 只注册六个 operation topics，缺少 `children` 与 `stop_child`；catalog 明确返回 `coverage:"registered_topics_only"`。
- `delegate` 和 `collect` Help 对 mixed observation 仍使用字符串占位符，不能机器读取 terminal/running 的稳定字段。
- messaging Help 只分别列出 direction、disposition、status 枚举，没有表达 S5 accepted exhaustive receipt union，可能组合出不存在的 `to_parent + continued`。
- Help context 只有总开关 `capabilities.delegation`；只装配部分 optional service operations 时，Help 仍可能报告 `available`。
- Notebook system prompt 与 `repl_execute` description 指向 `host.help('delegate')`，并告诉 Delegate 可调用 `send_message('parent', ...)` 与 `message_receipt`；它们没有枚举全部 Host methods。
- production delegated Notebook token 只允许 Notebook local RPC methods 与 `delegatedOutputCall`，未允许 `hostSdkHelp` 或 `delegatedWorkCall`；connection 也没有 root control connection 使用的 invocation lease。因此 child 的 `submit_output` 可达，但 Help 与 S5 messaging 指南可能在 capability gate 前失败。
- `DelegatedWorkReadModel` 对 `children`、`collect` 与 stop target pinning 强制 root Main、root Frame、同 Session、active branch direct children。child 知道方法名也不能管理 sibling。
- 公开 continuation 没有独立 `continue_child`；Main 对 terminal child 的 `send_message` 由 S5 合同创建 same-Frame continuation。`stop_children` 只是内部 RPC operation 名称。

## 规范性契约

- **HSDK-001 — 发布目录完整性（stable）**：无参数 `host.help()` MUST 注册并列出 `host.delegate`、`host.children`、`host.collect`、`host.stop_child`、`host.send_message`、`host.message_receipt`、`host.resolve_message` 与 `host.submit_output`。`host.help` 是发现元操作，不要求自列为 Subagent operation topic。
- **HSDK-002 — 不可用项仍可发现（stable）**：catalog MUST 对 Main 与 Delegate 返回同一组已发布 operation ids，不得按角色过滤 topic。每项 MUST 使用受信任 caller role 与真实 provisioning 投影 `availability`；不可用项 MUST 给出不泄漏 Session、Frame、Attempt 或 capability identity 的原因。
- **HSDK-003 — child 权限边界（stable）**：Delegate 查询 `delegate`、`children`、`collect`、`stop_child` 与 `resolve_message` MUST 得到 `unavailable`。这只改善发现性，MUST NOT 放宽 Owner authorization；实际调用仍须 fail-closed。Delegate 的 `send_message` 只允许 target literal `"parent"`，`message_receipt` 只允许 owned command，`submit_output` 仍受 exact writable Attempt 与 admitted schema 约束。
- **HSDK-004 — Main 权限边界（stable）**：Main 的 `children`、`collect`、`stop_child`、`send_message`、`message_receipt` 与 `resolve_message` availability MUST 与 production composition 一致；Main 的 `submit_output` MUST 为 `unavailable`。Help 不得暗示 Main 可读取或控制 inactive branch、non-direct child、其他 Session 或 legacy-unavailable child。
- **HSDK-005 — Agent-facing 字段合同（stable）**：每个 topic MUST 通过 `request`、`options`、`returns`、`constraints` 与 `examples` 表达可直接调用的扁平字段说明，不得投影 runtime JSON Schema 或 exhaustive errors。`children` MUST 描述 current Attempt inventory、admission order、最小字段与 active-branch scope；`stop_child` MUST 保持 non-empty Frame ID array 和逐项 `cancelled | already_terminal` 结果。
- **HSDK-006 — observation 与 receipt 摘要（stable）**：exact discriminated unions继续由 shared runtime contract 与 Owner tests拥有。Help MUST发布足以区分 accepted variant 的 discriminator、触发条件、状态集合及条件字段，不得复制 `oneOf` / `allOf` validation tree；调用失败由当次 Host error 提供纠正动作。
- **HSDK-007 — delegate 生命周期导航（stable）**：`help('delegate')` MUST 在单个 guide 中说明：异步返回 handles 后用 `children` 恢复 current inventory、用 `collect` 观察、用 `stop_child` 停止；有 `output_schema` 时 child 使用 `submit_output`。它 MUST同时说明 child不可nested delegate，并给出这些普通follow-up的最小调用形状，不要求Agent再查询其他Help topic。
- **HSDK-008 — 静态提示仅导航（stable）**：Notebook system prompt 与 `repl_execute` description MUST 指向 role-aware `host.help()` catalog，告知Agent只查询准备调用的operation且不得预取全部topics，SHOULD NOT复制request/result/error contracts。任何静态提示 MUST不宣称production capability尚不可调用的操作。
- **HSDK-009 — production child discovery（stable）**：一个仍 writable 的 authenticated production Delegate Attempt MUST 能经 issued delegated Notebook capability 调用 `host.help()`。它 MUST 能查到 `children` 与 `stop_child` 并看到 `unavailable`，不得因 allowed-method gate 或缺失 trusted invocation identity 而失败。
- **HSDK-010 — S5 child messaging 可达性（stable）**：同一 production Delegate capability MUST 允许 S5 已接受的 `send_message('parent', ...)` 与 owned `message_receipt` flow，并使用不可伪造的 Session、Frame、Attempt、origin 与 invocation identity。允许 RPC 到达 Owner MUST NOT 代替 Owner authorization，也不得开放 root-only operation。
- **HSDK-011 — provisioning 准确性（stable）**：Help availability MUST 至少按 operation 级 production provisioning 判断。装配任一 optional operation 缺失时，对应 topic MUST 为 `unavailable`；不得只凭 delegated-work service object 存在就宣称全部操作可用。Attempt/schema 等动态 precondition MAY 保留在 `constraints`，但 `availability` 的含义 MUST 不声称单次调用必然成功。
- **HSDK-012 — 漂移与预算防护（stable）**：project-owned gate MUST比较公开Subagent Host operation与Help registry，新增、删除或重命名公开operation而未同步Help时 MUST失败。root/child catalogs、availability与unknown-topic suggestion必须保持确定性测试；按`JSON.stringify`计量，catalog MUST≤2,500字符，delegate MUST≤3,200字符，其他operation topic MUST≤3,600字符。
- **HSDK-013 — 兼容与持久化（stable）**：本阶段 MUST不改变八个公开operation的调用/结果shape、authorization topology或durable data。`SUB-DEC-0014`授权Help nested shape从exhaustive schema变为flat field descriptions；现有`coverage:"registered_topics_only"`顶层字段保持不变。

## Interface 与语义

### Main 发现流程

```js
const catalog = await host.help()
const delegateContract = await host.help('delegate')
const requests = [
  { name: 'Registry search', task: 'Search trial registries' },
  { name: 'Analysis audit', task: 'Audit the analysis' }
]
const dispatched = await host.delegate(requests, { wait: false })

// handles 丢失时恢复 current inventory
const current = await host.children()
const observations = await host.collect(
  current.map(({ frame_id, attempt_id }) => ({ frame_id, attempt_id }))
)

await host.stop_child(current.map(({ frame_id }) => frame_id))
```

### Delegate 容错发现流程

```js
const catalog = await host.help()
const rootOnly = await host.help('children')
// rootOnly.availability.status === 'unavailable'

const sent = await host.send_message('parent', 'Need the cohort definition', {
  kind: 'question',
  request_id: 'cohort-question-1'
})
await host.message_receipt(sent.message_id, { timeout_seconds: 30 })
```

如果 initial request 带 `output_schema`，child 另按 exact topic 调用：

```js
await host.submit_output({ cohort: '...' })
```

### 角色矩阵

| operation         | Main | Delegate | 说明                                                   |
| ----------------- | ---- | -------- | ------------------------------------------------------ |
| `delegate`        | 是   | 否       | nested delegation 不支持                               |
| `children`        | 是   | 否       | current active-branch direct-child inventory           |
| `collect`         | 是   | 否       | current/historical pinned Attempt observation          |
| `stop_child`      | 是   | 否       | 参数仍是非空 Frame ID array                            |
| `send_message`    | 是   | 是       | Main→direct child；Delegate→literal `"parent"`         |
| `message_receipt` | 是   | 是       | 受 source principal 与 active branch authorization约束 |
| `resolve_message` | 是   | 否       | 只 acknowledge uncertain lane fence                    |
| `submit_output`   | 否   | 条件可用 | exact writable child Attempt + admitted schema         |

## 兼容性与持久化

- 不新增 durable 字段、migration、backfill、schema version或Session rewrite。
- 不改变任何公开 operation 的 request/result shape；`stop_child` 的单数名称与数组参数保持。
- catalog 增加两个 topic 会改变 exact topic array snapshot，但不删除或改写既有 topic，属于 additive discovery。
- Help descriptor 精确化不能改变 Owner 语义；若 Help 与现有实现冲突，以 accepted feature spec 为行为 authority，并把实现修复纳入同一 candidate。
- production child capability 的 allowlist/invocation wiring属于 Adapter修复；必须继续由 server绑定 caller identity，不能信任请求体中的 role、Frame、Attempt、origin或tool invocation。
- rollback不影响持久化数据，但会重新出现 Help/topic 缺失与 production child discovery/messaging不可达。

## Conformance 场景

| 场景                                                                  | 条款               | 验证面                                 |
| --------------------------------------------------------------------- | ------------------ | -------------------------------------- |
| 公开八个 operation 与 Help registry 集合相等                          | HSDK-001、012      | Host sandbox/Help parity gate          |
| root/child catalog topic ids相同，availability按角色不同              | HSDK-002..004      | Host Help contract                     |
| `children` exact current inventory合同，child查询为unavailable        | HSDK-003、005、009 | Help + delegated production capability |
| `stop_child` exact array/response合同，child查询不获得执行权          | HSDK-003、005、009 | Help + Owner authorization             |
| collect/timed delegate 展开 running/terminal union                    | HSDK-006           | shared Host contract                   |
| message topics列出route/state discriminator及关键条件字段             | HSDK-006           | Help summary + shared runtime schema   |
| 只装配delegate时其余optional operations显示unavailable                | HSDK-011           | local RPC partial composition          |
| 真实 issued child capability 调用 `help()` 成功                       | HSDK-009           | local RPC + REPL integration           |
| child可向parent发送并观察receipt；伪造root/sibling与root-only调用拒绝 | HSDK-003、010      | production-composed child journey      |
| system prompt禁止预取；delegate及其他topic满足独立字符预算            | HSDK-007、008、012 | Help + MCP projection contract         |
| unknown `continue_child`/`acknowledge_message` 不被宣称为公开方法     | HSDK-001、012      | Help suggestion regression             |
| 无Session持久化变更                                                   | HSDK-013           | final diff inspection                  |

## 开放决策

无。本阶段不改变 caller response shape、authorization topology、terminal语义或持久化承诺。若实现希望新增 `related_topics`、改变 catalog `coverage` 值、重命名 `stop_child` 或发布新 operation，必须先建立并接受独立 decision。

## 实现证据

### 当前审计（2026-08-10）

- 候选 Git：`377f953f`；当前审计只修改本 spec 与 Subagent 任务索引，工作树其余变更不属于本阶段。
- 确认公开 Subagent operation 为八个，Help registry 为六个；缺 `children` 与 `stop_child`。
- 确认当前 system prompt 是导航而非完整方法目录，方向符合 `SUB-DEC-0008`；Help 本身未完成正式目录职责。
- 确认 root-only Read Model authorization仍有效；child能发现 unavailable topic不代表获得control权限。
- 确认 production delegated Notebook capability只接通 Notebook local RPC与`delegatedOutputCall`，与 child Help/S5 messaging指南不一致。
- 只读审计未修改 runtime代码，也未执行production release gate。

### 计划 Test Impact Set

```text
npm test -- src/main/host-sdk/help.test.ts src/main/host-sdk/delegate-contract.test.ts
npm test -- src/main/notebook/local-rpc-server.delegated-work.test.ts
npm test -- src/main/notebook/delegated-lane-capability.test.ts
RUN_KERNEL=1 npm test -- src/main/notebook/repl-loop.integration.test.ts
npm test -- src/main/delegated-work/durable-delegated-work.test.ts
npm test -- src/main/delegated-work/message-delivery-owner.test.ts
npm test -- src/main/delegated-work/production-composition.test.ts
npm test -- src/main/notebook/mcp-server.test.ts
npm run typecheck:node
npm run lint
npm run build:e2e
npx playwright test e2e/subagent-release-gate.spec.ts
```

`conformant` 至少要求真实 issued delegated capability 的 Help 与 child→parent messaging integration通过；`certified` 还要求三framework production composition及desktop release gate复用同一capability path通过。

### 实现结果（2026-08-11）

- `HSDK-001..005、011..012`：`HostSdkHelpRegistry`现注册全部八个公开Subagent operations；Main与Delegate看到同一目录，availability按role与每个operation的真实provisioning投影。新增`children`与`stop_child` exact topics，并由REPL public-surface parity gate防止后续漂移。
- `HSDK-006..008`：`collect`与timed `delegate`共享完整running/terminal observation union；message topics共享accepted receipt base与route union，`send_message`/`message_receipt`保留四种状态，`resolve_message`只允许实际成功返回的`uncertain + acknowledged`。`help('delegate')`承载生命周期导航，Notebook system prompt与`repl_execute` description只指向role-aware Help。
- `HSDK-009..010`：真实`issueDelegatedNotebookConnection`允许`hostSdkHelp`与`delegatedWorkCall`到达Adapter；Server以issued capability绑定Session、Frame、Attempt与origin，并为每个请求生成不可伪造invocation identity。Delegate可`send_message('parent')`及观察owned receipt；root-only调用仍到Owner后fail-closed，请求体伪造owner字段无效。
- `HSDK-013`：没有修改公开operation调用/结果shape、authorization topology、durable data、persistence schema或migration。
- 候选身份由紧随本文档的Git commit记录；本文档不写入自引用SHA。

最终 Test Impact Set：

| 条款/风险                                                                    | 命令                                                                                                                                                                                                                                        | 结果                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Help exact contracts、operation provisioning、真实child capability、静态导航 | `npm test -- src/main/host-sdk/help.test.ts src/main/host-sdk/delegate-contract.test.ts src/main/notebook/local-rpc-server.delegated-work.test.ts src/main/notebook/delegated-lane-capability.test.ts src/main/notebook/mcp-server.test.ts` | `5 files / 85 passed`                                                  |
| 最后Help union精度修复                                                       | `npm test -- src/main/host-sdk/help.test.ts src/main/host-sdk/delegate-contract.test.ts`                                                                                                                                                    | `2 files / 16 passed`                                                  |
| Delegated Work Owner与production composition回归                             | `npm test -- src/main/delegated-work/durable-delegated-work.test.ts src/main/delegated-work/message-delivery-owner.test.ts src/main/delegated-work/production-composition.test.ts src/main/notebook/repl-loop.integration.test.ts`          | `3 executed files / 113 passed / 30 kernel-gated skipped`              |
| 真实REPL wrapper                                                             | `RUN_KERNEL=1 npm test -- src/main/notebook/repl-loop.integration.test.ts`                                                                                                                                                                  | `41 passed`                                                            |
| Node contracts                                                               | `npm run typecheck:node`                                                                                                                                                                                                                    | 通过                                                                   |
| lint                                                                         | `npm run lint`                                                                                                                                                                                                                              | exit 0；118个既有、均不在本diff文件中的warnings                        |
| desktop build                                                                | `npm run build:e2e`                                                                                                                                                                                                                         | 通过                                                                   |
| desktop production composition                                               | `npx playwright test e2e/subagent-release-gate.spec.ts`                                                                                                                                                                                     | `8 passed / 2 failed`；S5 Main↔child真实Host RPC journey及其余八项通过 |
| Playwright blocker复现                                                       | 在同一`377f953f`、零diff clean worktree单独运行两个失败journeys                                                                                                                                                                             | 两者以相同错误稳定失败                                                 |
| patch完整性                                                                  | `git diff --check`                                                                                                                                                                                                                          | 通过                                                                   |

完整Playwright gate的两个既有blockers均位于未修改表面：permission journey用strict locator读取同时存在于transcript与composer的两个`permission-card`；Specialist restart journey等待Recent sessions条目超时。相同SHA的clean worktree以完全相同错误复现，因此不归因于S9，也不在本阶段扩展修复。按stage gate规则，S9达到`accepted + conformant`；由于完整desktop release gate未通过，不标记`certified`。

### S13 后续演进（2026-08-11）

`SUB-DEC-0014`已把S9的exhaustive Help投影替换为扁平字段说明。八operation目录、role-aware availability与production child capability保持不变；Help不再发布`errors`与完整validation union。Main `help('delegate')`从10,120字符、约2,043个cl100k tokens降至3,125字符、约681 tokens，并由MCP execution projection确认正文不再被8,000字符inline gate省略。S13证据见`host-sdk-progressive-help.md`。

---
spec_id: SUB-HOST-SDK-PROGRESSIVE-HELP
title: S13 低 token 的任务导向 Host SDK Help
decision_status: accepted
implementation_status: conformant
compatibility: behavior-change
owner_module: HostSdkHelpRegistry
supersedes: []
last_verified_sha:
---

# S13 低 token 的任务导向 Host SDK Help

## 用户场景

Main Agent需要用尽可能少的上下文可靠完成delegation。一次`host.help('delegate')`应给出参数和返回字段的简短说明，并覆盖普通委派、异步恢复、收集与停止；Agent不应读取完整JSON Schema或枚举多个Help section。若调用失败，Host在当次错误中指出具体问题和修正动作。

## 范围与非目标

范围：

- 将八个Subagent operation topics从exhaustive schema改为task-oriented flat field descriptions。
- 保留`request`、`options`、`returns`及参数/返回字段用途。
- 让`delegate`单topic覆盖常用Main delegation生命周期。
- 删除完整errors目录、重复union branch和opaque nested payload展开。
- 建立字符预算、查询纪律和真实Agent-facing不截断gate。

非目标：

- 新增Help section topics、`detail`参数或公开Schema introspection API。
- 改变八个operation的调用/成功结果shape。
- 恢复已由`SUB-DEC-0013`删除的`context`字段。
- 改变authorization、nested delegation、provisioning或durable data。
- 提高通用Notebook MCP inline budget或引入结构化error envelope。

## 当前行为

- 基线`b06862c8`的`DELEGATE_DESCRIPTOR`直接嵌入完整`DELEGATE_AGENT_CONTRACT`，输出10,120字符、约2,043个cl100k tokens。
- Help registry允许16,000字符，但Notebook MCP单个`text/plain`payload超过8,000字符就只返回omission marker。
- system prompt要求Main首次delegation前调用完整`help('delegate')`。
- S12已经从delegate request删除`context`并保留`task`、`name`、`profile`、`inputs`与`output_schema`；本阶段必须以该最新调用面为准。

## 规范性契约

- **PHELP-001 — 八topic边界（stable）**：无参数`host.help()` MUST继续只列八个公开Subagent operations；Help MUST NOT新增section topics或引导Agent枚举全部topics。
- **PHELP-002 — 扁平字段格式（stable）**：每个operation guide MUST保留`request`、`options`、`returns`。输入字段 MUST使用`{name,type,required,description,default?,range?}`；返回字段 MUST使用`{name,type,required?,when?,description}`。Help MUST NOT返回JSON Schema的`oneOf`、nested `properties`或重复`required`树。
- **PHELP-003 — delegate request/options字段（stable）**：`delegate.request` MUST说明接受single object或non-empty object array，并列出`task:string`、`name:string`为required，`profile:string`、`inputs:string[]`、`output_schema:object`为optional；MUST NOT列出`context`。`options` MUST列出`wait:boolean`默认`true`及`timeout_seconds:number`范围`0..1800`。
- **PHELP-004 — delegate returns字段（stable）**：`delegate.returns` MUST说明`kind` discriminator与`receipts | observations | results`的触发条件和status集合。共享child字段 MUST只定义一次，并覆盖`frame_id`、`attempt_id`、`name`、`agent_name`、`status`、`terminal_message_id`、`response`、`artifacts_created`、`cancellation_reason`、`error`、`structured_output`、`structured_output_unsatisfied`。Opaque payload MUST只给类型和一句用途，不得递归展开。
- **PHELP-005 — 常用路径（stable）**：`help('delegate')` MUST让Main无需查询其他Help即可构造single/batch request，选择`wait:false`、`timeout_seconds`或all-settled，并在异步后正确调用`children`、`collect`和`stop_child`。Guide MUST保留root-only/nested-delegation、atomic batch、immutable inputs、Specialist选择/继承、name核心规则及wait/timeout冲突。
- **PHELP-006 — 错误驱动纠正（stable）**：Help MUST NOT列出exhaustive errors。Caller-correctable Host错误 MUST在调用时标识operation、失败字段/目标、约束和修正动作；transient unavailable错误 MUST说明是否稍后重试；authorization错误不得泄漏非caller identity。
- **PHELP-007 — 查询纪律（stable）**：Notebook静态导航 MUST告知Agent不要预取catalog全部topics。首次delegation MAY查询一次`delegate`；其他topic仅在准备调用相应operation且现有工作流说明不足时查询。
- **PHELP-008 — token与传输预算（stable）**：按`JSON.stringify(result)`计量，`delegate` MUST≤3,200字符，其他operation topic MUST≤3,600字符，catalog MUST≤2,500字符。每项经production-composed REPL→Notebook MCP MUST完整返回，无truncation或omission marker。
- **PHELP-009 — role与provisioning（stable）**：精简Help MUST保留trusted role与per-operation provisioning的availability投影；Delegate仍能发现root-only operation不可用原因，但不得获得调用权。
- **PHELP-010 — runtime兼容（stable）**：完整request/result union MUST继续由shared contract、runtime parser、Owner validation与project-owned tests拥有。Help精简 MUST不改变operation调用/成功结果shape、authorization topology、persistence schema或migration。

## Interface 与语义

`delegate`字段说明采用以下caller-visible形状：

```js
{
  request: {
    accepts: ['object', 'non_empty_array'],
    fields: [
      { name: 'task', type: 'string', required: true, description: 'Complete non-empty assignment.' },
      { name: 'name', type: 'string', required: true, description: 'Short unique child name; 1–48 code points, no emoji.' },
      { name: 'profile', type: 'string', required: false, description: 'Specialist id/name; omit to inherit the parent.' },
      { name: 'inputs', type: 'string[]', required: false, description: 'Immutable Upload/Artifact Version ids.' },
      { name: 'output_schema', type: 'object', required: false, description: 'JSON Schema 2020-12 for child structured output.' }
    ]
  },
  options: {
    fields: [
      { name: 'wait', type: 'boolean', required: false, default: true, description: 'Wait for all children unless false.' },
      { name: 'timeout_seconds', type: 'number', required: false, range: '0..1800', description: 'Bounded observation wait.' }
    ]
  },
  returns: {
    discriminator: { name: 'kind', values: ['receipts', 'observations', 'results'] },
    variants: [
      { value: 'receipts', when: 'wait=false', statuses: ['running'] },
      { value: 'observations', when: 'timeout_seconds is set', statuses: ['running', 'completed', 'cancelled', 'error'] },
      { value: 'results', when: 'all-settled wait', statuses: ['completed', 'cancelled', 'error'] }
    ],
    child_fields: [
      { name: 'frame_id', type: 'string', required: true, description: 'Stable child Frame handle.' },
      { name: 'attempt_id', type: 'string', required: true, description: 'Exact Attempt handle.' },
      { name: 'name', type: 'string', required: true, description: 'Delegation name.' },
      { name: 'agent_name', type: 'string', required: true, description: 'Resolved agent display name.' },
      { name: 'status', type: 'string', required: true, description: 'Child lifecycle status.' },
      { name: 'terminal_message_id', type: 'string', when: 'terminal and available', description: 'Terminal message id.' },
      { name: 'response', type: 'string', when: 'completed and available', description: 'Child text response.' },
      { name: 'artifacts_created', type: 'array', when: 'terminal', description: 'Finalized Artifact Version metadata.' },
      { name: 'cancellation_reason', type: 'string', when: 'cancelled', description: 'Cancellation source.' },
      { name: 'error', type: 'object', when: 'error', description: 'Terminal code and message.' },
      { name: 'structured_output', type: 'json', when: 'submitted', description: 'Accepted structured value.' },
      { name: 'structured_output_unsatisfied', type: 'boolean', when: 'terminal and schema unsatisfied', description: 'Required structured output was not submitted.' }
    ]
  }
}
```

普通Main工作流只读取一次Help：

```js
const guide = await host.help('delegate')
const dispatched = await host.delegate(
  [{ name: 'Source audit', task: 'Trace the primary sources', inputs: ['upload-version-1'] }],
  { wait: false }
)
const observations = await host.collect(
  dispatched.children.map(({ frame_id, attempt_id }) => ({ frame_id, attempt_id })),
  { timeout_seconds: 30 }
)
```

## 兼容性与持久化

- `host.help(query)`、八operation ids及`request/options/returns`顶层字段不变；nested shape从exact schema变为flat field descriptions。
- Agent仍能读取调用参数和返回参数。依赖Help生成SDK或解析完整conditional branch的caller不再受支持。
- Error message可增加actionable guidance，但error response shape、prefix和authorization不变。
- 无durable数据变化、migration、backfill或Session rewrite；rollback只恢复旧Help文本。

## Conformance 场景

| 场景                                                          | 条款           | 验证面                               |
| ------------------------------------------------------------- | -------------- | ------------------------------------ |
| request/options为扁平字段说明且不含context                    | PHELP-002..003 | Host Help contract                   |
| returns列出kind、variants与共享child字段且不递归展开          | PHELP-002、004 | descriptor snapshot                  |
| 单个delegate guide覆盖single/batch/async/bounded/collect/stop | PHELP-005      | Host Help contract                   |
| 常见validation/admission/control失败给出明确修正动作          | PHELP-006      | Host Adapter + Owner errors          |
| prompt禁止预取全部topics                                      | PHELP-007      | MCP description contract             |
| delegate≤3,200、其他operation≤3,600、catalog≤2,500且MCP不截断 | PHELP-008      | size/token + Adapter integration     |
| Main/Delegate与partial provisioning availability不变          | PHELP-009      | Help + local RPC capability          |
| shared contracts、operation shape与persistence回归不变        | PHELP-010      | contract + delegated-work regression |

## 开放决策

无。`SUB-DEC-0014`与`PHELP-001..010`已接受并实现。

## 实现证据

实现结果（2026-08-11）：

- `HostSdkHelpRegistry`不再导入或投影`DELEGATE_AGENT_CONTRACT` / `COLLECT_AGENT_CONTRACT`；八个topic统一返回扁平`fields`，且不含`errors`、`oneOf`、`allOf`或`properties`。
- `delegate`保留single/batch request、`wait`/`timeout_seconds`、三种result kind与全部公开child字段，并在一个topic内给出`children`、`collect`、`stop_child`最小follow-up形状。
- Help registry在runtime执行字符预算：catalog为2,500，delegate为3,200，其他operation topic为3,600。实现后的Main `help('delegate')`为3,125字符、约681个cl100k tokens，较基线分别减少69%与67%；MCP execution projection测试确认`text/plain`正文完整保留且无omission marker。
- Notebook静态导航改为按需查询，明确禁止预取全部topics；不再强制首次delegation前查询。
- `delegate`与`collect`RPC参数错误现在指出具体字段、合法值/范围及修正动作；未引入新的error envelope。
- exact runtime contract、operation成功result、authorization、capability wiring与durable data均未改变。

Test Impact Set：

```text
npm test -- src/main/host-sdk/help.test.ts src/main/host-sdk/delegate-contract.test.ts src/main/notebook/mcp-server.test.ts src/main/notebook/local-rpc-server.delegated-work.test.ts
# 4 files / 80 passed
RUN_KERNEL=1 npm test -- src/main/notebook/repl-loop.integration.test.ts
# 1 file / 41 passed
npm run typecheck:node
# passed
npm run lint -- --no-cache
# exit 0; 107 existing warnings, none in changed files
```

候选身份由紧随本文档的Git commit记录，避免自引用SHA。

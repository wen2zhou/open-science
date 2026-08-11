---
spec_id: SUB-STRUCTURED-OUTPUT
title: S6 可校验且可重复收集的 structured output
decision_status: accepted
implementation_status: conformant
compatibility: persistence-impact
owner_module: DurableDelegatedWork
supersedes: []
last_verified_sha: 0aaae702
---

# S6 可校验且可重复收集的 structured output

## 用户场景

Main Agent在委派一个或多个Subagent时，可为每个child提供可选JSON Schema。声明schema的child通过受认证入口提交JSON value；系统在服务端按admission时固定的schema校验并durable保存。child终态后，blocking `delegate`或稍后的`collect`返回可程序消费的structured output，同时继续返回普通文本response与Artifact。

Main Agent可以在`wait:false`后先观察running child，再用stable `{frame_id, attempt_id}` handle重复collect；structured output不因timeout、continuation、重复读取或app restart而被消费、移动或重新解释。

## 依赖与状态

- accepted + certified前置：S1 `SUB-DELEGATED-WAIT`的Attempt pinning、bounded collect、order、running/terminal projection与authorization合同。
- accepted decisions：
  - [`SUB-DEC-0006`](decisions/0006-structured-output-interface.md)：schema、child submission、result与terminal语义；
  - [`SUB-DEC-0007`](decisions/0007-structured-output-persistence.md)：Attempt归属、old-data与rollback。
- S2 timed delegate不是S6前置；本阶段不能声明或实现`delegate(..., {timeout_seconds})`。S2达到`accepted + conformant`后，timed observations只复用S6 terminal projection，不改变本spec的structured-output语义。
- 本spec的`STRUCT-001..020`均为本阶段已接受的`stable`实现合同。
- Owner Module是现有`DurableDelegatedWork`；目标Interfaces是parent侧`delegate`/`collect`与child-only submission。内部schema validation/submit ownership MAY 提取深Module，但不得把产品语义分散到provider Adapter或Host mapper。

## 范围与非目标

### 范围

- request-level additive `output_schema`，允许同batch不同schema。
- admission前schema profile/complexity校验与整批atomic rejection。
- authenticated、Attempt-scoped `host.submit_output(value)`。
- server-side validation、exactly-once/idempotent retry与submit/terminal race。
- Attempt-scoped durable schema/value evidence、old-data读取与显式rollback边界。
- blocking `delegate`与`wait:false → collect`统一投影文本、Artifact和structured output。
- historical Attempt collect、重复collect与Session reopen稳定读取。
- Host contract/Help、local RPC、REPL mapper、公共ACP execution、三种production framework composition与release gate。

### 非目标

- S2 timed delegate、跨Turn Composer/Cancel/Stop修复；S3 lifecycle taxonomy；S5 delivery receipts。
- nested delegation、Specialist继承、model routing、Scheduler、usage或cost。
- provider-native constrained decoding、从prose自动提取/修复JSON。
- partial/running structured observation或把submit作为Attempt terminal signal。
- continuation schema输入或隐式继承。
- 自动把structured output转成Artifact，或改变Artifact finalization、ownership、Provenance与Review。
- Renderer schema编辑器、structured result可视化、Reviewer审计和conversation export。
- 改变`stop_child`published response shape。

## 当前行为

- `DurableDelegateRequest`、Host contract/Help、local RPC与REPL接受可选`output_schema`；无schema路径保持旧shape。
- Codex、Claude Code与OpenCode共用app-owned structured submission seam；只有issued child capability能调用`host.submit_output`，owner identity来自认证绑定。
- completed child先staged transcript并finalize Artifact，再terminalize Attempt；blocking `delegate`和`collect`从同一durable snapshot投影文本、Artifact及可选structured result。
- running observation保持最小shape；continuation不继承schema，pinned historical Attempt仍读取旧value。
- durable Attempt严格白名单未扩展；schema/value整体evidence存于initial Attempt的initiating Message，旧reader save只损失S6 metadata。
- app restart仍把遗留running Attempt收口为`cancelled/runtime_interrupted`，不会恢复execution；accepted terminal value在reopen后稳定读取。
- 根依赖`ajv` 8.x是显式production dependency，validator采用`SUB-DEC-0006`的Draft 2020-12 profile与独立预算。

## 规范性契约

- **STRUCT-001 — additive request（stable）**：每个delegate request MAY包含`output_schema`；同batch items MAY不同。省略时admission、execution、terminal result与Host JSON shape MUST与现有合同相同。
- **STRUCT-002 — atomic schema admission（stable）**：Owner Module MUST在capacity reservation、workspace准备和durable admission前验证schema结构、dialect、vocabulary与限额；任一item失败 MUST整批无child。
- **STRUCT-003 — immutable Attempt contract（stable）**：accepted schema snapshot与dialect identity MUST随initial Attempt atomic admission并保持不可变；submission与historical projection MUST使用该snapshot，不得按Frame current state或最新validator重新解释。
- **STRUCT-004 — child-only submit（stable）**：只有声明schema且仍writable的authenticated child Attempt MAY调用`host.submit_output(value)`。接口 MUST隐式绑定caller Session/Frame/Attempt，MUST NOT接受caller supplied owner或schema。
- **STRUCT-005 — JSON purity（stable）**：schema与value MUST使用`SUB-DEC-0006`的Draft 2020-12 profile与JSON-safe边界；系统 MUST拒绝non-JSON、remote resolution与超限输入，MUST NOT coerce、填default、删除字段或修改submitted value。
- **STRUCT-006 — authoritative validation（stable）**：server-side validator是acceptance authority。invalid submission MUST不产生durable value并允许重试；client-side guard MAY更早报告，但不能替代server validation。
- **STRUCT-007 — exactly once（stable）**：每Attempt第一份valid submission的durable CAS是线性化点；相同JSON重放 MUST幂等成功，不同第二份value MUST拒绝且不得覆盖。
- **STRUCT-008 — non-terminal submit（stable）**：accepted submission MUST NOT自动结束Attempt、阻断后续文本或改变Artifact lifecycle。
- **STRUCT-009 — race与撤权（stable）**：submit与terminal/stop MUST共享current writable Attempt CAS。submit先commit则保留；terminal先commit则late submit失败。durable command MUST重验在途capability和ownership。
- **STRUCT-010 — running隐私（stable）**：receipts、`children()`与running observations MUST保持既有最小shape，不得暴露schema、partial value、submission presence或validation error。
- **STRUCT-011 — terminal coexistence（stable）**：声明schema的terminal result MUST保留现有`response`和`artifacts_created`。accepted value时同时包含`structured_output`与`structured_output_unsatisfied:false`；无accepted value时只包含`structured_output_unsatisfied:true`。
- **STRUCT-012 — terminal status正交（stable）**：missing/invalid submission MUST NOT自行把正常completion改为`error`。accepted value在`completed | cancelled | error`结果中保持可投影；caller必须结合terminal status判断是否消费。
- **STRUCT-013 — projection一致性（stable）**：blocking `delegate`、bounded `collect`、重复selector与historical Attempt handle MUST从同一authenticated durable snapshot投影同一JSON语义；structured output不得按读取而消费或重排。
- **STRUCT-014 — deadline隔离（stable）**：collect expiry MUST NOT提交、清除、消费或重新验证structured output。deadline deciding snapshot中running项不得携带structured terminal fields。
- **STRUCT-015 — continuation隔离（stable）**：initial Attempt的schema/value MUST绑定该Attempt。current continuation MUST不隐式继承旧schema；historical handle仍可读取旧Attempt result且不得与current Attempt串位。
- **STRUCT-016 — restart（stable）**：accepted submission MUST在Session reopen后保持相同JSON语义。遗留running Attempt仍按`cancelled/runtime_interrupted`收口；S6不得自动恢复execution。
- **STRUCT-017 — old data（stable）**：新reader MUST兼容完全缺失S6 metadata的旧数据，不backfill或伪造schema/value/unsatisfied flag。旧result保持原shape。
- **STRUCT-018 — persistence isolation（stable）**：schema/value MUST存入old reader可安全忽略的Attempt-owned Message evidence，并接受`SUB-DEC-0007`的S6-metadata有损rollback；不得因新增字段让旧reader拒绝整个delegated runtime context。
- **STRUCT-019 — bounded storage（stable）**：schema与value MUST使用`SUB-DEC-0006`的独立bytes/node/depth/properties/items预算；超限输入不得令Session其余数据不可读。
- **STRUCT-020 — adapter一致性（stable）**：Host contract/Help、RPC auth、REPL blocking/collect mapper、durable records、public ACP execution与Codex/Claude Code/OpenCode production composition MUST使用同一Owner语义；任一provider不得自定义JSON提取或terminal规则。

## Interface 与语义

### Parent Host SDK

拟议调用：

```js
const outcome = await host.delegate({
  name: 'Potency extraction',
  task: 'Extract compound potencies',
  output_schema: {
    type: 'object',
    properties: {
      compounds: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            ic50_nM: { type: 'number' }
          },
          required: ['name', 'ic50_nM'],
          additionalProperties: false
        }
      }
    },
    required: ['compounds'],
    additionalProperties: false
  }
})
```

拟议terminal child：

```js
{
  frame_id: 'frame-a',
  attempt_id: 'attempt-a',
  name: 'Potency extraction',
  agent_name: 'Main Agent',
  status: 'completed',
  response: 'I extracted two compounds and attached the source table.',
  artifacts_created: [],
  structured_output: {
    compounds: [
      { name: 'Compound A', ic50_nM: 12.5 },
      { name: 'Compound B', ic50_nM: 31 }
    ]
  },
  structured_output_unsatisfied: false
}
```

声明schema但未accepted submit：

```js
{
  frame_id: 'frame-a',
  attempt_id: 'attempt-a',
  status: 'completed',
  response: 'I could not determine all required values.',
  artifacts_created: [],
  structured_output_unsatisfied: true
}
```

### Child Host SDK

拟议调用：

```js
await host.submit_output({
  compounds: [{ name: 'Compound A', ic50_nM: 12.5 }]
})
```

该调用只返回`{accepted:true}`或throw；它不返回parent result，也不终止child。

### Error 模式

- malformed/unsupported/超限schema：parent delegate整批throw，且无admission side effects。
- child invalid/超限value：`submit_output`throw，无durable value；child可修正重试。
- unauthorized、无schema、non-current或terminal Attempt submit：fail-closed throw。
- child最终没有accepted value：不是RPC error；terminal result按`STRUCT-011..012`投影unsatisfied。
- storage/projection关联失败：parent调用整批throw，不降级为running或unsatisfied。

## 兼容性与持久化

- opt-in caller与result字段additive；无schema路径保持existing contract。
- schema与accepted value绑定exact initial Attempt，持久化到发布前Message reader可忽略的additive evidence位置；具体内部field名不属于caller合同。
- 新reader兼容旧数据缺字段；无migration/backfill。
- 发布前版本可以继续读取文本、Artifact与delegated Attempt历史，但不显示S6 metadata；若在旧版本保存，re-upgrade时structured output可能丢失。
- rollout前必须明确上述有损rollback并建议降级前备份；S6不交付downgrade migration或metadata恢复工具。
- schema/value sanitizer与限额独立于runtime-context共享预算，且Host/RPC映射不得泄露schema或capability secret。

## Conformance 场景

| 场景                                                                              | 条款                 | 验证面                  |
| --------------------------------------------------------------------------------- | -------------------- | ----------------------- |
| 同batch不同schema、out-of-order completion仍按request顺序                         | STRUCT-001..003、013 | Owner Interface         |
| 一项invalid schema使整批无reservation/workspace/durable child                     | STRUCT-002           | Admission contract      |
| 无schema request/result shape完全不变                                             | STRUCT-001、017      | Host/REPL regression    |
| child valid submit后文本、Artifact和structured result共存                         | STRUCT-004..008、011 | public ACP + projection |
| invalid后修正；same retry幂等；different second拒绝                               | STRUCT-006..007      | Structured Output Owner |
| submit与terminal/stop/capability revoke竞态                                       | STRUCT-009           | deterministic CAS race  |
| running receipt/collect不带structured terminal fields                             | STRUCT-010、014      | Read Model/REPL mapper  |
| missing submit completed + unsatisfied；cancel/error保留accepted value            | STRUCT-011..012      | terminal projection     |
| duplicate/historical selectors保持Attempt value且不消费                           | STRUCT-013、015      | collect contract        |
| Session reopen与runtime_interrupted仍读取accepted value                           | STRUCT-016           | persistence/recovery    |
| old-data缺字段可读且不backfill                                                    | STRUCT-017           | old-data fixture        |
| old reader读取新Session不丢delegated runtime context；旧版本save只损失S6 metadata | STRUCT-018           | rollback fixture        |
| null、Unicode、数组、边界大小、non-JSON与恶意schema                               | STRUCT-005、019      | validator/sanitizer     |
| parent/Reviewer/其他Session/伪造owner submit均拒绝                                | STRUCT-004、009      | local RPC auth          |
| Codex、Claude Code、OpenCode真实child均能submit                                   | STRUCT-020           | production composition  |

## 开放决策

无。`SUB-DEC-0006`与`SUB-DEC-0007`已`accepted`；未列入`STRUCT-001..020`的相邻能力仍是非目标。

## 实现证据

### 已交付实现（candidate `0aaae702`）

- Owner/Interface：`src/main/delegated-work/durable-delegated-work.ts`
- admission：`delegated-work-admission.ts`
- execution seam：`execution-port.ts`、`acp-execution.ts`
- projection/read：`delegated-work-projection.ts`、`delegated-work-read-model.ts`
- persistence：`src/shared/session-persistence.ts`、`session-records.ts`、`session-record-adapter.ts`、Session coordinator与in-memory Adapter
- Host adapters：`src/main/host-sdk/*`、`src/main/notebook/local-rpc-server.ts`、`resources/notebook/repl_loop.js`
- production adapters：Codex、Claude Code、OpenCode均通过`createProductionDelegatedWorkFrameworks`、各自production execution adapter与issued delegated-notebook RPC capability汇入同一Owner；三framework contract覆盖invalid后valid提交、blocking result及reopen/historical recollect。
- production-composed desktop journey：真实OpenCode child经delegated Notebook capability和REPL调用`host.submit_output`，同时保留terminal text与Artifact；重启后accepted value仍可读取。S6 journey独立通过，但完整release gate仍被既有Renderer focus restoration阻塞，因此本阶段为`conformant`而非`certified`。
- excluded consumers：Renderer、Reviewer、conversation export与structured visualization；必须回归不被新metadata破坏，但不构成本阶段功能支持。

### 候选 Test Impact Set

```text
npm test -- src/main/delegated-work/structured-output.test.ts
npm test -- src/main/delegated-work/durable-delegated-work.test.ts
npm test -- src/main/delegated-work/session-record-adapter.test.ts
npm test -- src/main/session-persistence/delegated-work-records.test.ts
npm test -- src/main/delegated-work/execution-contract.test.ts
npm test -- src/main/delegated-work/acp-execution.test.ts
npm test -- src/main/delegated-work/codex-execution.test.ts
npm test -- src/main/delegated-work/claude-code-certification.test.ts
npm test -- src/main/delegated-work/opencode-execution.test.ts
npm test -- src/main/delegated-work/production-composition.test.ts
npm test -- src/main/notebook/local-rpc-server.delegated-work.test.ts
RUN_KERNEL=1 npm test -- src/main/notebook/repl-loop.integration.test.ts
npm test -- src/main/host-sdk/delegate-contract.test.ts src/main/host-sdk/help.test.ts
npm test -- src/shared/session-persistence.test.ts
npm run typecheck:node
npm run lint
npm test
npm run build:e2e
npx playwright test e2e/subagent-release-gate.spec.ts
```

production-composed release gate至少覆盖：blocking `delegate(output_schema) → child submit → text/Artifact finalize → parent result`；`wait:false → running collect → terminal collect`；Session reopen/historical recollect；invalid/missing submit；old-data与rollback fixture。S2达到`accepted + conformant`后再补timed delegate projection，不得在此前把它计入S6通过证据。

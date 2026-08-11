---
decision_id: SUB-DEC-0006
title: Structured output schema、提交与终态语义
status: accepted
affects_specs:
  - SUB-STRUCTURED-OUTPUT
compatibility: additive
supersedes: []
---

# Structured output schema、提交与终态语义

## 背景与当前行为

当前 `host.delegate` 的每个 request 提供 `task`、`name`、`profile` 与 `inputs`；child execution 只产生文本 response、Artifact 与 Attempt terminal outcome。blocking `delegate` 和后续 `collect` 都通过同一 `DelegatedWorkProjectionOwner` 从 durable Attempt evidence 投影结果，但没有 schema、structured submission 或 `structured_output` 字段。

参考 Host SDK 把 `output_schema` 放在单个 delegate request 中，并以 child 显式调用 `submit_output` 作为结果来源；未提交时可返回 `structured_output_unsatisfied`。参考文档对 structured output 是否替代文本 response 描述不一致，而本项目 S6 用户场景明确要求 structured output 与文本、Artifact 共存，因此不能直接复制参考 response shape。

schema dialect、提交重试、missing submission、cancel/error 时的已提交值，以及 continuation 是否继承 schema 都会改变 caller 可依赖的结果或 terminal meaning，必须在实现前接受。

## 决策

1. `output_schema` 是单个 delegate request 的 additive 字段；同一 batch 的不同 request MAY 使用不同 schema。省略该字段时，现有 admission、execution 与 result shape MUST 保持不变。
2. schema profile固定为JSON Schema Draft 2020-12，持久化dialect identity为`2020-12`。schema MAY是object或boolean；若出现`$schema`，其值 MUST精确为`https://json-schema.org/draft/2020-12/schema`。`$ref`与`$dynamicRef`只允许以`#`开头的document-local fragment；MUST禁止remote/file resolution、`$vocabulary`、`format`、`pattern`与`patternProperties`。未知keyword MUST fail-closed。
3. schema 的结构、dialect、受支持 vocabulary 与复杂度 MUST 在 capacity reservation、workspace 准备和 durable admission 前完成校验；batch 中任一 schema 不合法或超限时 MUST 整批无 child。
4. structured output 只来自 app-owned、child-only 的 `host.submit_output(value)`；系统 MUST NOT 从最终 prose 猜测 JSON，也不依赖 provider-native constrained decoding。调用方不得传入或替换 Frame、Attempt 或 schema identity；服务端从 authenticated child capability 绑定当前 writable Attempt。
5. value MUST 是可无损 JSON round-trip 的值。`undefined`、`BigInt`、non-finite number、循环引用、稀疏/非 JSON object 与超限 payload MUST 在 durable write 前拒绝。
6. 每个声明 schema 的 Attempt 最多接受一个 structured output。第一份 valid value 的 durable commit 是线性化点；相同 JSON value 的重试 MUST 幂等成功，不同的后续 value MUST 拒绝且不得覆盖首值。invalid submission MUST 不写入并允许 child 修正后重试。
7. `submit_output` 不结束 Attempt。child 仍可产生普通最终文本并 finalize Artifact；running receipt、`children()` 与 running collect observation MUST NOT 暴露 submitted 或 partial structured output。
8. terminal result 对声明 schema 的 Attempt MUST 保留现有 `response` 与 `artifacts_created`，并始终包含 `structured_output_unsatisfied`：
   - 已有 accepted submission 时为 `false`，同时包含 `structured_output`；
   - 没有 accepted submission 时为 `true`，且不得包含 `structured_output`。
     无 schema 的 Attempt 不包含这两个字段。
9. 缺失或 invalid submission 本身不改变 Attempt terminal status；child 正常结束仍是 `completed`，caller 通过 `structured_output_unsatisfied:true` 区分合同未满足。已 accepted submission 在后续 `completed`、`cancelled` 或 `error` result 中继续投影；caller MUST 同时检查 terminal `status` 后再决定是否消费该值。
10. submit 与 terminal/stop 共用 current writable Attempt 的 durable CAS：submit 先 durable commit则按第9项投影；terminal 先 commit则 late submit MUST fail-closed。capability 在请求期间被撤销时，durable command 仍 MUST 重验 writable ownership。
11. S6 只为 initial delegate Attempt 建立 `output_schema` 合同。terminal continuation 在当前 Interface 中不能提供新 schema，也 MUST NOT 隐式继承上一 Attempt 的 schema；若后续阶段需要 continuation schema，必须先接受新的 caller-shape 与继承 decision。

## 已接受的 validator profile 与限额

production validator使用显式runtime dependency Ajv 8.x的Draft 2020-12入口，配置 MUST等价于：

```ts
new Ajv2020({
  strict: true,
  allErrors: false,
  validateFormats: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  ownProperties: true,
  messages: false,
  verbose: false,
  addUsedSchema: false
})
```

实现 MUST在Ajv compile/validate前执行JSON-safe prewalk。root depth为0；每个primitive、array与object各计一个node；bytes按`Buffer.byteLength(JSON.stringify(value), 'utf8')`计算；只接受dense array与plain own-property object。

| 预算                      | schema | submitted value |
| ------------------------- | -----: | --------------: |
| serialized UTF-8 bytes    | 64 KiB |         256 KiB |
| total nodes               |  1,000 |           5,000 |
| max depth                 |     32 |              32 |
| max properties per object |    128 |             256 |
| max items per array       |    128 |           1,000 |

`host.submit_output` durable acceptance receipt固定为`{accepted:true}`；canonical-equal retry返回同一shape，不公开duplicate、Frame、Attempt、schema/hash或timestamp。

invalid value只向authenticated child公开第一条安全错误：`code:'structured_output_validation_failed'`、标准keyword allowlist中的`keyword`与最多256 chars的RFC 6901 `instance_path`。`required`或`additionalProperties` MAY额外返回一个长度受限的`property`。MUST NOT公开Ajv message、`schemaPath`、完整params、schema/value片段、enum值、pattern或stack；rejected value与详细错误不得持久化，也不得出现在parent/running surfaces或日志中。

上述限额来自本项目Session/payload预算与Ajv 8.20微基准：复杂schema在约1,000 nodes后compile latency开始明显上升；1,000-item `uniqueItems` object array约20 ms而2,000 items约84 ms；256 KiB与现有connector payload等级一致。实现后的production-composed gate仍需验证Electron wiring与内存风险。

## 备选方案

- **解析最终 prose**：无需新 child API，但会让三个 provider 的容错和 JSON 提取行为漂移，也无法可靠区分 `null`、无提交与非法输出。
- **provider-native structured response**：可利用部分 provider 能力，但会把 S6 可用性绑定到 provider feature matrix，不能形成一致的 app-owned Interface。
- **missing submission 使 Attempt `error`**：terminal meaning更严格，但会把已有有效文本和 Artifact 的正常完成改写为执行失败。
- **last-write-wins**：实现简单，但并发/重试会让 collect 结果依赖竞态，破坏可重复观察。
- **continuation 自动继承**：调用方便，但属于新的隐式产品行为；当前 continuation Interface 无法让 caller确认或替换 schema。

## 兼容与迁移

- `output_schema` 与 terminal result structured 字段均为 opt-in additive shape；无 schema 的旧调用和旧数据保持现状。
- Host contract、Help、local RPC、REPL mapper 与 production composition必须原子更新，避免 blocking delegate 与 collect 的字段映射漂移。
- 本 decision 不改变现有 `stop_child` response shape；参考 SDK 的 stop-harvest 行为属于另一个 published-shape decision。
- 持久化与 rollback 由 [`SUB-DEC-0007`](0007-structured-output-persistence.md) 单独决定。

## Conformance 场景

1. 同 batch 两个不同合法 schema，out-of-order完成后结果仍按 request order且分别校验。
2. batch 中一个 schema非法或超限，reservation、workspace、Frame、Attempt与Message均未创建。
3. 无 schema调用的 request/result JSON shape与既有合同相同。
4. valid submit 后普通完成，`response`、`artifacts_created`、`structured_output`与`structured_output_unsatisfied:false`共存。
5. invalid submit无 durable write；修正后提交成功。
6. 相同 value 重试幂等；不同第二次提交拒绝且首值不变。
7. running observation不含 structured字段；terminal collect取得 accepted value。
8. missing submission正常完成并返回`structured_output_unsatisfied:true`。
9. submit与stop/terminal竞态只按durable CAS顺序决定；late submit失败。
10. parent、Reviewer、其他Session或伪造Frame/Attempt调用`submit_output`均fail-closed。
11. continuation不继承前一Attempt schema；historical handle仍返回旧Attempt structured result。
12. `null`与未提交可区分；non-JSON、恶意schema和边界大小输入按合同处理。

## 后续影响

- Feature spec、Host Help与production-composed gate必须明确文本和Artifact不会被structured output替代。
- S2 timed delegate只有在S2达到`accepted + conformant`后才能加入S6 conformance；S6不得自行引入S2等待与Cancel/Stop语义。
- 若未来需要`format`、regex keywords、remote reference或更大预算，必须用新的accepted decision和安全证据扩展profile。

---
decision_id: SUB-DEC-0009
title: S5 消息 command、receipt 与故障恢复持久化
status: accepted
affects_specs:
  - SUB-MESSAGE-DELIVERY
compatibility: persistence-impact
supersedes: []
---

# S5 消息 command、receipt 与故障恢复持久化

## 背景与当前行为

当前 delegated `pendingMessages` 只保存source/target、text、kind、caller source、`createdAt`与可选`deliveredAt`。它无法区分仍排队、明确失败与crash后的不确定结果；message invocation dedupe也只保存在进程内Map，失败或重启后无法从丢失的RPC response恢复同一 committed effect。

Subagent消息尚未发布，因此当前`pendingMessages`原型不是兼容性authority，不需要old-data migration或rollback。S5仍必须把新message owner与Session其余authority隔离，避免一条corrupt receipt破坏普通对话、Artifact、Plan、Permission或其他已存在数据。

## 决策

1. 每次S5 reliable send必须原子durable admission一个message command，至少保存：
   - stable `messageId`；
   - Session-scoped、source-Frame-scoped command identity；
   - canonical request digest；
   - source/target Frame与相关Attempt；
   - root-origin branch binding与caller source；
   - kind、reply/retry correlation；
   - per-lane sequence；
   - queued timestamp与delivery receipt。
2. command identity在`SUB-DEC-0008`定义的Session/source principal scope内MUST unique。canonical request同时持久化normalized target、原文message、kind、reply/retry correlation，并使用versioned `sha256-canonical-json-v1` digest；wait/observation options与解析时current target Attempt不进入digest。相同identity、相同canonical request读取既有command；相同identity、不同request MUST conflict。message ID和lane sequence一经admission不得改变。
3. receipt持久化为不可逆状态机：
   - `queued` MAY记录尚未dispatch或`dispatchStartedAt`；
   - `accepted`保存`acceptedAt`与Adapter evidence class；
   - `failed`保存`failedAt`、stable error code、safe diagnostic message、retryable；
   - `uncertain`保存进入不确定状态的时间和`deliveryMayHaveOccurred:true`。
4. `queued → accepted | failed | uncertain`使用conditional/CAS mutation。terminal receipt不可回退或相互覆盖；late provider callback、Attempt terminal与branch change不得伪造新事实。
5. 任何外部provider/root-runtime delivery side effect之前必须先以CAS durable写入`dispatchStartedAt`、dispatch epoch与target binding。该marker是保守fence：
   - crash发生在marker commit前，可证明未dispatch；
   - crash发生在marker commit后、Adapter call前，虽然可能实际未调用，recovery仍必须视为uncertain；
   - Adapter call开始后直到accepted/failed receipt commit前，缺少可查询的stable provider operation evidence时均为uncertain。
6. restart recovery按方向与固定route处理：
   - downward `disposition:"message"`只有在exact target Attempt仍current/running且无dispatch marker时才可继续；app restart已将该Attempt收口为`runtime_interrupted`时 MUST写`failed(target_attempt_unavailable)`，不得静默continuation；
   - upward无dispatch marker的queued command可在source relationship与root-origin branch仍validated时恢复到root scheduler；source Attempt在admission后terminal不撤销该消息；
   - `continued`绑定的新Attempt在restart后按Attempt recovery收口，不重新admit；
   - accepted、failed与uncertain均不得自动重投。
7. Host成功返回的terminal receipt必须已durable commit。provider已接受但accepted commit失败时，调用返回durability/uncertain error；不得返回`failed`，也不得用新message ID自动尝试。
8. source/target text、error message与correlation必须遵守独立persistence预算。错误持久化仅保存用户可诊断的stable code与bounded message，不保存provider secret、raw request或stack。
9. 当前prototype `pendingMessages`不得映射为S5 command、accepted evidence或retry input，也不得自动重投。开发切换可丢弃该prototype owner；不得按text、时间邻近或数组位置推断command identity、digest、sequence或delivery事实。
10. S5 command/receipt必须放在可独立sanitize和quarantine的message owner envelope中。invalid/corrupt envelope使S5 Host操作不可用并返回诊断，但raw envelope MUST在后续Session save中原样保留；Conversation Graph、child/Attempt、Artifact、Review、Plan、Permission及其他owner继续正常读写。不得因S5 corruption write-protect整个Session，也不得静默丢弃坏receipt或伪造accepted。
11. S5不建立pre-S5 backup、old reader或downgrade合同。实现可以在不破坏其他Session owner的前提下调整message-owner内部schema；若必须改变全局`SESSION_FILE_VERSION`、`ConversationGraph.schemaVersion`或`SessionRuntimeContext.version`，必须另提decision，不得作为S5实现细节扩大。
12. `uncertain` command的`resolution:"acknowledged"`是独立durable control fact，只解除lane fence；不得改写原dispatch evidence、声称accepted/failed或使原command可重投。只有`SUB-DEC-0008`授权的root Main操作可写该resolution。
13. stop/terminal/branch race不得仅按CAS commit先后决定事实。只有Adapter证明acceptance尚未发生时可写failed；dispatch marker存在且acceptance/rejection evidence不完整时必须写uncertain，即使stop mutation先获得锁。

## 备选方案

- 继续使用`deliveredAt?`：schema改动最小，但不能表达failed/uncertain、durable idempotency和安全重试。
- 将无`deliveredAt`一律视为failed：便于重试，但provider可能已接受，可能制造重复指令。
- restart自动重放全部queued：提高eventual delivery，但在无provider idempotency/query时违反安全重试承诺。
- 只做in-memory command cache：无法覆盖lost response后的process restart，也不符合Delegation Command定义。
- 为未发布原型维护legacy reader和backup：能保留开发数据，但增加双schema、rollback和测试负担，不产生用户价值。

## 开发切换

- Host SDK、local RPC、Owner、Session Adapter、shared sanitizer、tests与help在一个candidate中原子切换。
- 当前prototype message记录可在开发环境清理或quarantine，不提供迁移、回滚、降级或恢复承诺。
- 与S5无关的Session owner和数据必须继续读取、保存和删除；这属于隔离要求，不是prototype兼容承诺。

## Conformance 场景

1. 相同command identity与payload跨process重试返回同一message ID/receipt，外部Adapter只调用一次；payload不同conflict。
2. queued commit后、dispatch marker前crash可证明未dispatch；dispatch marker后、Adapter call前crash保守恢复为uncertain；provider acceptance后、accepted receipt commit前crash同样恢复为uncertain。
3. provider pre-acceptance reject后durable failed；同command读取原failed，新command才可重试。
4. provider accepted、accepted commit成功后restart仍读取accepted且不重投。
5. downward proven-unsent在restart后因exact Attempt已`runtime_interrupted`而failed，不continuation；upward proven-unsent在branch仍validated时恢复root scheduler。
6. dispatch已开始、terminal receipt前crash恢复为uncertain并fence同lane；root Main acknowledge后只解除fence，不改写delivery事实。
7. Attempt stop与provider callback竞态按acceptance evidence而非锁先后收口；late callback不改写accepted历史或伪造failed。
8. prototype `pendingMessages`不生成S5 command、accepted或retry side effect；开发切换后新写入只使用S5 owner。
9. corrupt S5 envelope被quarantine并原样保留，S5 Host操作失败；Conversation Graph、child inventory、Artifact、Review、Plan与Permission仍可正常读写。
10. 同一candidate内Host、Owner、Adapters、sanitizer与fixtures没有混用prototype/new shape。

## 后续影响

- `SessionRepository`、shared sanitizer、Session persistence coordinator、in-memory/session-record Adapters与delegated message read model必须原子切换到同一schema语义。
- S5 certification不包含未发布prototype兼容或rollback claim，但必须证明message-owner corruption不会阻塞Session其余功能。
- 若未来provider支持以`messageId`查询或幂等重放，可新增reconciliation Adapter将部分uncertain收敛，但不得改写已接受的历史receipt。

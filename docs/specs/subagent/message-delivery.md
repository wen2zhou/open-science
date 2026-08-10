---
spec_id: SUB-MESSAGE-DELIVERY
title: Main Agent 与 direct Subagent 的可靠双向通信
decision_status: accepted
implementation_status: certified
compatibility: persistence-impact
owner_module: DurableDelegatedWork
supersedes: []
last_verified_sha: 39985ecd8510978586271a97205f5dd1bd75f6c7
---

# Main Agent 与 direct Subagent 的可靠双向通信

## 用户场景

Main Agent 派发一个或多个Subagent后，可以在后续cell或Conversation Turn补充、纠正或回答direct child，并确认每条指令是仅已durable排队、已被目标runtime接受、明确失败，还是处于不能安全重试的不确定状态。running Subagent也可向其Main parent发送带Frame/Attempt来源的`info`或`question`；Main在安全边界收到消息后可回复同一child，不会串到sibling、inactive branch或其他Session。

用户不需要根据一次RPC是否返回来猜测“到底发没发”：相同command可恢复同一receipt，明确失败可用新command安全重试，provider可能已接受的uncertain消息不会被系统自动重复注入。

## 范围与非目标

本阶段包含：

- `host.send_message`双向direct parent-child Interface与machine-readable Host help；
- `host.message_receipt`恢复与bounded observation；
- `host.resolve_message`显式解除uncertain lane fence；
- durable command identity、receipt状态机、per-lane ordering与safe retry；
- Main→running child、child→idle/running Main和terminal-child continuation；
- active-branch authorization、permission/stop/terminal/branch/restart竞态；
- Codex、Claude Code与OpenCode production Adapter conformance；
- crash/restart、corrupt receipt isolation与production-composed desktop journey。

本阶段不包含：

- sibling、grandchild或nested delegation通信；
- Side chat MCP语义合并；
- provider native multi-agent或running-prompt字节级注入；
- 用户直接在Subagent preview输入消息的Composer；
- 保证目标理解、采纳、完成或回复；
- reference产品quota、cost/usage、Scheduler或新的lifecycle taxonomy。

## 当前行为

- `DurableDelegatedWork.sendMessage`、local RPC与REPL SDK已支持Main→Frame、Delegate→`"parent"`和terminal continuation。
- Main→running child先durable append再返回`queued`；provider acceptance后后台写`deliveredAt`，failure不可观察。
- child→parent先durable append，再同步启动root app-owned continuation并写`deliveredAt`，最后仍返回`queued`；Main runtime active时可能因interaction排他失败。
- `pendingMessages`只有`createdAt/deliveredAt?`，command dedupe仅在进程内；restart不重放undelivered历史。
- `sendMessage`没有完整复用active-branch authorization owner；当前production E2E没有双向message journey。
- 以上是characterization，不是accepted S5合同。

## 规范性契约

- **MSG-001 [stable]**：仅同一Session、active root Message Branch上的root Main Agent与其direct Delegate child允许通信；拓扑与authorization遵循`SUB-DEC-0003`。
- **MSG-002 [stable]**：Main→child、child→parent与continuation MUST使用同一active-branch authorization owner并fail-closed。
- **MSG-003 [stable]**：可靠发送 MUST先原子durable admission message command，再以CAS写dispatch-start fence，最后才触发任何target runtime side effect；restart必须能区分fence前proven-unsent与fence后uncertain。
- **MSG-004 [stable]**：command identity MUST durable且idempotent；相同identity/payload返回同receipt，不同payload conflict。
- **MSG-005 [stable]**：receipt MUST使用`SUB-DEC-0008`的exhaustive snake_case union，正交表达direction、`disposition:"message" | "continued"`和`status:"queued" | "accepted" | "failed" | "uncertain"`，并使用方向明确的source/target/continuation identity。
- **MSG-006 [stable]**：`queued`、`accepted`、`failed`与`uncertain` MUST具有`SUB-DEC-0008`定义的边界，receipt MUST永远不是目标回复。
- **MSG-007 [stable]**：Host caller MUST能按owned message/request identity恢复最新receipt并做bounded wait；每次observation MUST重验active-branch authorization，expiry或授权失效 MUST不改变消息、Attempt或Turn。root Main MUST能durable acknowledge uncertain风险以解除lane fence，但不得改写或重投原delivery事实。
- **MSG-008 [stable]**：同一source-target lane MUST按durable sequence开始投递；uncertain head MUST阻止后续自动越过，直到root Main显式acknowledge。eligible lane在branch/runtime持续可用时 MUST满足弱公平并最终开始dispatch或收口失败。
- **MSG-009 [stable]**：Main→child在child prompt安全边界投递；所有child→Main lane MUST由单一Session root scheduler与真实user prompt admission线性化，root idle时可唤醒，root active时排队到安全边界，MUST不创建并发prompt、抢占当前Turn或使eligible消息饥饿。
- **MSG-010 [stable]**：child→parent MUST保持source child root-origin branch binding；branch activation owner MUST在branch revision变化与restart后唤醒scheduler，并在dispatch fence前原子重验。switch-before-fence park，switch-after-fence且事实不完整转uncertain，不得重绑定到另一个root branch。
- **MSG-011 [stable]**：message admission MUST不隐式处理permission；awaiting permission期间保持queued。
- **MSG-012 [stable]**：terminal-before-command-commit的成功send admission MUST创建same-Frame continuation；capacity/authorization/model/workspace等admission失败时整条command无副作用失败。commit-before-terminal MUST保持原route，不得静默continuation。
- **MSG-013 [stable]**：`continued`只证明Attempt admission；runtime startup与provider acceptance MUST由receipt status独立表达。
- **MSG-014 [stable]**：source Turn取消不得撤销已admit message或停止旧Turn target Attempt；target stop/cancel MUST按Adapter acceptance evidence收口，只有可证明未accept才failed，事实不完整必须uncertain，且不得回退accepted。
- **MSG-015 [stable]**：`question`回答 MUST是独立反向message；`reply_to_message_id` MUST引用同branch、反方向、source/target互换且已admit的question，并持久化correlation。
- **MSG-016 [stable]**：restart recovery MUST区分方向、dispatch fence与固定route：downward fence前proven-unsent且exact Attempt已interrupted则failed且不continuation；fence后缺少可信acceptance/rejection evidence必须uncertain；upward proven-unsent在relationship/branch仍validated时恢复root scheduler；continued Attempt不重新admit；accepted、failed与uncertain不重投。
- **MSG-017 [stable]**：当前prototype `pendingMessages` MUST不映射、不重投也不生成S5 delivery事实；开发切换可清理或quarantine该未发布owner。
- **MSG-018 [stable]**：corrupt S5 command/receipt MUST隔离message owner并原样保留raw envelope；S5 Host操作fail-closed，但其他Session owner MUST继续正常读写，不得write-protect整个Session。
- **MSG-019 [stable]**：Codex、Claude Code与OpenCode MUST共享同一Owner语义和acceptance evidence mapping；若Adapter不能达到S5合同，产品不得继续把该framework标为同等级S5 conformant。
- **MSG-020 [stable]**：S5 MUST有贯通真实Host RPC、durable Owner、root interaction scheduler、Renderer可见Main消息的production-composed Main→child→Main往返，并覆盖receipt、branch、failure window与restart，才能标记`certified`。

## Interface 与语义

### 发送

```js
await host.send_message(target, message, {
  kind?,
  request_id?,
  reply_to_message_id?
})
```

- Main的`target`为`host.delegate/children`返回的direct child `frame_id`；Delegate只能用`"parent"`。
- SDK为省略`request_id`的单次调用建立durable identity；需要跨独立invocation恢复时，caller保留并复用显式`request_id`。
- 返回receipt严格使用`SUB-DEC-0008`的discriminated union；不得用含义不明的单一`attempt_id`或混用camelCase字段。

### 观察

```js
await host.message_receipt(message_id_or_request_id, { timeout_seconds? })
```

- 只允许source caller或当前authorized direct parent控制者读取；authorization不得泄漏其他消息是否存在。
- 每次bounded observation重新验证active branch；授权失效返回authorization error但不改变message。`timeout_seconds`默认30，必须是0到1800的有限数；timeout只返回最新receipt。

### 解除 uncertain fence

```js
await host.resolve_message(message_id, { action: 'acknowledge_uncertain' })
```

- 仅当前active branch root Main可调用。
- 该操作只将`resolution` durable改为`acknowledged`并解除lane fence，不把原消息改成accepted/failed，不重投，也不使新的重复发送变得安全。

### 回复与结果

- `kind:"question"`是消息意图，不是blocking RPC。
- Main使用source Frame ID回复child；child使用`"parent"`回复Main，并可带`reply_to_message_id`。
- 目标执行结果仍通过`collect`或后续Main Message获得，receipt不携带回答。

## 发布切换与持久化

- 当前Subagent消息Interface与记录均未发布，不保留旧输入/结果shape、prototype message migration、双reader、feature flag或pre-S5 backup。
- S5实现将Host SDK、local RPC、Owner、Adapters、tests与help原子切换到统一receipt合同。
- 新写入采用`SUB-DEC-0009`的durable command/receipt；prototype `pendingMessages`不得被解释或重投为S5 command。
- S5 message owner必须可独立quarantine并原样保留corrupt raw envelope；其他Session owner继续正常读写，不因S5 receipt损坏而write-protect整个Session。
- Side chat记录、Artifact、Review、Plan、Permission、Structured Output与Attempt model snapshot不因S5迁移改写。

## Conformance 场景

| 场景                                                                    | 条款              | Gate                          |
| ----------------------------------------------------------------------- | ----------------- | ----------------------------- |
| Main→running child durable queued→provider accepted，单次注入           | MSG-003..009      | Owner + ACP Adapter           |
| child→idle Main带来源唤醒，Main回复同child                              | MSG-001..010、015 | production composition        |
| child→running Main不并发prompt，安全边界后投递                          | MSG-008..010      | root runtime Adapter          |
| 相同command跨process恢复；payload mismatch conflict                     | MSG-004、007      | persistence + Host RPC        |
| pre-acceptance rejection为failed；acceptance commit窗口为uncertain      | MSG-005..008      | failure injection             |
| 同lane FIFO、uncertain head不被越过，acknowledge后只解除fence           | MSG-007..008      | Owner race contract           |
| terminal-before/after commit线性化，continuation startup failure可观察  | MSG-012..013      | Owner + execution Adapter     |
| awaiting permission、Stop、Cancel与late callback                        | MSG-011、014      | permission/Attempt race       |
| branch switch不跨branch投递，切回后恢复                                 | MSG-001..002、010 | active-branch production gate |
| sibling/reviewer/cross-Session/stale/legacy child调用fail-closed        | MSG-001..002      | authorization contract        |
| restart按方向/route恢复；downward interrupted失败、upward未dispatch恢复 | MSG-016           | recovery integration          |
| prototype message不迁移/重投；corrupt S5 owner隔离且其他owner可写       | MSG-017..018      | fixtures + repository         |
| 三framework真实production Adapter acceptance                            | MSG-019           | provider matrix               |
| desktop真实Main→child→Main、root scheduler、receipt、restart journey    | MSG-020           | Playwright release gate       |

MSG-020 gate必须从真实`host.send_message/message_receipt/resolve_message`调用贯通local RPC、durable Owner、Session persistence、child execution、root interaction scheduler与Renderer可见Main continuation；不得用直接替换`parentMessages.deliver`的collector绕过root runtime。Gate至少覆盖两个child与真实user prompt并发仲裁、branch park跨restart恢复、provider call前后与receipt commit前后的故障注入。三framework Adapter可使用project-owned fake process/backend驱动真实production Adapter边界，但必须分别证明`provider_prompt_accepted`、`provider_prompt_completed`、pre-accept failure与uncertain mapping；外部CLI实机覆盖范围在evidence中明确记录。

## 开放决策

无。

## 实现证据

当前candidate已原子切换Host SDK/local RPC到options输入与snake_case receipt，并实现durable command identity、CAS dispatch fence、terminal receipt、same-lane uncertain fence、bounded observation、root-only acknowledge、terminal continuation command/Attempt共同commit、Session restart recovery和message owner quarantine。`DurableDelegatedWork`、Session record adapter、production composition、Host help、local RPC与REPL focused gates已通过。

实现状态为`certified`。消息协议由独立`ReliableMessageDeliveryOwner`与`SessionMessageDeliveryPersistenceOwner`承载，原有composer/facade architecture completion gates已恢复；root user prompt与upward continuation通过同一个`AcpRuntimeCoordinator` admission lock线性化，并在该锁内完成branch重验与dispatch fence。production-composed Playwright release gate在同一次运行中通过全部四项journey：Main→child→Main roundtrip、branch park/restart、provider acceptance后receipt commit失败与restart recovery、两child upward lane和真实user prompt公平仲裁。post-fence fixture使用exact persisted `message_id`执行Main Host receipt observation，Session catalog decode、owner hydration、durable uncertain recovery、真实Host RPC与Renderer-visible Main continuation均已贯通。

当前evidence覆盖：

- MSG-003..008、012..013、015..018：`durable-delegated-work.test.ts`、`session-record-adapter.test.ts`、`delegated-work-records.test.ts`、`message-delivery-owner.ts`与shared exhaustive sanitizer；
- MSG-005..007：`help.test.ts`、`local-rpc-server.delegated-work.test.ts`与`repl-loop.integration.test.ts`；
- MSG-008..010 root安全边界、单一admission lock、branch CAS与weak fairness：`runtime-coordinator.test.ts`、`production-composition.test.ts`及Playwright branch/fairness journeys；
- MSG-019：`production-frameworks.test.ts`逐一经过Codex、Claude Code、OpenCode production factory边界，覆盖prompt accepted、成功完成fallback与pre-accept failure；uncertain由共享durable owner故障注入覆盖。该证据使用project-owned fake backend，不声称外部CLI实机认证；
- MSG-020：`e2e/subagent-release-gate.spec.ts`真实desktop journeys覆盖Main→child→Main receipt、Renderer Main continuation、两upward lanes与真实user prompt、branch park/restart/wake以及post-fence durable receipt失败窗口；四项在同一次production-composed release gate中全部通过，因此作为`certified`证据。

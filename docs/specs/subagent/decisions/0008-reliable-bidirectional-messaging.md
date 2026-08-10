---
decision_id: SUB-DEC-0008
title: Main Agent 与 direct Subagent 的可靠双向消息语义
status: accepted
affects_specs:
  - SUB-MESSAGE-DELIVERY
compatibility: additive
supersedes: []
---

# Main Agent 与 direct Subagent 的可靠双向消息语义

## 背景与当前行为

当前 `host.send_message(target, message, kind?)` 已支持 root Main Agent 向 direct child Frame 发送消息、running Delegate 向 `"parent"` 发送消息，以及向 terminal child 创建同 Frame continuation。Main→running child 先写 `pendingMessages` 后立即返回 `queued`，provider acceptance 在后台发生；child→parent 则同步等待 root runtime `startContinuation()` 到 provider 首次 update 后仍返回 `queued`。两个方向的同名回执因此代表不同事实。

现有 Main→child 后台 delivery failure 不可由 Host caller 观察；幂等只在进程内按 tool invocation 缓存；provider 可能已接受而 receipt 尚未 durable commit 的 crash window 也无法由 `queued/failed` 诚实表达。`sendMessage` 还没有完整复用 `SUB-DEC-0003` 已接受的 active-branch authorization owner，inactive branch child 可能被已知 Frame ID steer，或把上行消息错误注入另一个当前 root branch。

Side chat MCP `send_message` 是 `target:"main"`、advisory-only、next-real-user-turn delivery。它不唤醒、不打断 Main，也不允许回复；该语义不适合作为 delegated parent-child control Interface。

## 决策

1. S5 交付一个可靠双向父子消息能力，而不是只交付 Main→child steering。唯一agent-facing发送Interface继续是`host.send_message`；`host.resolve_message`只写uncertain control resolution，不发送或重投payload。Side chat MCP `send_message`保持独立，不承载Subagent消息。
2. 仅允许同一 Session、同一 active root Message Branch 上的 root Main Agent与其 direct Delegate child通信：
   - Main 使用 direct child Frame ID；
   - current running Delegate Attempt 仅可使用 `"parent"`；
   - sibling、grandchild、reviewer、跨 Session、非 root Main、inactive branch与`legacy-unavailable`均 fail-closed。
3. Main→child 与 child→parent admission MUST 使用 `children/collect/stop` 相同的 active-branch authorization owner。不得只验证 caller、Frame ID存在或 direct-parent 字段。
4. `host.send_message` 的稳定调用形状为：

   ```js
   await host.send_message(target, message, options?)
   ```

   `options`可包含`kind:"info" | "question"`、caller-stable `request_id`和可选`reply_to_message_id`；`kind`默认`"info"`。SDK必须为每次调用建立durable command identity，但只有caller保留并复用显式`request_id`时才承诺跨独立Host invocation恢复。

5. Host 返回 delivery receipt，永远不返回目标回复。receipt 将 route/disposition 与 delivery state 分开，并使用以下 exhaustive agent-facing union；外部字段统一为 snake_case：

   ```ts
   type MessageReceiptBase = {
     request_id: string
     message_id: string
     source_frame_id: string
     target_frame_id: string
     reply_to_message_id?: string
     queued_at: number
     same_request_safe: true
   }

   type MessageRoute =
     | {
         direction: 'to_child'
         disposition: 'message'
         target_attempt_id: string
         source_attempt_id?: never
         continuation_attempt_id?: never
         root_prompt_message_id?: never
       }
     | {
         direction: 'to_child'
         disposition: 'continued'
         continuation_attempt_id: string
         source_attempt_id?: never
         target_attempt_id?: never
         root_prompt_message_id?: never
       }
     | {
         direction: 'to_parent'
         disposition: 'message'
         source_attempt_id: string
         root_prompt_message_id: string
         target_attempt_id?: never
         continuation_attempt_id?: never
       }

   type MessageReceipt = MessageReceiptBase &
     MessageRoute &
     (
       | { status: 'queued'; dispatch_started_at?: number; new_request_retry_safe: false }
       | {
           status: 'accepted'
           accepted_at: number
           evidence: 'provider_prompt_accepted' | 'provider_prompt_completed'
           new_request_retry_safe: false
         }
       | {
           status: 'failed'
           failed_at: number
           error: {
             code: string
             message: string
             retryable: boolean
             delivery_may_have_occurred: false
           }
           new_request_retry_safe: boolean
         }
       | {
           status: 'uncertain'
           uncertain_at: number
           delivery_may_have_occurred: true
           resolution: 'pending' | 'acknowledged'
           new_request_retry_safe: false
         }
     )
   ```

   upward的`root_prompt_message_id`在command admission时分配并固定，后续root runtime必须使用该identity。每个route branch列出的`never`字段 MUST缺失；不得投影未列出的direction/disposition组合，也不得用一个含义不明的`attempt_id`覆盖两个方向。

6. `queued` 只表示 message command、payload、source/target、branch binding、目标 Attempt与lane sequence已原子 durable admission；不表示目标 runtime已接受、已读、已执行或将回复。
7. `accepted` 只表示目标 app-owned runtime/provider 已接受该 payload：provider 已发出 prompt-accepted/首个 update，或一次成功的 target prompt completion 已证明 payload 被执行。`accepted` 不表示理解、采用、完成或回复，且一经 durable commit不得回退。
8. `failed` 只表示系统已证明 payload 未越过 acceptance boundary，并且不会再自动递送。它必须包含 stable error code、`retryable`和`delivery_may_have_occurred:false`；`new_request_retry_safe`必须等于`error.retryable`。
9. provider 可能已接受但 acceptance evidence 未 durable commit时，receipt 必须为 `uncertain`、`new_request_retry_safe:false`、`delivery_may_have_occurred:true`。不得把该状态伪装成`failed`或自动重投。
10. durable command identity作用域固定为`(sessionId, sourcePrincipal, requestId)`：root Main的`sourcePrincipal`是root Frame，Delegate的`sourcePrincipal`是exact source Frame+Attempt。相同identity与相同canonical request必须返回同一`message_id`和最新receipt，不得产生第二个副作用；同identity但target、message、kind或reply correlation不同必须conflict。后续Main Turn可恢复root-owned command；新的Delegate Attempt不能冒充旧Attempt source恢复其command。真正重试一个已证明`failed`的投递使用新的`request_id`，并 MAY 记录 `retry_of_message_id`。
11. caller 可通过只读 `host.message_receipt(selector, options?)` 恢复 receipt；selector接受`message_id`或caller-owned`request_id`。source principal和当前active-branch root Main可读取；`timeout_seconds`默认30，必须是0到1800的有限数。bounded wait每次observation MUST重新验证Session、root/direct-child、source Attempt与branch authorization。等待期间授权失效时调用以authorization error结束，不取消或改写message、Attempt、lane或Main Turn。
12. 同一 `(sourceFrameId, targetFrameId)` lane MUST 按 durable admission sequence开始投递。不同downward lane之间不承诺全局顺序；所有upward lane由第15条的单一root scheduler仲裁。一个`uncertain` head会fence该lane后续自动越过，以免制造无法证明的重排；已证明`failed`的head不阻止后续消息。
13. root Main可通过`host.resolve_message(message_id, { action:"acknowledge_uncertain" })`显式确认uncertain风险并解除lane fence。该操作只允许当前active branch上的root Main，MUST durable记录`resolution:"acknowledged"`，不得声称原消息accepted或failed、不得重投原消息；之后的新消息仍保持`new_request_retry_safe:false`所表达的潜在重复/乱序风险。没有该显式resolution时uncertain head保持fence。
14. 消息只在目标runtime的安全边界投递，不抢占或中断正在执行的provider prompt：
    - Main→running child在当前child prompt yield后按lane顺序开始app-owned continuation；
    - child→Main在root runtime idle时可唤醒一个app-owned continuation；root正在执行时先durable排队，在当前root prompt settle后投递；
    - `info`与`question`使用相同调度，`kind`只影响提示与呈现优先级。
15. 每个Session只有一个root message delivery scheduler。已有active或已经admit的真实用户prompt先完成；root idle后，scheduler按`queued_at`、再按`message_id`从所有eligible upward lane选择最老消息，选择与新的user-prompt admission在线性化锁下互斥，选中后later user prompt不得越过。branch active、无lane fence且root runtime持续可用时，eligible消息 MUST最终开始dispatch；持续不可用必须收口为failed或uncertain，不能无限queued。upward delivery在root Frame、source child的validated root-origin branch上创建app-owned Main continuation/runtime segment，保留source Frame/Attempt/message provenance，不伪装成真实user Message。
16. child→parent消息必须绑定source child的validated root-origin branch，不得在delivery时重绑定到另一个当前root branch。branch activation owner在active branch revision变化与restart hydrate后唤醒scheduler；scheduler在同一root linearization lock内、写dispatch-start fence前重新验证stable branch ID/revision。switch-before-fence使消息park并保持queued；switch-after-fence且acceptance尚不可证明时进入uncertain，不承诺撤回provider side effect。已经inactive后发起的新上行调用fail-closed。
17. 消息admission不得隐式allow、deny或cancel delegated permission。target awaiting permission时保持`queued`；permission settle、Attempt stop或明确delivery failure再推动状态变化。
18. terminal与message admission以同一 command commit线性化：
    - target在commit前已terminal时，`disposition:"continued"`并原子创建同Frame新Attempt；
    - command先commit、target随后terminal时继续保持`disposition:"message"`，不得静默改为continuation；未accepted投递按证据转`failed`或`uncertain`。
19. target在command commit前已terminal时，成功的send admission MUST创建same-Frame continuation。authorization、capacity、cancellation fence、Specialist/model snapshot或workspace admission失败时整条command在任何message/Attempt副作用前失败，不返回queued receipt。`continued`只证明Attempt admission；其workspace/runtime startup与provider acceptance由独立`status`表达。completed、cancelled与error child均遵循本规则。
20. source Turn取消、source Attempt terminal或后续root Turn开始，不撤销已经durable admission的消息；这些事件也不得停止一个旧Turn target Attempt。target stop/cancel只有在Adapter证明未跨acceptance boundary时才可写failed；dispatch已开始但事实不完整时写uncertain。任何late callback都不得把已accepted事实回退。
21. `kind:"question"`不使发送调用等待回答。回答是独立的反向`send_message`；`reply_to_message_id`必须引用已durable admission、同一branch binding、方向相反、source/target互换且`kind:"question"`的消息。最终Subagent结果仍由`collect`读取。
22. 三个production Adapter使用同一evidence mapping：prompt-accepted callback或首个provider update映射`provider_prompt_accepted`；无该事件但prompt成功完成映射`provider_prompt_completed`；可证明在acceptance前拒绝/退出映射failed；调用已经开始且缺少可信acceptance或rejection evidence映射uncertain。Codex、Claude Code、OpenCode必须分别通过该mapping的contract evidence。
23. S5不承诺running provider prompt的字节级即时注入，不重新启用Codex/Claude Code/OpenCode原生nested-agent通信，也不为用户新增Subagent preview composer。Host help、Main runtime收件、receipt可观察性与production-composed desktop journey属于本阶段。
24. 参考实现的4,000字符、每任务32条上行与Side chat的12,000字符均不直接成为S5产品承诺。实现必须使用project-owned Host/RPC与persistence预算并返回可诊断admission error；固定公开quota需要独立证据与后续decision。

## 备选方案

- 复用Side chat MCP：接口较少，但会混合advisory next-user-turn与authenticated parent-child control，且无法表达Attempt、branch、continuation和reply语义。
- 只发布Main→child可靠steering：范围较小，但不能交付用户已要求的双向通信，child question仍会在Main-running场景失败。
- child消息立即抢占Main：延迟低，但改变root Turn terminal、ordering与用户Cancel语义，并受当前单interaction runtime限制。
- 只保留`queued/accepted/failed`三态：界面更简单，但无法诚实表示provider可能已接受、receipt commit失败的窗口，会让“安全重试”成为错误承诺。
- 保留当前`queued | continued`原型shape：改动较少，但会继续混合route admission和runtime acceptance，caller无法判断continuation启动失败。

## 发布与切换

- Subagent尚未发布，当前`host.send_message(target, message, kind?)`与`kind:"queued" | "continued"`结果只是内部原型，不构成兼容性承诺。S5实现直接原子切换到本决策的options输入与`disposition + status` receipt，不维护双shape、deprecation period或feature flag。
- `host.help('send_message')`和`host.help('message_receipt')`必须成为machine-readable正式合同；notebook system prompt只保留导航性说明。
- `host.help('resolve_message')`必须明确该操作只解除uncertain lane fence，不改变或重试原delivery事实。
- 已接受的`SUB-DEC-0003` active-branch control与`SUB-DEC-0004` Turn-scoped cancellation继续有效；本决策深化receipt和delivery，不放宽topology或branch access。
- durable command、crash recovery与corrupt-data isolation由`SUB-DEC-0009`治理。

## Conformance 场景

1. Main→running child先返回durable `queued`；provider acceptance后按同一`message_id`观察为`accepted`，runtime只收到一次。
2. child→idle Main先durable admission，再启动带source Frame/Attempt/branch provenance的app-owned continuation；receipt不是Main回复。
3. child→running Main保持queued，不触发并发prompt错误；root prompt settle后按lane顺序accepted，Main可用`reply_to_message_id`回复同一child。
4. 同`request_id`相同payload在response丢失后返回同receipt；不同payload conflict且无第二条message。
5. provider明确pre-acceptance reject为`failed`；provider可能已接受而receipt commit失败为`uncertain`，两者均不自动重复投递。
6. 两条同lane消息按durable sequence开始；第一条uncertain时第二条不得越过。
7. target terminal-before-commit创建same-Frame continuation；commit-before-terminal不改变disposition。
8. awaiting permission不被消息隐式响应；permission settle后消息继续，Stop则按证据进入failed/uncertain。
9. branch A消息admission后切到B不会注入B；切回A后恢复。B上的Main和A-child新调用均不能绕过authorization。
10. sibling、grandchild、reviewer、跨Session、inactive branch、stale Attempt和legacy-unavailable调用统一fail-closed且不泄漏目标状态。
11. Cancel source Turn不撤销已admit steering，也不停止旧Turn target Attempt；target Cancel fences late receipt但不回退accepted。
12. 一个uncertain head阻止同lane后续消息，root Main显式acknowledge后解除fence但原receipt仍不声称accepted/failed。
13. 两个child同时上行且用户同时发送时，共享root scheduler按已接受的linearization规则选择，消息不会饥饿且provenance归正确root branch/runtime segment。
14. branch switch与dispatch fence竞态分别覆盖switch-before-fence park、switch-after-fence uncertain，以及restart后切回原branch恢复。
15. Host help精确描述queued/accepted/failed/uncertain、continued、receipt observation、uncertain resolution、reply和错误语义。

## 后续影响

- `SUB-MESSAGE-DELIVERY`必须把本决策映射到`DurableDelegatedWork`、内部delivery owner、`DelegateExecution`与root runtime Adapter。
- Renderer可在后续阶段加入用户直接steer/reply UI，但不得创建第二套消息Owner或不同receipt语义。
- provider若未来提供带stable operation ID的true running-turn injection，可作为新的Adapter能力深化，但不得改变本决策的receipt含义与ordering。

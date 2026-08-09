---
decision_id: SUB-DEC-0004
title: 并发 Turn 下的 Turn-scoped Cancel 与 branch-scoped Stop
status: accepted
affects_specs:
  - SUB-DELEGATE-WAIT
compatibility: persistence-impact
supersedes: []
---

# 并发 Turn 下的 Turn-scoped Cancel 与 branch-scoped Stop

## 背景与当前行为

当前 Renderer 在任何 child running 时用 Cancel 替换 Send；底层实际上允许 idle root 开启新 Turn，键盘提交甚至可能绕过可见 gate。当前 `cancelPrompt` 又会调用 Session-wide delegated stop，取消该 Session 的全部 running children。

bounded delegate wait 允许 Turn A 正常结束而 child 继续。开放 Turn B 后，Session-wide cascade 会让用户取消 Turn B 时误杀 Turn A 的后台研究；这是需要修正的既有产品 bug，而不是必须保留的兼容行为。

## 决策

1. root Main idle 且有 running children 时，Composer MUST 同时提供正常 Send 与独立的 “Stop subagents” 控制。鼠标与 Enter 提交 MUST 使用同一 admission gate。
2. “Cancel run” MUST 是 Turn-scoped：取消当前 root Attempt，以及当前 running Attempt 由该 Conversation Turn 发起的 children。
3. child Attempt 的 initiating Turn 决定 Cancel 归属：
   - 当前 Turn 新建的 child initial Attempt MUST 被取消；
   - 当前 Turn 在旧 Frame 上创建的 continuation Attempt MUST 被取消；
   - 旧 Turn 发起、仅被当前 Turn collect 或 steer 的 running Attempt MUST 继续运行。
4. 每个新 admission 的 child Attempt MUST durable关联唯一的 initiating root Message/Conversation Turn。initial Attempt和continuation Attempt都必须在admission commit时建立该关联；后续steer不得改写。具体字段名属于Implementation，但关系不得靠user Message数组位置推断。
5. 对缺失initiating Turn的旧terminal Attempt无需backfill；升级后仍running的旧Attempt按restart recovery收口。旧Frame上的新continuation MUST 写入新关联。
6. Turn Cancel acceptance MUST 先为current Turn建立cancellation fence，再与child admission线性化：fence前已admit的本TurnAttempts必须停止；fence后同Turn initial/continuation admission必须拒绝，不能逃逸成running。旧TurnAttempts不受该fence影响。
7. Turn-scoped child cancellation MUST 使用 `main_agent_stop`；不得伪装成 Session stop。
8. “Stop subagents” MUST 在一个authenticated snapshot固定当前active branch identity与当时的running direct-child Attempt集合，随后只停止该集合；branch切换或新admission不得重定向/扩大targets。inactive branch children MUST 不受影响。
9. branch Stop各target结果可独立成功或失败，不承诺all-or-nothing rollback。成功终态保留；失败项可根据最新`children()`重试。UI MUST 呈现aggregate failure而不是回滚成功项。
10. Session 删除、graceful应用关闭或明确的 Session-wide stop MUST 停止该 Session 的所有 running children并使用 `session_stop`。crash/restart recovery使用`runtime_interrupted`。
11. branch-scoped Stop pending 时，Send/Enter MUST 暂时禁用，直到 Stop settles；失败后 MUST 恢复发送并显示错误。
12. delegated permission pending MUST NOT 阻止用户开启下一 Conversation Turn。Stop未pending时，Permission card、Send 与 Stop control MUST 可同时存在。
13. normal Turn completion 和 Delegated Wait expiry MUST NOT 触发任何 child cancellation。

## 备选方案

- 保持 Session-wide Cancel cascade：实现改动最少，但在并发 Turn 下会误杀旧 Turn 后台工作。
- Cancel 只取消 root、不取消当前 Turn children：可能留下用户明确终止的当前任务继续写入。
- 只有 Send、移除 Stop：后台 child 失去可达的安全控制。
- Stop 覆盖所有 branches：与 active-branch authorization 不一致，并会停止当前不可见工作。
- delegated permission 阻止新 Turn：让 parked child 再次阻断整个 Session，削弱 bounded wait 的价值。

## 兼容与迁移

- 新写入需要stable durable Attempt→initiating Turn关系，属于additive persistence impact。实现可增加最小identity字段或提供同等可靠的durable link，但不得按user Message数组序号推断。
- old-data读取必须兼容缺失关系：历史terminal Attempt保持可读；升级启动时遗留running Attempt先按`runtime_interrupted`收口；升级后的新initial/continuation Attempt必须写入关系。无需不可靠backfill，但必须有old-data fixtures与rollback说明。
- Renderer、Runtime Coordinator 与 Delegated Work stop owner 必须原子切换；只改按钮而保留 Session-wide cascade 不符合本决策。
- 现有 Session-wide Cancel characterization tests需要由 Turn-scoped与显式 Session-stop测试替代。
- rollback 会恢复误杀旧 Turn child 的已知 bug，不能视为无风险 UI 回退。

## Conformance 场景

1. A 结束且 A-child running 时，Composer 同时显示 Send 与 Stop；点击和 Enter 都能开启 B。
2. B active 时 Cancel：B root、B initial child 和 B continuation Attempt取消；A running Attempt继续。
3. B 只 steer A running Attempt 后 Cancel，A Attempt继续。
4. branch Stop只停止当前 active branch running children，inactive branch保持运行。
5. Stop pending 时点击或 Enter 均不能 admission 新 Turn；Stop失败后恢复。
6. A-child awaiting permission时，permission card、Send、Stop共存，B可开始。
7. Cancel acceptance与initial/continuation admission竞态：fence前admit的B Attempt被停止，fence后admission拒绝，A Attempt继续。
8. branch Stop固定一个snapshot中的target Attempts；随后切branch或新admission不改变targets；partial failure保留成功并可重试失败项。
9. graceful app/session shutdown全量停止并写`session_stop`；crash/restart写`runtime_interrupted`。

## 后续影响

- S2 必须包含 Renderer interaction test 与 production-composed E2E，不能只做 Host unit tests。
- 若以后提供 per-child UI Stop，应复用 active-branch authorization和 `main_agent_stop`，不得重新引入 Session cascade。

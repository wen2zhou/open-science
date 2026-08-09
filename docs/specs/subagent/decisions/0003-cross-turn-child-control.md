---
decision_id: SUB-DEC-0003
title: active Message Branch 上的跨 Turn child 控制权
status: accepted
affects_specs:
  - SUB-DELEGATED-WAIT
  - SUB-DELEGATE-WAIT
compatibility: behavior-change
supersedes: []
---

# active Message Branch 上的跨 Turn child 控制权

## 背景与当前行为

Delegate Agent Frame 持久化 `parentFrameId`、`originMessageId` 和自己的 `activeBranchId`。当前 Read Model 验证 caller 是同 Session 的 root Main Agent，并且 caller 的 origin Message 位于当前 root path；选择 child 时只检查 direct-child 关系，没有检查 child 的 `originMessageId` 是否仍在当前 root path。因此，知道 Frame ID 的合法 root caller 当前可能访问 inactive branch 创建的 child。

跨 Turn bounded wait 的常见场景要求 Turn A 正常结束后，Turn B/C 能继续观察和控制 Turn A 留下的 child。该能力不能隐式扩大为跨 Session 或跨 inactive branch 的控制权。

## 决策

1. child 的 durable identity 和生产归属仍是其 Delegate Agent Frame 与 Attempts；control owner 是同一 Session、当前 active Message Branch 上的 root Main Agent。
2. 后续 Conversation Turn 只有在 child 的 `originMessageId` 仍位于当前 root active branch ancestry 时，才可 `collect`、`children`、`stop`、`send_message` 或创建 terminal continuation。
3. 用户切到另一 Message Branch 后，旧 branch child MUST 不可发现、读取或按 Frame 控制；切回原 branch 后访问恢复。
4. 跨 Session、delegate/reviewer caller、非 root Frame 和非 direct child MUST fail-closed。
5. in-flight `collect` 的每次 observation snapshot MUST 重新验证 caller 与 child 的 active-branch authorization。等待期间授权失效时，整批调用 MUST 以 authorization error 结束，且 MUST NOT 停止 child。
6. Turn B 对 Turn A child 的 `collect` 是纯读取，MUST NOT reparent Frame、改变 Attempt、复制 terminal Message、转移 Artifact ownership，或新增 durable consumption relation。
7. Turn B 基于 collected evidence 生成的新 Message 或 Artifact 归 Turn B；原 child Artifact 与 Provenance 继续归原 child Frame/Attempt/terminal Message。
8. active branch 上的后续 root Turn 拥有完整 control 权；S5 可深化消息 delivery receipt，但不得把基础跨 Turn control 改为 originating-Turn-only。
9. `host.children()` MUST 成为丢失当前 handles 后的恢复渠道：从一次 authenticated snapshot 列出当前 active branch 的全部 direct children，包括 running 与 terminal，保持全 Session durable admission 顺序的 active-branch 子序列。每项至少包含 current Attempt 的 `frame_id`、`attempt_id`、`name`、`agent_name` 和粗粒度 `status`。
10. `host.children()` 只恢复调用时的 current Attempt inventory；MUST NOT 宣称能恢复历史 Attempt handle 或丢失响应对应的原 delegation batch correlation。
11. delegated permission 的 projection 与 response MUST 使用相同 active-branch authorization。branch 切换后旧 branch permission card MUST 消失，旧 request response MUST fail-closed；切回时若请求仍 pending，card MAY 恢复。
12. `originBindingState:"legacy-unavailable"` 或缺失 `originMessageId` 的历史 child 无法证明 branch ownership，Host discovery、collect 与control MUST fail-closed并返回可诊断的安全错误。不得猜测或按 Session-root 放行。
13. app restart 后的访问继续遵循 durable recovery 结果；本决策不承诺运行中的 child 跨重启继续执行。

## 备选方案

- Session-root 全局控制：实现最接近当前选择逻辑，但会让 inactive branch caller 访问隐藏 child，并与 Artifact branch visibility 不一致。
- originating-Turn-only：无法满足后续 Turn 收集和控制的核心场景。
- bearer capability handle 绕过 branch：可精确授权，但需要新的 durable grant、恢复和撤销模型。
- collect-only 跨 Turn：后续 Turn 能看到失控 child 却不能停止或纠正它，控制模型不完整。

## 兼容与迁移

- 新格式无需新增 branch 字段；active root ancestry 可由现有 Conversation Graph 与 child `originMessageId` 计算。
- 不对 `legacy-unavailable` 历史 Frame 做不可靠 backfill。旧数据继续可由历史 UI读取，但无法通过Host child-control Interface访问；必须保留old-data fixture和用户可诊断错误。
- 这是对当前可能存在的 cross-branch access 的授权收紧。Read Model、`children`、stop/send/continuation 必须使用同一 authorization owner，避免不同 Host 操作范围漂移。
- child 自己的 `activeBranchId`/`messageBranchId` 不是 root origin branch ID；实现不得用错 branch 层级。
- rollback 不影响 durable data，但会重新放宽 inactive branch 访问，属于安全语义回退。

## Conformance 场景

1. Turn A timed wait 返回 running；A 正常结束；同 branch Turn B 用新 trusted invocation 收集同一 Attempt。
2. Turn B 可 stop、steer 或 continue A 的 child，且 caller source 记录为对应 Turn，不转移原 Frame ownership。
3. edit/resend 切到新 branch 后，旧 child 从 `children()` 消失，直接 selector 整批 authorization failure；切回后恢复。
4. branch 在 bounded `collect` 等待期间切换，调用失败但 child 继续。
5. 其他 Session、非 root caller、reviewer/delegate 和 sibling Frame 均不能访问。
6. Turn B collect 后，原 child Artifact/Provenance 未改挂；B 的新产物归 B。
7. branch切换隐藏delegated permission card并使stale response fail-closed；切回后仍pending的card恢复。
8. `legacy-unavailable` child通过Host control fail-closed，旧Session其余数据仍可读取。

## 后续影响

- S1 的 production-composed gate必须独立验证read-side active-branch过滤与in-flight branch-switch race，不依赖跨Turn Composer UI。
- S2 的production-composed gate必须使用两个不同root origin Messages和两个trusted control invocations，并验证完整跨Turncontrol。
- Renderer 的 Subagents projection 与 Stop 控制必须按 active root branch 过滤。
- 跨 Session handoff、bearer capabilities 和 durable consumption relation仍是独立产品问题。

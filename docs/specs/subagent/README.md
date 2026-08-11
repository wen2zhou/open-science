# Subagent 开发任务索引

本文件是跨 Codex session 使用的轻量导航，不是规范性产品契约。具体行为、兼容性和 conformance 场景以对应的 `accepted` feature spec 或 decision 为准。

## 功能目标

Subagent 功能的目标，是让 Main Agent 能把可独立执行的工作可靠地委派给一个或多个隔离的 Subagent，同时始终知道工作处于什么状态、能够继续控制它们，并能稳定收回可消费的结果。

完整能力应支持以下用户工作流：

1. Main Agent 将一项工作拆成一个或多个子任务，并为每个子任务指定输入、Specialist 和可选模型；未显式指定 Specialist 时，可以按已接受的产品决策继承父 Specialist。
2. 系统原子地接纳一批子任务：要么全部创建，要么全部不创建。超过即时执行容量的任务可以可靠排队，而不是因临时无空位而丢失。
3. Main Agent 可以立即返回继续工作，也可以等待一段有限时间；等待超时只结束本次等待，不取消仍在运行的 Subagent。
4. Main Agent 可以观察每个子任务是排队中、运行中、等待权限、已完成、已停止、执行失败或因重启中断，并在稍后继续收集结果。
5. Main Agent 可以向运行中的 Subagent 补充或纠正指令，确认消息是否已被 runtime 接受，并在需要时停止任务或继续已结束的任务。
6. Subagent 返回文本、Artifact，以及可选的、经过校验的 structured output；调用方可以依赖稳定的顺序、身份和持久化语义处理结果。
7. 系统限制失控的扇出，并提供可信的 token usage；只有存在可信价格来源时才计算或承诺 cost。

这些能力不要求一次性交付。每个阶段必须形成一个可独立使用、可回归验证、可安全停止开发的纵向增量；未完成的后续阶段不得削弱已经验收的行为。

## 目标用户工作流

```text
拆分任务
  → 原子委派一批 Subagent
  → 立即返回或有限等待
  → 观察排队、运行、权限和终态
  → 补充指令、停止或继续
  → 收集文本、Artifact 和结构化结果
  → 查看历史、用量与剩余额度
```

这条流程是长期产品方向，不是单次 release gate。任一阶段只需把其中一个可观察行为从外部 Interface 到必要 Adapter、持久化和测试完整接通。

## 当前已有基础

以下能力已有实现，本计划在其上增量开发，而不是重建整套 delegated-work：

- Main Agent 可以单个或批量委派 direct child，批量 admission 保持全有或全无；
- 支持阻塞等待和 `wait: false`，并可通过 `children`、`collect` 读取 child；当前 `collect` 等待没有时间上限；
- 支持 Main Agent 与 child 消息、停止、terminal continuation 和权限提升；
- Frame、Attempt、消息和 Specialist snapshot 已持久化，重启会将遗留的 running Attempt 收口为中断终态；
- child 使用隔离 workspace 和不可变输入，并能投影 transcript、Artifact 和 Review；
- 只允许 root Main 管理自己的 direct children，nested delegation 仍被禁止。

具体阶段在进入设计时必须用代码和测试重新核实现状；本节只用于界定开发起点，不替代 feature spec。

## 状态含义

- 决策状态：`exploratory`、`proposed`、`accepted`、`superseded`。
- 实现状态：`not-started`、`partial`、`conformant`、`certified`。
- “候选 Module”表示 seam 尚未由真实变化和测试证明，讨论阶段不得提前创建空抽象。

## 当前建议

S1、S2与S5均已通过各自production-composed release gate并达到`certified`；S2真实desktop journey覆盖inactive-branch Stop、partial failure、Send gate恢复与失败项重试。S5同一次组合gate覆盖Main→child→Main、branch park/restart、post-fence receipt commit failure/restart recovery，以及两child upward lane与真实user prompt公平仲裁，并贯通真实Host RPC、durable Owner、root scheduler和Renderer-visible Main continuation。S10已在同一可靠消息production journey上证明child question durable command可投影为active-branch inline行，达到`certified`。S4的production-composed release gate已通过，accepted Interface与Adapter行为达到`conformant`；required完整lint仍有未修改基线blocker，因此暂不标记`certified`。S6的JSON Schema/submission语义与Message evidence rollback decisions已`accepted + conformant`。S11已实现48-code-point、current-branch uniqueness与actionable error合同，达到`conformant`。不得把S3及后续行为并入S2、S4、S5、S6或S11。

当前 decisions：

- `decisions/0001-default-subagent-identity.md`（`accepted`）：省略`profile`时继承受信任父runtime的Specialist stable ID；
- `decisions/0002-bounded-wait-interface.md`（`accepted`）：timeout、默认值与 observation response shape；
- `decisions/0003-cross-turn-child-control.md`（`accepted`）：active Message Branch 上的跨 Turn control；
- `decisions/0004-turn-scoped-cancellation.md`（`accepted`）：并发 Turn 下的 Cancel 与 Stop topology。
- `decisions/0005-attempt-turn-link-rollback.md`（`accepted`）：initiating Turn durable association采用version-gated rollback。
- `decisions/0006-structured-output-interface.md`（`accepted`）：schema、child submission、result与terminal语义；
- `decisions/0007-structured-output-persistence.md`（`accepted`）：Attempt归属、old-data与rollback。
- `decisions/0008-reliable-bidirectional-messaging.md`（`accepted`）：父子双向消息、receipt、root scheduler与failure evidence。
- `decisions/0009-message-delivery-persistence.md`（`accepted`）：durable command、dispatch fence、restart与owner quarantine。
- `decisions/0010-subagent-name-policy.md`（`superseded`）：旧的 optional/automatic name 行为。
- `decisions/0011-required-non-emoji-subagent-name.md`（`superseded`）：旧的80-code-point与parent-lifetime唯一性。
- `decisions/0012-branch-scoped-actionable-subagent-names.md`（`accepted`）：name必填、48-code-point、禁止emoji、当前branch唯一与actionable error。

## 任务地图

| ID  | 阶段                               | 本阶段交付给用户的能力                                                               | 决策状态      | 实现状态      | Owner Module / Seam                                                             | 前置依赖                                   | 计划文档                                                                |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------ | ------------- | ------------- | ------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| S1  | Bounded `collect`                  | Main Agent 在同一 Turn 内有界观察结果、跨 cells 再收集；后台 child 不被取消          | `accepted`    | `certified`   | 现有 `DelegatedWorkReadModel`；外部 `DurableDelegatedWork.collect` Interface    | `SUB-DEC-0002..0003`                       | `delegated-wait.md`                                                     |
| S2  | Bounded `delegate` wait            | 有界委派后可结束当前 Turn；后续 Turn 可继续控制 child，Cancel 不误杀旧 Turn 工作     | `accepted`    | `certified`   | 现有 `DurableDelegatedWork` 与 Read Model                                       | S1、`SUB-DEC-0002..0005`                   | `delegate-wait.md`                                                      |
| S3  | Lifecycle observation              | 调用方能可靠区分排队、运行、等待权限、各类终态与重启中断                             | `exploratory` | `not-started` | 现有 Read Model 与 `DelegatedWorkProjectionOwner`                               | S1 的状态投影约定                          | `lifecycle-observation.md`                                              |
| S4  | 省略 `profile` 时继承父 Specialist | 未显式选择 Specialist 的 child 按 accepted decision 继承父 Specialist                | `accepted`    | `conformant`  | 现有 `DelegatedWorkAdmissionPolicy`                                             | `SUB-DEC-0001`                             | `decisions/0001-default-subagent-identity.md`、`identity-resolution.md` |
| S5  | 可靠双向父子通信                   | Main与direct Subagent可双向发送、回复并恢复 queued/accepted/failed/uncertain receipt | `accepted`    | `certified`   | `ReliableMessageDeliveryOwner`、Session persistence owner与两方runtime Adapters | `SUB-DEC-0003..0004`、`SUB-DEC-0008..0009` | `message-delivery.md`                                                   |
| S6  | Structured output                  | child 可返回经过 schema 校验、可被程序直接消费的结果，同时保留文本和 Artifact        | `accepted`    | `conformant`  | 现有 `DurableDelegatedWork`；内部 Structured Output Module                      | S1、`SUB-DEC-0006..0007`                   | `structured-output.md`                                                  |
| S7  | Durable Scheduler                  | 大批 child 可先可靠接纳再按容量执行；排队任务在重启后仍可观察、取消和调度            | `exploratory` | `not-started` | 候选 Scheduler Module                                                           | S3 lifecycle 语义                          | `scheduler.md`                                                          |
| S8  | Per-task model routing             | Main Agent 可为每个子任务选择模型，实际解析结果随 Attempt 稳定记录                   | `exploratory` | `not-started` | Admission Policy 与 runtime Adapter                                             | identity/model snapshot 决策               | `model-routing.md`                                                      |
| S9  | Role-aware Host SDK discovery      | Main与child都能发现完整Subagent操作目录、准确权限与调用合同，且child正式能力可达     | `accepted`    | `conformant`  | 现有 `HostSdkHelpRegistry`；Notebook capability/REPL Adapters                   | S1、S2、S5、S6 已接受合同                  | `host-sdk-discovery.md`                                                 |
| S10 | 上行消息 inline 展示               | 用户在 Main 对话时间线中看到 direct Subagent 的提问或信息，并可进入来源 Subagent     | `accepted`    | `certified`   | `WorkspaceConversationItems`；Renderer transcript consumer                      | S5 durable message command                 | `inline-parent-messages.md`                                             |
| S11 | 必填、简短、非 emoji 且branch唯一  | 每个child显式命名；48-code-point、当前branch可区分并给出可修正错误                   | `accepted`    | `conformant`  | `DelegatedWorkAdmissionPolicy`；Session persistence command                     | `SUB-DEC-0012`                             | `subagent-naming.md`                                                    |

Host SDK、local RPC、持久化和 Renderer 是每个纵向阶段的 Adapter 或 consumer。它们应随对应能力接线和验收，不作为等待所有 Module 完成后的统一集成 wave。

## 阶段完成定义

一个阶段只有同时满足以下条件，才能从 `partial` 进入 `conformant`：

- 用户可观察能力和非目标已写入中文 `accepted` spec；
- 行为从外部 Interface 接通到该阶段需要的 Adapter 和持久化边界；
- conformance 场景、相关回归测试和变更影响要求的 stage gate 已通过；
- 旧行为的兼容性或明确迁移方案已验证；
- 后续阶段可以在不读取本文件之外历史讨论的情况下，从 task index、spec 和代码继续开发。

`certified` 表示又通过了该阶段定义的发布级检查。它不要求 S1–S8 全部完成。

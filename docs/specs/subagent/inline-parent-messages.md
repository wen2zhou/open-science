---
spec_id: SUB-INLINE-PARENT-MESSAGES
title: Subagent 上行消息在 Main 对话中的 inline 展示
decision_status: accepted
implementation_status: certified
compatibility: additive
owner_module: WorkspaceConversationItems
supersedes: []
last_verified_sha:
---

# Subagent 上行消息在 Main 对话中的 inline 展示

## 用户场景

Subagent 通过 `host.send_message("parent", ...)` 向 Main Agent 补充信息或提问后，用户可以在当前 Main 对话时间线中直接看到消息来源、意图与正文，并可进入对应 Subagent 的只读预览查看上下文。用户不需要从 Main 后续回复中猜测是哪一个 Subagent 发来了什么内容。

## 范围与非目标

本阶段包含：

- 将 active root Message Branch 上 direct Subagent 的 durable `to_parent` message command 投影为 Main 对话 inline 行；
- 区分 `question` 与 `info` 的可访问标题和视觉语义；
- 从 inline 行打开来源 Subagent 的现有只读预览；
- Renderer projection、组件与 focused consumer tests。

本阶段不包含：

- 用户在 inline 行内直接回答 Subagent，回复仍由 Main Agent 通过既有 `host.send_message` 完成；
- 在 inline 行展示 receipt 状态；当前 Renderer 没有订阅完整 receipt 更新，初始 `queued` 容易形成误导，状态 evidence 仍保留在 durable command；
- 把 receipt 当成 Main 的回答或自动隐藏 Main 后续回复；
- `host.submit_output`、Attempt terminal text、Artifact 或 structured output 的 inline 结果卡片；这类终态结果以后若展示，应采用可折叠的 completed/result 摘要，而不是 question 样式；
- Main→child message、sibling、grandchild、Reviewer 或 Side Chat 消息；
- 新的消息持久化、migration、notification 或 lifecycle taxonomy。

## 当前行为

- `SUB-MESSAGE-DELIVERY` 已将 child→Main message command、来源 Frame/Attempt、`kind`、正文、root Branch binding 与 receipt durable 保存到 `Session.runtimeContext.delegatedWork.messageCommands`。
- root runtime 使用 `suppressUserMessage: true` 消费上行消息；Renderer 通过 durable command 在 Main 对话中补充触发该 continuation 的 Subagent 原文。
- Renderer 已有 Session-scoped Subagents bar 与只读预览；Subagent transcript 复用通用 scroller，因此 inline projection 必须以 active root Frame 显式限定 Main 页面。
- 参考图的 question 卡片只作为目标视觉方向，不覆盖本项目已接受的 receipt、active Branch 与 Subagent preview 语义。

## 规范性契约

- **INLINE-MSG-001 [stable]**：Renderer MUST 仅在 Main Agent 会话页面投影 `direction:"to_parent"`、`disposition:"message"` 且绑定当前 active root Message Branch 的 durable command；Subagent 会话页面、inactive Branch、downward message 与无效 direct-child source MUST fail-closed 不展示。
- **INLINE-MSG-002 [stable]**：每个符合条件的 durable command MUST 在 Main 对话时间线中恰好出现一次，并按 `queuedAt` 与现有对话项稳定排序；restart 或 receipt 更新不得生成重复行。
- **INLINE-MSG-003 [stable]**：inline 行 MUST 展示来源 Subagent 的用户可读名称与完整消息正文；正文初始预览 MUST 最多显示 6 行，且仅在实际溢出时提供可访问的展开/折叠控制；`question` 标题 MUST 表达“asked a question”，`info` 标题 MUST 表达“sent a message”，不得展示内部 Frame/Attempt ID 作为正常标题。
- **INLINE-MSG-004 [stable]**：inline 行 MUST NOT 展示 durable receipt 状态；Renderer 未同步完整 receipt 更新时不得将初始 `queued` 暗示为当前状态。该限制 MUST NOT 删除或改写 durable command 中的 receipt evidence。
- **INLINE-MSG-005 [stable]**：用户激活 inline 行的来源 affordance 时 MUST 打开同一 Session 中 exact source Frame 的现有只读 Subagent preview；该操作 MUST 不发送消息、不改变 Attempt，也不创建新的 preview identity。
- **INLINE-MSG-006 [stable]**：inline 行 MUST 提供可访问名称和键盘可达的 preview、展开与折叠 affordance。
- **INLINE-MSG-007 [stable]**：本阶段 MUST 只消费既有 durable message command，不改变 `SUB-MESSAGE-DELIVERY` Interface、receipt、authorization、ordering 或持久化 shape。

## Interface 与语义

Renderer 输入是现有 `PersistedChatSession`：

```ts
session.runtimeContext?.delegatedWork?.messageCommands
session.conversationGraph
```

projection 使用 `messageId` 作为稳定行 identity、`queuedAt` 作为时间线时间，并从 `sourceFrameId` 解析 direct Delegate Frame 名称。`conversationGraph.activeFrameId` MUST 等于 `rootFrameId`，避免同一 durable command 出现在 Subagent transcript。receipt 仍由消息可靠性 Owner 持久化，但不进入 inline presentation projection。

inline 行是只读 evidence。点击来源 affordance 复用 `createSessionSubagentsPreviewItem(session.id, session.projectId, sourceFrameId)`，不新增消息发送或回答 Interface。

## 兼容性与持久化

本阶段为 additive Renderer consumer。无 schema、migration 或 durable write 变化。rollback 可仅移除 projection 与组件；既有 message command、Main continuation 与 Subagent preview 均保持可用。

## Conformance 场景

| 场景                                                                                            | 条款                     | Gate                            |
| ----------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------- |
| active Branch 的 question 在 Main 页面显示来源与正文且只出现一次；超长正文默认 6 行并可完整展开 | INLINE-MSG-001..004      | projection + Renderer component |
| info 与 question 使用准确的标题语义，且不展示 receipt 状态                                      | INLINE-MSG-003..006      | Renderer component              |
| Subagent 页面、inactive Branch、to_child 与非法 source 不投影                                   | INLINE-MSG-001、007      | projection                      |
| receipt 更新与 restart hydration 保持同一 `messageId` 行，且不进入 presentation projection      | INLINE-MSG-002、004、007 | projection + Session fixture    |
| 键盘激活来源 affordance 打开 exact Subagent preview                                             | INLINE-MSG-005..006      | Renderer interaction            |
| 已有 Chat Message、Activity 与 Subagent preview 回归不变                                        | INLINE-MSG-002、005、007 | focused consumer regression     |

## 开放决策

无。`submit_output` inline result 属于后续独立阶段，不在本阶段暗含决定。

## 实现证据

当前 uncommitted candidate 基于 `d5019d9a`，实现状态为 `certified`。

实现以现有 Renderer consumer 为边界：`projectInlineParentMessages` 仅在 active Frame 为 root 时，从 durable command 与 active root Branch fail-closed 投影来源、正文和意图；`WorkspaceConversationItems` 将稳定 `messageId` 行并入 Main 时间线；`WorkspaceSubagentMessageRow` 使用参考图方向的分区卡片展示 question/info，并通过现有 preview identity 打开 exact source Frame。receipt 不进入 presentation projection。Artifact Provenance 明确排除这种会话控制行。Host Interface、runtime、持久化 shape 与 fixture 行为均未改变。

最终 evidence：

- `INLINE-MSG-001..007` focused projection/component/consumer：`npx vitest run src/renderer/src/pages/workspace/workspace-conversation-items.test.ts src/renderer/src/pages/workspace/WorkspaceSubagentMessageRow.test.tsx src/renderer/src/pages/workspace/workspace-tool-activity-groups.test.ts src/renderer/src/pages/workspace/WorkspaceMessageScroller.interaction.test.tsx src/renderer/src/pages/workspace/SubagentReleaseSurfaces.render.test.tsx src/renderer/src/pages/workspace/subagent-release-projection.test.ts` → 6 files、84 tests passed；
- Renderer type contract：`npm run typecheck:web` → passed；
- affected source standards：`npx eslint e2e/subagent-release-gate.spec.ts src/renderer/src/pages/workspace/WorkspaceSubagentMessageRow.tsx src/renderer/src/pages/workspace/WorkspaceSubagentMessageRow.test.tsx src/renderer/src/pages/workspace/subagent-release-projection.ts src/renderer/src/pages/workspace/workspace-conversation-items.test.ts` → passed；
- production desktop composition：`npm run build:e2e` → passed；
- `INLINE-MSG-001..005` 真实 child question、Host RPC、durable command、root scheduler 与 Renderer inline：`npx playwright test e2e/subagent-release-gate.spec.ts --grep "routes reliable Main and child messages through production Host RPC and the root scheduler"` → 1 passed；
- final whitespace gate：`git diff --check HEAD` → passed。

未覆盖风险：未执行独立的深色主题、窄屏或逐像素视觉回归；组件使用现有 semantic/workspace tokens、键盘 Button 与 production desktop DOM assertion 降低该风险。`submit_output`/terminal result inline 仍是明确非目标。

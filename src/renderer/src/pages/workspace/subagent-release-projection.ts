import type { AcpPermissionRequest } from '../../../../shared/acp'
import {
  projectConversationMessage,
  resolveMessageBranchPath,
  type PersistedAgentFrame
} from '../../../../shared/conversation-graph'
import type {
  DelegatedMessageCommand,
  DelegatedWorkAttemptRecord,
  PersistedChatMessage,
  PersistedChatSession
} from '../../../../shared/session-persistence'
import type { AgentFrameworkId, AgentFrameworkView } from '../../../../shared/settings'

type SubagentRawStatus = PersistedAgentFrame['status']

type SessionSubagentChild = Readonly<{
  frameId: string
  title: string
  agentLabel: string
  status: SubagentRawStatus
  awaitingPermission?: boolean
}>

type SessionSubagentProjection = Readonly<{
  runningCount: number
  children: readonly SessionSubagentChild[]
}>

type SubagentFrameProjection = Readonly<{
  frameId: string
  title: string
  agentLabel: string
  status: SubagentRawStatus
  attempt?: DelegatedWorkAttemptRecord
  messages: readonly PersistedChatMessage[]
}>

type InlineParentMessageProjection = Readonly<{
  messageId: string
  sourceFrameId: string
  sourceName: string
  kind: DelegatedMessageCommand['kind']
  text: string
  queuedAt: number
}>

type DelegatedWorkAvailability =
  Readonly<{ available: true }> | Readonly<{ available: false; title: string; description: string }>

const resolveActiveRootMessageIds = (
  graph: NonNullable<PersistedChatSession['conversationGraph']>
): ReadonlySet<string> | undefined => {
  const root = graph.frames.find((frame) => frame.id === graph.rootFrameId)
  if (!root) return undefined
  try {
    return new Set(resolveMessageBranchPath(graph, root.activeBranchId).map(({ id }) => id))
  } catch {
    return undefined
  }
}

const latestAttempt = (
  session: PersistedChatSession,
  frameId: string
): DelegatedWorkAttemptRecord | undefined =>
  session.runtimeContext?.delegatedWork?.records
    .find((record) => record.agentFrameId === frameId)
    ?.attempts.at(-1)

const readableNameForFrame = (frame: PersistedAgentFrame): string | undefined =>
  frame.delegateName?.trim() || frame.agentName?.trim() || undefined

const titleForFrame = (frame: PersistedAgentFrame): string =>
  readableNameForFrame(frame) ?? `Subagent ${frame.id}`
const inlineSourceNameForFrame = (frame: PersistedAgentFrame): string =>
  readableNameForFrame(frame) ?? 'Subagent'

const agentLabelForFrame = (session: PersistedChatSession, frame: PersistedAgentFrame): string => {
  const resolved = latestAttempt(session, frame.id)?.resolvedAgent
  if (resolved?.kind === 'specialist') return resolved.displayName
  return frame.agentName?.trim() || 'Main Agent'
}

const projectSessionSubagents = (
  session: PersistedChatSession | undefined,
  permissions: readonly AcpPermissionRequest[]
): SessionSubagentProjection => {
  const graph = session?.conversationGraph
  if (!session || !graph) return { runningCount: 0, children: [] }
  const activeRootMessageIds = resolveActiveRootMessageIds(graph)
  if (!activeRootMessageIds) return { runningCount: 0, children: [] }

  const children = graph.frames
    .filter(
      (frame) =>
        frame.kind === 'delegate' &&
        frame.parentFrameId === graph.rootFrameId &&
        (frame.originBindingState === 'legacy-unavailable' ||
          (frame.originBindingState === 'validated' &&
            Boolean(frame.originMessageId && activeRootMessageIds.has(frame.originMessageId))))
    )
    .map((frame): SessionSubagentChild => {
      const attempt = latestAttempt(session, frame.id)
      const awaitingPermission =
        frame.status === 'running' &&
        permissions.some(
          (permission) =>
            permission.sessionId === session.id &&
            permission.delegated?.frameId === frame.id &&
            (!attempt || permission.delegated.attemptId === attempt.id)
        )
      return {
        frameId: frame.id,
        title: titleForFrame(frame),
        agentLabel: agentLabelForFrame(session, frame),
        status: frame.status,
        ...(awaitingPermission ? { awaitingPermission: true } : {})
      }
    })

  return {
    runningCount: children.filter(({ status }) => status === 'running').length,
    children
  }
}

const projectInlineParentMessages = (
  session: PersistedChatSession | undefined
): readonly InlineParentMessageProjection[] => {
  const graph = session?.conversationGraph
  const commands = session?.runtimeContext?.delegatedWork?.messageCommands
  if (!graph || !commands) return []
  if (graph.activeFrameId !== graph.rootFrameId) return []
  const root = graph.frames.find((frame) => frame.id === graph.rootFrameId && frame.kind === 'root')
  if (!root) return []
  const activeRootMessageIds = resolveActiveRootMessageIds(graph)
  if (!activeRootMessageIds) return []

  const projectedByMessageId = new Map<string, InlineParentMessageProjection>()
  for (const command of commands) {
    if (
      command.direction !== 'to_parent' ||
      command.disposition !== 'message' ||
      command.rootBranchId !== root.activeBranchId ||
      command.targetFrameId !== root.id
    ) {
      continue
    }
    const source = graph.frames.find(
      (frame) =>
        frame.id === command.sourceFrameId &&
        frame.kind === 'delegate' &&
        frame.parentFrameId === root.id &&
        frame.originBindingState === 'validated' &&
        Boolean(frame.originMessageId && activeRootMessageIds.has(frame.originMessageId))
    )
    if (!source) continue

    projectedByMessageId.set(command.messageId, {
      messageId: command.messageId,
      sourceFrameId: source.id,
      sourceName: inlineSourceNameForFrame(source),
      kind: command.kind,
      text: command.text,
      queuedAt: command.queuedAt
    })
  }

  return [...projectedByMessageId.values()].sort(
    (left, right) => left.queuedAt - right.queuedAt || left.messageId.localeCompare(right.messageId)
  )
}

const selectSubagentFrame = (
  session: PersistedChatSession | undefined,
  frameId: string
): SubagentFrameProjection | undefined => {
  const graph = session?.conversationGraph
  if (!session || !graph) return undefined
  const frame = graph.frames.find(
    (candidate) =>
      candidate.id === frameId &&
      candidate.kind === 'delegate' &&
      candidate.parentFrameId === graph.rootFrameId
  )
  if (!frame) return undefined

  let messages: PersistedChatMessage[]
  try {
    messages = resolveMessageBranchPath(graph, frame.activeBranchId).map(projectConversationMessage)
  } catch {
    return undefined
  }

  return {
    frameId,
    title: titleForFrame(frame),
    agentLabel: agentLabelForFrame(session, frame),
    status: frame.status,
    attempt: latestAttempt(session, frameId),
    messages
  }
}

const resolveDelegatedWorkAvailability = (
  frameworkId: AgentFrameworkId,
  frameworks: readonly AgentFrameworkView[]
): DelegatedWorkAvailability => {
  const framework = frameworks.find(({ id }) => id === frameworkId)
  if (framework?.supportsDelegatedWork === true) return { available: true }

  return {
    available: false,
    title: `Subagents unavailable for ${framework?.displayName ?? frameworkId}`,
    description:
      'Choose a certified agent framework in Settings before asking the Main Agent to delegate work.'
  }
}

export {
  projectInlineParentMessages,
  projectSessionSubagents,
  resolveActiveRootMessageIds,
  resolveDelegatedWorkAvailability,
  selectSubagentFrame
}
export type {
  DelegatedWorkAvailability,
  InlineParentMessageProjection,
  SessionSubagentChild,
  SessionSubagentProjection,
  SubagentFrameProjection,
  SubagentRawStatus
}

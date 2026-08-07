import type { AcpTurnTokenUsage } from '../../shared/acp'
import type { ArtifactFile } from '../../shared/artifacts'
import type {
  PersistedActivityGroup,
  PersistedMessageImage,
  PersistedToolActivity
} from '../../shared/session-persistence'
import type { AuthenticatedDelegateCaller, DurableDelegateRequest } from './durable-delegated-work'

type DurableResolvedAgent =
  | Readonly<{ kind: 'main' }>
  | Readonly<{
      kind: 'specialist'
      profileId: string
      revision: number
      displayName: string
    }>

type DurableAttempt = {
  id: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  resolvedAgent: DurableResolvedAgent
  runtimeSegmentIds: string[]
  startedAt: number
  endedAt?: number
  terminalMessageId?: string
  cancellationReason?: 'main_agent_stop' | 'session_stop' | 'runtime_interrupted'
  error?: Readonly<{ code: string; message: string }>
}

type DurableChildSummary = Readonly<{
  frameId: string
  attemptId: string
  title: string
  name: string
  agentName: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
}>

type DurableDelegateResult = Readonly<{
  frameId: string
  attemptId: string
  name: string
  agentName: string
  status: 'completed' | 'cancelled' | 'error'
  terminalMessageId?: string
  response?: string
  artifactsCreated: readonly ArtifactFile[]
  cancellationReason?: 'main_agent_stop' | 'session_stop' | 'runtime_interrupted'
  error?: Readonly<{ code: string; message: string }>
}>

type DurableDelegateOutcome =
  | Readonly<{
      kind: 'receipts'
      children: readonly Readonly<{
        frameId: string
        attemptId: string
        name: string
        agentName: string
        status: 'running'
      }>[]
    }>
  | Readonly<{ kind: 'results'; children: readonly DurableDelegateResult[] }>

type DurableChild = {
  frameId: string
  parentFrameId: string
  originMessageId: string
  title: string
  task: string
  context?: string
  inputs: readonly string[]
  messageBranchId: string
  attempts: DurableAttempt[]
  pendingMessages: DurablePendingMessage[]
}

type DurablePendingMessage = Readonly<{
  id: string
  sourceFrameId: string
  sourceAttemptId?: string
  targetFrameId: string
  targetAttemptId?: string
  text: string
  kind: 'info' | 'question'
  createdAt: number
  deliveredAt?: number
}>

type DurableMessage = {
  id: string
  frameId: string
  role: 'user' | 'assistant'
  content: string
  status?: 'complete' | 'error'
  eventIds?: string[]
  images?: PersistedMessageImage[]
  turnUsage?: AcpTurnTokenUsage
  turnUsageUnavailable?: true
  createdAt: number
  updatedAt?: number
  completedAt?: number
}

type DurableSnapshot = Readonly<{
  session: Readonly<{ projectId: string; sessionId: string }>
  rootFrameId: string
  originMessageIds: readonly string[]
  records: readonly DurableChild[]
  messages: readonly DurableMessage[]
}>

type AdmitChildInput = Readonly<{
  caller: AuthenticatedDelegateCaller
  frameId: string
  attemptId: string
  userMessageId: string
  title: string
  request: DurableDelegateRequest
  resolvedAgent: DurableResolvedAgent
  startedAt: number
}>

type AdmitChildrenInput = Readonly<{
  caller: AuthenticatedDelegateCaller
  children: readonly Omit<AdmitChildInput, 'caller'>[]
}>

type TerminalInput =
  | Readonly<{
      frameId: string
      attemptId: string
      status: 'completed'
      endedAt: number
      terminalMessage: DurableMessage
    }>
  | Readonly<{
      frameId: string
      attemptId: string
      status: 'cancelled'
      endedAt: number
      cancellationReason: 'main_agent_stop' | 'session_stop' | 'runtime_interrupted'
    }>
  | Readonly<{
      frameId: string
      attemptId: string
      status: 'error'
      endedAt: number
      error: Readonly<{ code: string; message: string }>
    }>

type ContinueChildInput = Readonly<{
  frameId: string
  previousAttemptId: string
  attemptId: string
  userMessageId: string
  message: string
  resolvedAgent: DurableResolvedAgent
  startedAt: number
}>

type DelegatedWorkDurableRecords = Readonly<{
  admitChildren(input: AdmitChildrenInput): Promise<void>
  continueChild(input: ContinueChildInput): Promise<void>
  startRuntime(
    frameId: string,
    attemptId: string,
    runtimeSegmentId: string
  ): Promise<Readonly<{ rootFrameId: string; messageBranchId: string; promptMessageId: string }>>
  stageTerminalMessage(frameId: string, attemptId: string, message: DurableMessage): Promise<void>
  stageTerminalActivities?(
    frameId: string,
    attemptId: string,
    activities: readonly PersistedToolActivity[],
    activityGroups: readonly PersistedActivityGroup[]
  ): Promise<void>
  terminalize(input: TerminalInput): Promise<void>
  appendPendingMessage(
    frameId: string,
    attemptId: string,
    message: DurablePendingMessage
  ): Promise<void>
  markMessageDelivered(
    frameId: string,
    attemptId: string,
    messageId: string,
    deliveredAt: number
  ): Promise<void>
  snapshot(): Promise<DurableSnapshot>
}>

export type {
  DelegatedWorkDurableRecords,
  DurableAttempt,
  DurableChild,
  DurableChildSummary,
  DurableDelegateOutcome,
  DurableDelegateResult,
  DurableMessage,
  DurablePendingMessage,
  DurableResolvedAgent,
  DurableSnapshot
}

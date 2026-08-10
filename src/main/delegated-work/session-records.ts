import type { AgentFrameworkId } from '../../shared/settings'
import type { ArtifactFile } from '../../shared/artifacts'
import type {
  DelegatedWorkAttemptRecord,
  DelegatedWorkCancellationReason,
  DelegatedWorkPendingMessage,
  DelegatedWorkRecord,
  DelegatedWorkResolvedAgent,
  DelegatedCallerSource,
  ResolvedSubagentModelSnapshot,
  PersistedActivityGroup,
  PersistedChatMessage,
  PersistedToolActivity
} from '../../shared/session-persistence'

type SessionKey = Readonly<{ projectId: string; sessionId: string }>

type CreateChildRecordInput = Readonly<{
  frameId: string
  branchId: string
  messageId: string
  attemptId: string
  task: string
  name?: string
  context?: string
  inputs?: readonly string[]
  resolvedAgent: DelegatedWorkResolvedAgent
  executionModel?: ResolvedSubagentModelSnapshot
  startedAt: number
  callerSource: DelegatedCallerSource
  initiatingTurnMessageId: string
}>

type CreateChildrenInput = Readonly<{
  expectedRevision: number
  parentFrameId: string
  originMessageId: string
  children: readonly CreateChildRecordInput[]
}>

type CreatedChild = Readonly<{
  frameId: string
  attemptId: string
  status: 'running'
}>

type StartAttemptRuntimeInput = Readonly<{
  expectedRevision: number
  frameId: string
  attemptId: string
  runtimeSegmentId: string
  frameworkId: AgentFrameworkId
  backendId?: string
  agentName?: string
  model?: string
  startedAt: number
}>

type StartContinuationAttemptInput = Readonly<{
  expectedRevision: number
  frameId: string
  previousAttemptId: string
  attemptId: string
  messageId: string
  message: string
  resolvedAgent: DelegatedWorkResolvedAgent
  executionModel?: ResolvedSubagentModelSnapshot
  startedAt: number
  callerSource: DelegatedCallerSource
  initiatingTurnMessageId: string
}>

type AttemptAgentEvent =
  | Readonly<{
      kind: 'message'
      message: PersistedChatMessage
      runtimeSegmentId: string
    }>
  | Readonly<{
      kind: 'activity'
      activity: PersistedToolActivity
      runtimeSegmentId: string
      promptMessageId: string
    }>
  | Readonly<{
      kind: 'activity-group'
      activityGroup: PersistedActivityGroup
      promptMessageId: string
    }>

type AttemptAgentEventInput = Readonly<{
  expectedRevision: number
  frameId: string
  attemptId: string
  event: AttemptAgentEvent
}>

type TransitionAttemptInput = Readonly<{
  expectedRevision: number
  frameId: string
  attemptId: string
  status: 'completed' | 'cancelled' | 'error'
  endedAt: number
  terminalMessageId?: string
  cancellationReason?: DelegatedWorkCancellationReason
  error?: Readonly<{ code: string; message: string }>
}>

type AppendPendingMessageInput = Readonly<{
  expectedRevision: number
  frameId: string
  attemptId: string
  message: DelegatedWorkPendingMessage
}>

type MarkMessageDeliveredInput = Readonly<{
  expectedRevision: number
  frameId: string
  attemptId: string
  messageId: string
  deliveredAt: number
}>

type StartPendingMessageTurnInput = Readonly<{
  expectedRevision: number
  frameId: string
  attemptId: string
  pendingMessageId: string
  promptMessageId: string
  runtimeSegmentId: string
  frameworkId: AgentFrameworkId
  startedAt: number
}>

type CompleteChildTurnInput = Readonly<{
  expectedRevision: number
  frameId: string
  attemptId: string
  runtimeSegmentId: string
  endedAt: number
}>

type AttachDelegatedMessageArtifactsInput = Readonly<{
  frameId: string
  attemptId: string
  messageId: string
  artifacts: readonly ArtifactFile[]
}>

type ChildRecord = Readonly<{
  frameId: string
  parentFrameId: string
  title: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  record: DelegatedWorkRecord
}>

/** Internal persistence port. It is intentionally absent from Host, IPC, and Renderer contracts. */
type DelegatedWorkRecordCommands = Readonly<{
  createChildren(key: SessionKey, input: CreateChildrenInput): Promise<readonly CreatedChild[]>
  startContinuationAttempt(
    key: SessionKey,
    input: StartContinuationAttemptInput
  ): Promise<CreatedChild>
  startAttemptRuntime(key: SessionKey, input: StartAttemptRuntimeInput): Promise<void>
  applyAgentEvent(key: SessionKey, input: AttemptAgentEventInput): Promise<void>
  transitionAttempt(key: SessionKey, input: TransitionAttemptInput): Promise<void>
  appendPendingMessage(key: SessionKey, input: AppendPendingMessageInput): Promise<void>
  markMessageDelivered(key: SessionKey, input: MarkMessageDeliveredInput): Promise<void>
  startPendingMessageTurn(key: SessionKey, input: StartPendingMessageTurnInput): Promise<void>
  completeChildTurn(key: SessionKey, input: CompleteChildTurnInput): Promise<void>
  attachDelegatedMessageArtifacts(
    key: SessionKey,
    input: AttachDelegatedMessageArtifactsInput
  ): Promise<void>
  readChildren(key: SessionKey, parentFrameId: string): Promise<readonly ChildRecord[]>
}>

export type {
  AppendPendingMessageInput,
  AttachDelegatedMessageArtifactsInput,
  AttemptAgentEvent,
  AttemptAgentEventInput,
  ChildRecord,
  CompleteChildTurnInput,
  CreateChildRecordInput,
  CreateChildrenInput,
  CreatedChild,
  DelegatedWorkAttemptRecord,
  DelegatedWorkRecordCommands,
  MarkMessageDeliveredInput,
  SessionKey,
  StartContinuationAttemptInput,
  StartAttemptRuntimeInput,
  StartPendingMessageTurnInput,
  TransitionAttemptInput
}

import type { AcpTurnTokenUsage } from '../../shared/acp'
import type { ArtifactFile } from '../../shared/artifacts'
import type {
  PersistedActivityGroup,
  DelegatedCallerSource,
  PersistedMessageImage,
  PersistedToolActivity
} from '../../shared/session-persistence'
import type { ResolvedSubagentModelSnapshot } from '../../shared/session-persistence'
import type { AuthenticatedDelegateCaller, DurableDelegateRequest } from './durable-delegated-work'
import type { JsonSchema, JsonValue, StructuredOutputEvidence } from './structured-output'

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
  initiatingTurnMessageId?: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  resolvedAgent: DurableResolvedAgent
  executionModel?: ResolvedSubagentModelSnapshot
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
  structuredOutput?: JsonValue
  structuredOutputUnsatisfied?: boolean
}>

type DurableRunningObservation = Readonly<{
  frameId: string
  attemptId: string
  name: string
  agentName: string
  status: 'running'
}>

type DurableDelegateObservation = DurableDelegateResult | DurableRunningObservation

type DurableCollectSelector = string | Readonly<{ frameId: string; attemptId: string }>

type DurableCollectOptions = Readonly<{ timeoutSeconds?: number }>

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
  | Readonly<{ kind: 'observations'; children: readonly DurableDelegateObservation[] }>

type DurableChild = {
  frameId: string
  parentFrameId: string
  originMessageId: string
  originBindingState: 'validated' | 'legacy-unavailable'
  title: string
  task: string
  context?: string
  outputSchema?: JsonSchema
  inputs: readonly string[]
  messageBranchId: string
  attempts: DurableAttempt[]
}

type MessageDirection = 'to_child' | 'to_parent'
type MessageDisposition = 'message' | 'continued'
type MessageEvidence = 'provider_prompt_accepted' | 'provider_prompt_completed'

type DurableMessageReceiptState =
  | Readonly<{ status: 'queued'; dispatchStartedAt?: number; dispatchEpoch?: string }>
  | Readonly<{ status: 'accepted'; acceptedAt: number; evidence: MessageEvidence }>
  | Readonly<{
      status: 'failed'
      failedAt: number
      error: Readonly<{ code: string; message: string; retryable: boolean }>
    }>
  | Readonly<{ status: 'uncertain'; uncertainAt: number; resolution: 'pending' | 'acknowledged' }>

type DurableMessageCommand = Readonly<{
  messageId: string
  requestId: string
  sourcePrincipal: string
  canonicalDigest: string
  sourceFrameId: string
  sourceAttemptId?: string
  targetFrameId: string
  targetAttemptId?: string
  continuationAttemptId?: string
  rootPromptMessageId?: string
  rootOriginMessageId: string
  callerRootMessageId: string
  rootBranchId: string
  rootBranchRevision: string
  direction: MessageDirection
  disposition: MessageDisposition
  text: string
  kind: 'info' | 'question'
  replyToMessageId?: string
  retryOfMessageId?: string
  laneSequence: number
  queuedAt: number
  receipt: DurableMessageReceiptState
}>

type DurablePendingMessage = Readonly<{
  id: string
  sourceFrameId: string
  sourceAttemptId?: string
  targetFrameId: string
  targetAttemptId?: string
  text: string
  kind: 'info' | 'question'
  callerSource?: DelegatedCallerSource
  createdAt: number
  deliveredAt?: number
}>

type DurableMessage = {
  id: string
  frameId: string
  role: 'user' | 'assistant'
  content: string
  responseToMessageId?: string
  runtimeSegmentId?: string
  status?: 'complete' | 'error'
  eventIds?: string[]
  images?: PersistedMessageImage[]
  turnUsage?: AcpTurnTokenUsage
  turnUsageUnavailable?: true
  createdAt: number
  updatedAt?: number
  completedAt?: number
  structuredOutputEvidence?: StructuredOutputEvidence
  structuredOutputEvidenceInvalid?: true
}

type DurableSnapshot = Readonly<{
  session: Readonly<{ projectId: string; sessionId: string }>
  rootFrameId: string
  rootBranchId: string
  rootBranchRevision: string
  originMessageIds: readonly string[]
  records: readonly DurableChild[]
  messages: readonly DurableMessage[]
  messageCommands: readonly DurableMessageCommand[]
  messageCommandsQuarantined?: true
}>

type AdmitChildInput = Readonly<{
  caller: AuthenticatedDelegateCaller
  frameId: string
  attemptId: string
  userMessageId: string
  name: string
  request: DurableDelegateRequest
  resolvedAgent: DurableResolvedAgent
  executionModel?: ResolvedSubagentModelSnapshot
  startedAt: number
  structuredOutputEvidence?: StructuredOutputEvidence
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
  executionModel?: ResolvedSubagentModelSnapshot
  startedAt: number
  callerSource: DelegatedCallerSource
  initiatingTurnMessageId: string
  messageCommand: DurableMessageCommand
}>

type DelegatedWorkDurableRecords = Readonly<{
  admitChildren(
    input: AdmitChildrenInput
  ): Promise<readonly Readonly<{ frameId: string; attemptId: string; name: string }>[]>
  continueChild(input: ContinueChildInput): Promise<void>
  startRuntime(
    frameId: string,
    attemptId: string,
    runtimeSegmentId: string
  ): Promise<
    Readonly<{
      rootFrameId: string
      messageBranchId: string
      promptMessageId: string
      runtimeSegmentId: string
    }>
  >
  stageTerminalMessage(frameId: string, attemptId: string, message: DurableMessage): Promise<void>
  stageTerminalActivities?(
    frameId: string,
    attemptId: string,
    runtimeSegmentId: string,
    activities: readonly PersistedToolActivity[],
    activityGroups: readonly PersistedActivityGroup[]
  ): Promise<void>
  terminalize(input: TerminalInput): Promise<void>
  startPendingTurn(
    frameId: string,
    attemptId: string,
    pendingMessageId: string,
    promptMessageId: string,
    runtimeSegmentId: string
  ): Promise<
    Readonly<{
      rootFrameId: string
      messageBranchId: string
      promptMessageId: string
      runtimeSegmentId: string
    }>
  >
  completeTurn(
    frameId: string,
    attemptId: string,
    runtimeSegmentId: string,
    endedAt: number
  ): Promise<void>
  submitOutput(
    frameId: string,
    attemptId: string,
    schemaDigest: string,
    value: JsonValue,
    acceptedAt: number
  ): Promise<'accepted' | 'idempotent'>
  admitMessage(command: DurableMessageCommand): Promise<'admitted' | 'idempotent'>
  markMessageDispatchStarted(
    messageId: string,
    dispatchStartedAt: number,
    dispatchEpoch: string,
    rootBranchId: string,
    rootBranchRevision: string
  ): Promise<'started' | 'terminal' | 'blocked'>
  settleMessage(
    messageId: string,
    state: Exclude<DurableMessageReceiptState, { status: 'queued' }>
  ): Promise<'settled' | 'terminal'>
  acknowledgeUncertain(messageId: string): Promise<'acknowledged' | 'terminal'>
  snapshot(): Promise<DurableSnapshot>
}>

export type {
  DelegatedWorkDurableRecords,
  DurableAttempt,
  DurableChild,
  DurableChildSummary,
  DurableCollectOptions,
  DurableCollectSelector,
  DurableDelegateObservation,
  DurableDelegateOutcome,
  DurableDelegateResult,
  DurableMessage,
  DurableMessageCommand,
  DurableMessageReceiptState,
  MessageDirection,
  MessageDisposition,
  MessageEvidence,
  DurablePendingMessage,
  DurableResolvedAgent,
  DurableSnapshot
}

import type { ArtifactFile } from '../../shared/artifacts'
import type { AcpAgentRuntimeUpdate, AcpPermissionScope } from '../../shared/acp'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { ReviewWithChecks } from '../../shared/reviewer'
import type { SpecialistProfileView } from '../../shared/specialist'
import type { AuthenticatedDelegateCaller } from './authenticated-delegate-caller'
import type { DelegatedArtifactEvidence } from './delegated-turn-lifecycle'
import type { DelegateExecution, DelegatePermissionResponse } from './execution-port'
import type {
  DelegatedWorkDurableRecords,
  DurableAttempt,
  DurableChildSummary,
  DurableCollectOptions,
  DurableCollectSelector,
  DurableDelegateObservation,
  DurableDelegateOutcome,
  DurableDelegateResult
} from './delegated-work-record-types'

type SessionKey = Readonly<{ projectId: string; sessionId: string }>

type DurableDelegateRequest = Readonly<{
  task: string
  name?: string
  profile?: string
  context?: string
  inputs?: readonly string[]
}>

type SpecialistDelegationProfile = Readonly<
  Pick<
    SpecialistProfileView,
    'id' | 'name' | 'displayName' | 'enabled' | 'setupPending' | 'revision'
  >
>

type ParentMessageDelivery = Readonly<{
  messageId: string
  session: SessionKey
  sourceFrameId: string
  sourceAttemptId: string
  targetFrameId: string
  originMessageId: string
  text: string
  kind: 'info' | 'question'
}>

type SessionSubagentSummary = Readonly<{
  runningCount: number
  children: readonly Readonly<{
    frameId: string
    title: string
    status: 'running' | 'completed' | 'cancelled' | 'error'
    awaitingPermission?: boolean
  }>[]
}>

type RootDelegatePermissionRequest = Readonly<{
  requestId: string
  frameId: string
  attemptId: string
  childTitle: string
  action: string
  riskScope: string
  options: readonly Readonly<{
    optionId: string
    name: string
    kind: string
    scope?: AcpPermissionScope
  }>[]
}>

type RootDelegatePermissionResponse = DelegatePermissionResponse &
  Readonly<{ frameId: string; attemptId: string }>

type RootDelegatePermissionEvent =
  | Readonly<{ kind: 'requested'; request: RootDelegatePermissionRequest }>
  | Readonly<{ kind: 'settled'; request: RootDelegatePermissionRequest }>

type DurableSendMessageOutcome =
  | Readonly<{
      kind: 'queued'
      messageId: string
      targetFrameId: string
      attemptId?: string
    }>
  | Readonly<{
      kind: 'continued'
      child: Readonly<{ frameId: string; attemptId: string; status: 'running' }>
    }>

type ReadOnlyAgentFrameDetail = Readonly<{
  frameId: string
  title: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  resolvedAgent: DurableAttempt['resolvedAgent']
  messages: readonly Readonly<{
    role: 'user' | 'assistant'
    content: string
    artifacts?: readonly ArtifactFile[]
    reviews?: readonly ReviewWithChecks[]
  }>[]
}>

type DelegatedReviewProjectionScope = Readonly<{
  session: SessionKey
  attemptId: string
  agentFrameId: string
  messageBranchId: string
  terminalMessageId: string
  artifactVersionIds: readonly string[]
}>

type DelegatedReviewEvidence = Readonly<{
  project(scope: DelegatedReviewProjectionScope): Promise<readonly ReviewWithChecks[]>
}>

type StopOutcome = Readonly<{
  frameId: string
  status: 'cancelled' | 'already_terminal'
}>

type RecoveryOutcome = Readonly<{ interrupted: readonly DurableDelegateResult[] }>

type DurableDelegatedWork = Readonly<{
  delegate(
    caller: AuthenticatedDelegateCaller,
    requests: DurableDelegateRequest | readonly DurableDelegateRequest[],
    options?: Readonly<{ wait?: boolean; timeoutSeconds?: number }>
  ): Promise<DurableDelegateOutcome>
  children(
    caller: AuthenticatedDelegateCaller,
    frameIds?: readonly string[]
  ): Promise<readonly DurableChildSummary[]>
  collect(
    caller: AuthenticatedDelegateCaller,
    selectors: readonly DurableCollectSelector[],
    options?: DurableCollectOptions
  ): Promise<readonly DurableDelegateObservation[]>
  sendMessage(
    caller: AuthenticatedDelegateCaller,
    targetFrameId: string | 'parent',
    message: string,
    kind?: 'info' | 'question'
  ): Promise<DurableSendMessageOutcome>
  sessionSummary(session: SessionKey): Promise<SessionSubagentSummary>
  readAgentFrame(
    session: SessionKey,
    frameId: string
  ): Promise<ReadOnlyAgentFrameDetail | undefined>
  rootPermissionRequests(session: SessionKey): Promise<readonly RootDelegatePermissionRequest[]>
  respondToPermission(session: SessionKey, response: RootDelegatePermissionResponse): Promise<void>
  setPermissionProfile(session: SessionKey, profile: PermissionProfileId): Promise<void>
  stopChildren(
    caller: AuthenticatedDelegateCaller,
    frameIds: readonly string[]
  ): Promise<readonly StopOutcome[]>
  cancelTurn(session: SessionKey, initiatingTurnMessageId: string): Promise<readonly StopOutcome[]>
  stopActiveBranch(session: SessionKey): Promise<readonly StopOutcome[]>
  stopSession(session: SessionKey): Promise<readonly StopOutcome[]>
  recoverInterrupted(): Promise<RecoveryOutcome>
  deleteSession(session: SessionKey): Promise<void>
}>

type CreateDurableDelegatedWorkOptions = Readonly<{
  execution: DelegateExecution
  records: DelegatedWorkDurableRecords
  assertAvailable?: (caller: AuthenticatedDelegateCaller) => Promise<void> | void
  resolveSpecialist?: (
    profileId: string
  ) => Promise<SpecialistDelegationProfile | undefined> | SpecialistDelegationProfile | undefined
  resolveSpecialistReference?: (
    profileReference: string
  ) => Promise<SpecialistDelegationProfile | undefined> | SpecialistDelegationProfile | undefined
  validateInput?: (identity: string) => Promise<boolean> | boolean
  workspace?: Readonly<{
    prepare(
      session: SessionKey,
      frameId: string,
      inputs: readonly string[]
    ): Promise<{ cwd: string }>
    deleteSession?(session: SessionKey): Promise<void>
  }>
  revokeAttemptWrites?: (scope: {
    session: SessionKey
    frameId: string
    attemptId: string
  }) => Promise<void> | void
  settleAttemptCleanup?: (scope: {
    session: SessionKey
    frameId: string
    attemptId: string
  }) => Promise<void> | void
  deliverToParent?: (delivery: ParentMessageDelivery) => Promise<void>
  artifactEvidence?: DelegatedArtifactEvidence
  reviewEvidence?: DelegatedReviewEvidence
  onRootPermissionEvent?(event: RootDelegatePermissionEvent): void
  onAgentRuntimeUpdate?(update: AcpAgentRuntimeUpdate): void
  now?: () => number
  createId?: (kind: 'frame' | 'attempt' | 'message' | 'runtime') => string
  collectPollIntervalMs?: number
  collectMonotonicNow?: () => number
  assertTurnOpen?: (session: SessionKey, initiatingTurnMessageId: string) => Promise<void> | void
}>

export type {
  CreateDurableDelegatedWorkOptions,
  DelegatedReviewEvidence,
  DelegatedReviewProjectionScope,
  DurableDelegateRequest,
  DurableDelegatedWork,
  DurableSendMessageOutcome,
  ParentMessageDelivery,
  ReadOnlyAgentFrameDetail,
  RecoveryOutcome,
  RootDelegatePermissionEvent,
  RootDelegatePermissionRequest,
  RootDelegatePermissionResponse,
  SessionKey,
  SessionSubagentSummary,
  SpecialistDelegationProfile,
  StopOutcome
}

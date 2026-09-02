import type { NotebookRunStatus } from './notebook'
import type { ComputeJobStatus } from './compute'

export type AgentResultDeliveryState =
  'waiting-result' | 'pending' | 'claimed' | 'consumed' | 'needs-attention'

export type AgentResultExecutionType = 'python' | 'r' | 'repl' | 'shell' | 'compute-job'

export type LocalRunAgentResultDeliveryContext = Readonly<{
  sourceKind?: 'local-run'
  runId: string
  executionType: Exclude<AgentResultExecutionType, 'compute-job'>
  terminalStatus: Exclude<NotebookRunStatus, 'queued' | 'running'>
  resultSummary: string
  errorGuidance?: string
  projectId: string
  sessionId: string
  agentFrameId?: string
  title?: string
  lane?: string
  acceptedAt?: number
  provenance?: Readonly<{
    messageBranchId?: string
    runtimeSegmentId?: string
    promptMessageId?: string
    executionInvocationId?: string
  }>
}>

export type ComputeJobAgentResultDeliveryContext = Readonly<{
  sourceKind: 'compute-job'
  jobId: string
  executionType: 'compute-job'
  terminalStatus:
    Extract<ComputeJobStatus, 'success' | 'failed' | 'timeout' | 'error'> | 'cancelled'
  resultSummary: string
  errorGuidance?: string
  projectId: string
  sessionId: string
  computeHost: Readonly<{
    providerId: string
    displayName: string
  }>
  title?: string
  acceptedAt?: number
  remoteWorkdir?: string
  featuredFiles: readonly string[]
  leftOnRemote: readonly Readonly<{ uri: string; size_mb: number; reason: string }>[]
  harvestError?: string
}>

export type ComputeJobAgentResultWaitingContext = Readonly<{
  sourceKind: 'compute-job'
  jobId: string
  executionType: 'compute-job'
  terminalStatus: 'waiting-result'
  projectId: string
  sessionId: string
  computeHost: Readonly<{
    providerId: string
    displayName: string
  }>
  title?: string
  acceptedAt?: number
}>

export type LocalRunAgentResultWaitingContext = Readonly<{
  sourceKind: 'local-run'
  runId: string
  executionType: Exclude<AgentResultExecutionType, 'compute-job'>
  terminalStatus: 'waiting-result'
  projectId: string
  sessionId: string
  agentFrameId?: string
  title: string
  lane: string
  acceptedAt: number
}>

export type AgentResultDeliveryContext =
  | LocalRunAgentResultDeliveryContext
  | LocalRunAgentResultWaitingContext
  | ComputeJobAgentResultDeliveryContext
  | ComputeJobAgentResultWaitingContext

export type TerminalAgentResultDeliveryContext =
  LocalRunAgentResultDeliveryContext | ComputeJobAgentResultDeliveryContext

export type AgentResultDelivery = Readonly<{
  id: string
  state: AgentResultDeliveryState
  context: AgentResultDeliveryContext
  attemptCount: number
  claimToken?: string
  claimExpiresAt?: number
  continuationMessageId?: string
  createdAt: number
  updatedAt: number
  consumedAt?: number
  dismissedAt?: number
}>

export type SessionAgentResultActivity = Readonly<{
  active: readonly []
  awaitingAgent: readonly AgentResultDelivery[]
}>

export type AgentResultDeliverySessionRequest = Readonly<{ sessionId: string }>
export type AgentResultDeliveryProjectRequest = Readonly<{ projectId: string }>

export type ProjectBackgroundActivityItem = Readonly<{
  id: string
  sourceKind: 'local-run' | 'compute-job'
  sourceId: string
  executionType: AgentResultExecutionType
  projectId: string
  sessionId: string
  title: string
  lane: string
  status:
    | NotebookRunStatus
    | 'submitted'
    | 'success'
    | 'error'
    | 'cancelling'
    | 'pending-delivery'
    | 'needs-attention'
    | 'result-unavailable'
  active: boolean
  needsAttention: boolean
  outcomeStatus?: Exclude<NotebookRunStatus, 'queued' | 'running'> | 'success' | 'error'
  updatedAt: number
}>

export type ProjectBackgroundActivity = Readonly<{
  revision: number
  items: readonly ProjectBackgroundActivityItem[]
  truncated: boolean
}>

export type ProjectBackgroundActivityChangedEvent = Readonly<{
  projectId: string
  revision: number
}>
export type DismissAgentResultDeliveryRequest = AgentResultDeliverySessionRequest &
  Readonly<{ deliveryId: string }>

import type { NotebookRunStatus } from './notebook'
import type { ComputeJobStatus } from './compute'

export type AgentResultDeliveryState =
  'waiting-result' | 'pending' | 'claimed' | 'consumed' | 'needs-attention' | 'dismissed'

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
}>

export type AgentResultDeliveryContext =
  | LocalRunAgentResultDeliveryContext
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
export type DismissAgentResultDeliveryRequest = AgentResultDeliverySessionRequest &
  Readonly<{ deliveryId: string }>

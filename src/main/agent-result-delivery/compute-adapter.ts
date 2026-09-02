import type {
  ComputeJobAgentResultDeliveryContext,
  TerminalAgentResultDeliveryContext
} from '../../shared/agent-result-delivery'
import type { JobSummary } from '../../shared/compute'
import type { ComputeJobDeliveryRegistration } from './repository'

const SUMMARY_LIMIT = 8_000

const isNonTerminal = (job: JobSummary): boolean =>
  job.status === 'queued' || job.status === 'submitted' || job.status === 'running'

const terminalStatus = (job: JobSummary): ComputeJobAgentResultDeliveryContext['terminalStatus'] =>
  job.cancellation_status === 'cancelled'
    ? 'cancelled'
    : (job.status as 'success' | 'failed' | 'timeout' | 'error')

const computeResultSummary = (job: JobSummary): string => {
  const parts = [
    `Compute Job ${job.job_id} ended with status ${terminalStatus(job)} on ${job.display_name}.`,
    job.exit_code === undefined ? undefined : `exitCode: ${String(job.exit_code)}`,
    job.stdout_tail?.trim() ? `stdout:\n${job.stdout_tail.trim()}` : undefined,
    job.stderr_tail?.trim() ? `stderr:\n${job.stderr_tail.trim()}` : undefined,
    job.featured_files?.length
      ? `featured files:\n${job.featured_files.join('\n')}`
      : 'featured files: none',
    job.harvest_error ? `harvest error: ${job.harvest_error}` : undefined,
    job.left_on_remote?.length
      ? `left on remote:\n${job.left_on_remote.map(({ uri, reason }) => `${uri} (${reason})`).join('\n')}`
      : undefined
  ].filter((part): part is string => part !== undefined)
  const summary = parts.join('\n\n')
  return summary.length <= SUMMARY_LIMIT ? summary : `${summary.slice(0, SUMMARY_LIMIT - 1)}…`
}

const computeErrorGuidance = (job: JobSummary): string | undefined => {
  if (job.cancellation_status === 'cancelled') {
    return 'The remote Compute Job was cancelled. Decide whether any follow-up is needed.'
  }
  if (job.status === 'success' && !job.harvest_error) return undefined
  if (job.harvest_error) {
    return 'Result harvesting was incomplete. Inspect featured files, files left on the remote Host, and the harvest error before continuing.'
  }
  if (job.status === 'timeout') {
    return 'The remote Compute Job timed out. Inspect its durable output before deciding whether to submit new work.'
  }
  return 'The remote Compute Job failed. Inspect its durable output and remote work directory; do not assume it should be resubmitted.'
}

const computeJobDeliveryContext = (job: JobSummary): ComputeJobAgentResultDeliveryContext => ({
  sourceKind: 'compute-job',
  jobId: job.job_id,
  executionType: 'compute-job',
  terminalStatus: terminalStatus(job),
  resultSummary: computeResultSummary(job),
  ...(computeErrorGuidance(job) ? { errorGuidance: computeErrorGuidance(job) } : {}),
  projectId: job.project_id ?? '',
  sessionId: job.session_id,
  computeHost: { providerId: job.provider_id, displayName: job.display_name },
  title: job.intent,
  acceptedAt: job.created_at,
  ...(job.remote_workdir ? { remoteWorkdir: job.remote_workdir } : {}),
  featuredFiles: job.featured_files ?? [],
  leftOnRemote: job.left_on_remote ?? [],
  ...(job.harvest_error ? { harvestError: job.harvest_error } : {})
})

type ComputeJobResultDeliveryAdapterDeps = Readonly<{
  repository: Readonly<{
    registerComputeJob(registration: ComputeJobDeliveryRegistration): Promise<unknown>
    hasComputeJobDeliveryPath(jobId: string): Promise<boolean>
    listWaitingComputeJobIds(): Promise<string[]>
  }>
  enqueue(context: TerminalAgentResultDeliveryContext): Promise<unknown>
}>

class ComputeJobResultDeliveryAdapter {
  private readonly chains = new Map<string, Promise<void>>()

  constructor(private readonly deps: ComputeJobResultDeliveryAdapterDeps) {}

  private serialize(jobId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(jobId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.chains.set(jobId, next)
    const cleanup = (): void => {
      if (this.chains.get(jobId) === next) this.chains.delete(jobId)
    }
    void next.then(cleanup, cleanup)
    return next
  }

  private registration(job: JobSummary): ComputeJobDeliveryRegistration {
    if (!job.project_id) throw new Error(`Compute Job ${job.job_id} has no Project scope.`)
    return {
      jobId: job.job_id,
      projectId: job.project_id,
      sessionId: job.session_id,
      providerId: job.provider_id,
      displayName: job.display_name,
      title: job.intent,
      acceptedAt: job.created_at
    }
  }

  observeJob(job: JobSummary): Promise<void> {
    if (!isNonTerminal(job)) return Promise.resolve()
    return this.serialize(job.job_id, async () => {
      await this.deps.repository.registerComputeJob(this.registration(job))
    })
  }

  observeNotification(job: JobSummary): Promise<void> {
    if (isNonTerminal(job) || job.notified_at === undefined) return Promise.resolve()
    return this.serialize(job.job_id, async () => {
      await this.deps.enqueue(computeJobDeliveryContext(job))
    })
  }

  async takeOver(jobs: readonly JobSummary[]): Promise<void> {
    await Promise.all(jobs.filter(isNonTerminal).map((job) => this.observeJob(job)))
  }

  async recoverWaiting(loadJob: (jobId: string) => Promise<JobSummary | undefined>): Promise<void> {
    const ids = await this.deps.repository.listWaitingComputeJobIds()
    await Promise.all(
      ids.map(async (jobId) => {
        const job = await loadJob(jobId)
        if (job) await this.observeNotification(job)
      })
    )
  }

  hasDeliveryPath(jobId: string): Promise<boolean> {
    return this.deps.repository.hasComputeJobDeliveryPath(jobId)
  }
}

export { ComputeJobResultDeliveryAdapter, computeJobDeliveryContext, isNonTerminal }
export type { ComputeJobResultDeliveryAdapterDeps }

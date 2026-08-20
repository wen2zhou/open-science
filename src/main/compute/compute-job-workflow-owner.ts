import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, relative, resolve } from 'node:path'

import type {
  ComputeCallError,
  ComputeJob,
  JobResult,
  JobStatusResult,
  SubmitJobResult
} from '../../shared/compute'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import type { ComputeConnectionBrokerAcquirer } from './connection-broker'
import type { ConcurrencyManager, SessionStatus } from './concurrency-manager'
import { sharedDispatchTracker } from './dispatch-tracker'
import { computeRemoteWorkdir, dispatchJob, hashCommand } from './job-dispatcher'
import type { StagedInputEntry } from './job-dispatcher'
import type { ComputeJobRepository } from './job-repository'
import { buildHarvestProjection, type HarvestProjection } from './harvest-engine'
import { validateHarvestConfig } from './harvest-classifier'
import type { ComputeHostRepository } from './repository'
import { GLOB_CHARS, SHELL_UNSAFE_CHARS } from './remote-path-security'

const COMMAND_PREVIEW_MAX_LEN = 120
const JOB_MAX_TIMEOUT_SECONDS = 7 * 24 * 3600
const JOB_DEFAULT_TIMEOUT_SECONDS = 24 * 3600
const TERMINAL_JOB_STATUSES: ReadonlySet<ComputeJob['status']> = new Set([
  'success',
  'failed',
  'timeout',
  'error'
])

export type RawInputSpec =
  { src: string; dst_filename: string } | { remote_path: string; dst_filename?: string }

export interface ArtifactResolver {
  resolveArtifactPath(path: string): Promise<string>
}

const assertBareName = (name: string, label: string): void => {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(
      `dst_filename must be a bare filename with no path separators (got "${name}" for ${label})`
    )
  }
}

const resolveWorkspacePath = (workspaceCwd: string, srcPath: string): string => {
  const resolved = resolve(workspaceCwd, srcPath)
  const rel = relative(resolve(workspaceCwd), resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`workspace path "${srcPath}" would escape the workspace root "${workspaceCwd}"`)
  }
  return resolved
}

export const resolveInputs = async (
  rawInputs: RawInputSpec[],
  workspaceCwd: string | undefined,
  artifactResolver: ArtifactResolver | undefined
): Promise<{ entries: StagedInputEntry[]; inputsSummary: string }> => {
  const entries: StagedInputEntry[] = []
  const summaryParts: string[] = []

  for (const raw of rawInputs) {
    if ('remote_path' in raw) {
      const remotePath = raw.remote_path
      if (!remotePath.startsWith('/')) {
        throw new Error(`remote_path must be an absolute path (got "${remotePath}")`)
      }
      if (GLOB_CHARS.test(remotePath)) {
        throw new Error(`remote_path must not contain glob characters (got "${remotePath}")`)
      }
      if (SHELL_UNSAFE_CHARS.test(remotePath)) {
        throw new Error(
          `remote_path must not contain shell-unsafe characters (got "${remotePath}")`
        )
      }
      const dstFilename = raw.dst_filename ?? basename(remotePath)
      assertBareName(dstFilename, `remote_path "${remotePath}"`)
      entries.push({
        kind: 'symlink',
        remotePath,
        dstFilename,
        label: remotePath
      })
      summaryParts.push(`${dstFilename} (symlink)`)
      continue
    }

    const { src, dst_filename: dstFilename } = raw
    assertBareName(dstFilename, `src "${src}"`)
    if (isAbsolute(src)) {
      if (!artifactResolver) {
        throw new Error(`Cannot resolve artifact "${src}": ArtifactResolver is not available`)
      }
      const localPath = await artifactResolver.resolveArtifactPath(src)
      entries.push({ kind: 'upload', localPath, dstFilename, label: src })
    } else {
      if (!workspaceCwd) {
        throw new Error(`Cannot resolve workspace path "${src}": workspace_cwd is not available`)
      }
      const localPath = resolveWorkspacePath(workspaceCwd, src)
      entries.push({ kind: 'upload', localPath, dstFilename, label: src })
    }
    summaryParts.push(dstFilename)
  }

  return {
    entries,
    inputsSummary:
      entries.length === 0
        ? ''
        : `${entries.length} input${entries.length === 1 ? '' : 's'}: ${summaryParts.join(', ')}`
  }
}

const queueFullError = (): Error & { computeCallError: ComputeCallError } => {
  const message =
    'Job queue is full (100 queued jobs). Wait for queued jobs to start running before submitting more.'
  const error = new Error(message) as Error & { computeCallError: ComputeCallError }
  error.computeCallError = {
    error_code: 'queue_full',
    message,
    retry_after_user_action: false
  }
  return error
}

export class ComputeJobWorkflowOwner {
  constructor(
    private readonly connectionBroker: ComputeConnectionBrokerAcquirer,
    private readonly hostRepository: ComputeHostRepository,
    private readonly approvalBroker: ComputeApprovalBroker | undefined,
    private readonly jobRepository: ComputeJobRepository | undefined,
    private readonly publishJobUpdated: ((job: ComputeJob) => void) | undefined,
    private readonly artifactResolver: ArtifactResolver | undefined,
    private readonly storageRoot: string | undefined,
    private readonly concurrencyManager: ConcurrencyManager | undefined
  ) {}

  async submitJob(
    providerId: string,
    intent: string,
    command: string,
    options: {
      environment?: string
      resourceRequest?: string
      inputs?: RawInputSpec[]
      outputManifest?: string
      harvestConfig?: string
      timeoutSeconds?: number
      workspaceCwd?: string
    },
    context: { sessionId: string; projectId: string }
  ): Promise<SubmitJobResult> {
    if (!this.jobRepository) {
      throw new Error('ComputeJobRepository is required to call submitJob.')
    }

    if (options.harvestConfig !== undefined) {
      let harvestConfig: unknown
      try {
        harvestConfig = JSON.parse(options.harvestConfig)
      } catch {
        throw new Error('harvest must be valid JSON.')
      }
      validateHarvestConfig(harvestConfig)
    }

    const host = await this.hostRepository.get(providerId)
    if (!host) {
      throw new Error(`No compute host found with provider id "${providerId}".`)
    }

    const rawTimeout = options.timeoutSeconds
    if (rawTimeout !== undefined) {
      if (!Number.isFinite(rawTimeout)) {
        const error = new Error(
          `timeout_seconds must be a finite number (got ${rawTimeout}).`
        ) as Error & { computeCallError: ComputeCallError }
        error.computeCallError = {
          error_code: 'timeout',
          message: 'timeout_seconds must be a finite number.',
          retry_after_user_action: false
        }
        throw error
      }
      if (!Number.isInteger(rawTimeout) || rawTimeout <= 0) {
        const error = new Error(
          `timeout_seconds must be a positive integer (got ${rawTimeout}).`
        ) as Error & { computeCallError: ComputeCallError }
        error.computeCallError = {
          error_code: 'timeout',
          message: 'timeout_seconds must be a positive integer.',
          retry_after_user_action: false
        }
        throw error
      }
      if (rawTimeout > JOB_MAX_TIMEOUT_SECONDS) {
        const error = new Error(
          `timeout_seconds ${rawTimeout} exceeds the 7-day maximum. Use a scheduler driver for multi-day jobs.`
        ) as Error & { computeCallError: ComputeCallError }
        error.computeCallError = {
          error_code: 'timeout',
          message: `timeout_seconds exceeds the 7-day (${JOB_MAX_TIMEOUT_SECONDS}s) maximum.`,
          retry_after_user_action: false
        }
        throw error
      }
    }
    const timeoutSeconds = rawTimeout ?? JOB_DEFAULT_TIMEOUT_SECONDS

    let stagedEntries: StagedInputEntry[] = []
    let inputsSummary = ''
    if (options.inputs && options.inputs.length > 0) {
      const resolved = await resolveInputs(
        options.inputs,
        options.workspaceCwd,
        this.artifactResolver
      )
      stagedEntries = resolved.entries
      inputsSummary = resolved.inputsSummary
    }

    const jobId = randomUUID()
    const remoteWorkdir = computeRemoteWorkdir(host.scratchRoot, jobId)
    if (this.concurrencyManager) {
      const preview = await this.concurrencyManager.enqueue({
        jobId,
        sessionId: context.sessionId,
        providerId
      })
      if (preview === 'queue_full') throw queueFullError()
    }

    if (!this.approvalBroker) {
      throw new Error('ComputeApprovalBroker is required to call submitJob.')
    }
    const commandPreview =
      command.length > COMMAND_PREVIEW_MAX_LEN
        ? `${command.slice(0, COMMAND_PREVIEW_MAX_LEN)}…`
        : command
    const decision = await this.approvalBroker.requestWithContext(
      {
        provider_id: host.providerId,
        provider_name: host.displayName,
        shape: host.shape,
        intent,
        command_preview: commandPreview,
        command_full: command,
        inputs_summary: inputsSummary || undefined,
        timeout_seconds: timeoutSeconds,
        remote_workdir: remoteWorkdir
      },
      {
        sessionId: context.sessionId,
        projectId: context.projectId,
        operation: 'submit_job',
        ownerId: host.id
      }
    )

    if (decision === 'deny') {
      const error = new Error(
        `Job submission approval was denied for host "${host.displayName}".`
      ) as Error & { computeCallError: ComputeCallError }
      error.computeCallError = {
        error_code: 'approval_denied',
        message: `Approval denied for submit_job on ${host.displayName}.`,
        retry_after_user_action: false
      }
      throw error
    }

    const commandHash = hashCommand(command)
    const inputManifest = stagedEntries.length > 0 ? JSON.stringify(stagedEntries) : undefined
    const jobRepository = this.jobRepository
    let dispatchHandoffHeld = false
    const createRow = async (initialStatus: 'submitted' | 'queued'): Promise<void> => {
      if (initialStatus === 'submitted') {
        sharedDispatchTracker.begin(jobId)
        dispatchHandoffHeld = true
      }
      await jobRepository.create({
        id: jobId,
        providerId: host.providerId,
        shape: host.shape,
        sessionId: context.sessionId,
        projectId: context.projectId,
        intent,
        command,
        commandHash,
        environment: options.environment,
        resourceRequest: options.resourceRequest,
        inputManifest,
        outputManifest: options.outputManifest,
        harvestConfig: options.harvestConfig,
        timeoutSeconds,
        remoteWorkdir,
        initialStatus
      })
    }

    let initialStatus: 'submitted' | 'queued' = 'submitted'
    try {
      if (this.concurrencyManager) {
        const admitted = await this.concurrencyManager.admit(
          { sessionId: context.sessionId, providerId },
          createRow
        )
        if (admitted === 'queue_full') throw queueFullError()
        initialStatus = admitted
      } else {
        await createRow('submitted')
      }

      if (initialStatus === 'submitted') {
        void dispatchJob(jobId, {
          connectionBroker: this.connectionBroker,
          hostRepository: this.hostRepository,
          jobRepository: this.jobRepository,
          onJobUpdated: this.handleJobUpdated
        })
      }
    } finally {
      if (dispatchHandoffHeld) sharedDispatchTracker.end(jobId)
    }

    return {
      job_id: jobId,
      provider_id: host.providerId,
      status: initialStatus,
      remote_workdir: remoteWorkdir
    }
  }

  async getJobStatus(jobId: string): Promise<JobStatusResult> {
    if (!this.jobRepository) {
      throw new Error('ComputeJobRepository is required to call getJobStatus.')
    }
    const job = await this.jobRepository.get(jobId)
    if (!job) throw new Error(`No compute job found with id "${jobId}".`)
    return {
      job_id: job.job_id,
      status: job.status,
      exit_code: job.exit_code,
      stdout_tail: job.stdout_tail,
      stderr_tail: job.stderr_tail,
      remote_workdir: job.remote_workdir
    }
  }

  async getJobResult(jobId: string): Promise<JobResult> {
    if (!this.jobRepository) {
      throw new Error('ComputeJobRepository is required to call getJobResult.')
    }
    const job = await this.jobRepository.get(jobId)
    if (!job) throw new Error(`No compute job found with id "${jobId}".`)

    if (!TERMINAL_JOB_STATUSES.has(job.status) || !job.harvested_at) {
      return jobResultWithFiles(job, {
        featuredFiles: [],
        localFeaturedFiles: [],
        hiddenFiles: [],
        outputFiles: [],
        leftOnRemote: []
      })
    }
    const projection = await buildHarvestProjection(job, this.storageRoot)
    return jobResultWithFiles(job, projection, Boolean(this.storageRoot))
  }

  async setSessionConcurrencyLimit(sessionId: string, limit: number): Promise<void> {
    if (!this.concurrencyManager) {
      throw new Error('ConcurrencyManager is required to set session concurrency limit.')
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error(
        `Session concurrency limit must be an integer in the range 1..500 (got ${limit}).`
      )
    }
    await this.concurrencyManager.setSessionLimit(sessionId, limit)
  }

  async getSessionConcurrencyStatus(sessionId: string): Promise<SessionStatus> {
    if (!this.concurrencyManager) {
      throw new Error('ConcurrencyManager is required to get session concurrency status.')
    }
    const status = await this.concurrencyManager.getStatus(sessionId)
    for (const host of await this.hostRepository.list()) {
      if (!(host.providerId in status.provider_ceilings)) {
        status.provider_ceilings[host.providerId] = host.concurrencyLimit ?? 10
      }
    }
    return status
  }

  handleJobUpdated = (job: ComputeJob): void => {
    if (this.concurrencyManager) this.concurrencyManager.handleJobUpdated(job)
    else this.publishJobUpdated?.(job)
  }
}

const jobResultWithFiles = (
  job: ComputeJob,
  files: Pick<
    HarvestProjection,
    'featuredFiles' | 'localFeaturedFiles' | 'hiddenFiles' | 'outputFiles' | 'leftOnRemote'
  >,
  includeLocalFeaturedFiles = false
): JobResult => ({
  job_id: job.job_id,
  status: job.status,
  exit_code: job.exit_code,
  featured_files: files.featuredFiles,
  hidden_files: files.hiddenFiles,
  output_files: files.outputFiles,
  ...(includeLocalFeaturedFiles ? { localFeaturedFiles: files.localFeaturedFiles } : {}),
  left_on_remote: files.leftOnRemote,
  remote_workdir: job.remote_workdir,
  stdout_tail: job.stdout_tail,
  stderr_tail: job.stderr_tail
})

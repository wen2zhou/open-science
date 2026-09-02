import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type {
  ExecuteNotebookControlRequest,
  ExecuteShellRequest,
  NotebookCell,
  NotebookLanguage,
  NotebookOutput,
  NotebookRunInputFile,
  NotebookRunRecord,
  NotebookRunProvenanceContext,
  NotebookRunSource,
  NotebookRunStatus,
  NotebookWorkingFile,
  RunNotebookCellRequest
} from '../../shared/notebook'
import type { ExecutionFileEvidenceSummary } from '../../shared/execution-file-evidence'
import type { Logger } from '../logger'
import { getAppClaudeConfigDir } from '../settings/provider-env'
import { NotebookDataExecutionAdmissionOwner } from './data-execution-admission'
import {
  EnvironmentManifestPublicationError,
  EnvironmentStateTracker,
  type EnvironmentCaptureTarget
} from './environment-state-tracker'
import { detectManagedRuntimeMutation } from './managed-runtime-guard'
import { NotebookRunTerminalizationOwner } from './run-terminalization'
import { notebookLaneKey, notebookLaneScope } from './lane-identity'
import { NotebookRunSubmissionConflictError } from './repository'
import type {
  NotebookSessionAggregate,
  NotebookSessionExecutionResult,
  NotebookSessionMcpRpcConnection,
  NotebookSessionResolvedInterpreter,
  NotebookSessionRuntimeBinding
} from './session-aggregate'
import { notebookInterpreterIdentity } from './session-aggregate'
import {
  NotebookShellProcessAdapter,
  type NotebookShellProcess,
  type NotebookShellResult
} from './shell-process'
import { startWorkingFileObservation } from './working-file-observer'
import type { TransientViewImage } from './host-view-image-service'
import {
  unavailableNotebookDependencyProjection,
  type NotebookDependencyInterpreter,
  type NotebookDependencyProjection
} from './dependency-analysis'
import type { NotebookHelperModuleHost, NotebookHelperModuleScope } from './helper-module-host'
import { getNotebookFileEvidenceLocation } from './repository'
import { getNotebookInputRoot } from './input-staging'

type NotebookControlResult = Pick<
  NotebookSessionExecutionResult,
  'stdout' | 'stderr' | 'traceback' | 'outputs' | 'truncated' | 'workingFiles' | 'fileEvidence'
> & {
  status: Exclude<NotebookRunStatus, 'queued' | 'running'>
  viewImages?: readonly TransientViewImage[]
}

type NotebookControlCompletionInterceptor = {
  intercept<T>(options: {
    context: {
      sessionId: string
      turnId: string
      controlInvocationGeneration: number
      toolInvocationId: string
      originatingTurnId?: string
      originatingUserMessageId?: string
      attachmentIds?: string[]
      artifactIds?: string[]
    }
    execute(): Promise<T>
  }): Promise<{ kind: 'deliver'; result: T } | { kind: 'captured' }>
}

class NotebookControlCompletionCapturedError extends Error {
  constructor() {
    super('Control tool completion was captured for specialist handoff.')
    this.name = 'NotebookControlCompletionCapturedError'
  }
}

type McpRpcConnectionBinding = {
  sessionId: string
  projectId: string
  agentFrameId: string
  attemptId?: string
  executionCwd: string
}
type McpRpcConnectionResolver = (
  binding: McpRpcConnectionBinding
) => Promise<NotebookSessionMcpRpcConnection>

type NotebookExecutionOwnerOptions = {
  configRoot: string
  storageRoot: string
  runTerminalization: NotebookRunTerminalizationOwner
  dataExecutionAdmission: NotebookDataExecutionAdmissionOwner
  environmentStateTracker: Pick<EnvironmentStateTracker, 'prepareRun' | 'captureCompletedRun'>
  createEnvironmentCaptureTarget: (
    language: NotebookLanguage,
    environment: string,
    binding: NotebookSessionRuntimeBinding | undefined,
    resolvedInterpreter: NotebookSessionResolvedInterpreter | undefined,
    runtimeRoot: string
  ) => EnvironmentCaptureTarget
  setKernelStatus: (
    session: NotebookSessionAggregate,
    status: 'running' | 'idle',
    processKey: string
  ) => void
  persistRecoveredKernelIdle: (
    session: NotebookSessionAggregate,
    processKey: string
  ) => Promise<void>
  getMcpRpcConnectionResolver: () => McpRpcConnectionResolver | undefined
  notifyAvailable: (session: NotebookSessionAggregate, source: NotebookRunSource) => void
  projectDependencies: (
    session: NotebookSessionAggregate,
    run: NotebookRunRecord,
    interpreter?: NotebookDependencyInterpreter
  ) => Promise<NotebookDependencyProjection>
  helperModules: Pick<
    NotebookHelperModuleHost,
    'preflight' | 'plan' | 'commitInitialized' | 'loadedEvidence'
  >
  logger: Pick<Logger, 'error'>
  platform?: NodeJS.Platform
  shellProcess?: NotebookShellProcess
}

const errorToExecutionResult = (error: unknown, cwd: string): NotebookSessionExecutionResult => {
  const message = error instanceof Error ? error.message : String(error)

  return {
    status: 'failed',
    kernelDispatched: false,
    stdout: '',
    stderr: message,
    traceback: message,
    cwdAfter: cwd,
    outputs: [{ type: 'error', message, traceback: message }]
  }
}

const CANCELLED_MESSAGE =
  'Run cancelled: the runtime was disabled (stop running work) while this cell was executing.'
const cancelledExecutionResult = (cwd: string): NotebookSessionExecutionResult => ({
  ...errorToExecutionResult(new Error(CANCELLED_MESSAGE), cwd),
  status: 'cancelled'
})

// Root runtime ownership is Session-scoped, but every durable Run still belongs to the authenticated
// conversation Frame that produced it. A renderer state read may have created the shared owner first.
const runAgentFrameId = (
  session: NotebookSessionAggregate,
  provenanceContext: NotebookRunProvenanceContext | undefined
): string => provenanceContext?.agentFrameId ?? notebookLaneScope(session.lane).agentFrameId

type ImmutableInputIdentity = Pick<
  NotebookRunInputFile,
  | 'inputFileVersionId'
  | 'sourceKind'
  | 'sourceFileId'
  | 'sourceProjectId'
  | 'sourceSessionId'
  | 'filename'
  | 'sizeBytes'
  | 'checksum'
> & {
  sourceVersionNumber: number | null
  contentType: string | null
}

const immutableInputIdentities = (
  inputs: readonly NotebookRunInputFile[] | undefined
): ImmutableInputIdentity[] =>
  (inputs ?? [])
    .map((input) => ({
      inputFileVersionId: input.inputFileVersionId,
      sourceKind: input.sourceKind,
      sourceFileId: input.sourceFileId,
      sourceVersionNumber: input.sourceVersionNumber ?? null,
      sourceProjectId: input.sourceProjectId,
      sourceSessionId: input.sourceSessionId,
      filename: input.filename,
      contentType: input.contentType ?? null,
      sizeBytes: input.sizeBytes,
      checksum: input.checksum
    }))
    .sort((left, right) => left.inputFileVersionId.localeCompare(right.inputFileVersionId))

const dataRunFingerprint = (
  session: NotebookSessionAggregate,
  cell: Readonly<NotebookCell>,
  request: RunNotebookCellRequest,
  helperModuleIds: readonly string[] | undefined
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        lane: notebookLaneKey(session.lane),
        code: cell.code,
        language: cell.language,
        timeoutMs: request.timeoutMs ?? null,
        source: request.source ?? 'agent',
        inputKind: request.inputKind ?? 'cell',
        provenanceContext: request.provenanceContext ?? null,
        allowedHelperSkillIds: [...(request.registeredHelperSkillIds ?? [])].sort(),
        inputFiles: immutableInputIdentities(request.registeredInputFiles),
        helperModuleIds: helperModuleIds ?? []
      })
    )
    .digest('hex')

const controlRunFingerprint = (
  session: NotebookSessionAggregate,
  request: ExecuteNotebookControlRequest
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        lane: notebookLaneKey(session.lane),
        code: request.code,
        timeoutMs: request.timeoutMs ?? null,
        provenanceContext: request.provenanceContext ?? null,
        inputFiles: immutableInputIdentities(request.registeredInputFiles)
      })
    )
    .digest('hex')

const controlResultFromRun = (run: NotebookRunRecord): NotebookControlResult => {
  if (run.status === 'queued' || run.status === 'running') {
    throw new Error(`REPL Run ${run.runId} has no terminal foreground result.`)
  }
  return {
    status: run.status,
    stdout: run.text.stdout,
    stderr: run.text.stderr,
    traceback: run.text.traceback,
    outputs: run.outputs,
    ...(run.truncated ? { truncated: true } : {}),
    workingFiles: run.workingFiles,
    fileEvidence: run.fileEvidence
  }
}

class NotebookExecutionOwner {
  private readonly shellProcess: NotebookShellProcess
  private controlCompletionInterceptor: NotebookControlCompletionInterceptor | undefined
  private readonly activeDataSubmissions = new Map<
    string,
    {
      fingerprint: string
      promise: Promise<{
        run: NotebookRunRecord
        dependencyProjection: NotebookDependencyProjection
      }>
    }
  >()
  private readonly activeControlSubmissions = new Map<
    string,
    { fingerprint: string; promise: Promise<NotebookControlResult> }
  >()
  // Keeps only the latest terminal foreground result per REPL lane. Durable Run history remains the
  // canonical result; this bounded transient copy preserves view-image blocks when a lost local-RPC
  // response retries the same authorized submission during the active app lifetime.
  private readonly completedControlSubmissions = new Map<
    string,
    {
      submissionIdentity: string
      fingerprint: string
      result: NotebookControlResult
    }
  >()

  constructor(private readonly options: NotebookExecutionOwnerOptions) {
    this.shellProcess = options.shellProcess ?? new NotebookShellProcessAdapter(options.platform)
  }

  private inputRoot(session: NotebookSessionAggregate): string {
    return getNotebookInputRoot(this.options.storageRoot, session.projectId, session.sessionId)
  }

  private fileEvidenceLocation(session: NotebookSessionAggregate): {
    fileEvidenceStorageRoot: string
    fileEvidenceRoot: string
    fileEvidenceStoragePrefix: string
  } {
    const location = getNotebookFileEvidenceLocation(
      this.options.storageRoot,
      session.projectId,
      session.sessionId,
      session.lane
    )
    return {
      fileEvidenceStorageRoot: this.options.storageRoot,
      fileEvidenceRoot: location.root,
      fileEvidenceStoragePrefix: location.storageKeyPrefix
    }
  }

  setControlCompletionInterceptor(
    interceptor: NotebookControlCompletionInterceptor | undefined
  ): void {
    this.controlCompletionInterceptor = interceptor
  }
  async executeDataCell(
    session: NotebookSessionAggregate,
    request: RunNotebookCellRequest,
    signal?: AbortSignal,
    helperModuleIds?: readonly string[]
  ): Promise<{ run: NotebookRunRecord; dependencyProjection: NotebookDependencyProjection }> {
    const cell = session.cellView(request.cellId)
    if (session.isCellReceiving(cell.id)) {
      throw new Error(`Notebook cell is still receiving code: ${cell.id}`)
    }
    const submissionFingerprint = dataRunFingerprint(session, cell, request, helperModuleIds)
    let runId: string | undefined
    const submissionIdentity =
      request.executionInvocationId ??
      (runId = this.options.runTerminalization.allocateRunIdentity().runId)
    const submissionKey = `${notebookLaneKey(session.lane)}:${submissionIdentity}`
    const active = this.activeDataSubmissions.get(submissionKey)
    if (active) {
      if (active.fingerprint !== submissionFingerprint) {
        throw new NotebookRunSubmissionConflictError(submissionIdentity)
      }
      return active.promise
    }
    const promise = (async () => {
      if (request.executionInvocationId) {
        const existing = await this.options.runTerminalization.findSubmission(
          session,
          submissionIdentity
        )
        if (existing) {
          if (existing.submissionFingerprint !== submissionFingerprint) {
            throw new NotebookRunSubmissionConflictError(submissionIdentity)
          }
          const dependencyProjection = await this.options
            .projectDependencies(session, existing)
            .catch(() => unavailableNotebookDependencyProjection([existing]))
          return { run: existing, dependencyProjection }
        }
      }
      runId ??= this.options.runTerminalization.allocateRunIdentity().runId
      return this.executeDataCellDurable(
        session,
        cell,
        request,
        runId,
        submissionIdentity,
        submissionFingerprint,
        signal,
        helperModuleIds
      )
    })()
    const entry = { fingerprint: submissionFingerprint, promise }
    this.activeDataSubmissions.set(submissionKey, entry)
    try {
      return await promise
    } finally {
      if (this.activeDataSubmissions.get(submissionKey) === entry) {
        this.activeDataSubmissions.delete(submissionKey)
      }
    }
  }

  private async executeDataCellDurable(
    session: NotebookSessionAggregate,
    cell: Readonly<NotebookCell>,
    request: RunNotebookCellRequest,
    runId: string,
    submissionIdentity: string,
    submissionFingerprint: string,
    signal?: AbortSignal,
    helperModuleIds?: readonly string[]
  ): Promise<{ run: NotebookRunRecord; dependencyProjection: NotebookDependencyProjection }> {
    const admittedAt = Date.now()
    const executionCount = session.nextExecutionCount()
    const cwdBefore = session.cwd
    const admission = await this.options.dataExecutionAdmission.admit(session, cell)
    const { environment, processKey } = admission.route
    const { binding, resolvedInterpreter } = admission
    const kernelWasTerminatedAtAdmission =
      session.isKernelTerminated(processKey) ||
      session.kernelStatus(processKey) === 'terminated' ||
      session.hasDurableKernelTermination(processKey)
    const kernelEpoch = session.kernelEpoch(
      processKey,
      kernelWasTerminatedAtAdmission,
      notebookInterpreterIdentity(resolvedInterpreter)
    )
    const kernelEpochId = kernelEpoch.id
    const helperModuleScope: NotebookHelperModuleScope = {
      projectId: request.projectId,
      sessionId: request.sessionId,
      ...(request.executionInvocationId && request.registeredHelperSkillIds
        ? { allowedSkillIds: request.registeredHelperSkillIds }
        : {})
    }
    const helperRequest = await this.options.helperModules.preflight(
      cell.language,
      helperModuleIds,
      kernelEpoch,
      helperModuleScope
    )
    const helperPlan = await this.options.helperModules.plan(kernelEpoch, helperRequest)
    const queuedRun: NotebookRunRecord = {
      runId,
      submissionIdentity,
      submissionFingerprint,
      admittedAt,
      kernelEpochId,
      ...(request.executionInvocationId
        ? { executionInvocationId: request.executionInvocationId }
        : {}),
      cellId: cell.id,
      source: request.source ?? 'agent',
      inputKind: request.inputKind ?? 'cell',
      kernelKind: cell.language,
      script: cell.code,
      status: 'queued',
      startedAt: admittedAt,
      cwdBefore,
      executionCount,
      environment,
      ...(binding?.source === 'external' ? { runtimeId: binding.runtimeId } : {}),
      ...request.provenanceContext,
      agentFrameId: runAgentFrameId(session, request.provenanceContext),
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: request.provenanceContext ? (request.registeredInputFiles ?? []) : []
    }
    queuedRun.frozenPermissionScope = {
      allowedHelperSkillIds: [...(request.registeredHelperSkillIds ?? [])].sort()
    }
    queuedRun.frozenRuntimeTarget = {
      language: cell.language,
      environment,
      processKey,
      ...(binding?.runtimeId ? { runtimeId: binding.runtimeId } : {}),
      ...(binding?.source ? { source: binding.source } : {}),
      ...(binding?.interpreterPath ? { interpreterPath: binding.interpreterPath } : {}),
      ...(resolvedInterpreter?.command ? { command: resolvedInterpreter.command } : {}),
      ...(resolvedInterpreter?.args ? { args: [...resolvedInterpreter.args] } : {}),
      ...(resolvedInterpreter?.condaPrefix ? { condaPrefix: resolvedInterpreter.condaPrefix } : {})
    }
    if (!existsSync(cwdBefore)) {
      this.options.logger.error('session working directory is missing before execution', {
        sessionId: session.sessionId
      })
    }
    const durableAdmission = await this.options.runTerminalization.admit({ session, queuedRun })
    if (!durableAdmission.admitted) {
      const dependencyProjection = await this.options
        .projectDependencies(session, durableAdmission.run, resolvedInterpreter)
        .catch(() => unavailableNotebookDependencyProjection([durableAdmission.run]))
      return { run: durableAdmission.run, dependencyProjection }
    }
    this.options.notifyAvailable(session, request.source ?? 'agent')

    try {
      return await session.enqueueExecution(
        processKey,
        async () => {
          const kernelWasTerminated =
            kernelWasTerminatedAtAdmission ||
            session.isKernelTerminated(processKey) ||
            session.kernelStatus(processKey) === 'terminated' ||
            session.hasDurableKernelTermination(processKey)
          const kernelMarkedRunning = admission.rejection === undefined
          let executedOnLiveKernel = true
          let reachedExecutor = false
          const terminalized = await this.options.runTerminalization.runAdmitted({
            session,
            // Admission freezes the exact Version identities. The request-owned copies retain only
            // the monotonic access association gathered while that frozen Version is resolved.
            queuedRun: { ...durableAdmission.run, inputFiles: queuedRun.inputFiles },
            startLive: () => {
              session.markCellRunning(cell.id, runId, executionCount)
              if (kernelMarkedRunning) {
                session.clearKernelTerminated(processKey)
                this.options.setKernelStatus(session, 'running', processKey)
              }
            },
            invoke: () =>
              this.options.dataExecutionAdmission.runShared(
                session,
                admission,
                async (rejection) => {
                  if (rejection !== undefined) {
                    executedOnLiveKernel = false
                    return errorToExecutionResult(rejection, cwdBefore)
                  }
                  const target = this.options.createEnvironmentCaptureTarget(
                    cell.language,
                    environment,
                    binding,
                    resolvedInterpreter,
                    session.runtimeRoot
                  )
                  let environmentRunStart
                  try {
                    environmentRunStart =
                      await this.options.environmentStateTracker.prepareRun(target)
                  } catch (error) {
                    executedOnLiveKernel = false
                    return errorToExecutionResult(error, cwdBefore)
                  }
                  reachedExecutor = true
                  const executionResult = await session
                    .execute({
                      runId,
                      kernelEpochId,
                      code: durableAdmission.run.script,
                      ...(helperPlan.injections.length
                        ? { helperModules: helperPlan.injections }
                        : {}),
                      cwd: cwdBefore,
                      language: cell.language,
                      environment,
                      notebookSessionRoot: session.notebookSessionRoot,
                      inputRoot: this.inputRoot(session),
                      dataRoot: session.dataRoot,
                      ...this.fileEvidenceLocation(session),
                      runtimeRoot: session.runtimeRoot,
                      protectedDirs: [
                        getAppClaudeConfigDir(this.options.configRoot),
                        ...helperPlan.protectedGenerationRoots
                      ],
                      timeoutMs: request.timeoutMs,
                      signal,
                      resolvedInterpreter,
                      sessionId: session.sessionId,
                      projectId: session.projectId,
                      inputRunLeaseId: request.inputRunLeaseId
                    })
                    .catch((error: unknown) => {
                      executedOnLiveKernel = false
                      const fallback = session.consumeForceStopped(processKey)
                        ? cancelledExecutionResult(cwdBefore)
                        : errorToExecutionResult(error, cwdBefore)
                      return { ...fallback, kernelDispatched: true }
                    })
                  this.options.helperModules.commitInitialized(
                    kernelEpoch,
                    executionResult.helperModulesInitialized ?? []
                  )
                  const resultWithEvidence = {
                    ...executionResult,
                    ...this.options.helperModules.loadedEvidence(kernelEpoch)
                  }
                  const result =
                    resultWithEvidence.kernelDispatched === undefined
                      ? { ...resultWithEvidence, kernelDispatched: true }
                      : resultWithEvidence
                  if (result.status !== 'completed') return result
                  try {
                    const capture = await this.options.environmentStateTracker.captureCompletedRun(
                      target,
                      result.environmentOverlay,
                      environmentRunStart
                    )
                    return {
                      ...result,
                      environmentCapture: {
                        state:
                          capture.manifest.captureStatus === 'complete' ? 'available' : 'partial',
                        manifestChecksum: capture.checksum,
                        ...(capture.manifest.warnings?.length
                          ? { warnings: [...capture.manifest.warnings] }
                          : {})
                      },
                      environmentManifest: capture.manifest,
                      environmentManifestChecksum: capture.checksum
                    }
                  } catch (error) {
                    return {
                      ...result,
                      environmentCapture: {
                        state: 'unavailable',
                        reason:
                          error instanceof EnvironmentManifestPublicationError
                            ? 'environment-manifest-publication-failed'
                            : 'environment-capture-failed'
                      }
                    }
                  }
                }
              ),
            settleLive: (result) => {
              session.completeCellRun(cell.id, result.status, result.cwdAfter ?? cwdBefore)
            }
          })
          const run = terminalized.run
          if (
            terminalized.dispatched &&
            !session.isKernelTerminated(processKey) &&
            (executedOnLiveKernel || (kernelMarkedRunning && !reachedExecutor))
          ) {
            this.options.setKernelStatus(session, 'idle', processKey)
            if (kernelWasTerminated) {
              await this.options.persistRecoveredKernelIdle(session, processKey)
            }
          }
          const dependencyProjection = await this.options
            .projectDependencies(session, run, resolvedInterpreter)
            .catch(() => unavailableNotebookDependencyProjection([run]))
          return { run, dependencyProjection }
        },
        signal
      )
    } catch (error) {
      if (!signal?.aborted) throw error
      const run = await this.options.runTerminalization.cancelQueued(
        session,
        durableAdmission.run,
        signal.reason
      )
      if (run.status === 'queued' || run.status === 'running') {
        throw new Error(`Notebook queued cancellation lost its terminal race: ${run.runId}`)
      }
      session.markCellRunning(cell.id, runId, executionCount)
      session.completeCellRun(cell.id, run.status, run.cwdAfter ?? cwdBefore)
      const dependencyProjection = await this.options
        .projectDependencies(session, run, resolvedInterpreter)
        .catch(() => unavailableNotebookDependencyProjection([run]))
      return { run, dependencyProjection }
    }
  }
  async executeControl(
    session: NotebookSessionAggregate,
    request: ExecuteNotebookControlRequest,
    signal?: AbortSignal
  ): Promise<NotebookControlResult> {
    const submissionFingerprint = controlRunFingerprint(session, request)
    const initialIdentity = request.executionInvocationId
      ? undefined
      : this.options.runTerminalization.allocateRunIdentity()
    const submissionIdentity = request.executionInvocationId ?? initialIdentity!.runId
    const laneKey = notebookLaneKey(session.lane)
    const submissionKey = `${laneKey}:${submissionIdentity}`
    const active = this.activeControlSubmissions.get(submissionKey)
    if (active) {
      if (active.fingerprint !== submissionFingerprint) {
        throw new NotebookRunSubmissionConflictError(submissionIdentity)
      }
      return active.promise
    }
    const completed = this.completedControlSubmissions.get(laneKey)
    if (request.executionInvocationId && completed?.submissionIdentity === submissionIdentity) {
      if (completed.fingerprint !== submissionFingerprint) {
        throw new NotebookRunSubmissionConflictError(submissionIdentity)
      }
      return completed.result
    }

    const promise = (async () => {
      if (request.executionInvocationId) {
        const existing = await this.options.runTerminalization.findSubmission(
          session,
          submissionIdentity
        )
        if (existing) {
          if (existing.submissionFingerprint !== submissionFingerprint) {
            throw new NotebookRunSubmissionConflictError(submissionIdentity)
          }
          return controlResultFromRun(existing)
        }
      }
      const identity = initialIdentity ?? this.options.runTerminalization.allocateRunIdentity()
      return this.executeControlDurable(
        session,
        request,
        identity.runId,
        identity.sequence,
        submissionIdentity,
        submissionFingerprint,
        signal
      )
    })()
    const entry = { fingerprint: submissionFingerprint, promise }
    this.activeControlSubmissions.set(submissionKey, entry)
    try {
      const result = await promise
      if (request.executionInvocationId) {
        this.completedControlSubmissions.set(laneKey, {
          submissionIdentity,
          fingerprint: submissionFingerprint,
          result
        })
      }
      return result
    } finally {
      if (this.activeControlSubmissions.get(submissionKey) === entry) {
        this.activeControlSubmissions.delete(submissionKey)
      }
    }
  }

  private async executeControlDurable(
    session: NotebookSessionAggregate,
    request: ExecuteNotebookControlRequest,
    controlInvocationId: string,
    controlInvocationGeneration: number,
    submissionIdentity: string,
    submissionFingerprint: string,
    signal?: AbortSignal
  ): Promise<NotebookControlResult> {
    const admittedAt = Date.now()
    const replWasTerminated =
      session.kernelStatus('repl') === 'terminated' || session.hasDurableKernelTermination('repl')
    const kernelEpochId = session.kernelEpoch('repl', replWasTerminated).id
    const queuedRun: NotebookRunRecord = {
      runId: controlInvocationId,
      submissionIdentity,
      submissionFingerprint,
      admittedAt,
      kernelEpochId,
      ...(request.executionInvocationId
        ? { executionInvocationId: request.executionInvocationId }
        : {}),
      cellId: `repl-${controlInvocationId}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'repl',
      script: request.code,
      status: 'queued',
      startedAt: admittedAt,
      cwdBefore: session.cwd,
      ...request.provenanceContext,
      agentFrameId: runAgentFrameId(session, request.provenanceContext),
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: request.provenanceContext ? (request.registeredInputFiles ?? []) : []
    }
    queuedRun.frozenRuntimeTarget = {
      language: 'repl',
      environment: 'control-plane',
      processKey: 'repl'
    }

    // Resolve and retain the Session-owned Host SDK capability before the durable admission point.
    // The per-invocation scope is opened only when this FIFO entry actually dispatches.
    signal?.throwIfAborted()
    const mcpRpc = await session.resolveMcpRpcConnection(this.options.getMcpRpcConnectionResolver())
    signal?.throwIfAborted()
    const blockedMutation = detectManagedRuntimeMutation({
      source: request.code,
      surface: 'repl',
      runtimeRoot: session.runtimeRoot,
      cwd: session.cwd,
      platform: this.options.platform
    })
    const durableAdmission = await this.options.runTerminalization.admit({ session, queuedRun })
    if (!durableAdmission.admitted) return controlResultFromRun(durableAdmission.run)
    this.options.notifyAvailable(session, 'agent')

    const rawRun = (async (): Promise<NotebookControlResult> => {
      try {
        return await session.enqueueControl(
          () =>
            this.executeControlExclusive(
              session,
              request,
              durableAdmission.run,
              controlInvocationGeneration,
              replWasTerminated,
              mcpRpc,
              blockedMutation,
              signal
            ),
          signal
        )
      } catch (error) {
        if (!signal?.aborted || error !== signal.reason) throw error
        const run = await this.options.runTerminalization.cancelQueued(
          session,
          durableAdmission.run,
          signal.reason
        )
        return controlResultFromRun(run)
      }
    })()

    try {
      // The completion gate deliberately stays outside enqueueControl: an approved continuation may
      // re-enter this same Session and must not deadlock behind the old invocation's handoff.
      const interceptor = this.controlCompletionInterceptor
      let result: NotebookControlResult
      if (!interceptor) {
        result = await rawRun
      } else {
        const outcome = await interceptor.intercept({
          context: {
            sessionId: session.sessionId,
            turnId: controlInvocationId,
            toolInvocationId: controlInvocationId,
            controlInvocationGeneration,
            ...(request.provenanceContext
              ? {
                  originatingTurnId: request.provenanceContext.promptMessageId,
                  originatingUserMessageId:
                    request.provenanceContext.originMessageId ??
                    request.provenanceContext.promptMessageId
                }
              : {}),
            attachmentIds:
              request.registeredInputFiles
                ?.filter((input) => input.sourceKind === 'upload-version')
                .map((input) => input.sourceFileId) ?? [],
            artifactIds:
              request.registeredInputFiles
                ?.filter((input) => input.sourceKind === 'artifact-version')
                .map((input) => input.sourceFileId) ?? []
          },
          execute: () => rawRun
        })
        if (outcome.kind === 'captured') throw new NotebookControlCompletionCapturedError()
        result = outcome.result
      }
      if (result.status !== 'completed') {
        session.discardControlInvocation(controlInvocationId)
        return result
      }
      const viewImages = await session.completeControlInvocation(controlInvocationId)
      return viewImages.length > 0 ? { ...result, viewImages } : result
    } catch (error) {
      session.discardControlInvocation(controlInvocationId)
      throw error
    }
  }

  private async executeControlExclusive(
    session: NotebookSessionAggregate,
    request: ExecuteNotebookControlRequest,
    queuedRun: NotebookRunRecord,
    controlInvocationGeneration: number,
    replWasTerminated: boolean,
    mcpRpc: NotebookSessionMcpRpcConnection | undefined,
    blockedMutation: ReturnType<typeof detectManagedRuntimeMutation>,
    signal?: AbortSignal
  ): Promise<NotebookControlResult> {
    const runId = queuedRun.runId
    const kernelEpochId = queuedRun.kernelEpochId

    let executedOnLiveKernel = !blockedMutation
    const terminalized = await this.options.runTerminalization.runAdmitted({
      session,
      queuedRun,
      startLive: () => {
        if (!blockedMutation) {
          session.clearKernelTerminated('repl')
          this.setReplStatus(session, 'running')
        }
      },
      invoke: () =>
        (blockedMutation
          ? Promise.resolve(
              errorToExecutionResult(
                new Error(`MANAGED_RUNTIME_MUTATION_BLOCKED: ${blockedMutation.message}`),
                session.cwd
              )
            )
          : (() => {
              const releaseControlInvocation = mcpRpc?.beginControlInvocation?.({
                turnId: runId,
                controlInvocationGeneration,
                toolInvocationId: runId,
                ...(request.provenanceContext
                  ? {
                      originatingTurnId: request.provenanceContext.promptMessageId,
                      originatingUserMessageId:
                        request.provenanceContext.originMessageId ??
                        request.provenanceContext.promptMessageId
                    }
                  : {}),
                attachmentIds:
                  request.registeredInputFiles
                    ?.filter((input) => input.sourceKind === 'upload-version')
                    .map((input) => input.sourceFileId) ?? [],
                artifactIds:
                  request.registeredInputFiles
                    ?.filter((input) => input.sourceKind === 'artifact-version')
                    .map((input) => input.sourceFileId) ?? []
              })
              return session
                .execute({
                  runId,
                  kernelEpochId,
                  code: request.code,
                  kind: 'repl',
                  cwd: session.cwd,
                  notebookSessionRoot: session.notebookSessionRoot,
                  inputRoot: this.inputRoot(session),
                  dataRoot: session.dataRoot,
                  ...this.fileEvidenceLocation(session),
                  runtimeRoot: session.runtimeRoot,
                  protectedDirs: [getAppClaudeConfigDir(this.options.configRoot)],
                  timeoutMs: request.timeoutMs,
                  signal,
                  mcpRpcEndpoint: mcpRpc?.endpoint,
                  mcpRpcSocketPath: mcpRpc?.socketPath,
                  mcpRpcToken: mcpRpc?.token,
                  sessionId: session.sessionId,
                  projectId: session.projectId,
                  inputRunLeaseId: request.inputRunLeaseId,
                  controlInvocationId: runId
                })
                .finally(() => releaseControlInvocation?.())
            })()
        ).catch((error: unknown) => {
          executedOnLiveKernel = false
          return errorToExecutionResult(error, session.cwd)
        })
    })

    if (terminalized.dispatched && executedOnLiveKernel && !session.isKernelTerminated('repl')) {
      this.setReplStatus(session, 'idle')
      // A terminated status is durable; clear it once, while ordinary running/idle transitions stay
      // in memory and do not rewrite the whole run.json document.
      if (replWasTerminated) {
        await this.options.persistRecoveredKernelIdle(session, 'repl')
      }
    }

    const result = terminalized.result
    if (!result) return controlResultFromRun(terminalized.run)

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      traceback: result.traceback,
      outputs: result.outputs,
      ...(result.truncated ? { truncated: true } : {}),
      workingFiles: result.workingFiles,
      fileEvidence: result.fileEvidence
    }
  }

  async executeShell(
    session: NotebookSessionAggregate,
    request: ExecuteShellRequest,
    signal?: AbortSignal
  ): Promise<NotebookShellResult> {
    const { runId } = this.options.runTerminalization.allocateRunIdentity()
    const runningRun: NotebookRunRecord = {
      runId,
      ...(request.executionInvocationId
        ? { executionInvocationId: request.executionInvocationId }
        : {}),
      cellId: `bash-${runId}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'bash',
      script: request.command,
      status: 'running',
      startedAt: Date.now(),
      cwdBefore: session.cwd,
      ...request.provenanceContext,
      agentFrameId: runAgentFrameId(session, request.provenanceContext),
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: request.provenanceContext ? (request.registeredInputFiles ?? []) : []
    }

    // No per-Session queue; the repository serializes only the durable run writes.
    const { result } = await this.options.runTerminalization.run({
      session,
      runningRun,
      invoke: async () => {
        const workingFileObservation = await startWorkingFileObservation({
          dataRoot: session.dataRoot,
          notebookSessionRoot: session.notebookSessionRoot,
          ...this.fileEvidenceLocation(session),
          runId,
          signal
        })
        let workingFiles: NotebookWorkingFile[] = []
        let fileEvidence: ExecutionFileEvidenceSummary | undefined
        const blockedMutation = detectManagedRuntimeMutation({
          source: request.command,
          surface: this.options.platform === 'win32' ? 'powershell' : 'bash',
          runtimeRoot: session.runtimeRoot,
          cwd: session.cwd,
          platform: this.options.platform
        })
        let shellResult: NotebookShellResult | undefined
        try {
          shellResult = await (blockedMutation
            ? Promise.resolve<NotebookShellResult>({
                stdout: '',
                stderr: `MANAGED_RUNTIME_MUTATION_BLOCKED: ${blockedMutation.message}`,
                exitCode: 1
              })
            : this.shellProcess.execute({
                command: request.command,
                cwd: session.cwd,
                handoffDir: join(session.notebookSessionRoot, 'handoff'),
                runtimeRoot: session.runtimeRoot,
                notebookSessionRoot: session.notebookSessionRoot,
                inputRoot: this.inputRoot(session),
                protectedDirs: [getAppClaudeConfigDir(this.options.configRoot)],
                sessionId: session.sessionId,
                projectId: session.projectId,
                timeoutMs: request.timeoutMs,
                signal
              }))
        } finally {
          const observation = await workingFileObservation.finish(
            shellResult === undefined ||
              signal?.aborted ||
              shellResult.cancelled ||
              shellResult.exitCode === null
              ? AbortSignal.abort()
              : signal
          )
          workingFiles = observation.workingFiles
          fileEvidence = observation.fileEvidence
        }
        if (!shellResult) throw new Error('Notebook shell execution completed without a result.')
        const status: NotebookRunStatus = shellResult.cancelled
          ? 'cancelled'
          : shellResult.exitCode === 0
            ? 'completed'
            : shellResult.exitCode === null
              ? 'timeout'
              : 'failed'
        const outputs: NotebookOutput[] = [
          ...(shellResult.stdout
            ? [{ type: 'stream' as const, name: 'stdout' as const, text: shellResult.stdout }]
            : []),
          ...(shellResult.stderr
            ? [{ type: 'stream' as const, name: 'stderr' as const, text: shellResult.stderr }]
            : [])
        ]

        return {
          status,
          stdout: shellResult.stdout,
          stderr: shellResult.stderr,
          traceback: '',
          cwdAfter: session.cwd,
          outputs,
          truncated: shellResult.truncated,
          workingFiles,
          fileEvidence,
          exitCode: shellResult.exitCode
        }
      }
    })

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      ...(result.truncated ? { truncated: true } : {})
    }
  }

  private setReplStatus(session: NotebookSessionAggregate, status: 'running' | 'idle'): void {
    session.setKernelStatus('repl', status)
  }
}

export { NotebookControlCompletionCapturedError, NotebookExecutionOwner }
export type { NotebookControlCompletionInterceptor, NotebookControlResult }

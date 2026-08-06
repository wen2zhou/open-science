import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ArtifactFile } from '../../shared/artifacts'
import type { ArtifactRpcCapabilityBinding } from '../../shared/artifact-provenance'
import { getNotebookDataRoot, getNotebookSessionRoot } from '../notebook/repository'
import type { ArtifactRunContext } from '../artifacts/mcp-server'
import { ArtifactRepository, getArtifactCurrentRunFilePath } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'

const artifactTurnHandleKey = Symbol('artifact-turn-handle')

type ArtifactTurnHandle = {
  readonly [artifactTurnHandleKey]: symbol
}

type ArtifactTurnProvenanceContext = {
  rootFrameId?: string
  agentFrameId?: string
  messageBranchId?: string
  messageBranchAncestry?: string[]
  messageAncestry?: string[]
  runtimeSegmentId?: string
  promptMessageId?: string
}

type OpenArtifactTurnRequest = {
  appSessionId: string
  artifactStorageSessionId: string
  projectId: string
  agentName: string
  provenanceContext?: ArtifactTurnProvenanceContext
}

type OpenExecutionArtifactTurnRequest = OpenArtifactTurnRequest & {
  executionId: string
  handoffRouting?: 'execution' | 'session-current'
}

type ArtifactTurnWriteInput = {
  filename: string
  content: string
  mimeType?: string
  kind?: 'plan'
}

type ArtifactTurnPublication = {
  appSessionId: string
  artifactStorageSessionId: string
  runId: string
  promptMessageId: string
  artifactClaimId: string
  artifacts: ArtifactFile[]
}

type ArtifactTurnSnapshot = {
  executionId?: string
  appSessionId: string
  runId: string
  agentFrameId?: string
  messageBranchId?: string
  runtimeSegmentId?: string
  promptMessageId?: string
  phase: 'open' | 'sealing' | 'finalized' | 'disposed'
  outstandingWrites: number
  terminalResult?: { kind: 'empty' } | { kind: 'publication'; artifactCount: number }
}

type ArtifactTurnProvenance = {
  listRunVersions: (request: {
    projectId: string
    appSessionId: string
    artifactRunId: string
  }) => Promise<ArtifactFile[]>
  writeAppGeneratedVersion: (request: {
    projectId: string
    appSessionId: string
    artifactStorageSessionId: string
    artifactRunId: string
    rootFrameId: string
    agentFrameId: string
    messageBranchId: string
    messageBranchAncestry: string[]
    messageAncestry: string[]
    runtimeSegmentId: string
    promptMessageId: string
    agentName: string
    filename: string
    content: string
    contentType?: string
    kind?: 'plan'
  }) => Promise<ArtifactFile>
}

type ArtifactTurnOwnerOptions = {
  dataRoot: string
  repository: ArtifactRepository
  runRegistry: ArtifactRunRegistry
  runtimeInstanceId?: string
  now?: () => number
  issueRpcCapability?: (binding: ArtifactRpcCapabilityBinding) => string
  revokeRpcCapability?: (token: string) => Promise<void> | void
  provenance?: ArtifactTurnProvenance
  writeHandoffFile?: (filePath: string, content: string) => Promise<void>
  notebook?: {
    setArtifactProvenanceContext?: (
      sessionId: string,
      context:
        | {
            rootFrameId: string
            agentFrameId: string
            messageBranchId: string
            runtimeSegmentId: string
            promptMessageId: string
          }
        | undefined
    ) => void
  }
}

type ArtifactTurn = {
  executionId: string
  explicitExecution: boolean
  handoffRouting: 'execution' | 'session-current'
  appSessionId: string
  artifactStorageSessionId: string
  projectId: string
  runId: string
  currentRunFile: string
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  messageBranchAncestry: string[]
  messageAncestry: string[]
  runtimeSegmentId: string
  promptMessageId: string
  agentName: string
  rpcCapabilityToken?: string
  phase: 'open' | 'sealing' | 'finalized' | 'disposed'
  inFlightAppWrites: Set<Promise<ArtifactFile>>
  writeDrainPromise?: Promise<void>
  finalizationPromise?: Promise<ArtifactTurnPublication | undefined>
  disposalPromise?: Promise<void>
  terminalResult?: { kind: 'empty' } | { kind: 'publication'; artifactCount: number }
}

class ArtifactTurnOwner {
  private readonly activeTurnsBySession = new Map<string, ArtifactTurn>()
  private readonly activeTurnsByExecution = new Map<string, ArtifactTurn>()
  private readonly activeHandlesByExecution = new Map<string, ArtifactTurnHandle>()
  private readonly handoffQueues = new Map<string, Promise<void>>()
  private readonly turnsByHandle = new WeakMap<ArtifactTurnHandle, ArtifactTurn>()
  private readonly runtimeInstanceId: string
  private readonly now: () => number
  private sequence = 0

  constructor(private readonly options: ArtifactTurnOwnerOptions) {
    this.runtimeInstanceId = options.runtimeInstanceId ?? randomUUID()
    this.now = options.now ?? Date.now
  }

  async open(request: OpenArtifactTurnRequest): Promise<ArtifactTurnHandle> {
    const turn = this.createTurn(request, undefined, 'session-current')
    return this.activate(turn)
  }

  async openExecution(request: OpenExecutionArtifactTurnRequest): Promise<ArtifactTurnHandle> {
    if (!request.executionId.trim()) throw new Error('Artifact execution id is required.')
    if (this.activeTurnsByExecution.has(request.executionId)) {
      throw new Error(`Artifact execution is already active: ${request.executionId}`)
    }
    const turn = this.createTurn(
      request,
      request.executionId,
      request.handoffRouting ?? 'execution'
    )
    return this.activate(turn)
  }

  private async activate(turn: ArtifactTurn): Promise<ArtifactTurnHandle> {
    const runContext = this.createRunContext(turn)
    return this.withHandoffLock(turn.currentRunFile, async () => {
      let handoffWritten = false

      turn.rpcCapabilityToken = this.options.issueRpcCapability?.({
        executionId: turn.executionId,
        projectId: turn.projectId,
        appSessionId: turn.appSessionId,
        artifactStorageSessionId: turn.artifactStorageSessionId,
        artifactRunId: turn.runId,
        rootFrameId: turn.rootFrameId,
        agentFrameId: turn.agentFrameId,
        messageBranchId: turn.messageBranchId,
        messageBranchAncestry: turn.messageBranchAncestry,
        messageAncestry: turn.messageAncestry,
        runtimeSegmentId: turn.runtimeSegmentId,
        promptMessageId: turn.promptMessageId,
        agentName: turn.agentName,
        ...(this.options.notebook ? { notebookSessionId: turn.appSessionId } : {}),
        allowedMethods: ['artifactCreateVersion', 'artifactReplayVersion']
      })
      if (turn.rpcCapabilityToken) runContext.rpcCapabilityToken = turn.rpcCapabilityToken

      try {
        await mkdir(dirname(turn.currentRunFile), { recursive: true })
        await this.writeHandoffFile(turn.currentRunFile, runContext)
        handoffWritten = true
        this.options.notebook?.setArtifactProvenanceContext?.(turn.appSessionId, {
          rootFrameId: turn.rootFrameId,
          agentFrameId: turn.agentFrameId,
          messageBranchId: turn.messageBranchId,
          runtimeSegmentId: turn.runtimeSegmentId,
          promptMessageId: turn.promptMessageId
        })
      } catch (error) {
        if (turn.rpcCapabilityToken) {
          try {
            await this.options.revokeRpcCapability?.(turn.rpcCapabilityToken)
          } catch {
            // Preserve the activation failure while still attempting every remaining cleanup stage.
          }
        }
        if (handoffWritten) {
          try {
            await this.writeHandoffFile(turn.currentRunFile, {})
          } catch {
            // The original activation failure remains the caller-visible error.
          }
          try {
            this.options.notebook?.setArtifactProvenanceContext?.(turn.appSessionId, undefined)
          } catch {
            // The original activation failure remains the caller-visible error.
          }
        }
        throw error
      }

      this.activeTurnsByExecution.set(turn.executionId, turn)
      if (turn.handoffRouting === 'session-current') {
        this.activeTurnsBySession.set(turn.appSessionId, turn)
      }
      const handle: ArtifactTurnHandle = { [artifactTurnHandleKey]: Symbol(turn.runId) }
      this.turnsByHandle.set(handle, turn)
      this.activeHandlesByExecution.set(turn.executionId, handle)
      return handle
    })
  }

  activeRunIds(): string[] {
    return Array.from(this.activeTurnsByExecution.values(), (turn) => turn.runId)
  }

  promptMessageIdFor(sessionId: string): string | undefined {
    return this.activeTurnsBySession.get(sessionId)?.promptMessageId
  }

  handleForExecution(executionId: string): ArtifactTurnHandle {
    const handle = this.activeHandlesByExecution.get(executionId)
    if (!handle) throw new Error(`No active Artifact turn for execution: ${executionId}`)
    return handle
  }

  handoffFile(handle: ArtifactTurnHandle): string {
    return this.resolve(handle).currentRunFile
  }

  snapshot(handle: ArtifactTurnHandle): ArtifactTurnSnapshot {
    const turn = this.resolve(handle)
    return {
      ...(turn.explicitExecution
        ? {
            executionId: turn.executionId,
            agentFrameId: turn.agentFrameId,
            messageBranchId: turn.messageBranchId,
            runtimeSegmentId: turn.runtimeSegmentId,
            promptMessageId: turn.promptMessageId
          }
        : {}),
      appSessionId: turn.appSessionId,
      runId: turn.runId,
      phase: turn.phase,
      outstandingWrites: turn.inFlightAppWrites.size,
      ...(turn.terminalResult ? { terminalResult: turn.terminalResult } : {})
    }
  }

  writeForActiveTurn(sessionId: string, input: ArtifactTurnWriteInput): Promise<ArtifactFile> {
    const turn = sessionId ? this.activeTurnsBySession.get(sessionId) : undefined
    if (!turn || turn.phase !== 'open') {
      return Promise.reject(new Error('No active assistant turn to attach a generated file to.'))
    }

    return this.writeTurn(turn, input)
  }

  write(handle: ArtifactTurnHandle, input: ArtifactTurnWriteInput): Promise<ArtifactFile> {
    const turn = this.resolve(handle)
    if (turn.phase !== 'open') {
      return Promise.reject(new Error('Artifact turn is not open for writes.'))
    }
    return this.writeTurn(turn, input)
  }

  private writeTurn(turn: ArtifactTurn, input: ArtifactTurnWriteInput): Promise<ArtifactFile> {
    const write = this.options.provenance
      ? this.options.provenance.writeAppGeneratedVersion({
          projectId: turn.projectId,
          appSessionId: turn.appSessionId,
          artifactStorageSessionId: turn.artifactStorageSessionId,
          artifactRunId: turn.runId,
          rootFrameId: turn.rootFrameId,
          agentFrameId: turn.agentFrameId,
          messageBranchId: turn.messageBranchId,
          messageBranchAncestry: turn.messageBranchAncestry,
          messageAncestry: turn.messageAncestry,
          runtimeSegmentId: turn.runtimeSegmentId,
          promptMessageId: turn.promptMessageId,
          agentName: turn.agentName,
          filename: input.filename,
          content: input.content,
          contentType: input.mimeType,
          kind: input.kind
        })
      : this.options.repository.writePendingFile({
          projectName: turn.projectId,
          sessionId: turn.artifactStorageSessionId,
          runId: turn.runId,
          filename: input.filename,
          mimeType: input.mimeType,
          kind: input.kind,
          source: { kind: 'inline', content: input.content, encoding: 'utf8' }
        })

    turn.inFlightAppWrites.add(write)
    void write.then(
      () => turn.inFlightAppWrites.delete(write),
      () => turn.inFlightAppWrites.delete(write)
    )
    return write
  }

  finalize(handle: ArtifactTurnHandle): Promise<ArtifactTurnPublication | undefined> {
    const turn = this.resolve(handle)
    if (turn.disposalPromise && !turn.finalizationPromise) {
      return Promise.reject(new Error('Artifact turn is already disposing or disposed.'))
    }
    if (!turn.finalizationPromise) {
      const finalization = this.finalizeTurn(turn)
      turn.finalizationPromise = finalization
      void finalization.catch(() => {
        // Claim preparation can fail transiently. Preserve the runtime's existing finally retry while
        // keeping a concurrent disposal terminal and non-reopenable.
        if (turn.finalizationPromise === finalization && !turn.disposalPromise) {
          turn.finalizationPromise = undefined
        }
      })
    }
    return turn.finalizationPromise
  }

  dispose(handle: ArtifactTurnHandle): Promise<void> {
    const turn = this.resolve(handle)
    turn.disposalPromise ??= this.disposeAfterFinalization(turn)
    return turn.disposalPromise
  }

  private createTurn(
    request: OpenArtifactTurnRequest,
    executionId: string | undefined,
    handoffRouting: 'execution' | 'session-current'
  ): ArtifactTurn {
    this.sequence += 1
    const runId = `artifact-run-${this.now()}-${this.sequence}`
    const rootFrameId =
      request.provenanceContext?.rootFrameId ?? `root-frame-${request.appSessionId}`
    const messageBranchId =
      request.provenanceContext?.messageBranchId ?? `message-branch-${request.appSessionId}`
    const promptMessageId = request.provenanceContext?.promptMessageId ?? `prompt-${runId}`
    const messageBranchAncestry = [
      ...(request.provenanceContext?.messageBranchAncestry ?? []).filter(
        (branchId) => branchId !== messageBranchId
      ),
      messageBranchId
    ]
    const messageAncestry = [
      ...(request.provenanceContext?.messageAncestry ?? []).filter(
        (messageId) => messageId !== promptMessageId
      ),
      promptMessageId
    ]

    const sessionCurrentRunFile = getArtifactCurrentRunFilePath(
      this.options.dataRoot,
      request.projectId,
      request.artifactStorageSessionId
    )
    return {
      executionId: executionId ?? `legacy-root:${request.appSessionId}:${runId}`,
      explicitExecution: executionId !== undefined,
      handoffRouting,
      appSessionId: request.appSessionId,
      artifactStorageSessionId: request.artifactStorageSessionId,
      projectId: request.projectId,
      runId,
      currentRunFile:
        handoffRouting === 'session-current'
          ? sessionCurrentRunFile
          : join(dirname(sessionCurrentRunFile), 'executions', `${runId}.json`),
      rootFrameId,
      agentFrameId: request.provenanceContext?.agentFrameId ?? rootFrameId,
      messageBranchId,
      messageBranchAncestry,
      messageAncestry,
      runtimeSegmentId:
        request.provenanceContext?.runtimeSegmentId ?? `runtime-segment-${this.runtimeInstanceId}`,
      promptMessageId,
      agentName: request.agentName,
      phase: 'open',
      inFlightAppWrites: new Set()
    }
  }

  private createRunContext(turn: ArtifactTurn): ArtifactRunContext {
    const base = {
      artifactRunId: turn.runId,
      ...(turn.explicitExecution ? { executionId: turn.executionId } : {}),
      appSessionId: turn.appSessionId,
      rootFrameId: turn.rootFrameId,
      agentFrameId: turn.agentFrameId,
      messageBranchId: turn.messageBranchId,
      messageBranchAncestry: turn.messageBranchAncestry,
      messageAncestry: turn.messageAncestry,
      runtimeSegmentId: turn.runtimeSegmentId,
      promptMessageId: turn.promptMessageId,
      agentName: turn.agentName
    }
    return this.options.notebook
      ? {
          ...base,
          notebookSessionId: turn.appSessionId,
          notebookDataDir: getNotebookDataRoot(
            this.options.dataRoot,
            turn.projectId,
            turn.appSessionId
          ),
          notebookSessionRoot: getNotebookSessionRoot(
            this.options.dataRoot,
            turn.projectId,
            turn.appSessionId
          )
        }
      : base
  }

  private closeWrites(turn: ArtifactTurn): Promise<void> {
    if (turn.writeDrainPromise) return turn.writeDrainPromise

    turn.phase = 'sealing'
    const rpcDrain = turn.rpcCapabilityToken
      ? Promise.resolve().then(() =>
          this.options.revokeRpcCapability?.(turn.rpcCapabilityToken as string)
        )
      : Promise.resolve()
    turn.writeDrainPromise = (async () => {
      const [rpcResult] = await Promise.allSettled([
        rpcDrain,
        Promise.allSettled([...turn.inFlightAppWrites])
      ])
      if (rpcResult.status === 'rejected') throw rpcResult.reason
    })()
    return turn.writeDrainPromise
  }

  private async finalizeTurn(turn: ArtifactTurn): Promise<ArtifactTurnPublication | undefined> {
    await this.closeWrites(turn)

    let artifacts: ArtifactFile[]
    let artifactVersionIds: string[] | undefined
    if (this.options.provenance) {
      artifacts = await this.options.provenance.listRunVersions({
        projectId: turn.projectId,
        appSessionId: turn.appSessionId,
        artifactRunId: turn.runId
      })
      artifactVersionIds = artifacts
        .map((artifact) => artifact.versionId)
        .filter(Boolean) as string[]
    } else {
      artifacts = await this.options.repository.listPendingRunFiles({
        projectName: turn.projectId,
        sessionId: turn.artifactStorageSessionId,
        runId: turn.runId
      })
    }

    if (artifacts.length === 0) {
      turn.phase = 'finalized'
      turn.terminalResult = { kind: 'empty' }
      return undefined
    }

    await this.options.repository.prepareRunFinalization({
      projectName: turn.projectId,
      sourceSessionId: turn.artifactStorageSessionId,
      sessionId: turn.appSessionId,
      runId: turn.runId,
      ...(artifactVersionIds ? { artifactVersionIds } : {}),
      provenanceContext: {
        rootFrameId: turn.rootFrameId,
        agentFrameId: turn.agentFrameId,
        messageBranchId: turn.messageBranchId,
        runtimeSegmentId: turn.runtimeSegmentId,
        promptMessageId: turn.promptMessageId
      }
    })

    const artifactClaimId = this.options.runRegistry.register({
      projectName: turn.projectId,
      artifactSessionId: turn.artifactStorageSessionId,
      sessionId: turn.appSessionId,
      runId: turn.runId,
      artifactVersionIds,
      rootFrameId: turn.rootFrameId,
      agentFrameId: turn.agentFrameId,
      messageBranchId: turn.messageBranchId,
      messageBranchAncestry: turn.messageBranchAncestry,
      messageAncestry: turn.messageAncestry,
      runtimeSegmentId: turn.runtimeSegmentId,
      promptMessageId: turn.promptMessageId
    })
    const publication = {
      appSessionId: turn.appSessionId,
      artifactStorageSessionId: turn.artifactStorageSessionId,
      runId: turn.runId,
      promptMessageId: turn.promptMessageId,
      artifactClaimId,
      artifacts
    }
    turn.phase = 'finalized'
    turn.terminalResult = { kind: 'publication', artifactCount: artifacts.length }
    return publication
  }

  private async disposeAfterFinalization(turn: ArtifactTurn): Promise<void> {
    if (turn.finalizationPromise) {
      try {
        await turn.finalizationPromise
      } catch {
        // Disposal must still clear every ephemeral resource after failed claim preparation.
      }
    }
    await this.disposeTurn(turn)
  }

  private async disposeTurn(turn: ArtifactTurn): Promise<void> {
    const cleanupErrors: unknown[] = []
    try {
      await this.closeWrites(turn)
    } catch (error) {
      cleanupErrors.push(error)
    }

    await this.withHandoffLock(turn.currentRunFile, async () => {
      const activeTurn = this.activeTurnsBySession.get(turn.appSessionId)
      const ownsActiveTurn = activeTurn === turn
      const ownsExecutionTurn = this.activeTurnsByExecution.get(turn.executionId) === turn
      const ownsDistinctLegacyHandoff =
        turn.handoffRouting === 'session-current' &&
        activeTurn !== undefined &&
        activeTurn.currentRunFile !== turn.currentRunFile
      try {
        if (
          ownsActiveTurn ||
          ownsDistinctLegacyHandoff ||
          (turn.handoffRouting === 'execution' && ownsExecutionTurn)
        ) {
          await this.writeHandoffFile(turn.currentRunFile, {})
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        if (ownsActiveTurn) {
          this.options.notebook?.setArtifactProvenanceContext?.(turn.appSessionId, undefined)
        }
      } catch (error) {
        cleanupErrors.push(error)
      } finally {
        if (this.activeTurnsBySession.get(turn.appSessionId) === turn) {
          this.activeTurnsBySession.delete(turn.appSessionId)
        }
        if (this.activeTurnsByExecution.get(turn.executionId) === turn) {
          this.activeTurnsByExecution.delete(turn.executionId)
          this.activeHandlesByExecution.delete(turn.executionId)
        }
        turn.phase = 'disposed'
      }
    })
    if (cleanupErrors.length > 0) throw cleanupErrors[0]
  }

  private writeHandoffFile(filePath: string, value: ArtifactRunContext | object): Promise<void> {
    const content = `${JSON.stringify(value)}\n`
    return this.options.writeHandoffFile
      ? this.options.writeHandoffFile(filePath, content)
      : writeFile(filePath, content, 'utf8')
  }

  private withHandoffLock<T>(handoffFile: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.handoffQueues.get(handoffFile) ?? Promise.resolve()
    const current = previous.then(operation)
    const tail = current.then(
      () => undefined,
      () => undefined
    )
    this.handoffQueues.set(handoffFile, tail)
    void tail.then(() => {
      if (this.handoffQueues.get(handoffFile) === tail) {
        this.handoffQueues.delete(handoffFile)
      }
    })
    return current
  }

  private resolve(handle: ArtifactTurnHandle): ArtifactTurn {
    const turn = this.turnsByHandle.get(handle)
    if (!turn) throw new Error('Unknown Artifact turn handle')
    return turn
  }
}

export { ArtifactTurnOwner }
export type {
  ArtifactTurnHandle,
  ArtifactTurnOwnerOptions,
  ArtifactTurnPublication,
  ArtifactTurnSnapshot,
  ArtifactTurnWriteInput,
  OpenExecutionArtifactTurnRequest,
  OpenArtifactTurnRequest
}

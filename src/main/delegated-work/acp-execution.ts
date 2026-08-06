import type { PromptResponse } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'

import {
  getAcpRuntimeEventText,
  type AcpPermissionRequest,
  type AcpPermissionResponse,
  type AcpRuntimeEvent
} from '../../shared/acp'
import {
  DelegateExecutionError,
  type DelegateCapacityReservation,
  type DelegateExecution,
  type DelegateExecutionEvent,
  type DelegateExecutionInput,
  type DelegateExecutionOutcome,
  type DelegatePermissionResponse,
  type RunningDelegateExecution
} from './execution-port'
import { nativeDelegationAuditFailureMessage } from './certification'

type DelegateExecutionProvenance = Readonly<{
  projectId: string
  sessionId: string
  agentFrameId: string
  runtimeSegmentId: string
  promptMessageId?: string
  messageBranchId?: string
}>

type DelegateExecutionCapability = Readonly<{
  token?: string
  revoke(): Promise<void> | void
}>

type PreparedDelegateExecution = Readonly<{
  executionId: string
  provenance: DelegateExecutionProvenance
  workspace: Readonly<{ cwd: string }>
  runtimeHome: string
  frameworkId: string
  capability: DelegateExecutionCapability
  disposeResources?(): Promise<void> | void
}>

type AcpDelegateExecutionCallbacks = Readonly<{
  onProviderPromptAccepted(sessionId: string): void
  onEvent(event: AcpRuntimeEvent): void
  onPermissionRequest(request: AcpPermissionRequest): void
}>

type AcpDelegateRuntime = Readonly<{
  createSession(request: { cwd: string; specialistId?: string }): Promise<{ sessionId: string }>
  sendAppContinuation(request: {
    sessionId: string
    text: string
    suppressUserMessage?: boolean
    provenanceContext?: {
      promptMessageId: string
      agentFrameId: string
      messageBranchId?: string
      runtimeSegmentId: string
    }
  }): Promise<PromptResponse>
  cancelPrompt(request: { sessionId: string }): Promise<unknown>
  respondToPermission(response: AcpPermissionResponse): Promise<unknown>
  deleteSession(request: { sessionId: string }): Promise<unknown>
  shutdownForQuit(): Promise<{ reaped: boolean }>
}>

type AcpDelegateExecutionOptions = Readonly<{
  capacity: number
  prepare(
    input: DelegateExecutionInput
  ): Promise<PreparedDelegateExecution> | PreparedDelegateExecution
  assertFrameworkNativeDelegationDisabled(scope: PreparedDelegateExecution): Promise<void> | void
  createRuntime(
    scope: PreparedDelegateExecution,
    callbacks: AcpDelegateExecutionCallbacks
  ): AcpDelegateRuntime
  buildPrompt?(input: DelegateExecutionInput): string
}>

type Deferred<Value> = Readonly<{
  promise: Promise<Value>
  resolve(value: Value): void
  reject(error: unknown): void
}>

const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const assertPreparedScope = (
  input: DelegateExecutionInput,
  scope: PreparedDelegateExecution
): void => {
  if (scope.executionId !== input.attemptId) {
    throw new Error('prepared executionId must equal the Attempt identity')
  }
  if (
    scope.provenance.projectId !== input.session.projectId ||
    scope.provenance.sessionId !== input.session.sessionId ||
    scope.provenance.agentFrameId !== input.frameId ||
    scope.provenance.runtimeSegmentId !== input.runtimeSegmentId
  ) {
    throw new Error('prepared execution provenance does not match the delegated Attempt')
  }
  if (
    !scope.provenance.runtimeSegmentId.trim() ||
    !scope.workspace.cwd.trim() ||
    !scope.runtimeHome.trim() ||
    !scope.frameworkId.trim()
  ) {
    throw new Error('prepared execution scope is incomplete')
  }
}

const createAcpDelegateExecution = (options: AcpDelegateExecutionOptions): DelegateExecution => {
  if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
    throw new Error('delegate execution capacity must be a positive integer')
  }

  type Slot = { status: 'reserved' | 'running'; attemptId?: string }
  const slots = new Map<string, Slot>()
  const activeAttempts = new Set<string>()
  const activeRuntimeHomes = new Set<string>()
  const activeWorkspaces = new Set<string>()

  const releaseSlot = (slotId: string): void => {
    const slot = slots.get(slotId)
    if (!slot) return
    slots.delete(slotId)
    if (slot.attemptId) activeAttempts.delete(slot.attemptId)
  }

  const reserve = async (count: number): Promise<DelegateCapacityReservation> => {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new DelegateExecutionError('capacity', 'reservation count must be a positive integer')
    }
    if (slots.size + count > options.capacity) {
      throw new DelegateExecutionError(
        'capacity',
        `delegated execution capacity is ${options.capacity}`
      )
    }

    const slotIds = Array.from({ length: count }, () => `delegate-slot-${randomUUID()}`)
    for (const slotId of slotIds) slots.set(slotId, { status: 'reserved' })
    const owned = new Set(slotIds)
    return Object.freeze({
      slotIds: Object.freeze(slotIds),
      async release(slotId) {
        if (!owned.delete(slotId)) return
        releaseSlot(slotId)
      },
      async releaseAll() {
        for (const slotId of [...owned]) {
          owned.delete(slotId)
          releaseSlot(slotId)
        }
      }
    })
  }

  const run = (input: DelegateExecutionInput, slotId: string): RunningDelegateExecution => {
    const slot = slots.get(slotId)
    if (!slot || slot.status !== 'reserved') {
      throw new Error(`delegate execution slot is not reserved: ${slotId}`)
    }
    if (activeAttempts.has(input.attemptId)) {
      throw new Error(`delegate Attempt is already running: ${input.attemptId}`)
    }
    slot.status = 'running'
    slot.attemptId = input.attemptId
    activeAttempts.add(input.attemptId)

    const acceptance = deferred<void>()
    const terminal = deferred<DelegateExecutionOutcome>()
    void acceptance.promise.catch(() => undefined)
    void terminal.promise.catch(() => undefined)
    const listeners = new Set<(event: DelegateExecutionEvent) => void>()
    const pendingMessages: string[] = []
    const pendingPermissions = new Set<string>()
    let providerSessionId: string | undefined
    let runtime: AcpDelegateRuntime | undefined
    let scope: PreparedDelegateExecution | undefined
    let ownsRuntimeHome = false
    let ownsWorkspace = false
    let writable = true
    let capabilityRevoked = false
    let acceptedSettled = false
    let terminalSettled = false
    let cancelRequested = false
    let currentResponse: string[] = []

    const settleAccepted = (error?: unknown): void => {
      if (acceptedSettled) return
      acceptedSettled = true
      if (error === undefined) acceptance.resolve()
      else acceptance.reject(error)
    }
    const publish = (event: DelegateExecutionEvent): void => {
      if (!writable || terminalSettled) return
      for (const listener of listeners) listener(event)
    }
    const callbacks: AcpDelegateExecutionCallbacks = {
      onProviderPromptAccepted(sessionId) {
        if (writable && sessionId === providerSessionId) settleAccepted()
      },
      onEvent(event) {
        if (!writable || event.sessionId !== providerSessionId) return
        const text = getAcpRuntimeEventText(event)
        if (event.kind === 'message' && event.role === 'assistant' && text) {
          currentResponse.push(text)
          publish({ kind: 'message', text })
        }
      },
      onPermissionRequest(request) {
        if (!writable || request.sessionId !== providerSessionId) return
        pendingPermissions.add(request.requestId)
        publish({
          kind: 'permission',
          awaiting: true,
          requestId: request.requestId,
          title: request.title,
          options: request.options.map(({ optionId, name, kind }) => ({ optionId, name, kind }))
        })
      }
    }

    const revokeWrites = async (): Promise<void> => {
      writable = false
      pendingPermissions.clear()
      if (scope && !capabilityRevoked) {
        capabilityRevoked = true
        await scope.capability.revoke()
      }
    }
    const cleanup = async (): Promise<void> => {
      let firstError: unknown
      try {
        await revokeWrites()
      } catch (error) {
        firstError = error
      }
      if (runtime && providerSessionId) {
        try {
          await runtime.deleteSession({ sessionId: providerSessionId })
        } catch (error) {
          firstError ??= error
        }
      }
      if (runtime) {
        try {
          await runtime.shutdownForQuit()
        } catch (error) {
          firstError ??= error
        }
      }
      if (scope) {
        if (ownsRuntimeHome) {
          activeRuntimeHomes.delete(scope.runtimeHome)
          ownsRuntimeHome = false
        }
        if (ownsWorkspace) {
          activeWorkspaces.delete(scope.workspace.cwd)
          ownsWorkspace = false
        }
        try {
          await scope.disposeResources?.()
        } catch (error) {
          firstError ??= error
        }
      }
      listeners.clear()
      releaseSlot(slotId)
      if (firstError !== undefined) throw firstError
    }

    const promptRequest = (
      text: string
    ): Parameters<AcpDelegateRuntime['sendAppContinuation']>[0] => ({
      sessionId: providerSessionId!,
      text,
      suppressUserMessage: true,
      ...(scope?.provenance.promptMessageId
        ? {
            provenanceContext: {
              promptMessageId: scope.provenance.promptMessageId,
              agentFrameId: scope.provenance.agentFrameId,
              ...(scope.provenance.messageBranchId
                ? { messageBranchId: scope.provenance.messageBranchId }
                : {}),
              runtimeSegmentId: scope.provenance.runtimeSegmentId
            }
          }
        : {})
    })

    const work = (async (): Promise<void> => {
      try {
        scope = await options.prepare(input)
        assertPreparedScope(input, scope)
        try {
          await options.assertFrameworkNativeDelegationDisabled(scope)
        } catch {
          throw new DelegateExecutionError(
            'unsupported_framework',
            nativeDelegationAuditFailureMessage(scope.frameworkId)
          )
        }
        if (activeRuntimeHomes.has(scope.runtimeHome)) {
          throw new Error(`runtime home is already active: ${scope.runtimeHome}`)
        }
        if (activeWorkspaces.has(scope.workspace.cwd)) {
          throw new Error(`workspace is already active: ${scope.workspace.cwd}`)
        }
        activeRuntimeHomes.add(scope.runtimeHome)
        ownsRuntimeHome = true
        activeWorkspaces.add(scope.workspace.cwd)
        ownsWorkspace = true
        if (cancelRequested) {
          settleAccepted()
          await cleanup()
          terminalSettled = true
          terminal.resolve({ status: 'cancelled' })
          return
        }

        runtime = options.createRuntime(scope, callbacks)
        const created = await runtime.createSession({
          cwd: scope.workspace.cwd,
          ...(input.profile ? { specialistId: input.profile } : {})
        })
        providerSessionId = created.sessionId
        if (cancelRequested) {
          settleAccepted()
          await cleanup()
          terminalSettled = true
          terminal.resolve({ status: 'cancelled' })
          return
        }

        let nextPrompt = options.buildPrompt?.(input) ?? input.task
        let response = ''
        while (!cancelRequested) {
          currentResponse = []
          const outcome = await runtime.sendAppContinuation(promptRequest(nextPrompt))
          response = currentResponse.join('')
          if (cancelRequested || outcome.stopReason === 'cancelled') break
          const queued = pendingMessages.shift()
          if (queued === undefined) break
          nextPrompt = queued
        }

        await cleanup()
        terminalSettled = true
        if (cancelRequested) terminal.resolve({ status: 'cancelled' })
        else terminal.resolve({ status: 'completed', response })
      } catch (error) {
        settleAccepted(error)
        let terminalError = error
        try {
          await cleanup()
        } catch (cleanupError) {
          terminalError = cleanupError
        }
        terminalSettled = true
        terminal.reject(terminalError)
      }
    })()

    return Object.freeze({
      accepted: acceptance.promise,
      completion: terminal.promise,
      subscribe(listener) {
        if (!terminalSettled) listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendMessage(message) {
        if (!writable || terminalSettled || cancelRequested) {
          throw new Error('delegate execution is no longer running')
        }
        pendingMessages.push(message)
      },
      async respondToPermission(response: DelegatePermissionResponse) {
        if (!writable || !runtime || !pendingPermissions.delete(response.requestId)) {
          throw new Error(`permission request is not active: ${response.requestId}`)
        }
        try {
          await runtime.respondToPermission(response)
        } catch (error) {
          if (writable && !terminalSettled && !cancelRequested) {
            pendingPermissions.add(response.requestId)
          }
          throw error
        }
        publish({ kind: 'permission', awaiting: false, requestId: response.requestId })
      },
      async cancel() {
        if (terminalSettled) return
        cancelRequested = true
        await revokeWrites().catch(() => undefined)
        if (runtime && providerSessionId) {
          await runtime.cancelPrompt({ sessionId: providerSessionId }).catch(() => undefined)
        }
        await work.catch(() => undefined)
      }
    })
  }

  return Object.freeze({ reserve, run })
}

export { createAcpDelegateExecution }
export type {
  AcpDelegateExecutionCallbacks,
  AcpDelegateExecutionOptions,
  AcpDelegateRuntime,
  DelegateExecutionCapability,
  DelegateExecutionProvenance,
  PreparedDelegateExecution
}

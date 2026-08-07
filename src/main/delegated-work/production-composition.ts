import { join } from 'node:path'

import type { AcpPermissionRequest, AcpPermissionResponse } from '../../shared/acp'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { SpecialistProfileView } from '../../shared/specialist'
import type { AgentFrameworkId } from '../../shared/settings'
import type { DelegatedWorkRecordCommands, SessionKey } from './session-records'
import type { DelegateExecution } from './execution-port'
import {
  createDurableDelegatedWork,
  type DurableDelegatedWork,
  type RootDelegatePermissionEvent,
  type RootDelegatePermissionRequest
} from './durable-delegated-work'
import { createProductionFrameWorkspace, type ResolvedImmutableInput } from './frame-workspace'
import { createSessionDelegatedWorkRecords } from './session-record-adapter'

type CertifiedSessionFramework = Readonly<{
  frameworkId: AgentFrameworkId
  execution: DelegateExecution
  assertAvailable(): Promise<void> | void
}>

type ProductionDelegatedWorkOptions = Readonly<{
  dataRoot: string
  sessions: Readonly<{
    commands: DelegatedWorkRecordCommands
    readSession(key: SessionKey): Promise<PersistedChatSession | undefined>
  }>
  resolveInput(identity: string, session: SessionKey): Promise<ResolvedImmutableInput>
  frameworks: Readonly<{
    forSession(session: PersistedChatSession): Promise<CertifiedSessionFramework>
  }>
  resolveSpecialist?(
    profileId: string
  ): Promise<SpecialistProfileView | undefined> | SpecialistProfileView | undefined
}>

type RootDelegatedWorkEvent =
  | Readonly<{ kind: 'permission-requested'; request: AcpPermissionRequest }>
  | Readonly<{ kind: 'permission-settled'; requestId: string }>

type RootDelegatedWorkControl = Readonly<{
  pendingPermissions(): readonly AcpPermissionRequest[]
  subscribe(listener: (event: RootDelegatedWorkEvent) => void): () => void
  respondToPermission(response: AcpPermissionResponse): Promise<boolean>
  stopSession(sessionId: string): Promise<void>
  stopAll(): Promise<void>
  deleteSession(sessionId: string): Promise<void>
}>

type ProductionDelegatedWorkComposition = Readonly<{
  host: Pick<
    DurableDelegatedWork,
    'delegate' | 'children' | 'collect' | 'stopChildren' | 'sendMessage'
  >
  root: RootDelegatedWorkControl
}>

type ScopedWork = Readonly<{ key: SessionKey; work: DurableDelegatedWork }>

const keyOf = (key: SessionKey): string => `${key.projectId}\u0000${key.sessionId}`

const permissionPublicId = (session: SessionKey, request: RootDelegatePermissionRequest): string =>
  `delegated:${encodeURIComponent(session.projectId)}:${encodeURIComponent(session.sessionId)}:${encodeURIComponent(request.frameId)}:${encodeURIComponent(request.attemptId)}:${encodeURIComponent(request.requestId)}`

const createProductionDelegatedWorkComposition = (
  options: ProductionDelegatedWorkOptions
): ProductionDelegatedWorkComposition => {
  const workspace = createProductionFrameWorkspace({
    root: join(options.dataRoot, 'delegated-work'),
    resolveInput: options.resolveInput
  })
  const works = new Map<string, Promise<ScopedWork>>()
  const permissions = new Map<
    string,
    Readonly<{ key: SessionKey; request: RootDelegatePermissionRequest }>
  >()
  const listeners = new Set<(event: RootDelegatedWorkEvent) => void>()

  const publish = (event: RootDelegatedWorkEvent): void => {
    for (const listener of listeners) listener(event)
  }
  const projectPermission = (
    key: SessionKey,
    request: RootDelegatePermissionRequest
  ): AcpPermissionRequest => ({
    requestId: permissionPublicId(key, request),
    sessionId: key.sessionId,
    toolCallId: request.frameId,
    title: request.action,
    options: request.options.map((option) => ({ ...option })),
    delegated: {
      frameId: request.frameId,
      attemptId: request.attemptId,
      childTitle: request.childTitle,
      riskScope: request.riskScope
    }
  })
  const observePermission = (key: SessionKey, event: RootDelegatePermissionEvent): void => {
    const publicId = permissionPublicId(key, event.request)
    if (event.kind === 'requested') {
      permissions.set(publicId, { key, request: event.request })
      publish({ kind: 'permission-requested', request: projectPermission(key, event.request) })
      return
    }
    if (permissions.delete(publicId)) publish({ kind: 'permission-settled', requestId: publicId })
  }

  const createScopedWork = async (key: SessionKey): Promise<ScopedWork> => {
    const session = await options.sessions.readSession(key)
    if (!session || session.id !== key.sessionId || session.projectId !== key.projectId) {
      throw new Error('Delegated Work Session is unavailable.')
    }
    if (!session.agentFrameworkId) {
      throw new Error('Delegated Work requires a durable Session framework identity.')
    }
    const framework = await options.frameworks.forSession(session)
    if (framework.frameworkId !== session.agentFrameworkId) {
      throw new Error('Delegated Work framework composition does not match the durable Session.')
    }
    await framework.assertAvailable()
    const records = createSessionDelegatedWorkRecords(
      {
        commands: options.sessions.commands,
        readSession: options.sessions.readSession,
        frameworkId: framework.frameworkId
      },
      key
    )
    const work = createDurableDelegatedWork({
      execution: framework.execution,
      records,
      assertAvailable: framework.assertAvailable,
      resolveSpecialist: options.resolveSpecialist,
      validateInput: (identity) => workspace.validateInput(identity, key),
      workspace,
      onRootPermissionEvent: (event) => observePermission(key, event)
    })
    await work.recoverInterrupted()
    return Object.freeze({ key, work })
  }

  const workFor = (key: SessionKey): Promise<ScopedWork> => {
    const identity = keyOf(key)
    const existing = works.get(identity)
    if (existing) return existing
    const created = createScopedWork(key)
    works.set(identity, created)
    void created.catch(() => {
      if (works.get(identity) === created) works.delete(identity)
    })
    return created
  }
  const worksForSession = async (sessionId: string): Promise<ScopedWork[]> =>
    Promise.all(
      [...works.entries()]
        .filter(([identity]) => identity.endsWith(`\u0000${sessionId}`))
        .map(([, work]) => work)
    )

  const host: ProductionDelegatedWorkComposition['host'] = Object.freeze({
    async delegate(caller, request, delegateOptions) {
      return (await workFor(caller.session)).work.delegate(caller, request, delegateOptions)
    },
    async children(caller, frameIds) {
      return (await workFor(caller.session)).work.children(caller, frameIds)
    },
    async collect(caller, frameIds) {
      return (await workFor(caller.session)).work.collect(caller, frameIds)
    },
    async stopChildren(caller, frameIds) {
      return (await workFor(caller.session)).work.stopChildren(caller, frameIds)
    },
    async sendMessage(caller, targetFrameId, message, kind) {
      return (await workFor(caller.session)).work.sendMessage(caller, targetFrameId, message, kind)
    }
  })

  const root: RootDelegatedWorkControl = Object.freeze({
    pendingPermissions: () =>
      Object.freeze(
        [...permissions.values()].map(({ key, request }) => projectPermission(key, request))
      ),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async respondToPermission(response) {
      const pending = permissions.get(response.requestId)
      if (!pending) {
        if (response.requestId.startsWith('delegated:')) {
          throw new Error('Delegated permission request is no longer active.')
        }
        return false
      }
      const scoped = await workFor(pending.key)
      await scoped.work.respondToPermission(pending.key, {
        frameId: pending.request.frameId,
        attemptId: pending.request.attemptId,
        requestId: pending.request.requestId,
        ...(response.optionId ? { optionId: response.optionId } : {}),
        ...(response.cancelled ? { cancelled: true } : {})
      })
      return true
    },
    async stopSession(sessionId) {
      const scoped = await worksForSession(sessionId)
      await Promise.all(scoped.map(({ key, work }) => work.stopSession(key)))
    },
    async stopAll() {
      const scoped = await Promise.all([...works.values()])
      await Promise.all(scoped.map(({ key, work }) => work.stopSession(key)))
    },
    async deleteSession(sessionId) {
      const scoped = await worksForSession(sessionId)
      await Promise.all(scoped.map(({ key, work }) => work.deleteSession(key)))
      for (const { key } of scoped) works.delete(keyOf(key))
      for (const [requestId, pending] of permissions) {
        if (pending.key.sessionId === sessionId) permissions.delete(requestId)
      }
    }
  })

  return Object.freeze({ host, root })
}

export { createProductionDelegatedWorkComposition }
export type {
  CertifiedSessionFramework,
  ProductionDelegatedWorkComposition,
  ProductionDelegatedWorkOptions,
  RootDelegatedWorkControl,
  RootDelegatedWorkEvent
}

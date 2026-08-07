import { join } from 'node:path'

import type { AcpPermissionRequest, AcpPermissionResponse } from '../../shared/acp'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { SpecialistProfileView } from '../../shared/specialist'
import type { AgentFrameworkId } from '../../shared/settings'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import {
  createDelegatedArtifactEvidence,
  type DelegatedArtifactEvidenceOptions
} from './delegated-artifact-evidence'
import {
  createDelegatedReviewEvidence,
  type DelegatedReviewEvidenceOptions
} from './delegated-review-evidence'
import type { DelegatedWorkRecordCommands, SessionKey } from './session-records'
import type { DelegateExecution } from './execution-port'
import {
  createDurableDelegatedWork,
  DurableDelegatedWorkError,
  type DurableDelegatedWork,
  type ParentMessageDelivery,
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
    findSessions?(sessionId: string): Promise<readonly PersistedChatSession[]>
  }>
  resolveInput(identity: string, session: SessionKey): Promise<ResolvedImmutableInput>
  frameworks: Readonly<{
    forSession(session: PersistedChatSession): Promise<CertifiedSessionFramework>
  }>
  resolveSpecialist?(
    profileId: string
  ): Promise<SpecialistProfileView | undefined> | SpecialistProfileView | undefined
  artifactEvidence?: DelegatedArtifactEvidenceOptions
  reviewEvidence?: DelegatedReviewEvidenceOptions
  parentMessages?: Readonly<{ deliver(delivery: ParentMessageDelivery): Promise<void> }>
}>

type RootDelegatedWorkEvent =
  | Readonly<{ kind: 'permission-requested'; request: AcpPermissionRequest }>
  | Readonly<{ kind: 'permission-settled'; requestId: string }>
  | Readonly<{ kind: 'records-changed'; sessionId: string }>
  | Readonly<{ kind: 'admission-rejected'; sessionId: string; reason: string }>

type RootDelegatedWorkControl = Readonly<{
  pendingPermissions(): readonly AcpPermissionRequest[]
  unavailableReasons?(): Readonly<Record<string, string>>
  subscribe(listener: (event: RootDelegatedWorkEvent) => void): () => void
  respondToPermission(response: AcpPermissionResponse): Promise<boolean>
  setPermissionProfile(sessionId: string, profile: PermissionProfileId): Promise<void>
  stopSession(sessionId: string): Promise<void>
  stopAll(): Promise<void>
  deleteSession(sessionId: string): Promise<void>
}>

type ProductionDelegatedWorkComposition = Readonly<{
  host: Pick<
    DurableDelegatedWork,
    'delegate' | 'children' | 'collect' | 'stopChildren' | 'sendMessage' | 'readAgentFrame'
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
  const unavailableReasons = new Map<string, string>()
  const artifactEvidence = options.artifactEvidence
    ? createDelegatedArtifactEvidence(options.artifactEvidence)
    : undefined
  const reviewEvidence = options.reviewEvidence
    ? createDelegatedReviewEvidence(options.reviewEvidence)
    : undefined

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
    const records = createSessionDelegatedWorkRecords(
      {
        commands: options.sessions.commands,
        readSession: options.sessions.readSession,
        frameworkId: framework.frameworkId,
        onRecordsChanged: () => publish({ kind: 'records-changed', sessionId: key.sessionId })
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
      artifactEvidence,
      reviewEvidence,
      deliverToParent: options.parentMessages?.deliver,
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
      try {
        const result = await (
          await workFor(caller.session)
        ).work.delegate(caller, request, delegateOptions)
        unavailableReasons.delete(caller.session.sessionId)
        return result
      } catch (error) {
        const session = await options.sessions.readSession(caller.session)
        if (
          error instanceof DurableDelegatedWorkError &&
          error.userFacingUnavailableReason &&
          (session?.runtimeContext?.delegatedWork?.records.length ?? 0) === 0
        ) {
          const reason = error.userFacingUnavailableReason
          unavailableReasons.set(caller.session.sessionId, reason)
          publish({
            kind: 'admission-rejected',
            sessionId: caller.session.sessionId,
            reason
          })
        }
        throw error
      }
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
    },
    async readAgentFrame(session, frameId) {
      return (await workFor(session)).work.readAgentFrame(session, frameId)
    }
  })

  const root: RootDelegatedWorkControl = Object.freeze({
    pendingPermissions: () =>
      Object.freeze(
        [...permissions.values()].map(({ key, request }) => projectPermission(key, request))
      ),
    unavailableReasons: () => Object.freeze(Object.fromEntries(unavailableReasons)),
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
    async setPermissionProfile(sessionId, profile) {
      const scoped = await worksForSession(sessionId)
      await Promise.all(scoped.map(({ key, work }) => work.setPermissionProfile(key, profile)))
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
      const durableSessions = (await options.sessions.findSessions?.(sessionId)) ?? []
      const keys = new Map<string, SessionKey>()
      for (const { key } of scoped) keys.set(keyOf(key), key)
      for (const session of durableSessions) {
        if (session.id === sessionId) {
          const key = { projectId: session.projectId, sessionId: session.id }
          keys.set(keyOf(key), key)
        }
      }
      const workDeletion = await Promise.allSettled(
        scoped.map(({ key, work }) => work.deleteSession(key))
      )
      // Workspace deletion is an independent durable cleanup boundary. Repeat it for every Session
      // identity so a restart (with an empty work cache) and a failed work teardown both remove the
      // stable Frame subtree.
      const workspaceDeletion = await Promise.allSettled(
        [...keys.values()].map((key) => workspace.deleteSession(key))
      )
      for (const { key } of scoped) works.delete(keyOf(key))
      for (const [requestId, pending] of permissions) {
        if (pending.key.sessionId === sessionId) permissions.delete(requestId)
      }
      unavailableReasons.delete(sessionId)
      const failures = [...workDeletion, ...workspaceDeletion].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length > 0) {
        throw new AggregateError(failures, `Delegated Session cleanup failed: ${sessionId}`)
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

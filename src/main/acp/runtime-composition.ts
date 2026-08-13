import { homedir } from 'node:os'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'

import type { AcpPermissionRequest, AcpRuntimeEvent, AcpStateSnapshot } from '../../shared/acp'
import { DEFAULT_ARTIFACT_PROJECT_NAME } from '../../shared/artifacts'
import { REVIEWER_MCP_SERVER_NAME, REVIEWER_MCP_TOOLS } from '../../shared/reviewer'
import {
  MAIN_DURABLE_CONTINUATION_LIFECYCLE_CLIENT_ID,
  MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID
} from '../../shared/lifecycle-events'
import {
  filterSpecialistConnectorSkills,
  resolveEffectiveSpecialistSkills
} from '../../shared/specialist'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRepository } from '../artifacts/repository'
import type { ArtifactRunRegistry } from '../artifacts/run-registry'
import type { GrantedLocalRootsRepository } from '../local-fs/granted-roots-repository'
import { createLogger, errorLogFields } from '../logger'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookHandoffContext } from '../notebook/runtime-service'
import {
  runTaskNotificationInBackground,
  type TaskNotificationService
} from '../notifications/task-notifications'
import type { NotificationInboxController } from '../notifications/notification-inbox-controller'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import { getProjectDbClient } from '../projects/prisma-client'
import { ProjectRepository } from '../projects/repository'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { AcpSettingsCapabilities } from '../settings/service-capabilities'
import {
  buildSpecialistIdentityAppend,
  buildSpecialistIdentityPrefix
} from '../specialist/identity'
import type { ProfileService } from '../specialist/service'
import { resolveConfigRoot, resolveDataRoot, resolveStorageRoot } from '../storage-root'
import type { UploadRepository } from '../uploads/repository'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import type { NotebookRpcConnection } from '../notebook/mcp-server'
import { releaseResolvedAgentBackendLeases, type ResolvedAgentBackend } from '../agent-framework'
import { modelFacingAppMcpToolName } from '../agent-framework/app-mcp-names'
import type { RootDelegatedWorkControl } from '../delegation/production-composition'
import { AgentMcpHttpHost } from './mcp-http-host'
import { projectRegistrySessionGrants } from './permission-broker'
import { AcpRuntime, type AcpRuntimeCallbacks, type AcpRuntimeOptions } from './runtime'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'
import { prepareRestrictedBackend } from './restricted-runtime-profile'

const log = createLogger('acp')
const scopedRuntimeReconciliations = new Map<string, Promise<void>>()

const reconcileScopedRuntimeRootOnce = (root: string): Promise<void> => {
  const existing = scopedRuntimeReconciliations.get(root)
  if (existing) return existing
  const reconciliation = rm(root, { recursive: true, force: true }).catch((error) => {
    log.warn('scoped Agent runtime reconciliation failed', errorLogFields(error))
  })
  scopedRuntimeReconciliations.set(root, reconciliation)
  return reconciliation
}

const resolveSpecialistSkillBindingPolicy = async (
  profiles: Pick<ProfileService, 'resolveRunnableById'>,
  settings: Pick<
    AcpSettingsCapabilities,
    'listSpecialistSkillCatalog' | 'provisionedConnectorSkillNames'
  >,
  specialistId: string
): Promise<Readonly<{ kind: 'exact'; allowedSkillIds: string[] }>> => {
  const profile = await profiles.resolveRunnableById(specialistId)
  if (!profile.enabled) throw new Error('The bound Specialist is disabled.')
  const effective = resolveEffectiveSpecialistSkills(
    profile,
    await settings.listSpecialistSkillCatalog()
  )
  if (effective.kind !== 'specialist') {
    throw new Error('The bound Specialist Skill scope is unavailable.')
  }
  const connectorSkills = filterSpecialistConnectorSkills(
    await settings.provisionedConnectorSkillNames(),
    profile
  )
  return {
    kind: 'exact' as const,
    allowedSkillIds: [...new Set([...effective.skillIds, ...connectorSkills])]
  }
}

// Builds the session-setup resolver for a project's Agent Context system-prompt append. The ACP
// projectName carries the Project id; unknown ids (e.g. the DEFAULT_ARTIFACT_PROJECT_NAME fallback
// namespace), blank contexts, and lookup failures all yield undefined so session setup proceeds
// without an append.
const createProjectAgentContextResolver = (repository: {
  get: (id: string) => Promise<{ agentContext?: string } | null>
}): ((projectName: string) => Promise<string | undefined>) => {
  return async (projectName) => {
    try {
      const project = await repository.get(projectName)
      const context = project?.agentContext?.trim()
      return context ? context : undefined
    } catch (error) {
      log.warn('project Agent Context lookup failed', errorLogFields(error))
      return undefined
    }
  }
}

type AcpRuntimeArtifacts = {
  repository: ArtifactRepository
  runRegistry: ArtifactRunRegistry
  provenanceRepository?: Pick<
    ArtifactProvenanceRepository,
    'listRunVersions' | 'writeAppGeneratedVersion'
  > &
    Partial<Pick<ArtifactProvenanceRepository, 'resolveVersionContent'>>
}

type AcpRuntimeCompositionOptions = AcpRuntimeArtifacts & {
  mcpEntryPath: string
  uploadRepository: UploadRepository
  notebookRpcServer: NotebookLocalRpcServer
  peekNotebookHandoffContext?: (sessionId: string) => NotebookHandoffContext | undefined
  authorizeSkillImportReferencedUploads: (
    projectId: string,
    sessionId: string,
    paths: string[]
  ) => Promise<() => void>
  settingsService: AcpSettingsCapabilities
  // The SQLite-backed granted-roots store ("Grant folder access"); the linked-folder file-reference
  // resolver reads it fresh per resolution. Absent only in tests — linked-folder references then
  // fail closed (no root resolves).
  grantedRootsRepository?: Pick<GrantedLocalRootsRepository, 'list'>
  permissionGrantRegistry?: PermissionGrantRegistry
  permissionGrantContext?: Readonly<{ projectId: string; sessionId: string }>
  initializationBarrier?: Promise<unknown>
  taskNotifications?: TaskNotificationService
  notificationInbox?: Pick<
    NotificationInboxController,
    'record' | 'settleAction' | 'settleAuthorization'
  >
  onSessionTurnStarted?: (sessionId: string, turnToken: string) => void
  onSessionTurnEnded?: (sessionId: string, turnToken: string) => void
  onSkillImportAttachmentEligible?: (
    sessionId: string,
    turnToken: string,
    attachmentUri: string
  ) => void
  onSessionCancellationRequested?: (sessionId: string) => void
  onSessionUnavailable?: (sessionId: string) => void
  onAllSessionsCancellationRequested?: () => void
  onDisconnected?: () => void
  beforeSessionDelete?: (sessionId: string) => Promise<void>
  profileService?: ProfileService
  sessionPersistenceCoordinator?: Pick<
    SessionPersistenceCoordinator,
    | 'readSessionRuntimeContext'
    | 'patchSessionRuntimeContext'
    | 'appendUserMessageToInteraction'
    | 'containsMessageOnActiveBranch'
    | 'loadSessionForContinuation'
    | 'sessionProjectId'
  >
  delegatedWork?: RootDelegatedWorkControl
  fixedBackend?: ResolvedAgentBackend
  runtimeCallbacks?: AcpRuntimeCallbacks
  delegatedNotebookConnection?: NotebookRpcConnection
  delegatedArtifactCurrentRunFile?: string
  spawnAgent?: () => ChildProcessWithoutNullStreams
  sideChatRelays?: AcpRuntimeOptions['sideChatRelays']
}

// Composes the compatibility façade while the coordinator remains the cross-generation Session owner.
const createAcpRuntime = ({
  mcpEntryPath,
  repository,
  runRegistry,
  provenanceRepository,
  uploadRepository,
  notebookRpcServer,
  peekNotebookHandoffContext,
  authorizeSkillImportReferencedUploads,
  settingsService,
  grantedRootsRepository,
  permissionGrantRegistry,
  permissionGrantContext,
  initializationBarrier,
  taskNotifications,
  notificationInbox,
  onSessionTurnStarted,
  onSessionTurnEnded,
  onSkillImportAttachmentEligible,
  onSessionCancellationRequested,
  onSessionUnavailable,
  onAllSessionsCancellationRequested,
  onDisconnected,
  beforeSessionDelete,
  profileService,
  sessionPersistenceCoordinator,
  delegatedWork,
  fixedBackend,
  runtimeCallbacks,
  delegatedNotebookConnection,
  delegatedArtifactCurrentRunFile,
  spawnAgent,
  sideChatRelays
}: AcpRuntimeCompositionOptions): AcpRuntimeCoordinator => {
  const configRoot = resolveConfigRoot()
  const dataRoot = resolveDataRoot()
  const defaultCwd = homedir()
  const scopedRuntimeRoot = join(configRoot, 'runtime-support', 'scoped-agents')
  // One startup reconciliation fences crash leftovers without racing live concurrent scoped runtimes.
  const scopedRuntimeReconciliation = reconcileScopedRuntimeRootOnce(scopedRuntimeRoot)
  // One lazily-shared repository for Agent Context lookups; getProjectDbClient caches the client.
  const projectRepository = new ProjectRepository(() => getProjectDbClient(resolveStorageRoot()))
  const callbacks: AcpRuntimeCallbacks = runtimeCallbacks ?? {
    onStateChanged: (state: AcpStateSnapshot) => broadcastToRenderers('acp:state', state),
    onEvent: (event: AcpRuntimeEvent) => {
      broadcastToRenderers('acp:event', event)
      // Fire-and-forget: a notification hiccup must never stall the renderer event stream.
      if (taskNotifications) {
        runTaskNotificationInBackground(
          () => taskNotifications.handleRuntimeEvent(event),
          (error) => log.warn('task notification event failed', errorLogFields(error))
        )
      }
    },
    onPermissionRequest: (request: AcpPermissionRequest) => {
      broadcastToRenderers('acp:permission-request', request)
      // A pending approval parks the turn; an unfocused user gets a desktop nudge.
      if (taskNotifications) {
        runTaskNotificationInBackground(
          () => taskNotifications.handlePermissionRequest(request),
          (error) => log.warn('permission notification failed', errorLogFields(error))
        )
      }
    },
    onPermissionSettled: (requestId, state) => {
      if (!notificationInbox) return
      runTaskNotificationInBackground(
        () => notificationInbox.settleAuthorization('agent-tool', requestId, state),
        (error) => log.warn('permission inbox settlement failed', errorLogFields(error))
      )
    }
  }

  return new AcpRuntimeCoordinator(
    (runtimeCallbacks, permissionGrantStore, processScope) => {
      const selection = fixedBackend
        ? undefined
        : settingsService.captureActiveAgentBackendSelection()
      const runtimeOptions: AcpRuntimeOptions = {
        appVersion: app.getVersion(),
        // Packaged macOS apps often start with cwd at "/" or the app bundle; use home instead.
        defaultCwd,
        resolveBackend: async (context) => {
          if (fixedBackend) return fixedBackend
          if (processScope.kind === 'main') {
            return settingsService.resolveAgentBackend(await selection!, context)
          }
          if (!profileService) throw new Error('Specialist profile resolution is unavailable.')
          return settingsService.resolveAgentBackend(await selection!, {
            ...context,
            skillBindingPolicy: await resolveSpecialistSkillBindingPolicy(
              profileService,
              settingsService,
              processScope.specialistId
            )
          })
        },
        ...(spawnAgent ? { spawnAgent } : {}),
        mcpHttpHost: new AgentMcpHttpHost(),
        skills: {
          needForceLoad: (ids) => settingsService.skillsNeedingForceLoad(ids),
          namesForIds: (ids) => settingsService.skillNudgeNamesForIds(ids)
        },
        ...(!delegatedNotebookConnection || delegatedArtifactCurrentRunFile
          ? {
              artifacts: {
                configRoot,
                dataRoot,
                projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
                mcpEntryPath,
                repository,
                runRegistry,
                provenance: provenanceRepository,
                getRpcConnection: () => notebookRpcServer.ensureStarted(),
                issueRpcCapability: (binding) =>
                  notebookRpcServer.issueArtifactRunCapability(binding),
                revokeRpcCapability: (token) =>
                  notebookRpcServer.revokeArtifactRunCapability(token),
                ...(delegatedArtifactCurrentRunFile
                  ? { currentRunFile: delegatedArtifactCurrentRunFile }
                  : {})
              }
            }
          : {}),
        ...(delegatedNotebookConnection ? {} : { uploads: { repository: uploadRepository } }),
        grantedRoots: grantedRootsRepository
          ? {
              // Read fresh per resolution so a just-removed root stops resolving immediately.
              resolveRootPath: async (rootId) =>
                (await grantedRootsRepository.list()).find((root) => root.id === rootId)?.path
            }
          : undefined,
        notebook: {
          projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
          mcpEntryPath,
          getRpcConnection: ({ sessionId, projectId }) =>
            delegatedNotebookConnection
              ? Promise.resolve(delegatedNotebookConnection)
              : notebookRpcServer.issueSessionConnection(
                  sessionId,
                  projectId,
                  `root-frame-${sessionId}`
                ),
          ...(delegatedNotebookConnection
            ? {}
            : {
                registerSessionAlias: (aliasSessionId, sessionId) =>
                  notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
                releaseSessionCapabilities: (sessionId) =>
                  notebookRpcServer.releaseSessionCapabilities(sessionId),
                registerSessionSpecialist: (sessionId, specialistId) =>
                  notebookRpcServer.registerSessionSpecialist(sessionId, specialistId),
                setArtifactProvenanceContext: (sessionId, context) =>
                  notebookRpcServer.setArtifactProvenanceContext(sessionId, context),
                registerTurnInputs: (request) =>
                  notebookRpcServer.registerNotebookTurnInputs(request),
                peekHandoffContext: peekNotebookHandoffContext
              })
        },
        ...(delegatedNotebookConnection
          ? {}
          : {
              skillImport: {
                mcpEntryPath,
                isEnabled: () => settingsService.getConversationSkillImportEnabled(),
                getRpcConnection: ({ sessionId }: { sessionId: string }) =>
                  notebookRpcServer.issueSkillImportConnection(sessionId),
                registerSessionAlias: (aliasSessionId: string, sessionId: string) =>
                  notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
                releaseSessionCapabilities: (sessionId: string) =>
                  notebookRpcServer.releaseSessionCapabilities(sessionId),
                authorizeReferencedUploads: authorizeSkillImportReferencedUploads
              }
            }),
        ...(!delegatedNotebookConnection && sessionPersistenceCoordinator
          ? {
              permissionWait: {
                sessions: sessionPersistenceCoordinator,
                onSessionUpdated: (session) => {
                  try {
                    broadcastToRenderers('session:updated', {
                      session,
                      originClientId: MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID
                    })
                  } catch (error) {
                    // The durable commit remains authoritative when a renderer projection is gone.
                    log.warn('permission wait Session publication failed', errorLogFields(error))
                  }
                },
                onContinuationSessionUpdated: (session) => {
                  try {
                    broadcastToRenderers('session:updated', {
                      session,
                      originClientId: MAIN_DURABLE_CONTINUATION_LIFECYCLE_CLIENT_ID
                    })
                  } catch (error) {
                    log.warn(
                      'durable continuation Session publication failed',
                      errorLogFields(error)
                    )
                  }
                }
              }
            }
          : {}),
        ...(sessionPersistenceCoordinator
          ? {
              plan: {
                mcpEntryPath,
                getRpcConnection: ({ sessionId, projectId }) =>
                  notebookRpcServer.issuePlanConnection(sessionId, projectId),
                registerSessionAlias: (aliasSessionId, sessionId) =>
                  notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
                sessions: sessionPersistenceCoordinator,
                onApprovalRequested: (request) => {
                  if (taskNotifications) {
                    runTaskNotificationInBackground(
                      () => taskNotifications.handlePlanApproval(request),
                      (error) =>
                        log.warn('plan approval notification failed', errorLogFields(error))
                    )
                    return
                  }
                  if (notificationInbox) {
                    runTaskNotificationInBackground(
                      () =>
                        notificationInbox.record({
                          dedupeKey: `authorization:session-plan:${request.artifactVersionId}`,
                          kind: 'authorization.required',
                          source: 'session-plan',
                          projectId: request.projectId,
                          sessionId: request.sessionId,
                          originId: request.artifactVersionId,
                          title: 'Plan approval needed',
                          summary: 'A plan needs your approval.',
                          actionState: 'pending'
                        }),
                      (error) =>
                        log.warn('plan approval inbox record failed', errorLogFields(error))
                    )
                  }
                },
                onApprovalSettled: (request) => {
                  if (!notificationInbox) return
                  runTaskNotificationInBackground(
                    () =>
                      notificationInbox.settleAuthorization(
                        'session-plan',
                        request.artifactVersionId,
                        request.state
                      ),
                    (error) => log.warn('plan approval inbox settle failed', errorLogFields(error))
                  )
                }
              }
            }
          : {}),
        callbacks: runtimeCallbacks,
        sideChatRelays,
        permissionGrantStore,
        permissionGrantRegistry,
        permissionGrantContext,
        resolveSpecialistIdentity: profileService
          ? async (specialistId: string, frameworkId: string) => {
              let profile
              try {
                profile = await profileService.resolveRunnableById(specialistId)
              } catch {
                // Profile not found or corrupt
                return undefined
              }
              if (!profile.enabled) return undefined
              const append = buildSpecialistIdentityAppend(profile)
              const prefix = buildSpecialistIdentityPrefix(profile)
              if (frameworkId === 'claude-code') return { append, prefix: '' }
              return { append: '', prefix }
            }
          : undefined,
        resolveSpecialistSkills: profileService
          ? async (specialistId) => {
              try {
                const profile = await profileService.resolveRunnableById(specialistId)
                if (!profile.enabled) {
                  return { kind: 'unavailable', reason: 'The bound specialist is disabled.' }
                }
                const effective = resolveEffectiveSpecialistSkills(
                  profile,
                  await settingsService.listSpecialistSkillCatalog()
                )
                if (effective.kind === 'specialist') {
                  const provisioned = await settingsService.provisionedConnectorSkillNames()
                  const connectorSkills = filterSpecialistConnectorSkills(provisioned, profile)
                  if (connectorSkills.length > 0) {
                    return {
                      ...effective,
                      frameworkNames: [...effective.frameworkNames, ...connectorSkills]
                    }
                  }
                }
                return effective
              } catch {
                return { kind: 'unavailable', reason: 'The bound specialist is unavailable.' }
              }
            }
          : undefined,
        resolveProjectAgentContext: createProjectAgentContextResolver(projectRepository)
      }
      const baseOwners = composeAcpRuntimeBaseOwners(runtimeOptions)
      return new AcpRuntime(
        runtimeOptions,
        baseOwners,
        composeAcpRuntimeSessionOwners(runtimeOptions, baseOwners)
      )
    },
    callbacks,
    defaultCwd,
    initializationBarrier,
    onDisconnected,
    onSessionUnavailable,
    {
      onSessionTurnStarted,
      onSessionTurnEnded,
      onSkillImportAttachmentEligible,
      onSessionCancellationRequested,
      onAllSessionsCancellationRequested,
      beforeSessionDelete
    },
    permissionGrantRegistry
      ? () => projectRegistrySessionGrants(permissionGrantRegistry.listCached())
      : undefined,
    delegatedWork,
    (runtimeCallbacks, permissionGrantStore) => {
      if (fixedBackend) {
        throw new Error(
          'Reviewer startup is unavailable for delegated runtimes because an isolated backend process cannot be resolved safely.'
        )
      }
      const selection = settingsService.captureActiveAgentBackendSelection()
      const profileRoot = join(scopedRuntimeRoot, `reviewer-${randomUUID()}`)
      const runtimeOptions: AcpRuntimeOptions = {
        appVersion: app.getVersion(),
        defaultCwd,
        resolveBackend: async (context) => {
          await scopedRuntimeReconciliation
          const backend = await settingsService.resolveAgentBackend(await selection, {
            ...context,
            skillBindingPolicy: { kind: 'none' }
          })
          try {
            return await prepareRestrictedBackend(backend, profileRoot, {
              agentName: 'open-science-reviewer',
              description: 'Reviews an artifact using only the app-owned Reviewer MCP tools.',
              systemPrompt: '',
              openCodePermissions: {
                '*': 'deny',
                ...Object.fromEntries(
                  Object.values(REVIEWER_MCP_TOOLS).map((toolName) => [
                    modelFacingAppMcpToolName('opencode', REVIEWER_MCP_SERVER_NAME, toolName),
                    'allow' as const
                  ])
                )
              },
              persistSession: false
            })
          } catch (error) {
            await releaseResolvedAgentBackendLeases(backend)
            throw error
          }
        },
        callbacks: runtimeCallbacks,
        permissionGrantStore
      }
      const baseOwners = composeAcpRuntimeBaseOwners(runtimeOptions)
      return {
        runtime: new AcpRuntime(
          runtimeOptions,
          baseOwners,
          composeAcpRuntimeSessionOwners(runtimeOptions, baseOwners)
        ),
        release: () => rm(profileRoot, { recursive: true, force: true })
      }
    }
  )
}

export {
  createAcpRuntime,
  createProjectAgentContextResolver,
  reconcileScopedRuntimeRootOnce,
  resolveSpecialistSkillBindingPolicy
}
export type { AcpRuntimeCompositionOptions }

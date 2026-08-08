import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { flushSessionPersistence } from '@/lib/session-persistence/session-persistence'
import type { ChatSession } from '@/stores/session-store'
import { MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS } from '../../../../shared/artifacts'
import {
  createArtifactVersionLocator,
  type ArtifactVersionDescriptor
} from '../../../../shared/artifact-provenance'
import { projectRootArtifactVisibility } from '../../../../shared/artifact-visibility'

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number] & {
  resolvedProjectId?: string
  resolvedSessionId?: string
}

const getMessageArtifacts = (
  session: ChatSession,
  message: ChatSession['messages'][number],
  resolvedArtifactsByVersionId?: ReadonlyMap<string, MessageArtifact | undefined>
): MessageArtifact[] => {
  if (!message.artifactIds) return []
  const artifactsById = new Map(
    (session.artifacts ?? []).map((artifact) => [artifact.id, artifact as MessageArtifact])
  )
  const artifactsByLogicalId = new Map<string, MessageArtifact>()
  for (const artifactId of message.artifactIds) {
    const artifact = artifactsById.get(artifactId) ?? resolvedArtifactsByVersionId?.get(artifactId)
    if (!artifact) continue
    const logicalId = artifact.versionId
      ? `version:${artifact.versionId}`
      : `artifact:${artifact.id}`
    const current = artifactsByLogicalId.get(logicalId)
    const isNativeVersion = Boolean(artifact.versionId && artifact.id === artifact.versionId)
    const currentIsNativeVersion = Boolean(current?.versionId && current.id === current.versionId)
    if (!current || (isNativeVersion && !currentIsNativeVersion)) {
      artifactsByLogicalId.set(logicalId, artifact)
    }
  }
  return [...artifactsByLogicalId.values()]
}

const isSafeVersionId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)

const toResolvedMessageArtifact = (descriptor: ArtifactVersionDescriptor): MessageArtifact => ({
  id: descriptor.versionId,
  artifactId: descriptor.artifactId,
  versionId: descriptor.versionId,
  versionNumber: descriptor.versionNumber,
  kind: 'managed-file',
  path: createArtifactVersionLocator({
    projectId: descriptor.projectName,
    appSessionId: descriptor.sessionId,
    artifactId: descriptor.artifactId,
    versionId: descriptor.versionId
  }),
  name: descriptor.name,
  mimeType: descriptor.mimeType,
  size: descriptor.size,
  mtimeMs: descriptor.mtimeMs,
  sha256: descriptor.checksum,
  resolvedProjectId: descriptor.projectName,
  resolvedSessionId: descriptor.sessionId
})

const useHistoricalArtifactDescriptors = (
  activeSession: ChatSession | undefined,
  projectedVersionIds: readonly string[]
): ReadonlyMap<string, MessageArtifact | undefined> => {
  const resolvedRef = useRef<{
    sessionId: string | undefined
    artifactsByVersionId: Map<string, MessageArtifact | undefined>
  }>({ sessionId: undefined, artifactsByVersionId: new Map() })
  const [resolved, setResolved] = useState<{
    sessionId: string | undefined
    artifactsByVersionId: ReadonlyMap<string, MessageArtifact | undefined>
  }>({ sessionId: undefined, artifactsByVersionId: new Map() })
  const [retryToken, setRetryToken] = useState(0)
  const retriedVersionIdsRef = useRef(new Set<string>())
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const sessionId = activeSession?.id
    if (resolvedRef.current.sessionId !== sessionId) {
      resolvedRef.current = { sessionId, artifactsByVersionId: new Map() }
      retriedVersionIdsRef.current.clear()
      setResolved(resolvedRef.current)
    }
    if (!activeSession || typeof window.api?.artifacts?.resolveVersionDescriptors !== 'function') {
      return
    }
    const cache = resolvedRef.current.artifactsByVersionId
    const storedArtifactIds = new Set(
      (activeSession.artifacts ?? []).map((artifact) => artifact.id)
    )
    const unresolvedVersionIds = [
      ...new Set([
        ...activeSession.messages.flatMap((message) => message.artifactIds ?? []),
        ...projectedVersionIds
      ])
    ].filter(
      (versionId) =>
        !storedArtifactIds.has(versionId) && !cache.has(versionId) && isSafeVersionId(versionId)
    )
    if (unresolvedVersionIds.length === 0) return
    for (const versionId of unresolvedVersionIds) cache.set(versionId, undefined)

    void (async () => {
      for (
        let index = 0;
        index < unresolvedVersionIds.length;
        index += MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS
      ) {
        const versionIds = unresolvedVersionIds.slice(
          index,
          index + MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS
        )
        try {
          const descriptors = await window.api.artifacts.resolveVersionDescriptors({
            projectId: activeSession.projectId,
            appSessionId: activeSession.id,
            versionIds
          })
          for (const descriptor of descriptors) {
            cache.set(descriptor.versionId, toResolvedMessageArtifact(descriptor))
          }
        } catch {
          let shouldRetry = false
          for (const versionId of versionIds) {
            cache.delete(versionId)
            if (!retriedVersionIdsRef.current.has(versionId)) {
              retriedVersionIdsRef.current.add(versionId)
              shouldRetry = true
            }
          }
          if (shouldRetry) {
            await flushSessionPersistence()
            if (
              mountedRef.current &&
              resolvedRef.current.sessionId === sessionId &&
              resolvedRef.current.artifactsByVersionId === cache
            ) {
              setRetryToken((token) => token + 1)
            }
          }
        }
      }
      if (
        mountedRef.current &&
        resolvedRef.current.sessionId === sessionId &&
        resolvedRef.current.artifactsByVersionId === cache
      ) {
        setResolved({ sessionId, artifactsByVersionId: new Map(cache) })
      }
    })()
  }, [activeSession, projectedVersionIds, retryToken])

  return resolved.sessionId === activeSession?.id ? resolved.artifactsByVersionId : new Map()
}

const useWorkspaceArtifactVisibility = (
  activeSession: ChatSession | undefined
): Readonly<{
  artifactsForMessage(message: ChatSession['messages'][number]): MessageArtifact[]
  artifactsForInvocations(invocationIds: readonly string[], placementId: string): MessageArtifact[]
}> => {
  const projection = useMemo(() => {
    const graph = activeSession?.conversationGraph
    if (!activeSession || !graph || graph.activeFrameId !== graph.rootFrameId) return undefined
    const rootFrame = graph.frames.find(({ id }) => id === graph.rootFrameId)
    return rootFrame
      ? projectRootArtifactVisibility(activeSession, rootFrame.activeBranchId)
      : undefined
  }, [activeSession])
  const projectedVersionIds = useMemo(
    () => projection?.placements.map(({ artifactVersionId }) => artifactVersionId) ?? [],
    [projection]
  )
  const historicalArtifacts = useHistoricalArtifactDescriptors(activeSession, projectedVersionIds)
  const artifactsForMessage = useCallback(
    (message: ChatSession['messages'][number]) =>
      activeSession ? getMessageArtifacts(activeSession, message, historicalArtifacts) : [],
    [activeSession, historicalArtifacts]
  )
  const artifactsForInvocations = useCallback(
    (invocationIds: readonly string[], placementId: string) => {
      if (!activeSession) return []
      const invocationSet = new Set(invocationIds)
      const artifactIds = (projection?.placements ?? [])
        .filter(({ toolInvocationId }) => invocationSet.has(toolInvocationId))
        .map(({ artifactVersionId }) => artifactVersionId)
      return getMessageArtifacts(
        activeSession,
        {
          id: placementId,
          role: 'agent',
          content: '',
          status: 'complete',
          eventIds: [],
          artifactIds,
          createdAt: 0,
          updatedAt: 0
        },
        historicalArtifacts
      )
    },
    [activeSession, historicalArtifacts, projection]
  )
  return { artifactsForMessage, artifactsForInvocations }
}

export { useWorkspaceArtifactVisibility }
export type { MessageArtifact }

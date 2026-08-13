import type { ResolvedAgentBackend } from './types'

type BackendReleaseState = {
  bestEffort?: Promise<void>
  skillRuntimeAttempt?: Promise<void>
  completeAttempt?: Promise<void>
}

const releases = new WeakMap<ResolvedAgentBackend, BackendReleaseState>()

const releaseResolvedAgentBackendLeases = (backend: ResolvedAgentBackend): Promise<void> => {
  const state = releases.get(backend) ?? {}
  if (!releases.has(backend)) releases.set(backend, state)
  if (state.completeAttempt) return state.completeAttempt

  const skillRuntimeLease = backend.skillRuntimeLease
  const owned: Array<{ release(): Promise<void> }> = []
  if (backend.responsesBridgeLease) owned.push(backend.responsesBridgeLease)
  if (backend.anthropicBridgeLease) owned.push(backend.anthropicBridgeLease)
  if (backend.providerTransportLease) owned.push(backend.providerTransportLease)
  // Bridge and transport teardown historically is best effort and at-most-once. A Skill Runtime
  // lease owns app-managed filesystem state, so its failure must remain observable and retryable.
  state.bestEffort ??= Promise.allSettled(
    [...new Set(owned)]
      .filter((lease) => lease !== skillRuntimeLease)
      .map((lease) => Promise.resolve().then(() => lease.release()))
  ).then(() => undefined)
  state.skillRuntimeAttempt ??= skillRuntimeLease
    ? Promise.resolve()
        .then(() => skillRuntimeLease.release())
        .catch((error) => {
          state.skillRuntimeAttempt = undefined
          throw error
        })
    : Promise.resolve()
  const completeAttempt = Promise.all([state.bestEffort, state.skillRuntimeAttempt])
    .then(() => undefined)
    .catch((error) => {
      if (state.completeAttempt === completeAttempt) state.completeAttempt = undefined
      throw error
    })
  state.completeAttempt = completeAttempt
  return completeAttempt
}

export { releaseResolvedAgentBackendLeases }

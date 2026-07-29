import type { StoredSpecialist } from '../settings/types'
import { resolveSessionSpecialistBinding } from './resolve-session-specialist'

// The resolved Specialist as seen by the runtime: identity (for logging/badges) plus trimmed
// instructions ready for prompt delivery. Empty instructions means the append adds no content.
export type ResolvedSessionSpecialist =
  | { kind: 'none'; instructions: string }
  | { kind: 'bound'; specialistId: string; instructions: string }
  | { kind: 'unavailable'; specialistId: string; instructions: string }

// Injectable seam the ACP runtime depends on. Each accessor reads the LATEST state so main never
// caches a hydration-time verdict: getBoundSpecialistId() reflects the registry (which tracks
// persisted selection changes), and the catalog accessors reflect current settings. Absent in tests
// that build the runtime without specialists; every usage guards on presence.
export type SessionSpecialistRuntime = {
  // The persisted Specialist id currently bound to a session, or undefined for None. Driven by the
  // SessionSpecialistRegistry, which the coordinator keeps in sync with persisted sessions.
  getBoundSpecialistId: (sessionId: string) => string | undefined
  // User-authored Custom specialists from the latest settings snapshot.
  getCustomSpecialists: () => StoredSpecialist[]
  // Runtime-projected built-ins (customize/reviewer). Reviewer is filtered out by the resolver.
  getBuiltinSpecialists: () => StoredSpecialist[]
}

// Resolves a session's Specialist against the latest settings, returning the runtime view with
// trimmed instructions. Bound/unavailable both carry the specialistId so callers can log/badge it;
// only `bound` carries non-empty instructions. Callers must NOT pass `instructions` into error or
// log fields — only the specialistId is safe to log.
export const resolveSessionSpecialist = (
  runtime: SessionSpecialistRuntime,
  sessionId: string
): ResolvedSessionSpecialist => {
  const specialistId = runtime.getBoundSpecialistId(sessionId)
  const resolution = resolveSessionSpecialistBinding(
    specialistId,
    runtime.getCustomSpecialists(),
    runtime.getBuiltinSpecialists()
  )

  if (resolution.kind === 'none') return { kind: 'none', instructions: '' }

  if (resolution.kind === 'unavailable') {
    return { kind: 'unavailable', specialistId: resolution.specialistId, instructions: '' }
  }

  const match =
    runtime.getCustomSpecialists().find((item) => item.id === resolution.specialistId) ??
    runtime.getBuiltinSpecialists().find((item) => item.id === resolution.specialistId)
  const instructions = match?.instructions?.trim() ?? ''

  return { kind: 'bound', specialistId: resolution.specialistId, instructions }
}

// Builds the system-prompt append for a resolved Specialist. None/unavailable/empty-instruction
// results yield no append (empty string), so the base framework prompt is left untouched. The append
// is a distinct string the framework delivers through its normal append channel (Claude _meta for
// Claude Code; per-turn prompt prefix for Codex/OpenCode).
export const specialistAppendFor = (resolved: ResolvedSessionSpecialist): string =>
  resolved.kind === 'bound' ? resolved.instructions : ''

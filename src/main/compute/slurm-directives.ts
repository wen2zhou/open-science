// Slurm script directive parsing (design.md §4.5).
//
// Structured `ResourceRequest` is authoritative. A submitted script MAY carry a limited set of
// advanced `#SBATCH` directives in the contiguous block at the TOP of the script. This module:
//
//   1. Extracts ONLY that contiguous leading directive block (shebang + plain comments + blank lines do
//      not break the block; the first real command line does).
//   2. Parses each allowed directive into a {key, value}, rejecting:
//        - reserved keys (--job-name, --output, --error, --chdir/--workdir, --array, --wrap, --wait)
//          because the runner owns job name / stdout / stderr / workdir / arrays;
//        - any key that conflicts with a structured resource field (design.md §4.5);
//        - values that are not single safe tokens (no shell metacharacters) so a directive argument can
//          never form shell injection (cross-cutting requirement: schema/parser validation first).
//
// All rejection happens BEFORE any SSH, so a bad script fails fast with a structured reason rather than
// launching on the login node.

import { RESERVED_SCHEDULER_KEYS } from '../../shared/compute-resources'
import type { ResourceRequest } from '../../shared/compute-resources'

// An allowed, parsed user directive. Keys are normalized to kebab-case long form (no leading --).
export type ParsedDirective = { key: string; value: string }

export type ParseDirectivesResult =
  { ok: true; directives: ParsedDirective[] } | { ok: false; reason: string }

// Maps a structured resource field to the set of #SBATCH long-option keys that would conflict with it.
// A user directive naming any of these when the structured field is set is rejected (design.md §4.5).
const RESOURCE_TO_CONFLICT_KEYS: Partial<Record<keyof ResourceRequest, string[]>> = {
  partition: ['partition'],
  account: ['account'],
  qos: ['qos'],
  nodes: ['nodes'],
  tasks: ['ntasks', 'ntasks-per-node'],
  cpusPerTask: ['cpus-per-task', 'cpus'],
  memoryMib: ['mem', 'mem-per-cpu', 'mem-per-gpu'],
  gpus: ['gres'],
  gpuType: ['gres'],
  timeLimitSeconds: ['time']
}

// A safe directive value: printable ASCII, no shell metacharacters that could break out of the token.
// Matches the `schedulerToken` constraint from compute-resources.ts for consistency.
const SAFE_VALUE = /^[A-Za-z0-9._:/@+=,-]+$/

// Extracts the contiguous leading directive block. Lines are walked in order; the block ends at the
// first line that is neither a directive, a plain comment, blank, nor a shebang.
export const extractDirectiveBlock = (script: string): string[] => {
  const lines = script.split('\n')
  const directives: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue // blank lines inside the leading region do not end the block
    if (line.startsWith('#!')) continue // shebang
    if (line.startsWith('#SBATCH')) {
      directives.push(line)
      continue
    }
    if (line.startsWith('#')) continue // plain comment, still leading
    // First real command line — block ends. (Directives after this are ignored, not parsed.)
    break
  }
  return directives
}

// Parses a single `#SBATCH --key=value` (or `#SBATCH --key value`) line into {key, value}.
// Returns undefined when the line is not a recognized long-form directive.
const parseDirectiveLine = (line: string): ParsedDirective | undefined => {
  const body = line.replace(/^#SBATCH\s+/, '').trim()
  if (!body.startsWith('--')) return undefined
  const rest = body.slice(2)
  // Long form: --key=value or --key value (single token). Short flags (-J) are rejected (ambiguous).
  const eq = rest.indexOf('=')
  if (eq >= 0) {
    const key = rest.slice(0, eq).trim().toLowerCase()
    const value = rest.slice(eq + 1).trim()
    if (!key || !value) return undefined
    return { key, value }
  }
  // space-separated form: only accept when there is exactly one whitespace-separated value token
  const parts = rest.split(/\s+/)
  if (parts.length === 2) {
    return { key: parts[0]!.toLowerCase(), value: parts[1]! }
  }
  return undefined
}

// Parses + validates the leading directive block against the structured resources. Reserved keys and
// conflicting keys are rejected before SSH. Allowed directives are returned for the renderer to fold
// into the sbatch wrapper AFTER the structured directives (structured first, so they win on duplicate).
export const parseAllowedDirectives = (
  script: string,
  resources: ResourceRequest
): ParseDirectivesResult => {
  const block = extractDirectiveBlock(script)
  const directives: ParsedDirective[] = []

  // Build the set of conflict keys implied by the structured resources actually set.
  const conflictKeys = new Set<string>()
  for (const [field, keys] of Object.entries(RESOURCE_TO_CONFLICT_KEYS)) {
    if (resources[field as keyof ResourceRequest] !== undefined) {
      for (const k of keys ?? []) conflictKeys.add(k)
    }
  }

  for (const line of block) {
    const parsed = parseDirectiveLine(line)
    if (!parsed) {
      return { ok: false, reason: `Unsupported #SBATCH directive: ${line}` }
    }
    const { key, value } = parsed
    if (RESERVED_SCHEDULER_KEYS.has(key)) {
      return {
        ok: false,
        reason: `Reserved #SBATCH directive --${key} is controlled by the runner; remove it (the system owns job name, stdout/stderr, workdir, arrays, and wrapping).`
      }
    }
    if (conflictKeys.has(key)) {
      return {
        ok: false,
        reason: `#SBATCH --${key} conflicts with a structured resource field; use the structured resource request instead.`
      }
    }
    if (!SAFE_VALUE.test(value)) {
      return {
        ok: false,
        reason: `#SBATCH --${key} value contains disallowed characters; only safe single-token values are permitted.`
      }
    }
    directives.push({ key, value })
  }

  return { ok: true, directives }
}

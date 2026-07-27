import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Spec hash (design.md §8.2 / §8.3 — a changed spec is stale, never silently reused).
//
// Main-only module: SHA-256 uses node:crypto, which is unavailable in the renderer. Keeping this out
// of the shared (browser-importable) compute-environment module prevents the renderer from pulling in
// node:crypto and white-screening on load. Only the main process (environment-repository) computes
// spec hashes; the renderer displays the already-persisted hash.
//
// The hash is taken over a CANONICAL JSON serialization: object keys are sorted recursively and
// undefined fields omitted, so semantically-equal specs hash identically regardless of field order.
// ---------------------------------------------------------------------------

// Stable JSON stringify: sorts object keys recursively, omits undefined, preserves array order (array
// order is meaningful for package phases and module load order, so it is NOT sorted — see the
// computeSpecHash tests that assert a reordered package list hashes differently).
export const canonicalJson = (value: unknown): string => {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']'
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const parts = keys
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]))
    return '{' + parts.join(',') + '}'
  }
  return JSON.stringify(value)
}

// Computes the SHA-256 content hash of a portable spec. The canonical form makes the hash stable
// across field order; the result is a 64-char lowercase hex string.
export const computeSpecHash = (spec: unknown): string =>
  createHash('sha256').update(canonicalJson(spec)).digest('hex')

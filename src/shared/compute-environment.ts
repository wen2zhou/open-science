// Remote compute environment contract (design.md §8).
//
// A `ComputeEnvironment` is a provider-scoped, reusable description of a remote software stack the
// agent can name at submit time (issue 05 / PR5). This module owns the portable `spec` (what the user
// intends to install), the provider-specific machine-readable `resolution` (how the installed stack is
// activated), the content hash that makes a changed spec stale, and the deterministic `preamble` the
// submit path injects into the final job script so both Direct SSH and Slurm consume the SAME resolved
// activation (design.md §8.2 / cross-cutting: submit path must keep Direct SSH and Slurm driver
// indifferent consumers of one resolved preamble).
//
// INVARIANTS (design.md §3):
//   - No secrets ever land in the spec or resolution. This module rejects credential-shaped keys.
//   - `detailsDoc` is human-readable documentation only; it is NEVER parsed into a command or resolution.
//   - The preamble is deterministic: same resolution -> identical script bytes so the audit snapshot and
//     the remote script always agree.

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Resolution schemas (design.md §8.2)
// ---------------------------------------------------------------------------

// True when the string contains a C0 control char (U+0000–U+001F) or DEL (U+007F). Used as a zod
// refine instead of a control-char regex so eslint's no-control-regex rule stays quiet (the check is
// the same; we just express it as a char-code test rather than a literal \x00-\x1F range).
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

// Printable-ASCII, no control chars / newlines. Resolution strings become shell arguments, so they must
// stay single-line and free of injection vectors. Mirrors the schedulerToken discipline in
// compute-resources.ts but allows spaces (module paths, export values) — the preamble renderer quotes
// where the shell would expand.
const resolutionLine = z
  .string()
  .min(1)
  .max(2048)
  .refine((s) => !hasControlChar(s), { message: 'must not contain control characters' })

// A module specifier: token-ish, allows `name/version` and dots, but no shell metacharacters that
// would let a module name escape the `module load` argument. Control chars and the common injection
// separators (`;`, backtick, `$`, `|`, `&`, newlines) are rejected.
const moduleToken = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._/+-]+$/, {
    message: 'must be a bare module specifier (no shell metacharacters)'
  })

// A single bind mount: `src[:dst[:mode]]`. Allows slashes, colons, dots — the values Apptainer binds
// accept — but no control chars, backticks, $, or command separators. Spaces are allowed (rare but
// valid paths).
const bindToken = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => !hasControlChar(s) && !/[`$|;&]/.test(s), {
    message: 'must not contain shell metacharacters'
  })

// Environment-variable key for Apptainer env overrides: a normal identifier (letters, digits,
// underscore), so it cannot inject shell syntax through the `export KEY=value` line we render.
const envKeyToken = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Z_][A-Z0-9_]*$/i, { message: 'must be a valid environment variable name' })

const envValueToken = z
  .string()
  .max(8192)
  .refine((s) => !hasControlChar(s) && !s.includes('`'), {
    message: 'must not contain control characters or backticks'
  })

// Credential-shaped keys that must NEVER be persisted in a resolution. Match is case-insensitive and
// substring-based so variants (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, PRIVATE_KEY, PASSWORD, ...) are all
// caught. Resolution data is machine-readable and travels into the job script, so a secret here would
// leak into the workdir, the approval card, and the job audit snapshot (design.md §3 invariant 8).
const SECRET_KEY_PATTERNS = [
  'secret',
  'token',
  'password',
  'passwd',
  'private_key',
  'privatekey',
  'credential',
  'api_key',
  'apikey',
  'access_key',
  '_key'
]

export const isSecretEnvKey = (key: string): boolean => {
  const lower = key.toLowerCase()
  return SECRET_KEY_PATTERNS.some((p) => lower.includes(p))
}

const apptainerEnvSchema = z
  .record(envKeyToken, envValueToken)
  .refine((env) => Object.keys(env).every((k) => !isSecretEnvKey(k)), {
    message: 'resolution env must not carry secret-bearing keys'
  })

// The frozen EnvironmentResolution union (design.md §8.2). `.strict()` is not applicable to a union;
// the per-variant object schemas use `.strict()` via the discriminated object below.
export const ComputeEnvironmentResolutionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('conda'),
      envName: resolutionLine.optional(),
      prefix: resolutionLine.optional(),
      activation: resolutionLine
    })
    .strict()
    .refine((v) => v.envName !== undefined || v.prefix !== undefined, {
      message: 'conda resolution requires envName or prefix'
    }),
  z
    .object({
      kind: z.literal('venv'),
      prefix: resolutionLine.optional(),
      envName: resolutionLine.optional(),
      activation: resolutionLine
    })
    .strict()
    .refine((v) => v.prefix !== undefined || v.envName !== undefined, {
      message: 'venv resolution requires prefix or envName'
    }),
  z
    .object({
      kind: z.literal('module'),
      modules: z.array(moduleToken).min(1).max(64),
      preamble: resolutionLine.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('apptainer'),
      image: resolutionLine,
      binds: z.array(bindToken).max(64).default([]),
      env: apptainerEnvSchema.default({})
    })
    .strict()
])

// The TS type derived from the resolution schema (after defaults applied). `binds` / `env` are always
// present on apptainer (defaulted to empty).
export type EnvironmentResolution = z.output<typeof ComputeEnvironmentResolutionSchema>

export type EnvironmentResolutionValidationError = {
  error_code: 'invalid_environment_resolution'
  message: string
  field?: string
  retry_after_user_action: boolean
}

export type EnvironmentResolutionValidation =
  | { ok: true; resolution: EnvironmentResolution }
  | { ok: false; error: EnvironmentResolutionValidationError }

const fieldFromIssue = (path: PropertyKey[] | undefined): string | undefined => {
  if (!path || path.length === 0) return undefined
  return path.map(String).join('.')
}

// Validates an unknown resolution value. Never throws. Returns a structured error with the first
// offending field so the IPC/agent boundary can surface a readable message.
export const validateEnvironmentResolution = (input: unknown): EnvironmentResolutionValidation => {
  if (input === undefined || input === null) {
    return {
      ok: false,
      error: {
        error_code: 'invalid_environment_resolution',
        message: 'resolution is required',
        retry_after_user_action: false
      }
    }
  }
  const parsed = ComputeEnvironmentResolutionSchema.safeParse(input)
  if (parsed.success) {
    return { ok: true, resolution: parsed.data }
  }
  const issue = parsed.error.issues[0]
  const field = fieldFromIssue(issue?.path)
  const reason =
    issue?.code === 'unrecognized_keys'
      ? `unknown field${(issue.keys ?? []).length ? `: ${(issue.keys ?? []).join(', ')}` : ''}`
      : (issue?.message ?? 'invalid value')
  const message = field ? `Invalid resolution.${field}: ${reason}` : `Invalid resolution: ${reason}`
  return {
    ok: false,
    error: {
      error_code: 'invalid_environment_resolution',
      message,
      field,
      retry_after_user_action: false
    }
  }
}

// ---------------------------------------------------------------------------
// Portable spec (design.md §8.2 — "ordered package phases, baked variables, weights, required smoke
// checks"). This is the human-authored intent; its content hash makes a changed spec `stale`.
// ---------------------------------------------------------------------------

const packageLine = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => !hasControlChar(s), { message: 'must not contain control characters' })

// A remote cache directory (e.g. `/scratch/proj-01/.cache/hf`). Reaches rendered shell text through
// the weight-bearing provisioning witness, so it is a denylist of shell-active characters rather than
// a length cap. The witness single-quotes the path (quoteRemotePath), but this schema is the second
// layer: a future caller that forgets to quote must not be able to re-open the injection hole.
//
// Deliberately permissive about what real HPC paths look like: slashes, dots, dashes, underscores,
// `+`, `=`, a leading `~`, and spaces all pass (`/scratch/proj-01/.cache/hf`, `/lustre/home/user/envs`,
// `~/.cache/huggingface`). Only characters that are ACTIVE to a shell are rejected — command
// substitution (`$`, backtick), separators/chaining (`;`, `|`, `&`, newline),
// redirection (`<`, `>`), subshells (`(`, `)`) and quote characters that could break out of a
// quoted context. Glob characters (`*`, `?`, `[`) are NOT rejected: they are inert inside quotes and
// legitimate (if rare) in a directory name, and this field is never used as an scp remote spec.
const cachePathToken = z
  .string()
  .min(1)
  .max(2048)
  .refine((s) => !hasControlChar(s) && !/[`$;|&<>()'"]/.test(s), {
    message: 'must not contain shell metacharacters'
  })

const weightSpec = z
  .object({
    name: z.string().min(1).max(256),
    uri: z.string().min(1).max(2048),
    digest: z.string().max(256).optional()
  })
  .strict()

const smokeCheck = z
  .object({
    // A short CLI/import witness (e.g. "python -c 'import torch'"). Stored for audit; never re-run
    // blindly by this slice (issue 06 owns validation execution).
    command: z.string().min(1).max(1024),
    kind: z.enum(['import', 'cli', 'gpu', 'workload']).optional()
  })
  .strict()

export const ComputeEnvironmentSpecSchema = z
  .object({
    runtime: z.enum(['conda', 'venv', 'module', 'apptainer']),
    base: z.string().max(256).optional(),
    packages: z.array(packageLine).max(4096).default([]),
    variables: z
      .record(envKeyToken, envValueToken)
      .refine((env) => Object.keys(env).every((k) => !isSecretEnvKey(k)), {
        message: 'spec variables must not carry secret-bearing keys'
      })
      .default({}),
    weights: z.array(weightSpec).max(256).default([]),
    cachePath: cachePathToken.optional(),
    smokeChecks: z.array(smokeCheck).max(64).default([])
  })
  .strict()

export type EnvironmentSpec = z.output<typeof ComputeEnvironmentSpecSchema>

export type EnvironmentSpecValidationError = {
  error_code: 'invalid_environment_spec'
  message: string
  field?: string
  retry_after_user_action: boolean
}

export type EnvironmentSpecValidation =
  { ok: true; spec: EnvironmentSpec } | { ok: false; error: EnvironmentSpecValidationError }

export const validateEnvironmentSpec = (input: unknown): EnvironmentSpecValidation => {
  if (input === undefined || input === null) {
    return {
      ok: false,
      error: {
        error_code: 'invalid_environment_spec',
        message: 'spec is required',
        retry_after_user_action: false
      }
    }
  }
  const parsed = ComputeEnvironmentSpecSchema.safeParse(input)
  if (parsed.success) {
    return { ok: true, spec: parsed.data }
  }
  const issue = parsed.error.issues[0]
  const field = fieldFromIssue(issue?.path)
  const reason =
    issue?.code === 'unrecognized_keys'
      ? `unknown field${(issue.keys ?? []).length ? `: ${(issue.keys ?? []).join(', ')}` : ''}`
      : (issue?.message ?? 'invalid value')
  const message = field ? `Invalid spec.${field}: ${reason}` : `Invalid spec: ${reason}`
  return {
    ok: false,
    error: {
      error_code: 'invalid_environment_spec',
      message,
      field,
      retry_after_user_action: false
    }
  }
}

// Spec hash lives in the main-only `spec-hash` module: SHA-256 uses node:crypto, which is unavailable
// in the renderer. Keeping it out of this browser-importable module prevents the renderer from pulling
// in node:crypto and white-screening on load. See `src/main/compute/spec-hash.ts`.

// ---------------------------------------------------------------------------
// Preamble rendering (design.md §8.2 / cross-cutting: Direct SSH and Slurm consume the SAME preamble).
//
// The preamble is a deterministic sequence of shell lines that, when prepended to the job command,
// activates the resolved environment. It is the ONLY thing the submit path injects; the driver renders
// it verbatim into command.sh (Direct) or the sbatch wrapper body (Slurm) before the workload line.
// ---------------------------------------------------------------------------

// Wraps an apptainer env value for safe interpolation into `export KEY=value`. Single-quotes the value
// and escapes embedded single-quotes so a value with spaces / special chars stays one argument.
const shellSingleQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

export const renderEnvironmentPreamble = (resolution: EnvironmentResolution): string => {
  switch (resolution.kind) {
    case 'conda':
    case 'venv':
      // The activation command is fully authored by the user/registry; we emit it verbatim. It is
      // already a single line (resolutionLine forbids control chars), so this is deterministic.
      return resolution.activation
    case 'module': {
      const loads = resolution.modules.map((m) => `module load ${m}`)
      return resolution.preamble ? [...loads, resolution.preamble].join('\n') : loads.join('\n')
    }
    case 'apptainer': {
      // env exports sorted by key for determinism, then a wrapper prefix the driver/caller appends the
      // workload to. Binds are emitted in their stored order (bind order can be load-bearing for mounts).
      const envLines = Object.keys(resolution.env)
        .sort()
        .map((k) => `export ${k}=${shellSingleQuote(resolution.env[k]!)}`)
      const bindArgs = resolution.binds.map((b) => `--bind ${b}`).join(' ')
      const wrapper = `apptainer exec ${bindArgs} ${shellSingleQuote(resolution.image)}`
      return [...envLines, wrapper].join('\n')
    }
  }
}

// ---------------------------------------------------------------------------
// Environment status contract (design.md §8.3)
// ---------------------------------------------------------------------------

export type ComputeEnvironmentStatus =
  'draft' | 'building' | 'validating' | 'ready' | 'failed' | 'stale'

export const COMPUTE_ENVIRONMENT_STATUS_VALUES: readonly ComputeEnvironmentStatus[] = [
  'draft',
  'building',
  'validating',
  'ready',
  'failed',
  'stale'
] as const

// Visibility (design.md §8.1). Environments default to provider-scoped reusable across projects;
// `project` is an explicit isolation escape hatch.
export type ComputeEnvironmentVisibility = 'provider' | 'project'

export const COMPUTE_ENVIRONMENT_VISIBILITY_VALUES: readonly ComputeEnvironmentVisibility[] = [
  'provider',
  'project'
] as const

// ---------------------------------------------------------------------------
// Normalized ComputeEnvironment record (cross-process: main <-> renderer via IPC, main -> repl).
// Timestamps are epoch ms; JSON columns are parsed to their typed shapes at the repository boundary.
// `spec` and `resolution` are always present on rows created by this slice; legacy/seed rows that
// somehow lack them degrade to undefined so the renderer never crashes (design.md §10 compat).
// ---------------------------------------------------------------------------

// A captured validation evidence record (design.md §8.3 — spec hash, driver, resource shape, command,
// exit code, stdout/stderr summary, timestamp, result). Stored as JSON in the validationJson column.
// All fields are plain data; no secrets.
export type EnvironmentValidationEvidence = {
  specHash: string
  driver?: 'direct' | 'slurm'
  resourceShape?: Record<string, unknown>
  command: string
  exitCode: number | null
  stdoutSummary?: string
  stderrSummary?: string
  validatedAt: string // ISO timestamp
  result: 'ready' | 'failed'
}

export type ComputeEnvironment = {
  id: string
  providerId: string
  name: string
  visibility: ComputeEnvironmentVisibility
  specHash: string
  spec: EnvironmentSpec | undefined
  resolution: EnvironmentResolution | undefined
  status: ComputeEnvironmentStatus
  buildJobId: string | undefined
  validation: EnvironmentValidationEvidence | undefined
  validatedAt: number | undefined
  detailsDoc: string
  createdAt: number
  updatedAt: number
}

// A compact summary for list views — omits the bulky spec/resolution JSON.
export type ComputeEnvironmentSummary = {
  id: string
  providerId: string
  name: string
  visibility: ComputeEnvironmentVisibility
  status: ComputeEnvironmentStatus
  specHash: string
  resolutionKind: EnvironmentResolution['kind'] | undefined
  resolutionSummary: string
  validatedAt: number | undefined
  validationResult: 'ready' | 'failed' | undefined
  updatedAt: number
}

// Builds a one-line human-readable summary of a resolution for approval/Settings display. Pure.
export const summarizeResolution = (resolution: EnvironmentResolution | undefined): string => {
  if (!resolution) return ''
  switch (resolution.kind) {
    case 'conda':
      return resolution.kind + (resolution.envName ? `:${resolution.envName}` : ':<prefix>')
    case 'venv':
      return resolution.kind + (resolution.envName ? `:${resolution.envName}` : ':<prefix>')
    case 'module':
      return `module:${resolution.modules.join(',')}`
    case 'apptainer':
      return `apptainer:${resolution.image.split('/').pop() ?? resolution.image}`
  }
}

// Payload for creating / editing a registry record. spec + resolution are validated at the boundary
// before this reaches the repository; the repository trusts the validated shapes.
export type UpsertComputeEnvironmentRequest = {
  providerId: string
  name: string
  visibility?: ComputeEnvironmentVisibility
  spec: EnvironmentSpec
  resolution: EnvironmentResolution
  detailsDoc?: string
}

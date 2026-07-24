// Slurm sbatch wrapper builder (design.md §4.5).
//
// Assembles the .sbatch script the Slurm driver submits. Ordering rule (design.md §4.5 — structured
// resources are authoritative):
//
//   1. shebang
//   2. STRUCTURED #SBATCH directives from the ResourceRequest (authoritative)
//   3. ALLOWED user #SBATCH directives (already validated by parseAllowedDirectives — never reserved,
//      never conflicting with structured fields)
//   4. RUNNER-OWNED #SBATCH directives (--job-name, --output, --error, --chdir). These are reserved;
//      the runner controls them so stdout/stderr/exit_code land in deterministic paths the poller reads.
//   5. the command body, run under `timeout` and writing exit_code atomically (same pattern as Direct)
//
// The runner-owned directives are emitted LAST so a stray duplicate from the allowed block (impossible
// by construction, but defensively) cannot override the runner's stdout/stderr/workdir.

import { renderResourceDirectives } from './slurm-resources'
import type { ParsedDirective } from './slurm-directives'
import type { ResourceRequest } from '../../shared/compute-resources'

export type SbatchWrapperInput = {
  command: string
  timeoutSeconds: number
  resources: ResourceRequest
  // Allowed, pre-validated user directives (never reserved / never conflicting).
  allowedDirectives: ParsedDirective[]
  // A stable job name for sbatch (defaults to "openscience"). Slurm limits job names to a reasonable
  // length; callers may stamp the short job id.
  jobName?: string
}

// Builds the sbatch wrapper script content.
export const buildSbatchWrapper = (input: SbatchWrapperInput): string => {
  const { command, timeoutSeconds, resources, allowedDirectives, jobName } = input

  // Walltime: prefer the structured timeLimit (authoritative); fall back to the per-job timeoutSeconds
  // so a job without an explicit walltime still gets one the poller's timeout logic can rely on.
  const walltimeRequest: ResourceRequest =
    resources.timeLimitSeconds !== undefined
      ? resources
      : { ...resources, timeLimitSeconds: timeoutSeconds }

  const structured = renderResourceDirectives(walltimeRequest)
  const allowed = allowedDirectives.map((d) => `#SBATCH --${d.key}=${d.value}`)

  // Runner-owned directives. --chdir makes stdout/stderr/exit_code relative to the workdir.
  const runnerOwned = [
    `#SBATCH --job-name=${jobName ?? 'openscience'}`,
    '#SBATCH --output=stdout',
    '#SBATCH --error=stderr',
    '#SBATCH --chdir=./'
  ]

  const directives = [...structured, ...allowed, ...runnerOwned]

  // Command body: same timeout + atomic exit_code pattern as the Direct launcher, so the poller's
  // exit-code-driven state machine (124→timeout, 0→success, else failed) works unchanged for Slurm.
  //
  // The Slurm poller reads terminal exit codes from `sacct` (ExitCode), NOT from the exit_code file the
  // way the Direct driver does. sacct reports the batch script's OWN exit status, so the wrapper MUST
  // exit with the workload's captured code — otherwise a trailing `echo/mv` (exit 0) would make sacct
  // report 0:0 for every job and a non-zero workload would be misreported as success. We still write the
  // exit_code marker file (parity with Direct + a diagnostic the harvest can surface) before exiting.
  const body = [
    `timeout -s TERM -k 30s ${timeoutSeconds} bash -lc ${shellSingleQuote(command)} > stdout 2> stderr`,
    'code=$?',
    'echo "$code" > exit_code.tmp && mv exit_code.tmp exit_code',
    'exit "$code"'
  ].join('\n')

  return ['#!/usr/bin/env bash', ...directives, '', body].join('\n')
}

// Single-quotes a string for safe interpolation into a remote bash -lc argument. Mirrors scp-runner's
// shellSingleQuote so a command with spaces/special chars stays a single argument.
const shellSingleQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

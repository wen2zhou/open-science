import { createHash } from 'node:crypto'

import type { ComputeJob } from '../../shared/compute'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { SshRunner } from './ssh-runner'
import { resolveSshTarget } from './ssh-runner'
import type { ScpRunner } from './scp-runner'
import { SystemScpRunner, runScpUpload } from './scp-runner'
import { shellSingleQuote } from './scp-runner'
import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'
import { DirectDriver, DirectDispatchError } from './direct-driver'
import { resolveJobDriver } from './compute-driver'
import { ResourceRequestSchema, type ResourceRequest } from '../../shared/compute-resources'
import {
  ComputeEnvironmentResolutionSchema,
  renderEnvironmentPreamble
} from '../../shared/compute-environment'

// Remote handle stored in the DB once the job is launched. This is the LEGACY unversioned shape the
// pre-refactor Direct dispatcher wrote. New jobs now store a versioned RemoteHandleV1 (written by the
// Direct driver), but this type stays exported because the poller's historical `_parseHandle` path
// and existing tests still reference it. parseRemoteHandle (src/shared/remote-handle.ts) accepts both.
export type RemoteHandle = {
  pid: number
  exit_code_path: string
  stdout_path: string
  stderr_path: string
  workdir: string
}

// Builds the launcher.sh script content for a given job.
// Uses timeout(1) with SIGTERM then SIGKILL after 30s grace. Login shell (-l) loads environment
// (module/conda PATH), then exec replaces it with a non-login shell to run command.sh. This
// prevents login shell initialization messages (from .bashrc/.bash_profile) from polluting stderr.
// exit_code is written via a tmp→rename atomic pattern so the poller never reads a partial value.
export const buildLauncherScript = (timeoutSeconds: number): string => {
  return (
    '#!/usr/bin/env bash\n' +
    `timeout -s TERM -k 30s ${timeoutSeconds} bash -l -c 'exec bash command.sh' > stdout 2> stderr\n` +
    'echo $? > exit_code.tmp && mv exit_code.tmp exit_code\n'
  )
}

// Encodes a string to base64 for safe transfer via a single SSH command (avoids heredoc/quoting).
export const toBase64 = (content: string): string => Buffer.from(content).toString('base64')

// Computes the SHA-256 hash of a command string for auditing and deduplication.
export const hashCommand = (command: string): string =>
  createHash('sha256').update(command).digest('hex')

// Calculates the remote workdir path from the scratch root and job id.
// This is called both at submit time (to return immediately) and by the dispatcher.
export const computeRemoteWorkdir = (scratchRoot: string | undefined, jobId: string): string => {
  const root = scratchRoot?.trim() || '~'
  return `${root}/.openscience/jobs/${jobId}`
}

// Quotes a remote path for safe interpolation into a remote shell command, while still allowing a
// leading `~` to be expanded to $HOME by the shell. A tilde inside double/single quotes is NOT
// expanded by bash, so the `~/` prefix is left unquoted and only the remainder is single-quoted
// (single quotes also neutralise $, backticks, spaces, etc. for injection safety). Paths without a
// leading tilde are single-quoted wholesale.
export const quoteRemotePath = (path: string): string => {
  const singleQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
  if (path === '~') return '~'
  if (path.startsWith('~/')) return `~/${singleQuote(path.slice(2))}`
  return singleQuote(path)
}

// One entry in the stored input manifest. Created by ComputeService (validation/resolution)
// and consumed by the dispatcher (staging).
export type StagedInputEntry =
  | { kind: 'upload'; localPath: string; dstFilename: string; label: string }
  | { kind: 'symlink'; remotePath: string; dstFilename: string; label: string }

// Performs the remote staging for all entries: scp upload for 'upload' entries,
// remote ln -s for 'symlink' entries. All-or-nothing: throws on first failure.
// Called inside dispatchJob after the SSH target is resolved.
export const stageInputs = async (
  entries: StagedInputEntry[],
  workdir: string,
  runner: SshRunner,
  target: import('./ssh-runner').ResolvedSshTarget,
  scpRunner: ScpRunner
): Promise<void> => {
  for (const entry of entries) {
    if (entry.kind === 'upload') {
      const remoteDest = `${workdir}/${entry.dstFilename}`
      await runScpUpload(scpRunner, target, entry.localPath, remoteDest)
    } else {
      // Remote symlink: ln -s /abs/path workdir/dst_filename
      const quoted = shellSingleQuote(entry.remotePath)
      const destQ = quoteRemotePath(`${workdir}/${entry.dstFilename}`)
      const lnCmd = `ln -s ${quoted} ${destQ}`
      const result = await runner.run(target, lnCmd, {
        timeoutMs: 30_000,
        loginShell: false,
        maxOutputBytes: 4 * 1024
      })
      if (result.exitCode !== 0) {
        throw new Error(
          `ln -s failed for ${entry.label}: ${result.stderr.trim() || `exit ${result.exitCode ?? 'null'}`}`
        )
      }
    }
  }
}

// Dependency interface for the dispatcher. Tests inject a fake SshRunner.
export type DispatcherDeps = {
  runner: SshRunner
  scpRunner?: ScpRunner
  hostRepository: ComputeHostRepository
  jobRepository: ComputeJobRepository
  // Optional broadcast hook for Phase 3d renderer IPC; no-op when omitted (Phase 3a).
  onJobUpdated?: (job: ComputeJob) => void
  // Tracks this dispatch as in-flight so the poller won't mistake a job that is still staging
  // inputs for a restart-orphaned one. Defaults to the process-wide shared tracker.
  dispatchTracker?: DispatchTracker
  // The compute driver registry used to resolve the job's snapshotted driver (design.md §4.2).
  // When omitted the dispatcher builds a per-call DirectDriver from `runner` — the only driver that
  // existed before this seam — so legacy callers and tests keep working unchanged.
  driverRegistry?: import('./compute-driver').ComputeDriverRegistry
}

// Dispatches one job to its remote host asynchronously (not awaited by submit_job RPC).
// Transitions: submitted → running (success) or error (any failure).
export async function dispatchJob(jobId: string, deps: DispatcherDeps): Promise<void> {
  const tracker = deps.dispatchTracker ?? sharedDispatchTracker
  // Mark in-flight synchronously (before the first await) so the poller can never observe this job
  // as untracked while its dispatch is genuinely running. Cleared in the finally below.
  tracker.begin(jobId)
  try {
    await dispatchJobInner(jobId, deps)
  } finally {
    tracker.end(jobId)
  }
}

// Re-hydrates a validated resource snapshot from the stored JSON string. The value was validated at
// the RPC boundary before it was stored (design.md §5); this re-validates defensively so a corrupted or
// legacy row degrades to an empty request rather than crashing dispatch (design.md §10).
const parseStoredResourceRequest = (stored: string | undefined): ResourceRequest => {
  if (!stored) return {}
  try {
    const parsed = ResourceRequestSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

// Re-renders the deterministic environment preamble from the snapshot persisted on the job row
// (design.md §8.3 — the job audit snapshot carries the chosen environment / spec hash / resolution
// snapshot, and the dispatcher reproduces the exact preamble the submit path resolved). Degrades to
// undefined when no snapshot is stored (plain command job) or the stored JSON is corrupt.
const parseStoredEnvironmentPreamble = (stored: string | undefined): string | undefined => {
  if (!stored) return undefined
  try {
    const snapshot = JSON.parse(stored) as { resolution?: unknown }
    if (!snapshot.resolution) return undefined
    const parsed = ComputeEnvironmentResolutionSchema.safeParse(snapshot.resolution)
    return parsed.success ? renderEnvironmentPreamble(parsed.data) : undefined
  } catch {
    return undefined
  }
}

async function dispatchJobInner(jobId: string, deps: DispatcherDeps): Promise<void> {
  const { runner, hostRepository, jobRepository, onJobUpdated } = deps
  const scpRunner = deps.scpRunner ?? new SystemScpRunner()

  const job = await jobRepository.get(jobId)
  if (!job) return // already gone (unlikely but guard anyway)

  const host = await hostRepository.get(job.provider_id)
  if (!host) {
    const updated = await jobRepository.update(jobId, {
      status: 'error',
      errorCode: 'dispatch_failed',
      finishedAt: new Date()
    })
    onJobUpdated?.(updated)
    return
  }

  // Resolve SSH target (runs ssh -G). Failure = host_unreachable.
  let target
  try {
    target = await resolveSshTarget(host.sshAlias, host.sshOverrides)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const updated = await jobRepository.update(jobId, {
      status: 'error',
      errorCode: 'host_unreachable',
      stderrTail: msg,
      finishedAt: new Date()
    })
    onJobUpdated?.(updated)
    return
  }

  const workdir = job.remote_workdir ?? computeRemoteWorkdir(host.scratchRoot, jobId)
  const timeoutSecs = job.timeout_seconds ?? 86400 // default 24h

  // Stage inputs declared in the manifest (all-or-nothing: failure → dispatch_failed).
  if (job.input_manifest) {
    let entries: StagedInputEntry[]
    try {
      entries = JSON.parse(job.input_manifest) as StagedInputEntry[]
    } catch {
      const updated = await jobRepository.update(jobId, {
        status: 'error',
        errorCode: 'dispatch_failed',
        stderrTail: 'Failed to parse inputManifest JSON',
        finishedAt: new Date()
      })
      onJobUpdated?.(updated)
      return
    }

    // Mkdir workdir first so symlinks and uploads have a destination.
    const mkdirResult = await runner.run(target, `mkdir -p ${quoteRemotePath(workdir)}`, {
      timeoutMs: 30_000,
      loginShell: false,
      maxOutputBytes: 4 * 1024
    })
    if (mkdirResult.exitCode !== 0) {
      const tail = mkdirResult.stderr || `mkdir exit ${mkdirResult.exitCode ?? 'null'}`
      const updated = await jobRepository.update(jobId, {
        status: 'error',
        errorCode: 'dispatch_failed',
        stderrTail: tail,
        finishedAt: new Date()
      })
      onJobUpdated?.(updated)
      return
    }

    try {
      await stageInputs(entries, workdir, runner, target, scpRunner)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const updated = await jobRepository.update(jobId, {
        status: 'error',
        errorCode: 'dispatch_failed',
        stderrTail: `Input staging failed: ${msg}`,
        finishedAt: new Date()
      })
      onJobUpdated?.(updated)
      return
    }
  }

  // Resolve the job's snapshotted driver (design.md §4.1). A job is always dispatched by the driver
  // resolved at submit time; later host re-probes never change it. When no registry is wired (legacy
  // callers / tests), fall back to a DirectDriver built from the runner — the only driver that
  // existed before this seam.
  //
  // The fallback applies ONLY to jobs whose snapshotted kind IS direct (or legacy rows with no kind).
  // A 'slurm' job must never be launched over plain SSH just because no Slurm driver is registered
  // (design.md §3 invariant 7 — "treat undefined as this backend is not enabled rather than silently
  // falling back"): the poller would then look the job up by its snapshotted kind, find a handle the
  // Slurm driver does not recognize, and leave it at `running` forever.
  const resolvedDriver = resolveJobDriver(job, deps.driverRegistry)
  if (!resolvedDriver && job.driver && job.driver !== 'direct') {
    const updated = await jobRepository.update(jobId, {
      status: 'error',
      errorCode: 'dispatch_failed',
      stderrTail:
        `No '${job.driver}' compute driver is registered, so this job cannot be dispatched. ` +
        `Refusing to fall back to direct SSH execution.`,
      finishedAt: new Date()
    })
    onJobUpdated?.(updated)
    return
  }
  const driver = resolvedDriver ?? new DirectDriver({ runner })

  // Delegate remote launch to the driver. The driver builds the scripts, transfers them, launches the
  // detached process, and returns a versioned handle. Connection/launch failures surface as a
  // DirectDispatchError carrying the job error_code; the dispatcher maps them to job status. Any other
  // thrown error is treated as an unexpected infrastructure failure (dispatch_failed).
  let versionedHandle
  try {
    versionedHandle = await driver.dispatch({
      target,
      workdir,
      command: job.command,
      timeoutSeconds: timeoutSecs,
      jobId,
      // Re-hydrate the validated resource snapshot for the driver. The stored string was already
      // validated at the RPC boundary (design.md §5); a malformed/missing value degrades to an empty
      // request so dispatch never crashes (design.md §10 — a bad row must not break loading).
      resources: parseStoredResourceRequest(job.resource_request),
      // Re-render the deterministic environment preamble from the snapshot so both drivers consume the
      // exact activation the submit path resolved (design.md §8.3 / cross-cutting requirement).
      environmentPreamble: parseStoredEnvironmentPreamble(job.environment_snapshot)
    })
  } catch (err) {
    let errorCode = 'dispatch_failed'
    let tail = err instanceof Error ? err.message : String(err)
    if (err instanceof DirectDispatchError) {
      errorCode = err.code
      tail = err.detail
    }
    const updated = await jobRepository.update(jobId, {
      status: 'error',
      errorCode,
      stderrTail: tail,
      finishedAt: new Date()
    })
    onJobUpdated?.(updated)
    return
  }

  // Persist the versioned handle. The driver returns a direct-v1 handle; legacy readers still parse
  // it (parseRemoteHandle accepts both). The stored string IS the audit/recovery handle the poller
  // and restart recovery consume (design.md §4.3).
  const updated = await jobRepository.update(jobId, {
    status: 'running',
    remoteHandle: JSON.stringify(versionedHandle),
    startedAt: new Date()
  })
  onJobUpdated?.(updated)
}

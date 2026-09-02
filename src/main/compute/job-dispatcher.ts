import { createHash } from 'node:crypto'

import type {
  ComputeJob,
  ComputeJobRemoteObjectEvidence,
  ComputeJobRemoteObjectIdentity
} from '../../shared/compute'
import { hasImmutableExecutionFileEvidenceReference } from '../../shared/execution-file-evidence'
import { createLogger, errorLogFields } from '../logger'
import { decodeDataPath } from '../storage/data-path'
import {
  classifyConnectionFailure,
  ComputeConnectionError,
  redactConnectionOutputs,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from './connection-broker'
import { quoteRemotePath, shellSingleQuote } from './remote-path-security'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'
import { ComputeJobLifecycle } from './compute-job-lifecycle'
import { classifyComputeJobExit, probeRemoteLaunch } from './remote-launch-recovery'
import {
  cleanupComputeJobFileEvidence,
  publishComputeJobFileEvidence,
  settleComputeJobFileEvidence
} from '../notebook/working-file-observer'

// Maximum number of bytes for the per-job dispatch SSH command (enough for base64 of large scripts).
const DISPATCH_MAX_OUTPUT_BYTES = 4 * 1024

// Timeout for the dispatch SSH connection (mkdir + write files + launch). Generous to accommodate
// slow cluster file systems; the job itself runs detached so the connection can close after.
const DISPATCH_TIMEOUT_MS = 120_000
const OWNER_MARKER_FILE = '.openscience-owner'
const DISPATCH_PROTOCOL_PREFIX = 'OPEN_SCIENCE_DISPATCH_V2'
const log = createLogger('compute')

// Remote handle stored in the DB once the job is launched.
export type RemoteHandle = {
  pid: number
  exit_code_path: string
  stdout_path: string
  stderr_path: string
  workdir: string
}

export const REMOTE_PROCESS_OWNERSHIP_FUNCTION = [
  'process_owned_by_workdir() {',
  '  pid=$1',
  '  expected_workdir=$2',
  "  case $pid in ''|*[!0-9]*) return 1 ;; esac",
  '  [ -n "$expected_workdir" ] || return 1',
  '  process_workdir=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)',
  '  if [ -z "$process_workdir" ] && command -v lsof >/dev/null 2>&1; then',
  `    process_workdir=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)`,
  '  fi',
  '  [ "$process_workdir" = "$expected_workdir" ]',
  '}'
].join('\n')

// Builds the launcher.sh script content for a given job.
// Uses timeout(1) with SIGTERM then SIGKILL after 30s grace. The login shell loads profile
// configuration, then attempts to source a readable .bashrc (non-interactive bash does not do so
// itself). A missing .bashrc is a no-op; a source failure returns through the normal exit-code
// lifecycle. A .bashrc may deliberately return early for non-interactive shells. exec then replaces
// the initialized shell with the user workload shell.
// exit_code is written via a tmp→rename atomic pattern so the poller never reads a partial value.
export const buildLauncherScript = (timeoutSeconds: number): string => {
  return (
    '#!/usr/bin/env bash\n' +
    `timeout -s TERM -k 30s ${timeoutSeconds} bash -l -c 'if [ -r ~/.bashrc ]; then . ~/.bashrc || exit $?; fi; exec bash command.sh' > stdout 2> stderr\n` +
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

const buildOwnerMarkerCommand = (workdir: string, ownerMarker: string): string => {
  const boundary = workdir.lastIndexOf('/.openscience/jobs/')
  if (boundary < 0) throw new Error('Unsafe remote Compute Job owner boundary.')
  const scratchRoot = boundary === 0 ? '/' : workdir.slice(0, boundary)
  const markerQ = quoteRemotePath(`${workdir}/${OWNER_MARKER_FILE}`)
  const markerValueQ = shellSingleQuote(ownerMarker)
  return [
    'set -eu',
    'set -f',
    'umask 077',
    `scratch_input=${shellSingleQuote(scratchRoot)}`,
    `workdir_input=${shellSingleQuote(workdir)}`,
    'case "$scratch_input" in "~") scratch_root=$HOME ;; "~/"*) scratch_root=$HOME/${scratch_input#??} ;; *) scratch_root=$scratch_input ;; esac',
    'case "$workdir_input" in "~/"*) workdir=$HOME/${workdir_input#??} ;; *) workdir=$workdir_input ;; esac',
    'path_no_symlinks() {',
    '  current=',
    '  old_ifs=$IFS',
    '  IFS=/',
    '  set -- $1',
    '  IFS=$old_ifs',
    '  for part do',
    '    [ -n "$part" ] || continue',
    '    current=$current/$part',
    '    [ -d "$current" ] && [ ! -L "$current" ] || return 1',
    '  done',
    '}',
    'path_no_symlinks "$scratch_root" || exit 71',
    'managed_root=${scratch_root%/}/.openscience',
    'jobs_root=$managed_root/jobs',
    'mkdir "$managed_root" 2>/dev/null || [ -d "$managed_root" ]',
    '[ -d "$managed_root" ] && [ ! -L "$managed_root" ] || exit 71',
    'mkdir "$jobs_root" 2>/dev/null || [ -d "$jobs_root" ]',
    '[ -d "$jobs_root" ] && [ ! -L "$jobs_root" ] || exit 71',
    'mkdir "$workdir" 2>/dev/null || [ -d "$workdir" ]',
    'path_no_symlinks "$workdir" || exit 71',
    `if [ -e ${markerQ} ] || [ -L ${markerQ} ]; then`,
    `  [ -f ${markerQ} ] && [ ! -L ${markerQ} ] || exit 72`,
    `  [ "$(cat ${markerQ} 2>/dev/null)" = ${markerValueQ} ] || exit 73`,
    'else',
    `  (set -C; printf '%s' ${markerValueQ} > ${markerQ}) 2>/dev/null || exit 74`,
    'fi',
    `path_no_symlinks "$workdir" && [ -f ${markerQ} ] && [ ! -L ${markerQ} ] && [ "$(cat ${markerQ} 2>/dev/null)" = ${markerValueQ} ] || exit 75`
  ].join('\n')
}

type DispatchEvidenceDescriptor = Readonly<{
  path: string
  role: ComputeJobRemoteObjectEvidence['role']
  kind: ComputeJobRemoteObjectIdentity['kind']
}>

const buildIdentityCaptureLines = (
  workdir: string,
  descriptors: readonly DispatchEvidenceDescriptor[]
): string[] => {
  const lines = [
    'stat_file_identity() {',
    '  stat -c \'%d:%i:%s:%Y\' -- "$1" 2>/dev/null || stat -f \'%d:%i:%z:%m\' "$1" 2>/dev/null',
    '}',
    'stat_link_identity() {',
    '  stat -c \'%d:%i\' -- "$1" 2>/dev/null || stat -f \'%d:%i\' "$1" 2>/dev/null',
    '}',
    `printf '%s\\n' ${shellSingleQuote(DISPATCH_PROTOCOL_PREFIX)}`,
    `printf 'pid:%s\\n' "$LAUNCHED_PID"`
  ]
  descriptors.forEach((descriptor, index) => {
    const pathQ = quoteRemotePath(`${workdir}/${descriptor.path}`)
    if (descriptor.kind === 'file') {
      lines.push(
        `[ -f ${pathQ} ] && [ ! -L ${pathQ} ] || exit 76`,
        `object_identity=$(stat_file_identity ${pathQ}) || exit 76`,
        `printf 'object:${index}:file:%s\\n' "$object_identity"`
      )
    } else {
      lines.push(
        `[ -L ${pathQ} ] || exit 76`,
        `object_identity=$(stat_link_identity ${pathQ}) || exit 76`,
        `link_target=$(readlink ${pathQ}) || exit 76`,
        `link_target_b64=$(printf '%s' "$link_target" | base64 | tr -d '\\r\\n') || exit 76`,
        `printf 'object:${index}:symlink:%s:%s\\n' "$object_identity" "$link_target_b64"`
      )
    }
  })
  return lines
}

const parseDispatchProtocol = (
  stdout: string,
  descriptors: readonly DispatchEvidenceDescriptor[]
): { pid: number; evidence: ComputeJobRemoteObjectEvidence[] } | undefined => {
  const lines = stdout.trim().split('\n')
  // Compatibility with an already-started dispatch from the previous protocol. Such a job remains
  // safe because absent evidence cannot authorize future cleanup.
  if (lines.length === 1 && /^[1-9]\d*$/.test(lines[0]!)) {
    const pid = Number(lines[0])
    return Number.isSafeInteger(pid) && pid > 1 ? { pid, evidence: [] } : undefined
  }
  if (lines[0] !== DISPATCH_PROTOCOL_PREFIX || !/^pid:[1-9]\d*$/.test(lines[1] ?? '')) {
    return undefined
  }
  const pid = Number(lines[1]!.slice('pid:'.length))
  if (!Number.isSafeInteger(pid) || pid <= 1 || lines.length !== descriptors.length + 2) {
    return undefined
  }
  const evidence: ComputeJobRemoteObjectEvidence[] = []
  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index]!
    const fields = lines[index + 2]!.split(':')
    if (fields[0] !== 'object' || fields[1] !== String(index) || fields[2] !== descriptor.kind) {
      return undefined
    }
    if (descriptor.kind === 'file') {
      const [device, inode, size, modifiedAtSeconds] = fields.slice(3)
      const sizeBytes = Number(size)
      if (
        fields.length !== 7 ||
        !/^\d+$/.test(device ?? '') ||
        !/^\d+$/.test(inode ?? '') ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 0 ||
        !/^\d+$/.test(modifiedAtSeconds ?? '')
      ) {
        return undefined
      }
      evidence.push({
        path: descriptor.path,
        role: descriptor.role,
        identity: {
          kind: 'file',
          device,
          inode,
          size_bytes: sizeBytes,
          modified_at_ns: `${modifiedAtSeconds}000000000`
        }
      })
    } else {
      const [device, inode, targetBase64] = fields.slice(3)
      if (
        fields.length !== 6 ||
        !/^\d+$/.test(device ?? '') ||
        !/^\d+$/.test(inode ?? '') ||
        targetBase64 === undefined
      ) {
        return undefined
      }
      evidence.push({
        path: descriptor.path,
        role: descriptor.role,
        identity: {
          kind: 'symlink',
          device,
          inode,
          link_target: Buffer.from(targetBase64, 'base64').toString()
        }
      })
    }
  }
  return { pid, evidence }
}

// Quotes a remote path for safe interpolation into a remote shell command, while still allowing a
// leading `~` to be expanded to $HOME by the shell. A tilde inside double/single quotes is NOT
// expanded by bash, so the `~/` prefix is left unquoted and only the remainder is single-quoted
// (single quotes also neutralise $, backticks, spaces, etc. for injection safety). Paths without a
// leading tilde are single-quoted wholesale.
export { quoteRemotePath } from './remote-path-security'

// One entry in the stored input manifest. Created by ComputeService (validation/resolution)
// and consumed by the dispatcher (staging).
export type StagedInputEntry =
  | {
      kind: 'upload'
      localPath: string
      dstFilename: string
      label: string
      generationId?: string
      checksum?: string
      sizeBytes?: number
    }
  | {
      kind: 'symlink'
      remotePath: string
      dstFilename: string
      label: string
      managedUri?: string
    }

// Performs the remote staging for all entries: scp upload for 'upload' entries,
// remote ln -s for 'symlink' entries. All-or-nothing: throws on first failure.
// Called inside dispatchJob after the SSH target is resolved.
export const stageInputs = async (
  entries: StagedInputEntry[],
  workdir: string,
  connection: ComputeConnectionLease
): Promise<void> => {
  for (const entry of entries) {
    if (entry.kind === 'upload') {
      const remoteDest = `${workdir}/${entry.dstFilename}`
      await connection.upload(entry.localPath, remoteDest)
    } else {
      // Remote symlink: ln -s /abs/path workdir/dst_filename
      const quoted = entry.managedUri
        ? quoteRemotePath(entry.remotePath)
        : shellSingleQuote(entry.remotePath)
      const destQ = quoteRemotePath(`${workdir}/${entry.dstFilename}`)
      const lnCmd = `ln -s ${quoted} ${destQ}`
      const result = await connection.run(lnCmd, {
        timeoutMs: 30_000,
        loginShell: false,
        maxOutputBytes: 4 * 1024
      })
      const connectionFailure = classifyConnectionFailure(result, false)
      if (connectionFailure) throw connectionFailure
      if (result.exitCode !== 0) {
        throw new Error(`ln -s failed for ${entry.label}.`)
      }
    }
  }
}

// Dependency interface for the dispatcher. Tests inject a fake SshRunner.
export type DispatcherDeps = {
  connectionBroker: ComputeConnectionBrokerAcquirer
  hostRepository: ComputeHostRepository
  jobRepository: ComputeJobRepository
  // Optional broadcast hook for Phase 3d renderer IPC; no-op when omitted (Phase 3a).
  onJobUpdated?: (job: ComputeJob) => void
  // Tracks this dispatch as in-flight so the poller won't mistake a job that is still staging
  // inputs for a restart-orphaned one. Defaults to the process-wide shared tracker.
  dispatchTracker?: DispatchTracker
  storageRoot?: string
}

// Dispatches one job to its remote host asynchronously (not awaited by submit_job RPC).
// Transitions: submitted → running/terminal when remote launch state is proven, or error when a
// failure is definitive. Ambiguous launch responses remain submitted for non-destructive recovery.
export async function dispatchJob(jobId: string, deps: DispatcherDeps): Promise<void> {
  const tracker = deps.dispatchTracker ?? sharedDispatchTracker
  // Mark in-flight synchronously (before the first await) so the poller can never observe this job
  // as untracked while its dispatch is genuinely running. Cleared in the finally below.
  tracker.begin(jobId)
  try {
    try {
      await dispatchJobInner(jobId, deps)
    } catch (error) {
      // Unknown failures may occur after the remote launcher has started but before its handle is
      // durable. Leave that row submitted so deterministic restart recovery can adopt it; only a
      // transport failure already proven to be pre-launch is safe to terminalize here.
      if (!(error instanceof ComputeConnectionError)) return
      const lifecycle = new ComputeJobLifecycle(deps.jobRepository, deps.onJobUpdated)
      await lifecycle.dispatchError(jobId, { errorCode: error.code, stderrTail: error.message })
    }
  } finally {
    await finalizeDispatchErrorEvidence(jobId, deps)
    tracker.end(jobId)
  }
}

const finalizeDispatchErrorEvidence = async (
  jobId: string,
  deps: DispatcherDeps
): Promise<void> => {
  if (!deps.storageRoot) return
  const job = await deps.jobRepository.get(jobId).catch(() => null)
  if (!job || job.status !== 'error') return
  if (hasImmutableExecutionFileEvidenceReference(job.file_evidence)) return
  const remoteInputPaths: string[] = []
  if (job.input_manifest) {
    try {
      const entries = JSON.parse(job.input_manifest) as Array<{
        kind?: string
        remotePath?: string
      }>
      for (const entry of entries) {
        if (entry.kind === 'symlink' && entry.remotePath) remoteInputPaths.push(entry.remotePath)
      }
    } catch {
      // New manifests are validated; malformed historical rows remain evidence-unknown.
    }
  }
  try {
    const fileEvidence = await publishComputeJobFileEvidence({
      storageRoot: deps.storageRoot,
      projectId: job.project_id,
      sessionId: job.session_id,
      jobId,
      producerRunId: job.producer_run_id,
      outputs: [],
      remoteInputPaths,
      reasonCodes: ['harvest-incomplete', 'remote-output-not-harvested']
    })
    const lifecycle = new ComputeJobLifecycle(deps.jobRepository, deps.onJobUpdated)
    await lifecycle.recordCleanupEvidence(jobId, ['error'], { fileEvidence })
    await settleComputeJobFileEvidence({
      storageRoot: deps.storageRoot,
      projectId: job.project_id,
      sessionId: job.session_id,
      jobId,
      producerRunId: job.producer_run_id,
      fileEvidence
    }).catch((error) =>
      log.warn('Compute Job file-evidence receipt remains for startup recovery.', {
        jobId,
        ...errorLogFields(error)
      })
    )
  } catch {
    const persisted = await deps.jobRepository.get(jobId).catch(() => null)
    if (persisted && !hasImmutableExecutionFileEvidenceReference(persisted.file_evidence)) {
      await cleanupComputeJobFileEvidence({
        storageRoot: deps.storageRoot,
        projectId: job.project_id,
        sessionId: job.session_id,
        jobId,
        preservePublished: true
      }).catch(() => undefined)
    }
  }
}

async function dispatchJobInner(jobId: string, deps: DispatcherDeps): Promise<void> {
  const { connectionBroker, hostRepository, jobRepository, onJobUpdated } = deps
  const lifecycle = new ComputeJobLifecycle(jobRepository, onJobUpdated)

  const job = await jobRepository.get(jobId)
  if (!job) return // already gone (unlikely but guard anyway)

  const host = await hostRepository.get(job.provider_id)
  if (!host) {
    await lifecycle.dispatchError(jobId, { errorCode: 'dispatch_failed' })
    return
  }

  // The lease captures one Host/authentication-revision snapshot for this entire dispatch.
  let connection: ComputeConnectionLease
  try {
    connection = await connectionBroker.acquire(job.provider_id, { intent: 'job_dispatch' })
  } catch (err) {
    const failure =
      err instanceof ComputeConnectionError
        ? { code: err.code, message: err.message }
        : { code: 'host_unreachable', message: 'The Compute Host could not be reached.' }
    await lifecycle.dispatchError(jobId, {
      errorCode: failure.code,
      stderrTail: failure.message
    })
    return
  }

  const workdir = job.remote_workdir ?? computeRemoteWorkdir(host.scratchRoot, jobId)
  const timeoutSecs = job.timeout_seconds ?? 86400 // default 24h
  if (!job.owner_marker) {
    await lifecycle.dispatchError(jobId, {
      errorCode: 'dispatch_failed',
      stderrTail: 'The remote Compute Job owner marker is unavailable.'
    })
    return
  }

  // Establish durable ownership before any platform file is uploaded, linked, written, or launched.
  // Retried dispatches may reuse the same marker, but a mismatched or non-regular marker fails closed.
  const ownerResult = await connection.run(buildOwnerMarkerCommand(workdir, job.owner_marker), {
    timeoutMs: 30_000,
    loginShell: false,
    maxOutputBytes: 4 * 1024
  })
  const ownerConnectionFailure = classifyConnectionFailure(ownerResult, false)
  if (ownerConnectionFailure) throw ownerConnectionFailure
  if (ownerResult.exitCode !== 0) {
    await lifecycle.dispatchError(jobId, {
      errorCode: 'dispatch_failed',
      stderrTail: 'Could not establish ownership of the remote Compute Job directory.'
    })
    return
  }

  // Stage inputs declared in the manifest (all-or-nothing: failure → dispatch_failed).
  let stagedEntries: StagedInputEntry[] = []
  if (job.input_manifest) {
    try {
      stagedEntries = (JSON.parse(job.input_manifest) as StagedInputEntry[]).map((entry) =>
        entry.kind === 'upload'
          ? { ...entry, localPath: decodeDataPath(entry.localPath, deps.storageRoot)! }
          : entry
      )
    } catch {
      await lifecycle.dispatchError(jobId, {
        errorCode: 'dispatch_failed',
        stderrTail: 'Failed to parse inputManifest JSON'
      })
      return
    }

    try {
      await stageInputs(stagedEntries, workdir, connection)
    } catch (err) {
      if (err instanceof ComputeConnectionError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      await lifecycle.dispatchError(jobId, {
        errorCode: 'dispatch_failed',
        stderrTail: `Input staging failed: ${msg}`
      })
      return
    }
  }

  // Build scripts.
  const commandScript = job.command // raw command content written to command.sh
  const launcherScript = buildLauncherScript(timeoutSecs)

  // Encode to base64 to avoid all shell quoting/injection issues.
  const commandB64 = toBase64(commandScript)
  const launcherB64 = toBase64(launcherScript)
  const evidenceDescriptors: DispatchEvidenceDescriptor[] = [
    { path: 'command.sh', role: 'control', kind: 'file' },
    { path: 'launcher.sh', role: 'control', kind: 'file' },
    { path: 'job.pid', role: 'control', kind: 'file' },
    ...stagedEntries.map((entry) => ({
      path: entry.dstFilename,
      role: entry.kind === 'upload' ? ('input_upload' as const) : ('input_symlink' as const),
      kind: entry.kind === 'upload' ? ('file' as const) : ('symlink' as const)
    }))
  ]

  // One SSH command: mkdir workdir, write scripts via base64 pipes, launch detached, echo pid.
  // Stdout = the pid (we echo it last).
  const quotedWorkdir = quoteRemotePath(workdir)
  const dispatchCmd = [
    `[ -d ${quotedWorkdir} ] && [ ! -L ${quotedWorkdir} ]`,
    `cd ${quotedWorkdir}`,
    // Write command.sh and launcher.sh via base64 to avoid heredoc/quoting issues.
    `printf '%s' ${JSON.stringify(commandB64)} | base64 -d > command.sh`,
    `printf '%s' ${JSON.stringify(launcherB64)} | base64 -d > launcher.sh`,
    `chmod +x command.sh launcher.sh`,
    // Detached launch: nohup + setsid so the process survives SSH disconnect.
    `nohup setsid bash launcher.sh >/dev/null 2>&1 &`,
    // Write pid to file AND echo it so we can read it back in this round-trip.
    `LAUNCHED_PID=$!`,
    `echo $LAUNCHED_PID > job.pid`,
    ...buildIdentityCaptureLines(workdir, evidenceDescriptors)
  ].join('\n')

  let runResult
  try {
    runResult = await connection.run(dispatchCmd, {
      timeoutMs: DISPATCH_TIMEOUT_MS,
      loginShell: false,
      maxOutputBytes: DISPATCH_MAX_OUTPUT_BYTES
    })
  } catch (error) {
    if (isDefinitivePreLaunchConnectionError(error)) throw error
    await recoverAmbiguousRemoteLaunch(job, connection, workdir, lifecycle)
    return
  }

  const connectionFailure = classifyConnectionFailure(runResult, false)
  if (connectionFailure) {
    if (isDefinitivePreLaunchResult(runResult, connectionFailure)) throw connectionFailure
    await recoverAmbiguousRemoteLaunch(job, connection, workdir, lifecycle)
    return
  }

  // Non-connection failure (mkdir, base64, etc.)
  if (runResult.exitCode !== 0) {
    await lifecycle.dispatchError(jobId, {
      errorCode: 'dispatch_failed',
      stderrTail: 'The remote Compute Job launcher failed.'
    })
    return
  }

  // The dispatch protocol is exactly one positive integer line. Partial output and permissive
  // parseInt prefixes are ambiguous because adopting the wrong PID can later target another job.
  const protocol = parseDispatchProtocol(runResult.stdout, evidenceDescriptors)
  if (runResult.truncated || !protocol) {
    await recoverAmbiguousRemoteLaunch(job, connection, workdir, lifecycle, runResult.stdout)
    return
  }
  const { pid } = protocol

  // Build the remote handle JSON.
  const handle: RemoteHandle = {
    pid,
    exit_code_path: `${workdir}/exit_code`,
    stdout_path: `${workdir}/stdout`,
    stderr_path: `${workdir}/stderr`,
    workdir
  }

  const transition = await lifecycle.dispatchRunning(jobId, JSON.stringify(handle))
  if (transition.kind === 'applied') {
    // Execution is already durably running if this additive evidence write fails. Missing evidence
    // fails cleanup closed; it must never cause a second launcher to be started.
    await lifecycle.recordCleanupEvidence(jobId, ['running'], {
      remoteObjectEvidence: protocol.evidence
    })
  }
}

const isDefinitivePreLaunchConnectionError = (error: unknown): boolean =>
  error instanceof ComputeConnectionError &&
  error.code !== 'host_unreachable' &&
  error.code !== 'timeout'

const isDefinitivePreLaunchResult = (
  result: { stderr: string },
  failure: ComputeConnectionError
): boolean => {
  if (failure.code !== 'host_unreachable' && failure.code !== 'timeout') return true
  if (failure.code === 'timeout') return false
  const stderr = result.stderr.toLowerCase()
  return (
    stderr.includes('connection refused') ||
    stderr.includes('network is unreachable') ||
    stderr.includes('no route to host') ||
    stderr.includes('could not resolve hostname')
  )
}

const recoverAmbiguousRemoteLaunch = async (
  job: ComputeJob,
  connection: ComputeConnectionLease,
  workdir: string,
  lifecycle: ComputeJobLifecycle,
  invalidProtocolOutput?: string
): Promise<void> => {
  let observation
  try {
    observation = await probeRemoteLaunch(connection, workdir)
  } catch (error) {
    // A failed recovery probe cannot distinguish "not launched" from "launched but unreachable".
    // Keep the durable submitted row for the poller to retry instead of inventing a terminal error.
    await lifecycle.recordPollError(
      job.job_id,
      'submitted',
      error instanceof ComputeConnectionError ? error.code : 'dispatch_recovery_probe_failed'
    )
    return
  }

  if (observation.kind === 'running') {
    await lifecycle.dispatchRunning(job.job_id, JSON.stringify(observation.handle))
    return
  }
  if (observation.kind === 'exited') {
    const exitCode = observation.exitCode
    const { status, errorCode } = classifyComputeJobExit(job, exitCode)
    await lifecycle.finishPolled(job.job_id, {
      status,
      exitCode,
      errorCode,
      stdoutTail: null,
      stderrTail: null
    })
    return
  }
  if (observation.kind === 'vanished') {
    await lifecycle.finishPolled(job.job_id, {
      status: 'failed',
      errorCode: 'process_vanished',
      stdoutTail: null,
      stderrTail: null
    })
    return
  }
  if (observation.kind === 'not_started' && invalidProtocolOutput !== undefined) {
    const [safeStdout = ''] = await redactConnectionOutputs(connection, [invalidProtocolOutput])
    const stderrTail = `Could not read pid from dispatch output: ${JSON.stringify(safeStdout)}`
    await lifecycle.dispatchError(job.job_id, { errorCode: 'dispatch_failed', stderrTail })
    return
  }
  if (observation.kind === 'pending' || observation.kind === 'not_started') {
    await lifecycle.recordPollError(job.job_id, 'submitted', 'dispatch_recovery_pending')
    return
  }
  if (observation.kind === 'ambiguous') {
    await lifecycle.recordPollError(job.job_id, 'submitted', 'dispatch_recovery_ambiguous')
  }
  // An inconclusive workdir — including one not created yet immediately after response loss — is
  // genuinely ambiguous. The poller retries the same non-destructive probe on its next tick.
}

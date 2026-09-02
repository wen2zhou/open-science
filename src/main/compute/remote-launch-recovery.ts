import { classifyConnectionFailure, type ComputeConnectionLease } from './connection-broker'
import { quoteRemotePath } from './remote-path-security'

import type {
  ComputeJob,
  ComputeJobRemoteObjectEvidence,
  ComputeJobRemoteObjectIdentity
} from '../../shared/compute'
import type { RemoteHandle } from './job-dispatcher'
import { remoteJobPidOwnershipFunctionLines } from './remote-job-process'

const RECOVERY_PROTOCOL = 'OPEN_SCIENCE_DISPATCH_RECOVERY_V1'
const RECOVERY_TIMEOUT_MS = 30_000
const RECOVERY_MAX_OUTPUT_BYTES = 1024
const RECOVERY_EVIDENCE_PROTOCOL = 'OPEN_SCIENCE_DISPATCH_EVIDENCE_V1'
const OWNER_MARKER_FILE = '.openscience-owner'

type RecoveryEvidenceDescriptor = Readonly<{
  path: string
  role: ComputeJobRemoteObjectEvidence['role']
  kind: ComputeJobRemoteObjectIdentity['kind']
}>

type RemoteLaunchRecoveryEvidenceRequest = Readonly<{
  ownerMarker: string
  descriptors: readonly RecoveryEvidenceDescriptor[]
}>

export type RemoteLaunchObservation =
  | { kind: 'not_started' }
  | {
      kind: 'running'
      handle: RemoteHandle
      evidence?: ComputeJobRemoteObjectEvidence[]
      startedAt?: Date
    }
  | { kind: 'exited'; exitCode: number; pid?: number }
  | { kind: 'vanished'; pid: number }
  | { kind: 'pending' }
  | { kind: 'ambiguous' }

export type RecoveredExitState = {
  status: 'success' | 'failed' | 'timeout'
  errorCode: 'job_failed' | 'timeout' | null
}

const positiveInteger = (value: string): number | undefined => {
  if (!/^[1-9]\d*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 1 ? parsed : undefined
}

const exitCodeInteger = (value: string): number | undefined => {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 255 ? parsed : undefined
}

export const remoteHandleFor = (workdir: string, pid: number): RemoteHandle => ({
  pid,
  exit_code_path: `${workdir}/exit_code`,
  stdout_path: `${workdir}/stdout`,
  stderr_path: `${workdir}/stderr`,
  workdir
})

export const classifyComputeJobExit = (
  job: Pick<ComputeJob, 'started_at' | 'submitted_at' | 'timeout_seconds'>,
  exitCode: number
): RecoveredExitState => {
  if (exitCode === 0) return { status: 'success', errorCode: null }
  if (exitCode === 124) return { status: 'timeout', errorCode: 'timeout' }
  if (exitCode !== 137) return { status: 'failed', errorCode: 'job_failed' }

  const startedAt = job.started_at ?? job.submitted_at
  const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0
  return elapsed >= (job.timeout_seconds ?? 86400)
    ? { status: 'timeout', errorCode: 'timeout' }
    : { status: 'failed', errorCode: 'job_failed' }
}

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const recoveryEvidenceRequestForJob = (
  job: Pick<ComputeJob, 'owner_marker' | 'input_manifest'>
): RemoteLaunchRecoveryEvidenceRequest | undefined => {
  if (!job.owner_marker || !/^[A-Za-z0-9_-]{16,256}$/.test(job.owner_marker)) return undefined
  const descriptors: RecoveryEvidenceDescriptor[] = [
    { path: 'command.sh', role: 'control', kind: 'file' },
    { path: 'launcher.sh', role: 'control', kind: 'file' },
    { path: 'job.pid', role: 'control', kind: 'file' }
  ]
  if (job.input_manifest) {
    let entries: unknown
    try {
      entries = JSON.parse(job.input_manifest)
    } catch {
      return undefined
    }
    if (!Array.isArray(entries)) return undefined
    const seen = new Set<string>(descriptors.map(({ path }) => path))
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') return undefined
      const candidate = entry as { kind?: unknown; dstFilename?: unknown }
      if (
        (candidate.kind !== 'upload' && candidate.kind !== 'symlink') ||
        typeof candidate.dstFilename !== 'string' ||
        !candidate.dstFilename ||
        candidate.dstFilename.startsWith('/') ||
        /[\0\r\n*?[\]{}\\]/.test(candidate.dstFilename) ||
        candidate.dstFilename.split('/').some((part) => !part || part === '.' || part === '..') ||
        seen.has(candidate.dstFilename)
      ) {
        return undefined
      }
      descriptors.push({
        path: candidate.dstFilename,
        role: candidate.kind === 'upload' ? 'input_upload' : 'input_symlink',
        kind: candidate.kind === 'upload' ? 'file' : 'symlink'
      })
      seen.add(candidate.dstFilename)
    }
  }
  return { ownerMarker: job.owner_marker, descriptors }
}

const recoveryEvidenceLines = (
  workdir: string,
  request: RemoteLaunchRecoveryEvidenceRequest
): string[] => {
  const marker = quoteRemotePath(`${workdir}/${OWNER_MARKER_FILE}`)
  const lines = [
    'path_no_symlinks() {',
    '  pns_path=$1; pns_current=; pns_old_ifs=$IFS; IFS=/; set -- $pns_path; IFS=$pns_old_ifs',
    '  for pns_part do [ -n "$pns_part" ] || continue; pns_current=$pns_current/$pns_part; [ -d "$pns_current" ] && [ ! -L "$pns_current" ] || return 1; done',
    '}',
    `path_no_symlinks "$workdir" && [ -f ${marker} ] && [ ! -L ${marker} ] && [ "$(cat ${marker} 2>/dev/null)" = ${shellSingleQuote(request.ownerMarker)} ] || exit 76`,
    'stat_file_identity() {',
    `  stat -c '%d:%i:%s:%Y' -- "$1" 2>/dev/null || stat -f '%d:%i:%z:%m' "$1" 2>/dev/null`,
    '}',
    'stat_link_identity() {',
    `  stat -c '%d:%i' -- "$1" 2>/dev/null || stat -f '%d:%i' "$1" 2>/dev/null`,
    '}',
    `printf '%s\\n' ${shellSingleQuote(RECOVERY_EVIDENCE_PROTOCOL)}`
  ]
  request.descriptors.forEach((descriptor, index) => {
    const path = quoteRemotePath(`${workdir}/${descriptor.path}`)
    if (descriptor.kind === 'file') {
      lines.push(
        `[ -f ${path} ] && [ ! -L ${path} ] || exit 76`,
        `object_identity=$(stat_file_identity ${path}) || exit 76`,
        `printf 'object:${index}:file:%s\\n' "$object_identity"`
      )
    } else {
      lines.push(
        `[ -L ${path} ] || exit 76`,
        `object_identity=$(stat_link_identity ${path}) || exit 76`,
        `link_target=$(readlink ${path}) || exit 76`,
        `link_target_b64=$(printf '%s' "$link_target" | base64 | tr -d '\\r\\n') || exit 76`,
        `printf 'object:${index}:symlink:%s:%s\\n' "$object_identity" "$link_target_b64"`
      )
    }
  })
  return lines
}

const buildRecoveryProbe = (
  workdir: string,
  evidenceRequest?: RemoteLaunchRecoveryEvidenceRequest
): string => {
  const quotedWorkdir = quoteRemotePath(workdir)
  const quotedPidFile = quoteRemotePath(`${workdir}/job.pid`)
  const quotedExitCodeFile = quoteRemotePath(`${workdir}/exit_code`)
  return [
    `echo ${RECOVERY_PROTOCOL}`,
    `[ ! -L ${quotedWorkdir} ] || { echo workdir:1; echo exit_code:; echo pid:; echo cwd_match:unknown; echo started_at:; exit 0; }`,
    `if [ -d ${quotedWorkdir} ]; then echo workdir:1; else echo workdir:0; echo exit_code:; echo pid:; echo cwd_match:0; echo started_at:; exit 0; fi`,
    `if [ -f ${quotedExitCodeFile} ]; then RECOVERY_EXIT_CODE=$(cat ${quotedExitCodeFile}); else RECOVERY_EXIT_CODE=; fi`,
    `printf 'exit_code:%s\n' "$RECOVERY_EXIT_CODE"`,
    `if [ -f ${quotedPidFile} ]; then RECOVERY_PID=$(cat ${quotedPidFile}); else RECOVERY_PID=; fi`,
    `printf 'pid:%s\n' "$RECOVERY_PID"`,
    `  RECOVERY_EXPECTED_CWD=$(cd ${quotedWorkdir} 2>/dev/null && pwd -P)`,
    'workdir=$RECOVERY_EXPECTED_CWD',
    ...remoteJobPidOwnershipFunctionLines(),
    `case "$RECOVERY_PID" in '' ) RECOVERY_CWD_MATCH=0 ;; *[!0-9]*) RECOVERY_CWD_MATCH=unknown ;; *)`,
    '  if ! kill -0 "$RECOVERY_PID" 2>/dev/null; then RECOVERY_CWD_MATCH=0',
    '  else job_pid_is_owned "$RECOVERY_PID"; case $? in 0) RECOVERY_CWD_MATCH=1 ;; 1) RECOVERY_CWD_MATCH=0 ;; *) RECOVERY_CWD_MATCH=unknown ;; esac; fi',
    ';; esac',
    `printf 'cwd_match:%s\\n' "$RECOVERY_CWD_MATCH"`,
    `RECOVERY_STARTED_AT=$(stat -c %Y ${quotedPidFile} 2>/dev/null || stat -f %m ${quotedPidFile} 2>/dev/null || true)`,
    `printf 'started_at:%s\n' "$RECOVERY_STARTED_AT"`,
    ...(evidenceRequest
      ? [
          'if [ -z "$RECOVERY_EXIT_CODE" ] && [ -n "$RECOVERY_PID" ] && [ "$RECOVERY_CWD_MATCH" = 1 ]; then',
          ...recoveryEvidenceLines(workdir, evidenceRequest).map((line) => `  ${line}`),
          'fi'
        ]
      : [])
  ].join('\n')
}

export const probeRemoteLaunch = async (
  connection: ComputeConnectionLease,
  workdir: string,
  evidenceRequest?: RemoteLaunchRecoveryEvidenceRequest
): Promise<RemoteLaunchObservation> => {
  const result = await connection.run(buildRecoveryProbe(workdir, evidenceRequest), {
    timeoutMs: RECOVERY_TIMEOUT_MS,
    loginShell: false,
    maxOutputBytes: evidenceRequest ? 4 * RECOVERY_MAX_OUTPUT_BYTES : RECOVERY_MAX_OUTPUT_BYTES
  })
  const connectionFailure = classifyConnectionFailure(result, false)
  if (connectionFailure) throw connectionFailure
  if (result.exitCode !== 0 || result.truncated) return { kind: 'ambiguous' }

  const lines = result.stdout.trimEnd().split('\n')
  if (lines.length < 5 || lines[0] !== RECOVERY_PROTOCOL) {
    return { kind: 'ambiguous' }
  }
  const workdirRaw = lines[1]?.startsWith('workdir:')
    ? lines[1].slice('workdir:'.length)
    : undefined
  const exitCodeRaw = lines[2]?.startsWith('exit_code:')
    ? lines[2].slice('exit_code:'.length)
    : undefined
  const pidRaw = lines[3]?.startsWith('pid:') ? lines[3].slice('pid:'.length) : undefined
  const cwdMatchRaw = lines[4]?.startsWith('cwd_match:')
    ? lines[4].slice('cwd_match:'.length)
    : undefined
  const startedAtRaw = lines[5]?.startsWith('started_at:')
    ? lines[5].slice('started_at:'.length)
    : undefined
  if (
    (workdirRaw !== '0' && workdirRaw !== '1') ||
    exitCodeRaw === undefined ||
    pidRaw === undefined ||
    (cwdMatchRaw !== '0' && cwdMatchRaw !== '1')
  ) {
    return { kind: 'ambiguous' }
  }
  const exitCode = exitCodeRaw === '' ? undefined : exitCodeInteger(exitCodeRaw)
  const pid = pidRaw === '' ? undefined : positiveInteger(pidRaw)
  const startedAtSeconds = startedAtRaw ? positiveInteger(startedAtRaw) : undefined
  if (
    (exitCodeRaw !== '' && exitCode === undefined) ||
    (pidRaw !== '' && pid === undefined) ||
    (startedAtRaw !== undefined && startedAtRaw !== '' && startedAtSeconds === undefined) ||
    (workdirRaw === '0' && (exitCodeRaw !== '' || pidRaw !== '' || cwdMatchRaw !== '0'))
  ) {
    return { kind: 'ambiguous' }
  }
  if (workdirRaw === '0') return { kind: 'not_started' }
  if (exitCode !== undefined) return { kind: 'exited', exitCode, ...(pid ? { pid } : {}) }
  if (!pid) return cwdMatchRaw === '0' ? { kind: 'pending' } : { kind: 'ambiguous' }
  const evidence = evidenceRequest
    ? parseRecoveryEvidence(lines.slice(6), evidenceRequest.descriptors)
    : undefined
  return cwdMatchRaw === '1'
    ? evidenceRequest && !evidence
      ? { kind: 'ambiguous' }
      : {
          kind: 'running',
          handle: remoteHandleFor(workdir, pid),
          ...(evidence ? { evidence } : {}),
          ...(startedAtSeconds === undefined
            ? {}
            : { startedAt: new Date(startedAtSeconds * 1000) })
        }
    : { kind: 'vanished', pid }
}

const parseRecoveryEvidence = (
  lines: readonly string[],
  descriptors: readonly RecoveryEvidenceDescriptor[]
): ComputeJobRemoteObjectEvidence[] | undefined => {
  if (lines.length !== descriptors.length + 1 || lines[0] !== RECOVERY_EVIDENCE_PROTOCOL)
    return undefined
  const evidence: ComputeJobRemoteObjectEvidence[] = []
  for (const [index, descriptor] of descriptors.entries()) {
    const fields = lines[index + 1]!.split(':')
    if (fields[0] !== 'object' || fields[1] !== String(index) || fields[2] !== descriptor.kind)
      return undefined
    if (descriptor.kind === 'file') {
      const [device, inode, sizeText, modifiedAtSeconds] = fields.slice(3)
      const size = Number(sizeText)
      if (
        fields.length !== 7 ||
        !/^\d+$/.test(device ?? '') ||
        !/^\d+$/.test(inode ?? '') ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        !/^\d+$/.test(modifiedAtSeconds ?? '')
      )
        return undefined
      evidence.push({
        path: descriptor.path,
        role: descriptor.role,
        identity: {
          kind: 'file',
          device,
          inode,
          size_bytes: size,
          modified_at_ns: `${modifiedAtSeconds}000000000`
        }
      })
    } else {
      const [device, inode, target] = fields.slice(3)
      if (
        fields.length !== 6 ||
        !/^\d+$/.test(device ?? '') ||
        !/^\d+$/.test(inode ?? '') ||
        target === undefined
      )
        return undefined
      evidence.push({
        path: descriptor.path,
        role: descriptor.role,
        identity: {
          kind: 'symlink',
          device,
          inode,
          link_target: Buffer.from(target, 'base64').toString()
        }
      })
    }
  }
  return evidence
}

export { recoveryEvidenceRequestForJob }

import type { ComputeConnectionLease } from './connection-broker'
import { remoteJobPidOwnershipFunctionLines } from './remote-job-process'

const CLEANUP_TIMEOUT_MS = 30_000
const MAX_PROTOCOL_OUTPUT_BYTES = 1024
const OWNER_MARKER_FILE = '.openscience-owner'
const PROTOCOL_PREFIX = 'OSCLEANUP1'

type RemoteComputeJobObjectIdentity = Readonly<{
  kind: 'file' | 'symlink'
  size_bytes?: number
  modified_at_ns?: string
  device?: string
  inode?: string
  link_target?: string
}>

type RemoteComputeJobCleanupCandidate = Readonly<{
  path: string
  identity: RemoteComputeJobObjectIdentity
}>

type RemoteComputeJobCleanupRequest = Readonly<{
  scratchRoot: string
  workdir: string
  ownerMarker: string
  trackedPid?: number
  candidates: readonly RemoteComputeJobCleanupCandidate[]
  knownRetainedPaths: readonly string[]
}>

type RemoteComputeJobCleanupResult = Readonly<{
  verification: 'verified' | 'ownership_unproven' | 'source_active'
  workspaceRemoved: boolean
  deletedObjectCount: number
  mismatchedCandidateCount: number
  unknownObjectCount: number
}>

class RemoteComputeJobCleanupIndeterminateError extends Error {
  readonly name = 'RemoteComputeJobCleanupIndeterminateError'

  constructor() {
    super('The remote Compute Job cleanup result could not be confirmed.')
  }
}

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
const unsafePathCharacters = /[\0\r\n]/
const unsafeRelativePathCharacters = /[\0\r\n*?[\]{}\\]/
const unsignedInteger = /^(?:0|[1-9]\d*)$/

const assertRelativePath = (path: string, label: string): void => {
  if (
    !path ||
    path.startsWith('/') ||
    unsafeRelativePathCharacters.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe remote cleanup ${label} path.`)
  }
}

const assertBasePaths = (
  request: Pick<RemoteComputeJobCleanupRequest, 'scratchRoot' | 'workdir'>
): string => {
  const { scratchRoot, workdir } = request
  const hasUnsafeSegments = (path: string): boolean => {
    const suffix =
      path === '~' || path === '/' ? '' : path.startsWith('~/') ? path.slice(2) : path.slice(1)
    if (!suffix) return false
    return suffix.split('/').some((part) => !part || part === '.' || part === '..')
  }
  if (
    unsafePathCharacters.test(scratchRoot) ||
    unsafePathCharacters.test(workdir) ||
    (!scratchRoot.startsWith('/') && !scratchRoot.startsWith('~/') && scratchRoot !== '~') ||
    (!workdir.startsWith('/') && !workdir.startsWith('~/')) ||
    hasUnsafeSegments(scratchRoot) ||
    hasUnsafeSegments(workdir) ||
    (scratchRoot === '/' && !workdir.startsWith('/.openscience/jobs/'))
  ) {
    throw new Error('Unsafe remote Compute Job cleanup boundary.')
  }
  const prefix = scratchRoot === '/' ? '' : scratchRoot
  const expectedPrefix = `${prefix}/.openscience/jobs/`
  if (!workdir.startsWith(expectedPrefix)) {
    throw new Error('Unsafe remote Compute Job cleanup boundary.')
  }
  const jobId = workdir.slice(expectedPrefix.length)
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new Error('Unsafe remote Compute Job cleanup boundary.')
  }
  return jobId
}

const requireUnsigned = (value: string | undefined, label: string): string => {
  if (value === undefined || !unsignedInteger.test(value)) {
    throw new Error(`Incomplete remote cleanup ${label} identity.`)
  }
  return value
}

const requireSafeInteger = (value: number | undefined, label: string): string => {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Incomplete remote cleanup ${label} identity.`)
  }
  return String(value)
}

// POSIX stat exposes whole-second timestamps on both GNU/Linux and macOS. Persisted evidence keeps
// nanoseconds, so compare its explicit floor alongside device, inode, and size instead of comparing
// the nanosecond string directly with GNU stat %Y.
const modifiedAtSeconds = (value: string | undefined): string => {
  const nanoseconds = requireUnsigned(value, 'file')
  return (BigInt(nanoseconds) / 1_000_000_000n).toString()
}

const remotePathExpression = (relativePath: string): string =>
  `"$workdir"/${shellSingleQuote(relativePath)}`

const parentGuard = (relativePath: string): string => {
  const parts = relativePath.split('/').slice(0, -1)
  const checks: string[] = []
  let current = ''
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    const path = remotePathExpression(current)
    checks.push(`[ -d ${path} ] && [ ! -L ${path} ]`)
  }
  return checks.length > 0 ? checks.join(' && ') : ':'
}

const candidateLines = (candidate: RemoteComputeJobCleanupCandidate): string[] => {
  const path = remotePathExpression(candidate.path)
  const parentIsSafe = parentGuard(candidate.path)
  let identityMatches: string
  if (candidate.identity.kind === 'file') {
    const expected = [
      requireUnsigned(candidate.identity.device, 'file'),
      requireUnsigned(candidate.identity.inode, 'file'),
      requireSafeInteger(candidate.identity.size_bytes, 'file'),
      modifiedAtSeconds(candidate.identity.modified_at_ns)
    ].join(':')
    identityMatches = `[ -f ${path} ] && [ ! -L ${path} ] && [ "$(stat_file_identity ${path})" = ${shellSingleQuote(expected)} ]`
  } else {
    if (
      candidate.identity.link_target === undefined ||
      unsafePathCharacters.test(candidate.identity.link_target)
    ) {
      throw new Error('Incomplete remote cleanup symlink identity.')
    }
    const device = candidate.identity.device
    const inode = candidate.identity.inode
    const inodeGuard =
      device === undefined && inode === undefined
        ? ':'
        : `[ "$(stat_device_inode ${path})" = ${shellSingleQuote(
            `${requireUnsigned(device, 'symlink')}:${requireUnsigned(inode, 'symlink')}`
          )} ]`
    identityMatches = `[ -L ${path} ] && [ "$(readlink ${path} 2>/dev/null || :)" = ${shellSingleQuote(candidate.identity.link_target)} ] && ${inodeGuard}`
  }
  return [
    `if ${parentIsSafe}; then`,
    `  if ${identityMatches}; then`,
    "    ownership_ok || { printf '%s\\n' 'OSCLEANUP1|UNCERTAIN|0|0|0|0'; exit 0; }",
    `    rm -f ${path} || { printf '%s\\n' 'OSCLEANUP1|UNCERTAIN|0|0|0|0'; exit 0; }`,
    '    deleted=$((deleted + 1))',
    `  elif [ -e ${path} ] || [ -L ${path} ]; then`,
    '    mismatched=$((mismatched + 1))',
    `    if [ ! -d ${path} ] || [ -L ${path} ]; then recognized=$((recognized + 1)); fi`,
    '  fi',
    'else',
    '  mismatched=$((mismatched + 1))',
    'fi'
  ]
}

const retainedPathLines = (path: string): string[] => {
  const expression = remotePathExpression(path)
  return [
    `if ${parentGuard(path)}; then`,
    `  if { [ -e ${expression} ] || [ -L ${expression} ]; } && { [ ! -d ${expression} ] || [ -L ${expression} ]; }; then`,
    '    recognized=$((recognized + 1))',
    '  fi',
    'fi'
  ]
}

const validateRequest = (request: RemoteComputeJobCleanupRequest): string => {
  const jobId = assertBasePaths(request)
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(request.ownerMarker)) {
    throw new Error('Unsafe remote Compute Job owner marker.')
  }
  if (
    request.trackedPid !== undefined &&
    (!Number.isSafeInteger(request.trackedPid) || request.trackedPid <= 1)
  ) {
    throw new Error('Invalid remote Compute Job process identity.')
  }
  const seen = new Set<string>()
  for (const candidate of request.candidates) {
    assertRelativePath(candidate.path, 'candidate')
    if (seen.has(candidate.path)) throw new Error('Duplicate remote cleanup object path.')
    seen.add(candidate.path)
    candidateLines(candidate)
  }
  for (const path of request.knownRetainedPaths) {
    assertRelativePath(path, 'retained')
    if (seen.has(path)) throw new Error('Duplicate remote cleanup object path.')
    seen.add(path)
  }
  return jobId
}

const buildRemoteCleanupCommand = (request: RemoteComputeJobCleanupRequest): string => {
  const jobId = validateRequest(request)
  const lines = [
    'set -f',
    'deleted=0',
    'mismatched=0',
    'recognized=0',
    `scratch_input=${shellSingleQuote(request.scratchRoot)}`,
    `workdir_input=${shellSingleQuote(request.workdir)}`,
    'case "$scratch_input" in "~") scratch_root=$HOME ;; "~/"*) scratch_root=$HOME/${scratch_input#??} ;; *) scratch_root=$scratch_input ;; esac',
    'case "$workdir_input" in "~/"*) workdir=$HOME/${workdir_input#??} ;; *) workdir=$workdir_input ;; esac',
    'jobs_parent=${scratch_root%/}/.openscience/jobs',
    `expected_workdir=$jobs_parent/${jobId}`,
    `marker_path=$workdir/${OWNER_MARKER_FILE}`,
    'path_no_symlinks() {',
    '  pns_path=$1',
    '  pns_current=',
    '  pns_old_ifs=$IFS',
    '  IFS=/',
    '  set -- $pns_path',
    '  IFS=$pns_old_ifs',
    '  for pns_part do',
    '    [ -n "$pns_part" ] || continue',
    '    pns_current=$pns_current/$pns_part',
    '    [ -d "$pns_current" ] && [ ! -L "$pns_current" ] || return 1',
    '  done',
    '}',
    'stat_file_identity() {',
    `  stat -c '%d:%i:%s:%Y' "$1" 2>/dev/null || stat -f '%d:%i:%z:%m' "$1" 2>/dev/null`,
    '}',
    'stat_device_inode() {',
    `  stat -c '%d:%i' "$1" 2>/dev/null || stat -f '%d:%i' "$1" 2>/dev/null`,
    '}',
    'boundary_ok() {',
    '  path_no_symlinks "$jobs_parent" || return 1',
    '  path_no_symlinks "$workdir" || return 1',
    '  scratch_canonical=$(cd "$scratch_root" 2>/dev/null && pwd -P) || return 1',
    '  workdir_canonical=$(cd "$workdir" 2>/dev/null && pwd -P) || return 1',
    '  [ "$workdir" = "$expected_workdir" ] && [ "$workdir_canonical" = "${scratch_canonical%/}/.openscience/jobs/' +
      jobId +
      '" ]',
    '}',
    'ownership_ok() {',
    '  boundary_ok || return 1',
    '  [ -f "$marker_path" ] && [ ! -L "$marker_path" ] || return 1',
    `  [ "$(cat "$marker_path" 2>/dev/null || :)" = ${shellSingleQuote(request.ownerMarker)} ]`,
    '}',
    "path_no_symlinks \"$jobs_parent\" || { printf '%s\\n' 'OSCLEANUP1|OWNERSHIP_UNPROVEN|0|0|0|0'; exit 0; }",
    '[ -e "$workdir" ] || [ -L "$workdir" ] || { printf \'%s\\n\' \'OSCLEANUP1|VERIFIED|0|0|0|1\'; exit 0; }',
    "ownership_ok || { printf '%s\\n' 'OSCLEANUP1|OWNERSHIP_UNPROVEN|0|0|0|0'; exit 0; }"
  ]
  if (request.trackedPid !== undefined) {
    lines.push(
      ...remoteJobPidOwnershipFunctionLines(),
      `job_pid_is_owned ${request.trackedPid}`,
      'case $? in',
      `  0) printf '%s\\n' '${PROTOCOL_PREFIX}|SOURCE_ACTIVE|0|0|0|0'; exit 0 ;;`,
      '  1|3) : ;;',
      `  *) printf '%s\\n' '${PROTOCOL_PREFIX}|OWNERSHIP_UNPROVEN|0|0|0|0'; exit 0 ;;`,
      'esac'
    )
  }
  for (const candidate of request.candidates) {
    lines.push(...candidateLines(candidate))
  }
  for (const path of request.knownRetainedPaths) {
    lines.push(...retainedPathLines(path))
  }
  lines.push(
    'find -P "$workdir" -depth -type d -empty ! -path "$workdir" -exec rmdir {} \\; 2>/dev/null || :',
    `total=$(find -P "$workdir" -mindepth 1 ! -type d ! -path "$marker_path" -exec sh -c 'printf x' \\; 2>/dev/null | wc -c | tr -d '[:space:]')`,
    "case \"$total:$recognized\" in *[!0-9:]*|:*) printf '%s\\n' 'OSCLEANUP1|UNCERTAIN|0|0|0|0'; exit 0 ;; esac",
    '[ "$total" -ge "$recognized" ] || { printf \'%s\\n\' \'OSCLEANUP1|UNCERTAIN|0|0|0|0\'; exit 0; }',
    'unknown=$((total - recognized))',
    `remaining=$(find -P "$workdir" -mindepth 1 ! -path "$marker_path" -exec sh -c 'printf x' \\; 2>/dev/null | wc -c | tr -d '[:space:]')`,
    'if [ "$remaining" = 0 ]; then',
    "  ownership_ok || { printf '%s\\n' 'OSCLEANUP1|UNCERTAIN|0|0|0|0'; exit 0; }",
    `  rm -f "$marker_path" || { printf '%s\\n' 'OSCLEANUP1|UNCERTAIN|0|0|0|0'; exit 0; }`,
    '  deleted=$((deleted + 1))',
    '  if rmdir "$workdir" 2>/dev/null; then',
    `    printf '%s\\n' "${PROTOCOL_PREFIX}|VERIFIED|$deleted|$mismatched|0|1"`,
    '    exit 0',
    '  fi',
    '  if boundary_ok && [ ! -e "$marker_path" ] && [ ! -L "$marker_path" ]; then',
    `    (umask 077; set -C; printf '%s' ${shellSingleQuote(request.ownerMarker)} > "$marker_path") 2>/dev/null || { printf '%s\\n' 'OSCLEANUP1|UNCERTAIN|0|0|0|0'; exit 0; }`,
    `    [ -f "$marker_path" ] && [ ! -L "$marker_path" ] && [ "$(cat "$marker_path" 2>/dev/null || :)" = ${shellSingleQuote(request.ownerMarker)} ] || { printf '%s\\n' 'OSCLEANUP1|UNCERTAIN|0|0|0|0'; exit 0; }`,
    '  fi',
    "  printf '%s\\n' 'OSCLEANUP1|UNCERTAIN|0|0|0|0'",
    '  exit 0',
    'fi',
    `printf '%s\\n' "${PROTOCOL_PREFIX}|VERIFIED|$deleted|$mismatched|$unknown|0"`
  )
  return lines.join('\n')
}

const parseCount = (value: string): number | undefined => {
  if (!unsignedInteger.test(value)) return undefined
  const count = Number(value)
  return Number.isSafeInteger(count) ? count : undefined
}

const runRemoteComputeJobCleanup = async (
  connection: ComputeConnectionLease,
  request: RemoteComputeJobCleanupRequest
): Promise<RemoteComputeJobCleanupResult> => {
  const command = buildRemoteCleanupCommand(request)
  let response: Awaited<ReturnType<ComputeConnectionLease['run']>>
  try {
    response = await connection.run(command, {
      timeoutMs: CLEANUP_TIMEOUT_MS,
      loginShell: false,
      maxOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES
    })
  } catch {
    throw new RemoteComputeJobCleanupIndeterminateError()
  }
  if (response.timedOut || response.truncated || response.exitCode !== 0) {
    throw new RemoteComputeJobCleanupIndeterminateError()
  }
  const fields = response.stdout.trim().split('|')
  if (fields.length !== 6 || fields[0] !== PROTOCOL_PREFIX || fields[1] === 'UNCERTAIN') {
    throw new RemoteComputeJobCleanupIndeterminateError()
  }
  const deletedObjectCount = parseCount(fields[2]!)
  const mismatchedCandidateCount = parseCount(fields[3]!)
  const unknownObjectCount = parseCount(fields[4]!)
  if (
    deletedObjectCount === undefined ||
    mismatchedCandidateCount === undefined ||
    unknownObjectCount === undefined ||
    (fields[5] !== '0' && fields[5] !== '1') ||
    (fields[1] !== 'VERIFIED' &&
      fields[1] !== 'OWNERSHIP_UNPROVEN' &&
      fields[1] !== 'SOURCE_ACTIVE')
  ) {
    throw new RemoteComputeJobCleanupIndeterminateError()
  }
  if (fields[1] !== 'VERIFIED' && (deletedObjectCount !== 0 || fields[5] !== '0')) {
    throw new RemoteComputeJobCleanupIndeterminateError()
  }
  return {
    verification:
      fields[1] === 'VERIFIED'
        ? 'verified'
        : fields[1] === 'SOURCE_ACTIVE'
          ? 'source_active'
          : 'ownership_unproven',
    workspaceRemoved: fields[5] === '1',
    deletedObjectCount,
    mismatchedCandidateCount,
    unknownObjectCount
  }
}

const verifyRemoteComputeJobWorkspaceAbsent = async (
  connection: ComputeConnectionLease,
  request: Pick<RemoteComputeJobCleanupRequest, 'scratchRoot' | 'workdir'>
): Promise<boolean> => {
  assertBasePaths(request)
  const command = [
    'set -f',
    `scratch_input=${shellSingleQuote(request.scratchRoot)}`,
    `workdir_input=${shellSingleQuote(request.workdir)}`,
    'case "$scratch_input" in "~") scratch_root=$HOME ;; "~/"*) scratch_root=$HOME/${scratch_input#??} ;; *) scratch_root=$scratch_input ;; esac',
    'case "$workdir_input" in "~/"*) workdir=$HOME/${workdir_input#??} ;; *) workdir=$workdir_input ;; esac',
    'jobs_parent=${scratch_root%/}/.openscience/jobs',
    'path_no_symlinks() {',
    '  pns_path=$1',
    '  pns_current=',
    '  pns_old_ifs=$IFS',
    '  IFS=/',
    '  set -- $pns_path',
    '  IFS=$pns_old_ifs',
    '  for pns_part do',
    '    [ -n "$pns_part" ] || continue',
    '    pns_current=$pns_current/$pns_part',
    '    [ -d "$pns_current" ] && [ ! -L "$pns_current" ] || return 1',
    '  done',
    '}',
    `path_no_symlinks "$jobs_parent" || { printf '%s\n' '${PROTOCOL_PREFIX}|UNCERTAIN'; exit 0; }`,
    'if [ -e "$workdir" ] || [ -L "$workdir" ]; then',
    `  printf '%s\n' '${PROTOCOL_PREFIX}|WORKSPACE_PRESENT'`,
    'else',
    `  printf '%s\n' '${PROTOCOL_PREFIX}|WORKSPACE_ABSENT'`,
    'fi'
  ].join('\n')
  let response: Awaited<ReturnType<ComputeConnectionLease['run']>>
  try {
    response = await connection.run(command, {
      timeoutMs: CLEANUP_TIMEOUT_MS,
      loginShell: false,
      maxOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES
    })
  } catch {
    throw new RemoteComputeJobCleanupIndeterminateError()
  }
  if (response.timedOut || response.truncated || response.exitCode !== 0) {
    throw new RemoteComputeJobCleanupIndeterminateError()
  }
  const output = response.stdout.trim()
  if (output === `${PROTOCOL_PREFIX}|WORKSPACE_ABSENT`) return true
  if (output === `${PROTOCOL_PREFIX}|WORKSPACE_PRESENT`) return false
  throw new RemoteComputeJobCleanupIndeterminateError()
}

export {
  RemoteComputeJobCleanupIndeterminateError,
  runRemoteComputeJobCleanup,
  verifyRemoteComputeJobWorkspaceAbsent
}
export type {
  RemoteComputeJobCleanupCandidate,
  RemoteComputeJobCleanupRequest,
  RemoteComputeJobCleanupResult,
  RemoteComputeJobObjectIdentity
}

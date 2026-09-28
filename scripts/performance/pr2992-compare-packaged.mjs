/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, open, realpath, readdir, rename } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import os from 'node:os'

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--(baseline|candidate|output|groups|plan)=(.+)$/.exec(arg)
    if (!match) throw new Error(`Invalid argument: ${arg}`)
    return [match[1], match[2]]
  })
)
for (const key of ['baseline', 'candidate', 'output'])
  if (!args[key]) throw new Error(`Missing --${key}`)
const groups = Number(args.groups ?? 3)
if (!Number.isInteger(groups) || groups < 1 || groups > 10) throw new Error('groups must be 1–10')
const watchdogMs = 360_000
const watchdogGraceMs = 5_000
const planPath = resolve(args.plan ?? 'scripts/performance/pr2992-acceptance-plan.json')
const plan = JSON.parse(await readFile(planPath, 'utf8'))
if (groups !== plan.groups) throw new Error('Run count differs from frozen acceptance plan')
const output = resolve(args.output)
try {
  if ((await readdir(output)).length > 0)
    throw new Error(`Output directory is not empty: ${output}`)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  await mkdir(output, { recursive: true })
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const artifacts = {}
for (const variant of ['baseline', 'candidate']) {
  const manifestPath = resolve(args[variant], 'build-manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const app = await realpath(manifest.app)
  const actualHash = sha256(await readFile(join(app, 'Contents/Resources/app.asar')))
  if (actualHash !== manifest.asarSha256)
    throw new Error(`${variant} package changed after its build`)
  artifacts[variant] = {
    ...manifest,
    app,
    executable: await realpath(join(app, 'Contents/MacOS/Open-Science'))
  }
}
if (
  artifacts.baseline.revision !== plan.baselineRevision ||
  artifacts.candidate.revision !== plan.candidateRevision ||
  artifacts.baseline.lockfileSha256 !== artifacts.candidate.lockfileSha256 ||
  artifacts.baseline.lockfileSha256 !== plan.lockfileSha256 ||
  artifacts.baseline.micromambaSha256 !== artifacts.candidate.micromambaSha256 ||
  JSON.stringify(artifacts.baseline.nativeHashes) !==
    JSON.stringify(artifacts.candidate.nativeHashes)
)
  throw new Error('Comparison artifacts differ from the frozen revisions or dependencies')
const baselineSource = JSON.parse(
  await readFile(resolve(args.baseline, 'source-hashes.json'), 'utf8')
)
const candidateSource = JSON.parse(
  await readFile(resolve(args.candidate, 'source-hashes.json'), 'utf8')
)
const sourceChanges = [
  ...new Set([...Object.keys(baselineSource), ...Object.keys(candidateSource)])
]
  .filter((path) => baselineSource[path] !== candidateSource[path])
  .sort()
if (JSON.stringify(sourceChanges) !== JSON.stringify([...plan.expectedProductionFiles].sort()))
  throw new Error(`Unexpected production source difference: ${sourceChanges.join(', ')}`)
if (
  artifacts.baseline.productionSourceSha256 === artifacts.candidate.productionSourceSha256 ||
  artifacts.baseline.asarSha256 === artifacts.candidate.asarSha256
)
  throw new Error('Comparison artifacts must contain different source patches and app.asar builds')
const state = {
  createdAt: new Date().toISOString(),
  status: 'planned',
  candidateStatus: 'not-run',
  plan: {
    ...plan,
    planPath,
    sourceChanges,
    groups,
    orderPerGroup: ['baseline', 'candidate', 'candidate', 'baseline'],
    workers: 1,
    retries: 0,
    cpuProfiler: false,
    window: 'inactive 1280x900 zoom=1',
    watchdogMs,
    watchdogGraceMs,
    keychainMode: 'Chromium mock Keychain for both packaged variants',
    osSecretAccessMeasured: false,
    credentialBoundary:
      'Both packaged variants use Chromium --use-mock-keychain with isolated test profiles. The native credential metadata probe remains active; OS secret access is outside this performance comparison.',
    retentionRule: plan.retentionRule,
    endpoints: [
      'open wall time',
      'session switch wall and renderer click-to-content RAF',
      'typing wall and renderer input-to-RAF',
      'per-phase >50ms long tasks'
    ],
    exclusions:
      'Preflight runs are separate; all runs in this manifest, including failures and missing summaries, are retained.'
  },
  artifacts,
  machine: {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    memoryBytes: os.totalmem(),
    cpu: os.cpus()[0]?.model,
    cpuCount: os.cpus().length
  },
  runs: Array.from({ length: groups }, (_, group) =>
    ['baseline', 'candidate', 'candidate', 'baseline'].map((variant, position) => ({
      id: `${group + 1}-${position + 1}-${variant}`,
      variant,
      group: group + 1,
      status: 'planned',
      summaries: [],
      missingSummaries: ['interaction:20', 'interaction:100', 'interaction:500']
    }))
  ).flat()
}
const save = async () => {
  const path = join(output, 'comparison-run.json')
  const pending = `${path}.tmp`
  await writeFile(pending, JSON.stringify(state, null, 2))
  await rename(pending, path)
}
const expectedSummaries = ['interaction:20', 'interaction:100', 'interaction:500']
const collectSummaries = async (directory) => {
  const summaries = []
  const errors = []
  const visit = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      errors.push(`Cannot read ${relative(output, current)}: ${String(error)}`)
      return
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.name === 'interaction-summary.json') {
        try {
          const data = JSON.parse(await readFile(path, 'utf8'))
          if (!data || typeof data !== 'object' || Array.isArray(data))
            throw new Error('Summary must be a JSON object')
          const kind = `interaction:${data.sessionCount}`
          summaries.push({ kind, path: relative(output, path), data })
        } catch (error) {
          errors.push(`Cannot parse ${relative(output, path)}: ${String(error)}`)
        }
      }
    }
  }
  await visit(directory)
  const counts = new Map()
  for (const summary of summaries) {
    counts.set(summary.kind, (counts.get(summary.kind) ?? 0) + 1)
    if (!expectedSummaries.includes(summary.kind)) errors.push(`Unexpected ${summary.kind} summary`)
    if (summary.data.completed !== true) errors.push(`${summary.kind} journey did not complete`)
  }
  for (const [kind, count] of counts) if (count > 1) errors.push(`Duplicate ${kind} summaries`)
  return {
    summaries,
    errors,
    missingSummaries: expectedSummaries.filter((kind) => !counts.has(kind))
  }
}
const updateStatus = () => {
  const candidateRuns = state.runs.filter((run) => run.variant === 'candidate')
  const baselineRuns = state.runs.filter((run) => run.variant === 'baseline')
  state.candidateStatus = candidateRuns.some((run) => run.status === 'failed')
    ? 'failed'
    : candidateRuns.every((run) => run.status === 'passed')
      ? 'passed'
      : 'incomplete'
  state.baselineStatus = baselineRuns.some((run) => run.status === 'failed')
    ? 'failed'
    : baselineRuns.every((run) => run.status === 'passed')
      ? 'passed'
      : 'incomplete'
  state.status = state.runs.every((run) => run.status === 'passed' || run.status === 'failed')
    ? 'complete'
    : 'running'
  state.outcome =
    state.status !== 'complete'
      ? 'incomplete'
      : state.candidateStatus === 'failed'
        ? 'candidate-failed'
        : state.baselineStatus === 'failed'
          ? 'baseline-failed'
          : 'all-passed'
  state.totals = {
    planned: state.runs.filter((run) => run.status === 'planned').length,
    running: state.runs.filter((run) => run.status === 'running').length,
    passed: state.runs.filter((run) => run.status === 'passed').length,
    failed: state.runs.filter((run) => run.status === 'failed').length,
    missingSummaries: state.runs
      .filter((run) => run.status === 'passed' || run.status === 'failed')
      .reduce((count, run) => count + run.missingSummaries.length, 0)
  }
}
let interruptedSignal = null
let activeRunInterrupt = null
const forwardInterrupt = (signal) => {
  if (interruptedSignal) return
  interruptedSignal = signal
  console.error(`Received ${signal}; stopping after the active run is recorded`)
  activeRunInterrupt?.()
}
process.on('SIGINT', () => forwardInterrupt('SIGINT'))
process.on('SIGTERM', () => forwardInterrupt('SIGTERM'))
const launchRun = async (run, directory) => {
  const logHandle = await open(join(directory, 'run.log'), 'wx')
  let child
  let logError = null
  let writePending = Promise.resolve()
  let timedOut = false
  let timedOutAt = null
  const killErrors = []
  const killGroup = (signal) => {
    if (!child?.pid) return
    try {
      // detached creates a dedicated process group; negative PID cannot target the runner.
      process.kill(-child.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') killErrors.push(`${signal}: ${String(error)}`)
    }
  }
  const writeLog = (chunk) => {
    writePending = writePending.then(async () => {
      if (logError) return
      try {
        await logHandle.writeFile(chunk)
      } catch (error) {
        logError = String(error)
        killGroup('SIGTERM')
      }
    })
  }
  try {
    child = spawn(
      process.execPath,
      [
        'node_modules/@playwright/test/cli.js',
        'test',
        'e2e/pr2992-interaction-performance.spec.ts',
        '--workers=1',
        '--retries=0',
        '--reporter=list',
        `--output=${join(directory, 'artifacts')}`
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPEN_SCIENCE_E2E_BACKGROUND: '1',
          OPEN_SCIENCE_INTERACTION_PROFILE: '1',
          OPEN_SCIENCE_PERF_CPU_PROFILE: '0',
          OPEN_SCIENCE_E2E_MOCK_KEYCHAIN: '1',
          OPEN_SCIENCE_E2E_EXECUTABLE: artifacts[run.variant].executable
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      }
    )
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', writeLog)
    const execution = await new Promise((resolveRun) => {
      let spawnError
      let watchdog
      let forceKill
      let interruptForceKill
      let settled = false
      const finish = (exitCode, signal) => {
        if (settled) return
        settled = true
        clearTimeout(watchdog)
        clearTimeout(forceKill)
        clearTimeout(interruptForceKill)
        activeRunInterrupt = null
        resolveRun({ exitCode, signal, spawnError })
      }
      child.once('error', (error) => {
        spawnError = String(error)
      })
      child.once('close', finish)
      watchdog = setTimeout(() => {
        timedOut = true
        timedOutAt = new Date().toISOString()
        killGroup('SIGTERM')
        forceKill = setTimeout(() => {
          killGroup('SIGKILL')
          child.stdout?.destroy()
          child.stderr?.destroy()
          finish(null, 'SIGKILL')
        }, watchdogGraceMs)
      }, watchdogMs)
      activeRunInterrupt = () => {
        killGroup(interruptedSignal)
        interruptForceKill = setTimeout(() => {
          killGroup('SIGKILL')
          child.stdout?.destroy()
          child.stderr?.destroy()
          finish(null, 'SIGKILL')
        }, watchdogGraceMs)
      }
      if (interruptedSignal) activeRunInterrupt()
    })
    await writePending
    return { ...execution, timedOut, timedOutAt, logError, killErrors, interruptedSignal }
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      spawnError: String(error),
      timedOut,
      timedOutAt,
      logError,
      killErrors,
      interruptedSignal
    }
  } finally {
    activeRunInterrupt = null
    await writePending
    await logHandle.close()
  }
}
updateStatus()
await save()
for (const run of state.runs) {
  if (interruptedSignal) break
  const directory = join(output, run.id)
  Object.assign(run, {
    status: 'running',
    startedAt: new Date().toISOString(),
    before: { loadavg: os.loadavg(), freeMemoryBytes: os.freemem() }
  })
  updateStatus()
  await save()
  console.log(`Starting ${run.id}`)
  let execution = {
    exitCode: null,
    signal: null,
    spawnError: null,
    timedOut: false,
    timedOutAt: null,
    logError: null,
    killErrors: [],
    interruptedSignal: null
  }
  let collected = { summaries: [], errors: [], missingSummaries: expectedSummaries }
  const errors = []
  try {
    await mkdir(directory)
    execution = await launchRun(run, directory)
    collected = await collectSummaries(directory)
  } catch (error) {
    errors.push(`Run setup or collection failed: ${String(error)}`)
  }
  if (execution.spawnError) errors.push(`Playwright spawn failed: ${execution.spawnError}`)
  if (execution.interruptedSignal)
    errors.push(`Runner interrupted by ${execution.interruptedSignal}`)
  if (execution.timedOut) errors.push(`Playwright watchdog expired after ${watchdogMs} ms`)
  if (execution.logError) errors.push(`Cannot write run.log: ${execution.logError}`)
  errors.push(...execution.killErrors.map((error) => `Watchdog signal failed: ${error}`))
  if (execution.signal) errors.push(`Playwright terminated by ${execution.signal}`)
  if (execution.exitCode !== 0) errors.push(`Playwright exit code: ${execution.exitCode}`)
  errors.push(...collected.errors)
  if (collected.missingSummaries.length > 0)
    errors.push(`Missing summaries: ${collected.missingSummaries.join(', ')}`)
  Object.assign(run, {
    status: errors.length === 0 ? 'passed' : 'failed',
    ...execution,
    completedAt: new Date().toISOString(),
    after: { loadavg: os.loadavg(), freeMemoryBytes: os.freemem() },
    summaries: collected.summaries,
    missingSummaries: collected.missingSummaries,
    errors
  })
  updateStatus()
  await save()
  console.log(`Finished ${run.id}: ${run.status}, summaries=${run.summaries.length}`)
}
if (interruptedSignal) {
  updateStatus()
  state.status = 'interrupted'
  state.outcome = 'interrupted'
  state.interruptedAt = new Date().toISOString()
  state.interruptedSignal = interruptedSignal
  await save()
  process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
}
console.log(`Comparison recorded at ${join(output, 'comparison-run.json')}`)
if (!interruptedSignal && state.candidateStatus !== 'passed') process.exitCode = 1

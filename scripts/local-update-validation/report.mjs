/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SCENARIOS } from './server.mjs'

export async function readJsonLines(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line, index, lines) => {
      try {
        return [JSON.parse(line)]
      } catch (error) {
        if (index === lines.length - 1 && !text.endsWith('\n')) return [] // Concurrent append, retry at next observation.
        throw new Error(`Invalid JSONL evidence in ${path}: ${error.message}`)
      }
    })
}
const exists = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}
const status = (event) => (event.type === 'update-status' ? event.status : undefined)
const after = (events, type, index = -1) =>
  events.findIndex((event, i) => i > index && event.type === type)

const time = (event) => Date.parse(event?.at)
const zipRequest = (event) =>
  event.type === 'request' && event.method === 'GET' && event.path?.endsWith('.zip')
const transferred = (event) =>
  event.type === 'update-progress' &&
  event.progress?.phase === 'downloading' &&
  Number.isFinite(event.progress.transferred) &&
  event.progress.transferred > 0

function downloadCancellationEvidence(app, server, downloaded) {
  let previousState
  const cancelled = app.findIndex((event) => {
    const value = status(event)
    if (!value) return false
    const transition =
      previousState === 'downloading' &&
      value.state === 'available' &&
      value.error === undefined &&
      value.progress === undefined &&
      value.downloadedBytes === undefined &&
      value.downloadProgress === undefined
    previousState = value.state
    return transition
  })
  const retry = app.findIndex(
    (event, index) => index > cancelled && status(event)?.state === 'downloading'
  )
  const requests = server.filter(zipRequest)
  const first = requests[0]
  const next = requests[1]
  const partial =
    cancelled > 0 &&
    app
      .slice(0, cancelled)
      .find(
        (event) =>
          transferred(event) &&
          Number.isFinite(event.progress.total) &&
          event.progress.transferred < event.progress.total
      )
  const interruption = server.find(
    (event) =>
      event.type === 'response-interrupted' &&
      event.throttled === true &&
      event.path === first?.path
  )
  const firstCompleted = server.some(
    (event) =>
      event.type === 'response-completed' && event.throttled === true && event.path === first?.path
  )
  const quit = app.find((event) => event.type === 'application-quit')
  const completion = server.find(
    (event) =>
      event.type === 'response-completed' &&
      event.throttled === false &&
      event.path === next?.path &&
      time(event) >= time(next) &&
      time(event) <= time(app[downloaded])
  )
  const noEarlySuccess =
    retry > cancelled &&
    app
      .slice(0, retry)
      .every((event) => event.type !== 'download-verified' && status(event)?.state !== 'ready')
  return {
    // Download cancellation returns to available; outcome=cancelled belongs to installation recovery.
    uiReturnedToAvailable: cancelled >= 0,
    partialProgressBeforeCancellation:
      !!partial && time(first) <= time(partial) && time(partial) <= time(app[cancelled]),
    firstTransferInterruptedBeforeRetry:
      !!interruption &&
      !firstCompleted &&
      time(interruption) >= time(first) &&
      time(interruption) < time(next) &&
      (!quit || time(interruption) < time(quit)) &&
      time(first) < time(next) &&
      time(app[cancelled]) <= time(next),
    retryDownloadedAndVerified:
      noEarlySuccess &&
      downloaded > retry &&
      time(app[retry]) <= time(next) &&
      !!completion &&
      app.slice(retry, downloaded).some(transferred),
    firstRequestAt: first?.at,
    cancellationAt: app[cancelled]?.at,
    firstInterruptionAt: interruption?.at,
    retryRequestAt: next?.at,
    retryVerifiedAt: app[downloaded]?.at
  }
}

export function evaluateScenario({
  scenario,
  app = [],
  server = [],
  observations = [],
  fixture,
  zipSha512,
  versionA,
  versionB,
  isolationVerified = true
}) {
  const states = app.map(status).filter(Boolean)
  const available = states.some((value) => value.state === 'available')
  const handoffIndex = app.findIndex((event) =>
    ['handoff-boundary', 'handoff-failure'].includes(event.type)
  )
  const downloaded = app.findIndex(
    (event) =>
      event.type === 'download-verified' &&
      event.artifactSha512 === zipSha512 &&
      event.networkTransferred === true &&
      event.checksumAlgorithm === 'sha512'
  )
  const stopped = after(app, 'runtime-stopped', downloaded)
  const stopProof =
    stopped >= 0 &&
    app[stopped].processExited === true &&
    app[stopped].exitRecord === 'clean' &&
    app[stopped].lockHeld === true &&
    observations.some(
      (event) =>
        event.type === 'runtime-exit-observed' &&
        event.pid === app[stopped].pid &&
        event.generation === app[stopped].generation
    )
  const boundary =
    downloaded >= 0 &&
    stopped > downloaded &&
    handoffIndex > stopped &&
    stopProof &&
    app[handoffIndex].nativeInstallInvoked === false &&
    app[handoffIndex].targetStarted === false
  const stopFailure = app.findIndex((event) =>
    ['runtime-stop-timeout', 'runtime-stop-unclean'].includes(status(event)?.reason)
  )
  const recovered = after(
    app,
    'runtime-recovered',
    scenario === 'shutdown-failure' ? stopped : handoffIndex
  )
  const recoveryProof =
    (boundary ||
      (scenario === 'shutdown-failure' &&
        stopFailure >= 0 &&
        stopped > stopFailure &&
        stopProof)) &&
    recovered > stopped &&
    app[recovered].serviceReady === true &&
    observations.some(
      (event) =>
        event.type === 'runtime-recovery-observed' &&
        event.pid === app[recovered].pid &&
        event.generation === app[recovered].generation
    )
  const recoveredAt = recovered >= 0 ? Date.parse(app[recovered].at) : Infinity
  const dataPreserved = fixture?.preserved === true
  const recoveryWrite =
    fixture?.recoveryWrite?.exists === true && fixture.recoveryWrite.mtimeMs > recoveredAt
  const faultTriggered = server.some(
    (event) => event.type === 'fault-triggered' && event.fault === scenario
  )
  const unexpected =
    server.some((event) => event.type === 'facility-failure') ||
    observations.some((event) => event.type === 'facility-failure')
  const unexpectedInstallation =
    observations.some((event) => event.type === 'target-started-observed') ||
    states.some((value) => value.outcome === 'installed') ||
    app.some(
      (event) =>
        event.type === 'native-install-started' ||
        event.type === 'target-started' ||
        event.nativeInstallInvoked === true ||
        event.targetStarted === true ||
        (versionA && event.type === 'application-started' && event.version !== versionA)
    )
  const unsafe =
    scenario === 'upgrade'
      ? observations.some((event) => event.type === 'target-started-observed') ||
        app.some(
          (event) =>
            event.type === 'application-started' &&
            event.version !== versionA &&
            event.version !== versionB
        )
      : unexpectedInstallation
  const installation = observations.find(
    (event) =>
      event.type === 'upgrade-observed' &&
      event.version === versionB &&
      event.receiptVerified &&
      event.automaticRelaunchVerified &&
      event.oldProcessesExited &&
      event.targetPackageVerified
  )
  const upgradedReady = app.find(
    (event) =>
      event.type === 'runtime-ready' &&
      event.version === versionB &&
      event.pid === installation?.pid &&
      event.desktopPid === installation?.desktopPid &&
      event.generation === installation?.generation
  )
  const nativeInstall = after(app, 'native-install-started', stopped)
  const postUpdateWrite =
    fixture?.postUpdateWrite?.exists === true &&
    fixture.postUpdateWrite.notebookCompleted === true &&
    fixture.postUpdateWrite.notebookStartedAt > time(installation) &&
    fixture.postUpdateWrite.mtimeMs > time(upgradedReady) &&
    fixture.postUpdateWrite.mtimeMs > time(installation)
  const fullUpgrade =
    downloaded >= 0 &&
    stopProof &&
    nativeInstall > stopped &&
    !!installation &&
    !!upgradedReady &&
    time(upgradedReady) > time(app[nativeInstall]) &&
    time(installation) >= time(upgradedReady) &&
    dataPreserved &&
    postUpdateWrite &&
    app.some(
      (event) =>
        event.type === 'application-quit' &&
        event.pid === installation.desktopPid &&
        time(event) > fixture.postUpdateWrite.mtimeMs
    )
  const taskRunning = observations.find((event) => event.type === 'task-running-observed')
  const taskExit = observations.find(
    (event) =>
      event.type === 'task-exit-observed' &&
      event.pid === taskRunning?.pid &&
      event.mtimeMs === taskRunning?.mtimeMs
  )
  const taskNotRestarted = observations.some(
    (event) =>
      event.type === 'task-not-restarted' &&
      event.pid === taskRunning?.pid &&
      event.mtimeMs === taskRunning?.mtimeMs &&
      event.recoveryGeneration === app[recovered]?.generation
  )
  const sourceReady = server.find((event) => event.type === 'source-ready')
  const started = app.find((event) => event.type === 'application-started')
  const launched = observations.find(
    (event) => event.type === 'initial-application-launched' && event.pid === started?.pid
  )
  const preflight = observations.find(
    (event) =>
      event.type === 'source-health-before-launch' &&
      event.origin === sourceReady?.origin &&
      event.ready === true
  )
  const sourceClosed = server.findLast(
    (event) => event.type === 'source-closed' && event.origin === sourceReady?.origin
  )
  const portReleased = observations.findLast(
    (event) => event.type === 'source-port-released' && event.origin === sourceReady?.origin
  )
  const stoppedEvents = app.filter((event) => event.type === 'runtime-stopped')
  const quitEvents = app.filter((event) => event.type === 'application-quit')
  const lifecycle = {
    sourceReadyBeforeA: !!(
      sourceReady &&
      started &&
      launched &&
      preflight &&
      Date.parse(sourceReady.at) <= Date.parse(started.at) &&
      Date.parse(preflight.at) <= Date.parse(started.at)
    ),
    sourceSurvivedApplication:
      stoppedEvents.length + quitEvents.length > 0 &&
      stoppedEvents.every((event) =>
        observations.some(
          (observed) =>
            observed.type === 'source-health-after-runtime-stop' &&
            observed.pid === event.pid &&
            observed.generation === event.generation &&
            observed.origin === sourceReady?.origin &&
            observed.ready === true &&
            Date.parse(observed.at) >= Date.parse(event.at)
        )
      ) &&
      quitEvents.every((event) =>
        observations.some(
          (observed) =>
            observed.type === 'source-health-after-application-quit' &&
            observed.pid === event.pid &&
            observed.origin === sourceReady?.origin &&
            observed.ready === true &&
            Date.parse(observed.at) >= Date.parse(event.at)
        )
      ),
    sourceClosed: !!sourceClosed,
    portReleased: !!(
      sourceClosed &&
      portReleased &&
      Date.parse(portReleased.at) >= Date.parse(sourceClosed.at)
    )
  }
  const lifecyclePassed = Object.values(lifecycle).every(Boolean)
  let downloadCancellation
  let passed = false
  switch (scenario) {
    case 'upgrade':
      passed = fullUpgrade
      break
    case 'boundary':
      passed =
        boundary &&
        app[handoffIndex].type === 'handoff-boundary' &&
        states.some((value) => value.recovery?.canRecover === true)
      break
    case 'handoff-failure':
      passed =
        boundary &&
        app[handoffIndex].type === 'handoff-failure' &&
        recoveryProof &&
        dataPreserved &&
        recoveryWrite
      break
    case 'same-version':
    case 'lower-version':
      passed =
        states.some((value) => value.state === 'up-to-date') &&
        !available &&
        handoffIndex < 0 &&
        server.some((event) => event.path === '/latest-mac.yml')
      break
    case 'download-cancel': {
      downloadCancellation = downloadCancellationEvidence(app, server, downloaded)
      passed =
        faultTriggered &&
        downloadCancellation.uiReturnedToAvailable &&
        downloadCancellation.partialProgressBeforeCancellation &&
        downloadCancellation.firstTransferInterruptedBeforeRetry &&
        downloadCancellation.retryDownloadedAndVerified
      break
    }
    case 'network-failure': {
      const failure = app.findIndex((event) => status(event)?.state === 'error')
      passed = faultTriggered && failure >= 0 && downloaded > failure
      break
    }
    case 'checksum-failure':
    case 'corrupt-artifact':
      passed =
        faultTriggered &&
        states.some(
          (value) => value.state === 'error' && /checksum|sha512|digest/i.test(value.error ?? '')
        ) &&
        server.some(
          (event) =>
            event.type === 'request' && event.method === 'GET' && event.path?.endsWith('.zip')
        ) &&
        downloaded < 0 &&
        handoffIndex < 0 &&
        !states.some((value) => value.state === 'ready')
      break
    case 'active-task': {
      const blocked = app.findIndex(
        (event) =>
          status(event)?.reason === 'active-work' && status(event)?.blockedBy?.includes('notebook')
      )
      passed =
        blocked >= 0 &&
        taskRunning &&
        taskExit &&
        Date.parse(taskRunning.at) <= Date.parse(app[blocked].at) &&
        Date.parse(taskExit.at) <= Date.parse(app[handoffIndex]?.at) &&
        app.slice(0, blocked + 1).every((event) => event.type !== 'runtime-stopped') &&
        states.some(
          (value) => value.reason === 'active-work' && value.recovery?.runtime === 'running'
        ) &&
        boundary &&
        recoveryProof &&
        dataPreserved &&
        recoveryWrite &&
        taskNotRestarted
      break
    }
    case 'shutdown-failure': {
      const fault = server.find(
        (event) =>
          event.type === 'fault-triggered' &&
          event.fault === scenario &&
          event.mechanism === 'runtime-lock-hardlink'
      )
      const release = server.find(
        (event) =>
          event.type === 'fault-released' &&
          event.fault === scenario &&
          event.reason === 'user-request'
      )
      const observed = observations.find(
        (event) =>
          event.type === 'shutdown-fault-observed' &&
          event.dev === fault?.dev &&
          event.ino === fault?.ino &&
          event.nlink === 2
      )
      const released = observations.find(
        (event) =>
          event.type === 'shutdown-fault-release-observed' &&
          event.dev === fault?.dev &&
          event.ino === fault?.ino &&
          event.nlink === 1
      )
      passed =
        downloaded >= 0 &&
        faultTriggered &&
        !!observed &&
        !!released &&
        !!release &&
        stopFailure >= 0 &&
        handoffIndex < 0 &&
        states.some(
          (value) =>
            ['runtime-stop-timeout', 'runtime-stop-unclean'].includes(value.reason) &&
            value.recovery?.canRecover === true
        ) &&
        Date.parse(fault.at) <= Date.parse(app[stopFailure].at) &&
        Date.parse(release.at) >= Date.parse(app[stopFailure].at) &&
        recovered > stopFailure &&
        Date.parse(app[recovered].at) >= Date.parse(release.at) &&
        recoveryProof &&
        dataPreserved &&
        recoveryWrite
      break
    }
  }
  const executed =
    app.length > 0 &&
    (scenario !== 'shutdown-failure' ||
      states.some((value) =>
        ['runtime-stop-timeout', 'runtime-stop-unclean'].includes(value.reason)
      ))
  return {
    scenario,
    status:
      unexpected || unsafe
        ? 'failed'
        : passed && lifecyclePassed && isolationVerified
          ? 'passed'
          : executed
            ? 'failed'
            : 'not-run',
    presetFault: [
      'network-failure',
      'checksum-failure',
      'corrupt-artifact',
      'handoff-failure',
      'shutdown-failure',
      'download-cancel'
    ].includes(scenario),
    faultTriggered:
      scenario === 'handoff-failure'
        ? app.some((event) => event.type === 'handoff-failure')
        : faultTriggered,
    downloadVerified: downloaded >= 0,
    realUpgradeCompleted: !!fullUpgrade,
    writableAfterUpgrade: !!postUpdateWrite,
    ...(downloadCancellation ? { downloadCancellation } : {}),
    runtimeStopped: stopProof,
    handoffBoundaryReached: boundary,
    runtimeRecovered: recoveryProof,
    taskProcessObserved: !!taskRunning,
    taskProcessExited: !!taskExit,
    taskNotRestarted,
    dataPreserved,
    writableAfterRecovery: recoveryWrite,
    lifecycle,
    isolationVerified,
    facilityFailure: unexpected,
    unsafeAction: unsafe,
    diagnostics:
      passed && lifecyclePassed && isolationVerified
        ? []
        : [
            'Required evidence is incomplete or contradicts the scenario; inspect app-events.jsonl, server-events.jsonl, observations.jsonl and application.log.'
          ]
  }
}

export async function writeReport(runRoot) {
  const owner = await exists(join(runRoot, '.local-update-validation-owner.json'))
  if (!owner) throw new Error('Not an owned local-update-validation run.')
  const source = await exists(join(runRoot, 'source.json'))
  const build = await exists(join(runRoot, 'build.json'))
  let names = []
  try {
    names = await readdir(join(runRoot, 'scenarios'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const scenarios = []
  for (const name of names.sort()) {
    const dir = join(runRoot, 'scenarios', name)
    const config = await exists(join(dir, 'local-update.json'))
    if (!config) continue
    const keychain = await exists(join(dir, 'keychain-verification.json'))
    const isolationVerified =
      keychain?.isolated === true &&
      keychain?.hostPreferencesUnchanged === true &&
      keychain.defaultKeychain === config.keychainPath &&
      keychain.searchList?.length === 1 &&
      keychain.searchList[0] === config.keychainPath
    const app = (await readJsonLines(join(dir, 'app-events.jsonl'))).filter(
      (event) => event.runId === config.runId && event.scenario === config.scenario
    )
    scenarios.push({
      ...evaluateScenario({
        scenario: config.scenario,
        app,
        isolationVerified,
        server: await readJsonLines(join(dir, 'server-events.jsonl')),
        observations: await readJsonLines(join(dir, 'observations.jsonl')),
        fixture: await exists(join(dir, 'fixture-verification.json')),
        zipSha512: build?.b?.files?.find((file) => file.name.endsWith('.zip'))?.sha512,
        versionA: build?.versionA,
        versionB: build?.versionB
      }),
      directory: dir
    })
  }
  const required = SCENARIOS.map((scenario) => ({
    scenario,
    status: scenarios.some((result) => result.scenario === scenario && result.unsafeAction)
      ? 'failed'
      : scenarios.some((result) => result.scenario === scenario && result.status === 'passed')
        ? 'passed'
        : scenarios.some((result) => result.scenario === scenario && result.status === 'failed')
          ? 'failed'
          : 'not-run'
  }))
  const failures = await readJsonLines(join(runRoot, 'facility-events.jsonl'))
  const report = {
    schema: 1,
    runId: owner.runId,
    generatedAt: new Date().toISOString(),
    status:
      required.every((result) => result.status === 'passed') &&
      build?.boundaryVerified === true &&
      failures.length === 0 &&
      !scenarios.some((result) => result.unsafeAction)
        ? 'passed'
        : 'not-passed',
    source: source && {
      commit: source.commit,
      snapshotId: source.snapshotId,
      fileCount: source.files.length
    },
    artifacts: build,
    requiredScenarios: required,
    scenarios,
    facilityFailures: failures,
    unverified: [
      ...(required.some((item) => item.scenario === 'upgrade' && item.status === 'passed')
        ? []
        : ['native-installation', 'B-startup', 'post-update-data']),
      ...(build?.productionFullPackageVerified ? [] : ['production-full-package'])
    ],
    diagnosticsDirectory: runRoot
  }
  await writeFile(join(runRoot, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
  const summary = [
    '# Local macOS update validation',
    '',
    `Run: ${owner.runId}`,
    `Result: **${report.status}**`,
    `Commit: ${source?.commit ?? 'not captured'}`,
    `Snapshot: ${source?.snapshotId ?? 'not captured'}`,
    `Versions: A ${build?.versionA ?? '?'} → B ${build?.versionB ?? '?'}`,
    '',
    '| Required scenario | Status |',
    '| --- | --- |',
    ...required.map((item) => `| ${item.scenario} | ${item.status} |`),
    '',
    `Real installation, automatic B startup and post-update data: **${required.find((item) => item.scenario === 'upgrade')?.status ?? 'not-run'}**. Complete production/test package boundary verification: ${build?.productionFullPackageVerified === true ? 'passed' : 'not-run'}.`,
    'The application owns installation, automatic B startup, shutdown and recovery. The runner prepares and observes. Local ad-hoc signing is tested; official signing, notarization and production distribution require separate acceptance.',
    '',
    `Structured evidence: ${join(runRoot, 'result.json')}`,
    `Diagnostics: ${runRoot}`,
    ''
  ].join('\n')
  await writeFile(join(runRoot, 'summary.md'), summary)
  return report
}

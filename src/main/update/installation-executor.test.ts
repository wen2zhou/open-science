import { prefetchSystemBootIdentity } from '../system-boot-identity'
import { afterEach, beforeAll, expect, it } from 'vitest'
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  INSTALLATION_EXECUTOR_SOURCE,
  resumeBoundInstallationExecutor
} from './installation-executor'
import {
  advanceInstallationUpdate,
  beginInstallationUpdate,
  bindInstallationExecutor,
  captureInstallationManifest,
  finishInstallationRecovery,
  inspectInstallationUpdate,
  installationStateDirectory
} from './installation-protection'
// Match startup's asynchronous Windows boot query before creating durable update records.
beforeAll(async () => {
  await prefetchSystemBootIdentity()
})

const directories: string[] = []
afterEach(async () => {
  // Windows can briefly retain a file lock after the executor has exited.
  for (const p of directories.splice(0))
    await rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
it.each([
  undefined,
  'before-rename',
  'after-old-rename',
  'kill-after-rename',
  'cancel-before-start',
  'appimage',
  'deb-delayed',
  ...(process.platform === 'win32' ? [] : ['relaunch'])
])('settles a real isolated replacement/rollback: %s', async (fault) => {
  const dir = mkdtempSync(join(tmpdir(), 'executor-test-'))
  directories.push(dir)
  const root = join(dir, 'app'),
    staged = join(dir, 'replacement'),
    executor = join(dir, 'executor')
  const image = fault === 'appimage'
  const native = fault === 'deb-delayed'
  const channel =
    fault === 'deb-delayed' ? 'supervised-deb' : image ? 'supervised-appimage' : 'supervised-mac'
  const relaunch = fault === 'relaunch'
  const rollback = !!fault && !image && !native && !relaunch
  for (const p of image ? [executor] : [root, staged, executor]) mkdirSync(p)
  writeFileSync(image ? root : join(root, 'program'), 'old')
  writeFileSync(image ? staged : join(staged, 'program'), 'new')
  if (relaunch) {
    mkdirSync(join(staged, 'Contents/MacOS'), { recursive: true })
    const executable = join(staged, 'Contents/MacOS/Open-Science')
    writeFileSync(executable, `#!/bin/sh\nprintf 'B started' > '${join(dir, 'relaunched')}'\n`)
    chmodSync(executable, 0o700)
  }
  const location = { installationRoot: root, stateRoot: join(dir, 'state') }
  const configRoot = join(dir, 'config')
  const record = beginInstallationUpdate({
    ...location,
    runtime: { pid: process.pid, generation: 'test', configRoot },
    startupOptions: {
      configRoot,
      dataRoot: join(dir, 'data'),
      profilePath: join(dir, 'profile'),
      host: '127.0.0.1',
      port: 0,
      credentialStore: 'file'
    },
    currentVersion: '1',
    targetVersion: '2',
    targetManifest: captureInstallationManifest(staged, '2'),
    inspectProcesses: () => []
  })
  advanceInstallationUpdate(location, record.operationId, 'stopping')
  advanceInstallationUpdate(location, record.operationId, 'stopped', true)
  advanceInstallationUpdate(location, record.operationId, 'handoff')
  const preload = join(dir, 'preload.cjs')
  if (native) {
    const control = JSON.stringify(join(dir, 'settled')),
      started = JSON.stringify(join(dir, 'started')),
      program = JSON.stringify(join(root, 'program'))
    writeFileSync(
      preload,
      `const fs=require('node:fs');require('node:child_process').execFileSync=(command,args)=>{if(command==='/usr/bin/systemd-run'){fs.writeFileSync(${started},'started');return ''}if(command!=='/usr/bin/systemctl')throw Error('Unexpected command');if(!fs.existsSync(${started}))return 'LoadState=not-found';const settled=fs.existsSync(${control});if(settled)fs.writeFileSync(${program},'new');return 'LoadState=loaded\\nActiveState=active\\nSubState='+(settled?'exited':'running')+'\\nExecMainStatus=0\\nControlGroup=\\nExitType=cgroup'}`
    )
  }
  const bytes = JSON.stringify({
    recordPath: join(installationStateDirectory(location), 'update-in-progress.json'),
    operationId: record.operationId,
    channel,
    installationRoot: record.installationRoot,
    stagedBundle: staged,
    backup: join(dir, 'backup'),
    discard: join(dir, 'discard'),
    desktopPid: 2147483647,
    relaunch,
    relaunchExecutable: relaunch ? join(root, 'Contents/MacOS/Open-Science') : undefined,
    nodeSha256: captureInstallationManifest(process.execPath, 'executor').files['@image'],
    executorSha256: createHash('sha256').update(INSTALLATION_EXECUTOR_SOURCE).digest('hex'),
    fault,
    delayFile: fault === 'kill-after-rename' ? join(dir, 'continue') : undefined
  })
  writeFileSync(join(executor, 'request.json'), bytes)
  writeFileSync(join(executor, 'executor.cjs'), INSTALLATION_EXECUTOR_SOURCE)
  bindInstallationExecutor(location, record.operationId, {
    channel,
    directory: executor,
    requestSha256: createHash('sha256').update(bytes).digest('hex')
  })
  if (fault === 'kill-after-rename' || fault === 'cancel-before-start') {
    copyFileSync(process.execPath, join(executor, 'node'))
    // These fixtures exercise the macOS executor contract on every host. Windows
    // resolves its extensionless launch path to node.exe; no symlink privilege is needed.
    if (process.platform === 'win32') copyFileSync(process.execPath, join(executor, 'node.exe'))
  }
  if (fault === 'kill-after-rename') {
    const child = spawn(
      process.execPath,
      [join(executor, 'executor.cjs'), join(executor, 'request.json')],
      { stdio: 'ignore' }
    )
    try {
      const deadline = Date.now() + 3000
      while (!existsSync(join(dir, 'backup'))) {
        if (Date.now() > deadline) throw new Error('executor did not reach rename')
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(() => finishInstallationRecovery(location, record.operationId, 'complete')).toThrow(
        'not settled'
      )
    } finally {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGKILL')
      await exited
    }
    expect(() => finishInstallationRecovery(location, record.operationId, 'complete')).toThrow(
      'not settled'
    )
    expect(inspectInstallationUpdate(location)?.operationId).toBe(record.operationId)
  }
  if (fault === 'cancel-before-start') {
    await resumeBoundInstallationExecutor(location, record.operationId)
    expect(existsSync(join(executor, 'changing.json'))).toBe(false)
  } else if (fault === 'kill-after-rename')
    await resumeBoundInstallationExecutor(location, record.operationId)
  else
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          ...(native ? ['--require', preload] : []),
          join(executor, 'executor.cjs'),
          join(executor, 'request.json')
        ],
        { stdio: 'pipe' }
      )
      if (native)
        void (async () => {
          const deadline = Date.now() + 3000
          while (!existsSync(join(dir, 'started'))) {
            if (Date.now() > deadline) throw new Error('Native fixture did not start')
            await new Promise((r) => setTimeout(r, 10))
          }
          expect(existsSync(join(executor, 'result.json'))).toBe(false)
          expect(() =>
            finishInstallationRecovery(location, record.operationId, 'complete')
          ).toThrow('not settled')
          writeFileSync(join(dir, 'settled'), 'empty')
        })().catch((error) => {
          child.kill('SIGKILL')
          reject(error)
        })
      let error = ''
      child.stderr.on('data', (d) => (error += d))
      child.once('error', reject)
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(error))))
    })
  expect(JSON.parse(readFileSync(join(executor, 'result.json'), 'utf8')).outcome).toBe(
    rollback ? 'rolled-back' : 'installed'
  )
  expect(readFileSync(image ? root : join(root, 'program'), 'utf8')).toBe(rollback ? 'old' : 'new')
  if (relaunch) {
    const deadline = Date.now() + 5000
    while (!existsSync(join(dir, 'relaunched'))) {
      if (Date.now() > deadline)
        throw new Error('Replacement application was not automatically relaunched')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(readFileSync(join(dir, 'relaunched'), 'utf8')).toBe('B started')
  }
  finishInstallationRecovery(location, record.operationId, rollback ? 'cancel' : 'complete')
  expect(inspectInstallationUpdate(location)).toBeUndefined()
})

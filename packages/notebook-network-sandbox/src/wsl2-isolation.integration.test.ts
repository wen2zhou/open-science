import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { wsl2Launch, type Wsl2Launch } from '../runtime/src/platform/wsl2-isolation.js'
import { isWsl2BashDevelopmentEnabled } from '../runtime/src/wsl2-development-gate.js'
import { notebookWorkloadCacheEnv } from '../../../src/main/notebook/notebook-workload-cache-paths.js'

const distro = process.env.OPEN_SCIENCE_WSL_DISTRO
const user = process.env.OPEN_SCIENCE_WSL_USER
const enabled =
  process.platform === 'win32' && Boolean(distro && user) && isWsl2BashDevelopmentEnabled()

const execute = async (
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> =>
  new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.once('error', reject)
    child.once('exit', (exitCode) => resolve({ exitCode, stdout, stderr }))
  })

const waitForStdout = (
  child: ChildProcessWithoutNullStreams,
  expected: string,
  timeoutMs = 5_000
): Promise<void> =>
  new Promise((resolve, reject) => {
    let stdout = ''
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${expected}.`)),
      timeoutMs
    )
    const onData = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8')
      if (!stdout.includes(expected)) return
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      resolve()
    }
    child.stdout.on('data', onData)
  })

describe.runIf(enabled)('WSL2 sandbox real profile', () => {
  let root = ''
  let workspace = ''
  let handoff = ''
  let cache = ''
  let unauthorized = ''

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-wsl-command-'))
    workspace = join(root, 'Workspace 路径')
    handoff = join(root, 'handoff')
    cache = join(root, 'runtime', 'cache', 'notebook')
    unauthorized = join(root, 'unauthorized')
    await Promise.all(
      [workspace, handoff, cache, unauthorized].map((directory) =>
        mkdir(directory, { recursive: true })
      )
    )
    await writeFile(join(unauthorized, 'secret.txt'), 'host-secret', 'utf8')
  })

  afterAll(async () => rm(root, { recursive: true, force: true }))

  const launch = (command: string): Promise<Wsl2Launch> =>
    wsl2Launch({
      target: {
        kind: 'wsl2',
        profileId: 'real-profile',
        distro: distro!,
        user: user!
      },
      command,
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        OPEN_SCIENCE_TEST_SECRET: 'must-not-leak'
      },
      pathEnvironment: {
        OPEN_SCIENCE_HANDOFF_DIR: handoff,
        ...notebookWorkloadCacheEnv(join(root, 'runtime'))
      },
      filesystem: {
        privateRoot: root,
        readOnlyRoots: [],
        readWriteRoots: [workspace, handoff, cache],
        deniedReadRoots: [unauthorized],
        deniedWriteRoots: []
      }
    })

  it('runs Unicode Bash with mapped workspace channels and closed host surfaces', async () => {
    const prepared = await launch(String.raw`
printf '你好 stdout\n'
printf 'guest stderr\n' >&2
printf handoff > "$OPEN_SCIENCE_HANDOFF_DIR/result.txt"
printf cache > "$OPEN_SCIENCE_NOTEBOOK_CACHE_DIR/result.txt"
mkdir -p "$MPLCONFIGDIR" "$UV_CACHE_DIR" "$HF_DATASETS_CACHE" "$HF_XET_CACHE" "$HF_ASSETS_CACHE" "$TORCHINDUCTOR_CACHE_DIR" "$TORCH_EXTENSIONS_DIR" "$PYTORCH_KERNEL_CACHE_PATH" "$TRITON_CACHE_DIR" "$NUMBA_CACHE_DIR" "$R_USER_CACHE_DIR"
[ ! -e ../unauthorized/secret.txt ]
[ -z "\${OPEN_SCIENCE_TEST_SECRET:-}" ]
[ "$PATH" = /usr/bin:/bin ]
[ ! -e /mnt/c/Windows/System32/cmd.exe ]
[ -z "$(find /run/WSL -name '*_interop' -print -quit 2>/dev/null || true)" ]
[ ! -r /proc/net/route ] || ! grep -q '^.*[[:space:]]00000000[[:space:]]' /proc/net/route
`)

    await expect(execute(prepared.argv, prepared.env, workspace)).resolves.toEqual({
      exitCode: 0,
      stdout: '你好 stdout\n',
      stderr: 'guest stderr\n'
    })
    await prepared.release()
  })

  it('preserves a real non-zero Bash exit code', async () => {
    const prepared = await launch(`printf 'failed' >&2; exit 23`)
    await expect(execute(prepared.argv, prepared.env, workspace)).resolves.toEqual({
      exitCode: 23,
      stdout: '',
      stderr: 'failed'
    })
    await prepared.release()
  })

  it('cleans an execution when cancellation races receipt publication', async () => {
    const prepared = await launch('sleep 30')
    const child = spawn(prepared.argv[0]!, prepared.argv.slice(1), {
      cwd: workspace,
      env: prepared.env,
      windowsHide: true
    })
    const startedAt = Date.now()

    await expect(prepared.release('cancel')).resolves.toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(8_000)
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Receipt-race WSL host did not exit.')),
          5_000
        )
        child.once('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
  }, 15_000)

  it('cancels background, double-fork, and persistent-writer descendants without stopping a concurrent execution', async () => {
    const victim = await launch(String.raw`
env -u OPEN_SCIENCE_WSL_EXECUTION_TOKEN setsid /bin/bash --noprofile --norc -c '
  trap "" TERM
  (trap "" TERM; while :; do printf writer; sleep 0.1; done) &
  while :; do sleep 1; done
' &
printf ready
while :; do sleep 1; done
`)
    const concurrent = await launch(`sleep 4; printf concurrent-ok`)
    const victimChild = spawn(victim.argv[0]!, victim.argv.slice(1), {
      cwd: workspace,
      env: victim.env,
      windowsHide: true
    })
    const concurrentCompletion = execute(concurrent.argv, concurrent.env, workspace)

    await waitForStdout(victimChild, 'ready')
    const startedAt = Date.now()
    await expect(victim.release('cancel')).resolves.toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(8_000)
    await expect(
      new Promise<void>((resolve, reject) => {
        if (victimChild.exitCode !== null || victimChild.signalCode !== null) {
          resolve()
          return
        }
        const timeout = setTimeout(
          () => reject(new Error('Cancelled WSL host did not exit.')),
          5_000
        )
        victimChild.once('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    ).resolves.toBeUndefined()

    const token = victim.argv.find((value) =>
      /^open-science-execution-[0-9a-f-]{36}$/u.test(value)
    )!
    const receipt = victim.argv.find((value) => /^\/tmp\/\.open-science-execution-/u.test(value))!
    const cleanupEvidence = execFileSync(
      victim.argv[0]!,
      [
        '--distribution',
        distro!,
        '--user',
        user!,
        '--exec',
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        String.raw`token=$1; receipt=$2; alive=0
for environment in /proc/[0-9]*/environ; do
  [ -r "$environment" ] || continue
  tr '\0' '\n' < "$environment" 2>/dev/null | grep -Fqx "OPEN_SCIENCE_WSL_EXECUTION_TOKEN=$token" && alive=$((alive + 1))
done
[ -e "$receipt" ] && receipt_exists=1 || receipt_exists=0
printf 'alive=%s;receipt=%s\n' "$alive" "$receipt_exists"`,
        'verify-exact-cleanup',
        token,
        receipt
      ],
      { encoding: 'utf8', windowsHide: true }
    ).trim()
    expect(cleanupEvidence).toBe('alive=0;receipt=0')
    await expect(concurrentCompletion).resolves.toEqual({
      exitCode: 0,
      stdout: 'concurrent-ok',
      stderr: ''
    })
    await concurrent.release('exit')
  }, 20_000)
})

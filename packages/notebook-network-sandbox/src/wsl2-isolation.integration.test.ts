import { spawn } from 'node:child_process'
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
})

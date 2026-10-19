import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE_PROJECT, FIXTURE_SESSION, prepareFixture, verifyFixture } from './fixture'
import { assertShellSearchScope } from '../../src/main/notebook/shell-search-scope'
import { getNotebookDataRoot } from '../../src/main/notebook/repository'
import { decodeRunDocumentDataPaths } from '../../src/main/notebook/run-document-data-paths'
import { decodeSessionFile } from '../../src/shared/session-persistence/file-codec'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it('seeds actual production stores once, observes preservation without repairing corrupt data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-update-fixture-'))
  roots.push(root)
  const config = { configRoot: join(root, 'config'), dataRoot: join(root, 'data') }
  await prepareFixture(config)
  const manifest = JSON.parse(await readFile(join(root, 'fixture-manifest.json'), 'utf8'))
  const before = await stat(manifest.sessionPath)
  expect(await verifyFixture(config)).toMatchObject({
    preserved: true,
    recoveryWrite: { exists: false }
  })
  expect((await stat(manifest.sessionPath)).mtimeMs).toBe(before.mtimeMs)
  await expect(prepareFixture(config)).rejects.toThrow('Refusing to reseed')
  await writeFile(manifest.attachment.path, 'corrupt fixture')
  expect(await verifyFixture(config)).toMatchObject({
    preserved: false,
    checks: { attachment: false }
  })
  expect(await readFile(manifest.attachment.path, 'utf8')).toBe('corrupt fixture')
  await writeFile(join(manifest.workspace, 'recovery-write.txt'), 'LOCAL_UPDATE_RECOVERY_WRITE\n')
  expect(await verifyFixture(config)).toMatchObject({ recoveryWrite: { exists: true } })
  const database = join(config.configRoot, 'open-science.db')
  await rm(database)
  expect(await verifyFixture(config)).toMatchObject({
    preserved: false,
    checks: { project: false }
  })
  await expect(stat(database)).rejects.toMatchObject({ code: 'ENOENT' })
}, 30000)

it('generates inspectable inline commands in the production Notebook data directory', async () => {
  const root = await mkdtemp(join(tmpdir(), "local-update-fixture's scoped "))
  roots.push(root)
  const config = { configRoot: join(root, 'config'), dataRoot: join(root, 'data') }
  await prepareFixture(config)
  const manifest = JSON.parse(await readFile(join(root, 'fixture-manifest.json'), 'utf8'))
  const expected = getNotebookDataRoot(config.dataRoot, FIXTURE_PROJECT, FIXTURE_SESSION)
  expect(manifest.workspace).toBe(expected)
  const session = decodeSessionFile(JSON.parse(await readFile(manifest.sessionPath, 'utf8')))
  expect(session.status).toBe('ok')
  if (session.status === 'ok') expect(session.session.cwd).toBe(expected)
  const notebook = decodeRunDocumentDataPaths(
    JSON.parse(await readFile(manifest.notebookPath, 'utf8')),
    config.dataRoot
  )
  expect(notebook.workspaceCwd).toBe(expected)
  expect(notebook.dataRoot).toBe(expected)
  // No grants or policy mocks: these are the same admission checks used by the packaged Shell.
  await expect(
    assertShellSearchScope(manifest.taskCommand, expected, [], 'darwin')
  ).resolves.toBeUndefined()
  await expect(
    assertShellSearchScope(manifest.recoveryWriteCommand, expected, [], 'darwin')
  ).resolves.toBeUndefined()
  await expect(
    assertShellSearchScope(`/bin/sh './task.sh'`, expected, [], 'darwin')
  ).rejects.toThrow('shell script files')
  if (process.platform !== 'win32') {
    const execute = promisify(execFile)
    await execute('/bin/sh', ['-c', manifest.recoveryWriteCommand], { cwd: expected })
    expect(await verifyFixture(config)).toMatchObject({
      preserved: true,
      recoveryWrite: { exists: true }
    })
    // A real redirection failure must stop before exec sleep, rather than silently starting work.
    await mkdir(join(expected, 'task.pid'))
    const result = await execute('/bin/sh', ['-c', manifest.taskCommand], {
      cwd: expected,
      timeout: 1000
    }).catch((error: NodeJS.ErrnoException & { killed?: boolean }) => error)
    expect(result).toMatchObject({ killed: false })
    expect(typeof (result as NodeJS.ErrnoException).code).toBe('number')
  }
}, 30000)

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronState = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.1.0',
    getName: () => 'LocalUpdateValidation',
    getPath: () => electronState.root,
    whenReady: async () => {}
  },
  session: { fromPartition: () => ({}) },
  // ElectronHttpExecutor retains the real updater request/download/checksum implementation.
  // Node HTTP is the test transport; no fake updater lifecycle events are supplied.
  net: { request: (options: Parameters<typeof request>[0]) => request(options) }
}))
import {
  LocalMacDownloadUpdater,
  localRuntimeRecoveryEvidence,
  verifyLocalPublisher
} from './adapter'
import { createDesktopPreviewProxy } from '../desktop-preview-proxy'
import type { DesktopRuntimeClient } from '../desktop-runtime-client'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import { CancellationError, CancellationToken } from 'builder-util-runtime'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const remove of cleanup.splice(0).reverse()) await remove()
})
async function setup(corrupt: boolean): Promise<{
  updater: LocalMacDownloadUpdater
  expected: Buffer
  checksum: string
  bytesServed(): number
}> {
  const require = createRequire(import.meta.url)
  const electronEntry = require.resolve('electron')
  const previousModule = require.cache[electronEntry]
  const mockExports = {
    app: {
      isPackaged: true,
      getVersion: () => '0.1.0',
      getName: () => 'LocalUpdateValidation',
      getPath: () => electronState.root,
      whenReady: async () => {}
    },
    session: { fromPartition: () => ({}) },
    net: { request: (options: Parameters<typeof request>[0]) => request(options) }
  }
  require.cache[electronEntry] = { exports: mockExports } as NodeModule
  cleanup.push(async () => {
    if (previousModule) require.cache[electronEntry] = previousModule
    else delete require.cache[electronEntry]
  })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-updater-test-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  electronState.root = root
  const expected = Buffer.from('target B application archive, same workspace snapshot')
  const payload = corrupt ? Buffer.from('damaged target B archive') : expected
  const checksum = createHash('sha512').update(expected).digest('base64')
  const feed = {
    version: '0.2.0',
    files: [{ url: 'target.zip', size: expected.length, sha512: checksum }],
    path: 'target.zip',
    sha512: checksum,
    releaseDate: new Date().toISOString()
  }
  let bytesServed = 0
  const server = createServer((incoming, response) => {
    if (incoming.url?.startsWith('/latest')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(feed))
    } else if (incoming.url === '/target.zip') {
      bytesServed += payload.length
      response.writeHead(200, { 'Content-Length': payload.length })
      response.end(payload)
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  )
  const address = server.address() as { port: number }
  const metadata = join(root, 'updater.yml')
  await writeFile(metadata, 'updaterCacheDirName: local-update-validation\n')
  const updater = new LocalMacDownloadUpdater(`http://127.0.0.1:${address.port}/`, root, metadata)
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.logger = null
  return { updater, expected, checksum, bytesServed: () => bytesServed }
}

describe('local macOS download adapter', () => {
  it.each(['production executor', 'local updater'] as const)(
    'aborts the real %s request on cancellation before any retry or application exit',
    async (mode) => {
      const { updater } = await setup(false)
      const expected = Buffer.alloc(256 * 1024, 'verified retry bytes')
      const checksum = createHash('sha512').update(expected).digest('base64')
      let firstInterrupted = false
      let starts = 0
      let firstResponse!: import('node:http').ServerResponse
      const server = createServer((incoming, response) => {
        if (incoming.url?.startsWith('/latest')) {
          response.setHeader('Content-Type', 'application/json')
          response.end(
            JSON.stringify({
              version: '0.2.0',
              files: [{ url: 'target.zip', size: expected.length, sha512: checksum }],
              path: 'target.zip',
              sha512: checksum
            })
          )
          return
        }
        starts += 1
        response.setHeader('Content-Length', expected.length)
        if (starts === 1) {
          firstResponse = response
          response.on('close', () => {
            firstInterrupted = !response.writableFinished
          })
          // The server never finishes this response. Only the client's cancellation can end it.
          response.write(expected.subarray(0, 16 * 1024))
        } else response.end(expected)
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      cleanup.push(
        () =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections()
            server.close((error) => (error ? reject(error) : resolve()))
          })
      )
      const url = new URL(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/target.zip`
      )
      updater.setFeedURL({ provider: 'generic', url: new URL('/', url).href })
      await updater.checkForUpdates()
      const executor = new ElectronHttpExecutor()
      const destination = join(electronState.root, 'production-executor.zip')
      const token = new CancellationToken()
      const downloaded = vi.fn()
      updater.on('update-downloaded', downloaded)
      const download = (cancellationToken: CancellationToken): Promise<unknown> =>
        mode === 'local updater'
          ? updater.downloadUpdate(cancellationToken)
          : executor.download(url, destination, {
              cancellationToken,
              sha512: checksum,
              onProgress: () => {}
            })
      const transfer = download(token)
      // Observe bytes written by the real SDK stream before canceling the live transfer.
      await vi.waitFor(() => expect(firstResponse).toBeDefined())
      const partialPath =
        mode === 'local updater'
          ? join(electronState.root, 'local-update-validation', 'pending', 'temp-target.zip')
          : destination
      await vi.waitFor(async () => expect((await stat(partialPath)).size).toBeGreaterThan(0))
      token.cancel()
      await expect(transfer).rejects.toBeInstanceOf(CancellationError)
      await expect.poll(() => firstInterrupted, { timeout: 750, interval: 10 }).toBe(true)
      expect(starts).toBe(1)
      expect(downloaded).not.toHaveBeenCalled()
      const retry = await download(new CancellationToken())
      const path = mode === 'local updater' ? (retry as string[])[0] : destination
      expect(await readFile(path)).toEqual(expected)
      expect(starts).toBe(2)
    }
  )

  it('records the ready service bound endpoint when startup requested dynamic port zero', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'local-recovery-endpoint-')))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const server = createServer((_request, response) => response.end('recovered preview'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
    )
    const port = (server.address() as { port: number }).port
    await writeFile(join(root, 'web-service.json'), JSON.stringify({ pid: process.pid, port }))
    await writeFile(join(root, 'web-token'), 'test-only-preview-token'.repeat(3))
    const endpoint = await createDesktopPreviewProxy(root, process.pid)
    cleanup.push(async () => endpoint.dispose())
    const response = await endpoint.fetch(new Request('open-science-preview://target/ready'))
    expect(await response.text()).toBe('recovered preview')
    let phase: 'ready' | 'checking' = 'ready'
    const startupOptions = { port: 0, dataRoot: root }
    const client = {
      processId: () => process.pid,
      startupState: () => ({ phase }),
      runtimeInfo: () => ({ generation: 'recovered-generation', startupOptions })
    } as unknown as DesktopRuntimeClient
    expect(localRuntimeRecoveryEvidence(client, endpoint, '1')).toMatchObject({
      pid: process.pid,
      generation: 'recovered-generation',
      ready: true,
      serviceReady: true,
      port,
      dataRoot: root
    })
    expect(port).toBeGreaterThan(0)
    expect(startupOptions.port).toBe(0)
    expect(() => localRuntimeRecoveryEvidence(client, { port: 0 }, '1')).toThrow('not ready')
    phase = 'checking'
    expect(() => localRuntimeRecoveryEvidence(client, endpoint, '1')).toThrow('not ready')
  })

  it('checks a real feed and downloads a ZIP through the production SHA512 verifier', async () => {
    const { updater, expected, checksum, bytesServed } = await setup(false)
    const downloaded = vi.fn()
    updater.on('update-downloaded', downloaded)
    expect((await updater.checkForUpdates())?.updateInfo.version).toBe('0.2.0')
    const paths = await updater.downloadUpdate()
    expect(bytesServed()).toBe(expected.length)
    expect(await readFile(paths[0])).toEqual(expected)
    expect(downloaded).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadedFile: paths[0],
        files: [expect.objectContaining({ sha512: checksum })]
      })
    )
    expect(() => updater.quitAndInstall()).toThrow('Native installation is disabled')
  })
  it('rejects a corrupted network artifact without publishing downloaded readiness', async () => {
    const { updater, bytesServed } = await setup(true)
    const downloaded = vi.fn()
    updater.on('update-downloaded', downloaded)
    await updater.checkForUpdates()
    await expect(updater.downloadUpdate()).rejects.toThrow(/checksum/i)
    expect(bytesServed()).toBeGreaterThan(0)
    expect(downloaded).not.toHaveBeenCalled()
  })
})

it('accepts only the isolated ad-hoc publisher after code signature integrity verification', () => {
  const signature = new Set([
    'Identifier=com.aipoch.open-science.local-update-validation',
    'Signature=adhoc',
    'TeamIdentifier=not set'
  ])
  expect(() => verifyLocalPublisher(signature)).not.toThrow()
  for (const required of signature) {
    const invalid = new Set(signature)
    invalid.delete(required)
    expect(() => verifyLocalPublisher(invalid)).toThrow()
  }
  expect(() =>
    verifyLocalPublisher(
      new Set(['Identifier=com.aipoch.open-science', 'TeamIdentifier=87G9WFU9H3'])
    )
  ).toThrow()
})

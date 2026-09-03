import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { evaluateWsl2BashPreview, wsl2BashPreviewStatus } from './wsl2-preview-gate'

describe('WSL2 Bash Preview admission', () => {
  it('starts unavailable until the main process initializes the packaged gate', () => {
    expect(wsl2BashPreviewStatus()).toEqual({
      available: false,
      reason: 'not-initialized'
    })
  })

  it.each([
    ['linux', 'x64', 'unsupported-platform'],
    ['win32', 'arm64', 'unsupported-architecture']
  ] as const)('rejects %s %s outside the certified host boundary', (platform, arch, reason) => {
    expect(
      evaluateWsl2BashPreview({ platform, arch, buildEnabled: true, packaged: false })
    ).toEqual({ available: false, reason })
  })

  it('provides a build-level rollback that cannot be changed at runtime', () => {
    expect(
      evaluateWsl2BashPreview({
        platform: 'win32',
        arch: 'x64',
        buildEnabled: false,
        packaged: false
      })
    ).toEqual({ available: false, reason: 'build-disabled' })
  })

  it('rejects unpackaged Windows x64 builds outside the certified boundary', () => {
    expect(
      evaluateWsl2BashPreview({
        platform: 'win32',
        arch: 'x64',
        buildEnabled: true,
        packaged: false
      })
    ).toEqual({ available: false, reason: 'unpackaged-build' })
  })

  it('admits a packaged Windows x64 build only with matching versioned assets', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'wsl-preview-assets-'))
    try {
      const assetDirectory = join(resourcesPath, 'notebook-network-sandbox', 'wsl2')
      await mkdir(assetDirectory, { recursive: true })
      expect(
        evaluateWsl2BashPreview({
          platform: 'win32',
          arch: 'x64',
          buildEnabled: true,
          packaged: true,
          resourcesPath,
          appVersion: '0.24.0'
        })
      ).toEqual({ available: false, reason: 'assets-unavailable' })
      await writeFile(
        join(assetDirectory, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          appVersion: '0.24.0',
          assets: ['wsl2-execution-wrapper-v1', 'wsl2-exact-cleanup-v1', 'wsl2-network-bridge-v1']
        })
      )

      expect(
        evaluateWsl2BashPreview({
          platform: 'win32',
          arch: 'x64',
          buildEnabled: true,
          packaged: true,
          resourcesPath,
          appVersion: '0.24.0'
        })
      ).toEqual({ available: true, reason: 'available' })
      expect(
        evaluateWsl2BashPreview({
          platform: 'win32',
          arch: 'x64',
          buildEnabled: true,
          packaged: true,
          resourcesPath,
          appVersion: '0.24.1'
        })
      ).toEqual({ available: false, reason: 'assets-unavailable' })
    } finally {
      await rm(resourcesPath, { recursive: true, force: true })
    }
  })
})

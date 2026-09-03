import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Wsl2BashPreviewStatus } from '../../shared/wsl-setup'

declare const __OPEN_SCIENCE_WSL2_BASH_PREVIEW__: boolean | undefined

const REQUIRED_ASSETS = [
  'wsl2-execution-wrapper-v1',
  'wsl2-exact-cleanup-v1',
  'wsl2-network-bridge-v1'
] as const

type PreviewEvaluation = Readonly<{
  platform: NodeJS.Platform
  arch: string
  buildEnabled: boolean
  packaged: boolean
  resourcesPath?: string
  appVersion?: string
}>

const packagedAssetsMatch = (resourcesPath: string, appVersion: string): boolean => {
  try {
    const parsed = JSON.parse(
      readFileSync(join(resourcesPath, 'notebook-network-sandbox', 'wsl2', 'manifest.json'), 'utf8')
    ) as Record<string, unknown>
    return (
      parsed.schemaVersion === 1 &&
      parsed.appVersion === appVersion &&
      Array.isArray(parsed.assets) &&
      parsed.assets.length === REQUIRED_ASSETS.length &&
      REQUIRED_ASSETS.every((asset) => (parsed.assets as unknown[]).includes(asset))
    )
  } catch {
    return false
  }
}

export const evaluateWsl2BashPreview = (input: PreviewEvaluation): Wsl2BashPreviewStatus => {
  if (!input.buildEnabled) return { available: false, reason: 'build-disabled' }
  if (input.platform !== 'win32') return { available: false, reason: 'unsupported-platform' }
  if (input.arch !== 'x64') return { available: false, reason: 'unsupported-architecture' }
  if (
    input.packaged &&
    (!input.resourcesPath ||
      !input.appVersion ||
      !packagedAssetsMatch(input.resourcesPath, input.appVersion))
  ) {
    return { available: false, reason: 'assets-unavailable' }
  }
  return { available: true, reason: 'available' }
}

// Vite replaces this boolean while building the main bundle. The release job can set
// OPEN_SCIENCE_BUILD_WSL2_BASH_PREVIEW=0 to produce a rollback build; no runtime environment
// variable, renderer override, remote flag, or persisted preference can reopen that build.
export const WSL2_BASH_PREVIEW_BUILD_ENABLED =
  typeof __OPEN_SCIENCE_WSL2_BASH_PREVIEW__ === 'boolean'
    ? __OPEN_SCIENCE_WSL2_BASH_PREVIEW__
    : true

let currentStatus: Wsl2BashPreviewStatus = evaluateWsl2BashPreview({
  platform: process.platform,
  arch: process.arch,
  buildEnabled: WSL2_BASH_PREVIEW_BUILD_ENABLED,
  packaged: false
})

export const initializeWsl2BashPreview = (input: Omit<PreviewEvaluation, 'buildEnabled'>): void => {
  currentStatus = evaluateWsl2BashPreview({
    ...input,
    buildEnabled: WSL2_BASH_PREVIEW_BUILD_ENABLED
  })
}

export const wsl2BashPreviewStatus = (): Wsl2BashPreviewStatus => currentStatus

export const assertWsl2BashPreviewAvailable = (): void => {
  if (!currentStatus.available) throw new Error('Notebook WSL2 Bash Preview is unavailable.')
}

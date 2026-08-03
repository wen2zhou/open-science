import { describe, expect, it, vi } from 'vitest'

import { saveSpecialistPackageReport, selectSpecialistArchive } from './electron-adapter'

describe('selectSpecialistArchive', () => {
  it('selects one ZIP in main and returns only bytes to the package IPC seam', async () => {
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ['/private/contributor/research-synth.zip']
    })
    const readFile = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]))
    const getFileSize = vi.fn().mockResolvedValue(3)

    const result = await selectSpecialistArchive({ showOpenDialog, readFile, getFileSize })

    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openFile'],
      filters: [{ name: 'Specialist ZIP', extensions: ['zip'] }]
    })
    expect(readFile).toHaveBeenCalledWith('/private/contributor/research-synth.zip')
    expect(getFileSize).toHaveBeenCalledWith('/private/contributor/research-synth.zip')
    expect(result).toEqual({ bytes: new Uint8Array([1, 2, 3]) })
    expect(JSON.stringify(result)).not.toContain('/private')
  })

  it('returns cancellation without reading a file', async () => {
    const readFile = vi.fn()
    await expect(
      selectSpecialistArchive({
        showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
        readFile,
        getFileSize: vi.fn()
      })
    ).resolves.toEqual({ cancelled: true })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('rejects a compressed file over 50 MB before reading it', async () => {
    const readFile = vi.fn()
    await expect(
      selectSpecialistArchive({
        showOpenDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePaths: ['/private/contributor/oversized.zip']
        }),
        readFile,
        getFileSize: vi.fn().mockResolvedValue(50 * 1024 * 1024 + 1)
      })
    ).resolves.toEqual({ tooLarge: true, compressedBytes: 50 * 1024 * 1024 + 1 })
    expect(readFile).not.toHaveBeenCalled()
  })
})

describe('saveSpecialistPackageReport', () => {
  it('writes only the machine-readable report chosen by main', async () => {
    const showSaveDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePath: '/downloads/specialist-package-report.json'
    })
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const report = {
      schemaVersion: 1 as const,
      summary: {
        id: 'safe-specialist',
        version: '1.0.0',
        name: 'Safe Specialist',
        description: 'Safe report content.',
        source: 'zip' as const
      },
      diagnostics: [{ severity: 'warning' as const, code: 'safe.code', message: 'Safe.' }],
      installable: true
    }

    await expect(
      saveSpecialistPackageReport({ showSaveDialog, writeFile }, report)
    ).resolves.toEqual({ saved: true, filePath: '/downloads/specialist-package-report.json' })
    expect(showSaveDialog).toHaveBeenCalledWith({
      defaultPath: 'safe-specialist-1.0.0-diagnostics.json',
      filters: [{ name: 'JSON report', extensions: ['json'] }]
    })
    const json = String(writeFile.mock.calls[0]?.[1])
    expect(JSON.parse(json)).toEqual(report)
    expect(json).not.toMatch(/candidateToken|systemPrompt|archiveBytes/)
  })
})

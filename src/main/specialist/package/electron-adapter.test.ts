import { describe, expect, it, vi } from 'vitest'

import { selectSpecialistArchive } from './electron-adapter'

describe('selectSpecialistArchive', () => {
  it('selects one ZIP in main and returns only bytes to the package IPC seam', async () => {
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ['/private/contributor/research-synth.zip']
    })
    const readFile = vi.fn().mockResolvedValue(Buffer.from([1, 2, 3]))

    const result = await selectSpecialistArchive({ showOpenDialog, readFile })

    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openFile'],
      filters: [{ name: 'Specialist ZIP', extensions: ['zip'] }]
    })
    expect(readFile).toHaveBeenCalledWith('/private/contributor/research-synth.zip')
    expect(result).toEqual({ bytes: new Uint8Array([1, 2, 3]) })
    expect(JSON.stringify(result)).not.toContain('/private')
  })

  it('returns cancellation without reading a file', async () => {
    const readFile = vi.fn()
    await expect(
      selectSpecialistArchive({
        showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
        readFile
      })
    ).resolves.toEqual({ cancelled: true })
    expect(readFile).not.toHaveBeenCalled()
  })
})

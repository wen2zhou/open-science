import { describe, expect, it, vi } from 'vitest'
import { createDesktopOwnedCrashHandler } from './desktop-owned-crash-handler'

const birth = 'Fri Oct 16 15:26:10 2026'
const options = {
  platform: 'darwin' as const,
  resourcesPath: '/Applications/Open Science.app/Contents/Resources',
  profilePath: '/Users/developer/Test Profile',
  crashDatabasePath: '/Users/developer/Test Profile/Crashpad'
}
const handler =
  '/Applications/Open Science.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler'
const canonicalHandler = handler.replace('/Helpers/', '/Versions/A/Helpers/')
function setup(): {
  owned: ReturnType<typeof createDesktopOwnedCrashHandler>
  rows: { text: string }
  inspection: {
    readProcesses: ReturnType<typeof vi.fn<() => string>>
    mappedFiles: ReturnType<typeof vi.fn<(pid: number) => string[]>>
    canonical: (path: string) => string
    now: () => number
  }
} {
  const rows = { text: '' }
  const inspection = {
    readProcesses: vi.fn(() => rows.text),
    mappedFiles: vi.fn<(pid: number) => string[]>(() => [canonicalHandler]),
    canonical: (path: string) => (path === handler ? canonicalHandler : path),
    now: () => Date.parse(birth) + 500
  }
  const owned = createDesktopOwnedCrashHandler(options, inspection)
  const [key, nonce] = Object.entries(owned.globalExtra)[0]
  rows.text = ` 93336 ${birth} ${handler} --no-rate-limit --database=${options.crashDatabasePath} --annotation=${key}=${nonce} --annotation=prod=Electron --handshake-fd=30\n`
  return { owned, rows, inspection }
}

describe('Desktop-owned macOS Crashpad occupancy exception', () => {
  it('keeps private ownership fixed when Electron mutates its annotation copy', () => {
    const { owned, rows } = setup()
    const original = { ...owned.globalExtra }
    const electronAnnotations = { ...owned.globalExtra }
    electronAnnotations._companyName = 'aipoch'
    electronAnnotations.open_science_desktop_owner = 'changed'
    expect(Object.isFrozen(owned.globalExtra)).toBe(true)
    expect(owned.globalExtra).toEqual(original)
    expect(owned.allowedProcessIds()).toEqual([93336])
    rows.text = rows.text.replace(
      /open_science_desktop_owner=[^ ]+/,
      'open_science_desktop_owner=changed'
    )
    expect(owned.allowedProcessIds()).toEqual([])
  })

  it('binds exactly one nonce, profile database, mapped executable and stable PID birth', () => {
    const { owned, inspection } = setup()
    expect(owned.allowedProcessIds()).toEqual([93336])
    expect(inspection.mappedFiles).toHaveBeenCalledExactlyOnceWith(93336)
    expect(inspection.readProcesses).toHaveBeenCalledTimes(2)
    expect(owned.allowedProcessIds()).toEqual([93336])
    expect(createDesktopOwnedCrashHandler(options).globalExtra).not.toEqual(owned.globalExtra)
  })

  it.each([
    [
      'another launch nonce',
      (line: string) =>
        line.replace(/open_science_desktop_owner=[^ ]+/, 'open_science_desktop_owner=other')
    ],
    [
      'another profile',
      (line: string) =>
        line.replace(options.crashDatabasePath, '/Users/developer/Daily Profile/Crashpad')
    ],
    ['another executable', (line: string) => line.replace(handler, '/tmp/chrome_crashpad_handler')],
    ['old orphan', (line: string) => line.replace('15:26:10', '15:26:09')],
    ['future process', (line: string) => line.replace('15:26:10', '15:26:11')],
    [
      'wrapper mentioning the handler',
      (line: string) => line.replace(handler, `/bin/sh -c ${handler}`)
    ],
    [
      'duplicate database option',
      (line: string) => line.trimEnd() + ` --database=${options.crashDatabasePath}\n`
    ],
    [
      'duplicate owner annotation',
      (line: string) =>
        line.trimEnd() +
        ' ' +
        line.match(/--annotation=open_science_desktop_owner=[^ ]+/)![0] +
        '\n'
    ]
  ])('does not exempt %s', (_name, change) => {
    const { owned, rows } = setup()
    rows.text = change(rows.text)
    expect(owned.allowedProcessIds()).toEqual([])
  })

  it('refuses an argv spoof without the exact executable text mapping', () => {
    const { owned, inspection } = setup()
    inspection.mappedFiles.mockReturnValue(['/bin/sleep', handler + '.other'])
    expect(owned.allowedProcessIds()).toEqual([])
  })

  it('refuses ambiguous duplicate handlers even when they share the launch annotation', () => {
    const { owned, rows } = setup()
    rows.text += rows.text.replace('93336', '93338')
    expect(owned.allowedProcessIds()).toEqual([])
  })

  it('rejects PID replacement during mapping and after a successful binding', () => {
    const { owned, rows, inspection } = setup()
    inspection.readProcesses
      .mockReturnValueOnce(rows.text)
      .mockReturnValueOnce(rows.text.replace('93336', '93338'))
    expect(owned.allowedProcessIds()).toEqual([])
    expect(owned.allowedProcessIds()).toEqual([93336])
    rows.text = rows.text.replace('93336', '93338')
    expect(owned.allowedProcessIds()).toEqual([])
  })

  it('requires birth identity as well as a matching PID across scans', () => {
    const { owned, rows, inspection } = setup()
    inspection.now = () => Date.parse(birth) + 5000
    inspection.readProcesses
      .mockReturnValueOnce(rows.text)
      .mockReturnValueOnce(rows.text.replace('15:26:10', '15:26:11'))
    expect(owned.allowedProcessIds()).toEqual([])
    expect(owned.allowedProcessIds()).toEqual([93336])
    rows.text = rows.text.replace('15:26:10', '15:26:11')
    expect(owned.allowedProcessIds()).toEqual([])
  })

  it('never grants an exception on missing evidence or inspection failure', () => {
    const { owned, rows, inspection } = setup()
    rows.text = ''
    expect(owned.allowedProcessIds()).toEqual([])
    inspection.readProcesses.mockImplementation(() => {
      throw new Error('denied')
    })
    expect(owned.allowedProcessIds()).toEqual([])
  })

  it('rejects escaped database scope and does not inspect other platforms', () => {
    const { inspection } = setup()
    expect(
      createDesktopOwnedCrashHandler(
        { ...options, crashDatabasePath: '/other/Crashpad' },
        inspection
      ).allowedProcessIds()
    ).toEqual([])
    expect(
      createDesktopOwnedCrashHandler(
        { ...options, platform: 'linux' },
        inspection
      ).allowedProcessIds()
    ).toEqual([])
    expect(inspection.readProcesses).not.toHaveBeenCalled()
  })
})

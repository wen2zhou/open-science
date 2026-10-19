import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareValidationKeychain } from './keychain.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(): { runRoot: string; homeRoot: string; systemHome: string } {
  const runRoot = realpathSync(mkdtempSync(join(tmpdir(), 'validation-keychain-')))
  roots.push(runRoot)
  const homeRoot = join(runRoot, 'home')
  const systemHome = join(runRoot, 'login-home')
  mkdirSync(homeRoot)
  mkdirSync(systemHome)
  return { runRoot, homeRoot, systemHome }
}

describe('scenario-owned Keychain preparation', () => {
  it('configures only the isolated HOME and verifies normal login metadata is unchanged', () => {
    const config = fixture()
    let prepared: string | undefined
    const mutations: string[] = []
    const execute = vi.fn(
      (_command: string, args: string[], options: { env: { HOME: string } }) => {
        if (args.includes('-s') || args.includes('-p') || args[0] === 'set-keychain-settings') {
          mutations.push(options.env.HOME)
          if (args[0] === 'create-keychain') {
            prepared = args.at(-1)!
            writeFileSync(prepared, 'owned test database')
          }
          return { status: 0, stdout: '' }
        }
        const path = options.env.HOME === config.systemHome ? '/login/daily.keychain-db' : prepared
        return {
          status: path ? 0 : args[0] === 'default-keychain' ? 1 : 0,
          stdout: path ? JSON.stringify(path) + '\n' : ''
        }
      }
    )
    const proof = prepareValidationKeychain(config, {
      platform: 'darwin',
      systemHome: config.systemHome,
      spawnSync: execute
    })
    expect(proof.isolated).toBe(true)
    expect(proof.hostPreferencesUnchanged).toBe(true)
    expect(proof.searchList).toEqual([proof.keychainPath])
    expect(mutations.length).toBeGreaterThan(0)
    expect(mutations.every((home) => home === config.homeRoot)).toBe(true)
    expect(proof).not.toHaveProperty('password')
  })
  it.each(['directory', 'file'] as const)(
    'rejects a symlinked preference %s before any system operation',
    (kind) => {
      const config = fixture()
      const target = join(
        config.systemHome,
        kind === 'directory' ? 'Preferences' : 'com.apple.security.plist'
      )
      const preferences = join(config.homeRoot, 'Library/Preferences')
      mkdirSync(join(config.homeRoot, 'Library'))
      if (kind === 'directory') {
        mkdirSync(target)
        symlinkSync(target, preferences)
      } else {
        mkdirSync(preferences)
        writeFileSync(target, 'daily preferences must remain untouched')
        symlinkSync(target, join(preferences, 'com.apple.security.plist'))
      }
      const execute = vi.fn()
      expect(() =>
        prepareValidationKeychain(config, {
          platform: 'darwin',
          systemHome: config.systemHome,
          spawnSync: execute
        })
      ).toThrow('Symlink')
      expect(execute).not.toHaveBeenCalled()
    }
  )

  it('rejects a login HOME or foreign Keychain path before any system operation', () => {
    const config = fixture()
    const execute = vi.fn()
    expect(() =>
      prepareValidationKeychain(
        { ...config, homeRoot: config.systemHome },
        {
          platform: 'darwin',
          systemHome: config.systemHome,
          spawnSync: execute
        }
      )
    ).toThrow()
    expect(() =>
      prepareValidationKeychain(
        { ...config, keychainPath: '/outside/test.keychain-db' },
        {
          platform: 'darwin',
          systemHome: config.systemHome,
          spawnSync: execute
        }
      )
    ).toThrow()
    expect(execute).not.toHaveBeenCalled()
  })
})

/* eslint-disable @typescript-eslint/explicit-function-return-type -- JavaScript tooling module; TypeScript annotations are not valid in .mjs. */
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { userInfo } from 'node:os'

// Security.framework's non-sandboxed user preference database is scoped by HOME:
// https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/DLDBListCFPref.cpp
// kUserDefaultPath, getPwInfo(kHomeDir), ExpandTildesInPath and writePropertyList show that user
// reads AND writes target HOME/Library/Preferences/com.apple.security.plist, not a global domain.
// Keep official credential helpers and their fixed service/account identities untouched. A unique
// database and user search list give every scenario its own complete credential namespace.
export function prepareValidationKeychain(config, dependencies = {}) {
  const execute = dependencies.spawnSync ?? spawnSync
  const platform = dependencies.platform ?? process.platform
  const systemHome = dependencies.systemHome ?? userInfo().homedir
  if (platform !== 'darwin' || process.getuid?.() === 0)
    throw new Error('Isolated validation Keychains require a non-root macOS login user.')
  const { runRoot, homeRoot } = config
  const keychainPath =
    config.keychainPath ?? join(homeRoot, 'Library/Keychains/local-update-validation.keychain-db')
  for (const value of [runRoot, homeRoot, keychainPath])
    if (!isAbsolute(value) || resolve(value) !== value)
      throw new Error('Validation Keychain paths must be canonical absolute paths.')
  const own = (parent, value) => {
    const within = relative(parent, value)
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw new Error('Validation Keychain paths must belong exclusively to this scenario.')
  }
  own(runRoot, homeRoot)
  own(homeRoot, keychainPath)
  if (
    realpathSync(runRoot) !== runRoot ||
    realpathSync(homeRoot) !== homeRoot ||
    homeRoot === systemHome
  )
    throw new Error('Validation Keychain HOME must be independent of the login HOME.')
  // Reject existing symlinks before creating any child directories or preference files.
  for (const value of [
    homeRoot,
    dirname(keychainPath),
    join(homeRoot, 'Library/Preferences'),
    join(homeRoot, 'Library/Preferences/com.apple.security.plist')
  ]) {
    let entry = value
    while (true) {
      try {
        if (lstatSync(entry).isSymbolicLink())
          throw new Error('Symlink in validation Keychain scope.')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      const parent = dirname(entry)
      if (parent === entry) break
      entry = parent
    }
  }
  const isolatedEnv = { ...process.env, HOME: homeRoot }
  const hostEnv = { ...process.env, HOME: systemHome }
  const invoke = (args, env, requireSuccess = true) => {
    const result = execute('/usr/bin/security', args, {
      env,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 16_384,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    if (result.error || result.signal || (requireSuccess && result.status !== 0))
      // Never forward child-process errors or arguments: create/unlock arguments contain a
      // one-time test password. They do not contain a login password or an existing secret.
      throw new Error('The isolated validation Keychain preparation command failed.')
    return { status: result.status, stdout: String(result.stdout ?? '') }
  }
  const metadata = (env) => ({
    default: invoke(['default-keychain', '-d', 'user'], env, false),
    search: invoke(['list-keychains', '-d', 'user'], env)
  })
  const fingerprint = () => {
    try {
      return createHash('sha256')
        .update(readFileSync(join(systemHome, 'Library/Preferences/com.apple.security.plist')))
        .digest('hex')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  const before = metadata(hostEnv)
  const beforeFingerprint = fingerprint()
  const assertHostUnchanged = () => {
    if (
      JSON.stringify(metadata(hostEnv)) !== JSON.stringify(before) ||
      fingerprint() !== beforeFingerprint
    )
      throw new Error(
        'Login Keychain preferences changed during validation preparation. No global preferences were restored or overwritten.'
      )
  }
  mkdirSync(dirname(keychainPath), { recursive: true, mode: 0o700 })
  mkdirSync(join(homeRoot, 'Library/Preferences'), { recursive: true, mode: 0o700 })
  const passwordPath = join(homeRoot, '.local-update-validation-keychain-password')
  let password
  try {
    let existing = false
    try {
      const state = lstatSync(keychainPath)
      if (!state.isFile() || state.isSymbolicLink())
        throw new Error('Invalid validation Keychain file.')
      existing = true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (existing) {
      const state = lstatSync(passwordPath)
      if (!state.isFile() || state.isSymbolicLink() || (state.mode & 0o077) !== 0)
        throw new Error('The owned validation Keychain password file is unavailable or unsafe.')
      password = readFileSync(passwordPath, 'utf8')
    } else {
      password = randomBytes(32).toString('base64url')
      writeFileSync(passwordPath, password, { mode: 0o600, flag: 'wx' })
      invoke(['create-keychain', '-p', password, keychainPath], isolatedEnv)
    }
    invoke(['list-keychains', '-d', 'user', '-s', keychainPath], isolatedEnv)
    invoke(['default-keychain', '-d', 'user', '-s', keychainPath], isolatedEnv)
    invoke(['unlock-keychain', '-p', password, keychainPath], isolatedEnv)
    invoke(['set-keychain-settings', '-t', '86400', keychainPath], isolatedEnv)
    const scope = metadata(isolatedEnv)
    const parse = (value) =>
      value.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    const defaults = parse(scope.default)
    const search = parse(scope.search)
    if (
      scope.default.status !== 0 ||
      defaults.length !== 1 ||
      defaults[0] !== keychainPath ||
      search.length !== 1 ||
      search[0] !== keychainPath
    )
      throw new Error('The prepared Keychain metadata does not prove exclusive scenario scope.')
    const state = lstatSync(keychainPath)
    if (!state.isFile() || state.isSymbolicLink() || realpathSync(keychainPath) !== keychainPath)
      throw new Error('The prepared Keychain escaped the owned scenario directory.')
    assertHostUnchanged()
    return {
      keychainPath,
      isolated: true,
      hostPreferencesUnchanged: true,
      defaultKeychain: defaults[0],
      searchList: search
    }
  } finally {
    password = undefined
    assertHostUnchanged()
  }
}

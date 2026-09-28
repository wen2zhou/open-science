/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Builds a local, ad-hoc signed production .app without publishing or replacing the installed app.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, copyFile, lstat, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import yaml from 'js-yaml'

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--(source|output|variant|resources)=(.+)$/.exec(arg)
    if (!match) throw new Error(`Invalid argument: ${arg}`)
    return [match[1], match[2]]
  })
)
for (const key of ['source', 'output', 'variant', 'resources']) {
  if (!args[key]) throw new Error(`Missing --${key}=...`)
}
const source = resolve(args.source)
const output = resolve(args.output)
const resources = resolve(args.resources)
const require = createRequire(import.meta.url)
const run = (command, argv, capture = false) =>
  new Promise((resolveRun, reject) => {
    const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
    delete env.CSC_LINK
    delete env.CSC_KEY_PASSWORD
    const child = spawn(command, argv, {
      cwd: source,
      env,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit']
    })
    const chunks = []
    child.stdout?.on('data', (chunk) => {
      chunks.push(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}`))
        return
      }
      const bytes = Buffer.concat(chunks)
      resolveRun(capture === 'raw' ? bytes : bytes.toString('utf8').trim())
    })
  })
const digest = (data) => createHash('sha256').update(data).digest('hex')
await mkdir(output, { recursive: true })
const modules = join(source, 'node_modules')
let moduleState = await lstat(modules).catch(() => undefined)
if (moduleState?.isSymbolicLink()) {
  // electron-builder's collector can omit transitive modules through a worktree-wide symlink.
  // Remove only that link, then make an APFS copy-on-write clone of the installed dependencies.
  await unlink(modules)
  moduleState = undefined
}
if (!moduleState) await run('cp', ['-cR', join(resources, 'node_modules'), modules])
const nativeFiles = [
  'credential-identity-probe-native/build/Release/credential_identity_probe',
  'credential-identity-probe-native/build/Release/credential_key_validator',
  'process-tree-native/build/Release/process_tree_native.node',
  'safe-file-publisher-native/build/Release/safe_file_publisher_native.node'
]
const nativeHashes = {}
for (const file of nativeFiles) {
  const destination = join(source, 'packages', file)
  await mkdir(resolve(destination, '..'), { recursive: true })
  await copyFile(join(resources, 'packages', file), destination)
  nativeHashes[file] = digest(await readFile(destination))
}
await mkdir(join(source, 'resources/bin/mac/arm64'), { recursive: true })
await copyFile(
  join(resources, 'resources/bin/mac/arm64/micromamba'),
  join(source, 'resources/bin/mac/arm64/micromamba')
)
const revision = await run('git', ['rev-parse', 'HEAD'], true)
// Includes tracked source edits; untracked production sources are enumerated separately below.
const patch = await run('git', ['diff', '--binary', 'HEAD'], 'raw')
const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard', 'src'], true))
  .split('\n')
  .filter(Boolean)
const productionSourceHashes = {}
const trackedSource = (
  await run(
    'git',
    ['ls-files', 'src', 'electron.vite.config.ts', 'package.json', 'package-lock.json'],
    true
  )
)
  .split('\n')
  .filter(Boolean)
for (const path of [...trackedSource, ...untracked].sort()) {
  if (/\.test\.[cm]?[jt]sx?$/.test(path)) continue
  productionSourceHashes[path] = digest(await readFile(join(source, path)))
}
const identity = {
  variant: args.variant,
  revision,
  patchSha256: digest(patch),
  productionSourceSha256: digest(JSON.stringify(productionSourceHashes)),
  lockfileSha256: digest(await readFile(join(source, 'package-lock.json'))),
  micromambaSha256: digest(await readFile(join(source, 'resources/bin/mac/arm64/micromamba'))),
  nativeHashes,
  node: process.version,
  electron: require('electron/package.json').version,
  platform: process.platform,
  arch: process.arch
}
await writeFile(join(output, 'source.patch'), patch)
await writeFile(join(output, 'source-hashes.json'), JSON.stringify(productionSourceHashes, null, 2))
await run(process.execPath, [
  '--max-old-space-size=6144',
  'node_modules/electron-vite/bin/electron-vite.js',
  'build'
])
await run('npm', ['run', 'build:web'])
const config = yaml.load(await readFile(join(source, 'electron-builder.yml'), 'utf8'))
// Both arms are launched from separate .app paths on one macOS runner. Give each temporary
// ad-hoc package its own LaunchServices identity so one path cannot capture the other's launch.
config.appId = `${config.appId}.pr2992.${args.variant}`
config.directories.output = output
config.files.push('!test-results{,/**/*}', '!playwright-report{,/**/*}', '!.scratch{,/**/*}')
config.mac.icon = 'build/icon.icns'
config.mac.identity = null
config.dmg.sign = false
const configPath = join(output, 'comparison-builder.json')
await writeFile(configPath, JSON.stringify(config, null, 2))
await run(process.execPath, [
  'node_modules/electron-builder/cli.js',
  '--mac',
  '--arm64',
  '--dir',
  '--publish',
  'never',
  '--config',
  configPath
])
const app = join(output, 'mac-arm64/Open-Science.app')
const bundleIdentifier = await run(
  'plutil',
  ['-extract', 'CFBundleIdentifier', 'raw', join(app, 'Contents/Info.plist')],
  true
)
if (bundleIdentifier !== config.appId)
  throw new Error(`Unexpected packaged bundle identifier: ${bundleIdentifier}`)
// A changing input (such as a test log) can corrupt later ASAR offsets/content.
const asar = require('@electron/asar')
const asarPath = join(app, 'Contents/Resources/app.asar')
let verifiedAsarFiles = 0
for (const path of asar.listPackage(asarPath)) {
  const name = path.slice(1)
  const entry = asar.statFile(asarPath, name)
  if (entry.files || entry.link || entry.unpacked) continue
  if (
    entry.integrity?.algorithm !== 'SHA256' ||
    digest(asar.extractFile(asarPath, name)) !== entry.integrity.hash
  )
    throw new Error(`ASAR integrity mismatch: ${name}`)
  verifiedAsarFiles += 1
}
JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
for (const file of nativeFiles) {
  await lstat(join(app, 'Contents/Resources/app.asar.unpacked/node_modules/@aipoch', file))
}
await writeFile(
  join(output, 'build-manifest.json'),
  JSON.stringify(
    {
      ...identity,
      app,
      bundleIdentifier,
      verifiedAsarFiles,
      asarSha256: digest(await readFile(join(app, 'Contents/Resources/app.asar'))),
      configuration:
        'electron-builder production config with comparison-only variant bundle identifier; local ad-hoc signing, ICNS fallback, test results and scratch logs excluded',
      completedAt: new Date().toISOString()
    },
    null,
    2
  )
)
console.log(`Packaged comparison artifact: ${app}`)

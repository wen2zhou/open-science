import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClaudeInstallEvent } from '../../shared/settings'
import type { ConnectorSettingsModule } from './connector-settings'
import type { ClaudeDetectDeps } from './claude-detect'
import type { CodexDetectDeps } from './codex-detect'
import type { OpencodeDetectDeps } from './opencode-detect'
import type { ProviderPreflightAccess } from './agent-runtime-manager'
import type { SkillCatalogModule } from './skill-catalog'
import type { BundledSkill } from '../skills/registry'
import { connectorSkillDocsDir } from '../connectors/runtime-settings-projection'
import { SkillRuntimeStateOwner } from '../skills/runtime-state'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/no-such-app-root', isPackaged: false }
}))

const { AgentRuntimeManager } = await import('./agent-runtime-manager')
const { SettingsRepository } = await import('./repository')
const { getAppClaudeConfigDir } = await import('./provider-env')
const { managedClaudeDir } = await import('./managed-claude')
const { managedOpencodeDir } = await import('./managed-opencode')

type Repository = InstanceType<typeof SettingsRepository>
type ManagerOptions = ConstructorParameters<typeof AgentRuntimeManager>[0]

type RuntimeInventory = {
  claude: Map<string, string | undefined>
  opencode: Map<string, string | undefined>
  codexAdapter: Map<string, string | undefined>
  codexNative: Map<string, string | undefined>
}

const createInventory = (): RuntimeInventory => ({
  claude: new Map(),
  opencode: new Map(),
  codexAdapter: new Map(),
  codexNative: new Map()
})

const createClaudeDeps = (inventory: RuntimeInventory): ClaudeDetectDeps => ({
  env: {},
  homePath: '/home',
  platform: 'linux',
  isExecutable: (path) => Promise.resolve(inventory.claude.has(path)),
  getVersion: (path) => Promise.resolve(inventory.claude.get(path)),
  resolveNpmBinDirs: () => Promise.resolve([])
})

const createOpencodeDeps = (inventory: RuntimeInventory): OpencodeDetectDeps => ({
  env: {},
  homePath: '/home',
  platform: 'linux',
  isExecutable: (path) => Promise.resolve(inventory.opencode.has(path)),
  getVersion: (path) => Promise.resolve(inventory.opencode.get(path)),
  resolveNpmBinDirs: () => Promise.resolve([])
})

const createCodexDeps = (
  inventory: RuntimeInventory,
  managedAdapterPath: string,
  managedCodexPath: string
): CodexDetectDeps => ({
  env: {},
  homePath: '/home',
  platform: 'linux',
  isRunnable: (path) => Promise.resolve(inventory.codexAdapter.has(path)),
  getAdapterVersion: (path) => Promise.resolve(inventory.codexAdapter.get(path)),
  getCodexVersion: (path) => Promise.resolve(inventory.codexNative.get(path)),
  smokeInitialize: () => Promise.resolve(true),
  resolveNpmBinDirs: () => Promise.resolve([]),
  managedAdapterPath,
  managedCodexPath
})

const restoreWrites = async (path: string): Promise<void> => {
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata) return
  if (metadata.isDirectory()) {
    await chmod(path, 0o755)
    for (const name of await readdir(path)) await restoreWrites(join(path, name))
  } else if (!metadata.isSymbolicLink()) await chmod(path, 0o644)
}

describe('AgentRuntimeManager', () => {
  let storageRoot: string
  let repository: Repository
  let inventory: RuntimeInventory
  let managedAdapterPath: string
  let managedCodexPath: string
  let provisionClaudeConfig: ReturnType<typeof vi.fn>
  let manager: InstanceType<typeof AgentRuntimeManager>

  const createManager = (
    overrides: Partial<ManagerOptions> = {}
  ): InstanceType<typeof AgentRuntimeManager> => {
    provisionClaudeConfig = vi.fn().mockResolvedValue(undefined)
    const skills = {
      materializeSkills: vi.fn().mockResolvedValue(undefined),
      runtimeProjectionCatalog: vi.fn().mockResolvedValue([]),
      provisionClaudeConfig
    } as unknown as SkillCatalogModule
    const connectors = {
      getConnectors: vi.fn().mockResolvedValue(undefined),
      enabledConnectorIds: vi.fn().mockReturnValue([]),
      materializedCustomSkillNames: vi.fn().mockReturnValue([])
    } as unknown as ConnectorSettingsModule

    return new AgentRuntimeManager({
      repository,
      storageRoot,
      userClaudeDir: join(storageRoot, 'user-claude'),
      skills,
      connectors,
      allocateSettingsIdSequence: vi.fn().mockReturnValue(1),
      detectDeps: createClaudeDeps(inventory),
      opencodeDetectDeps: createOpencodeDeps(inventory),
      codexDetectDeps: createCodexDeps(inventory, managedAdapterPath, managedCodexPath),
      allocateOpenCodeUsagePort: () => Promise.resolve(42_424),
      installManagedClaudeImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'not configured' }
      }),
      installManagedOpencodeImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'not configured' }
      }),
      installManagedCodexImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'not configured' }
      }),
      resolveCodexProxyEnvironment: () => Promise.resolve(undefined),
      ...overrides
    })
  }

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-runtime-manager-'))
    repository = new SettingsRepository(storageRoot)
    inventory = createInventory()
    managedAdapterPath = join(storageRoot, 'codex-managed', 'adapter', 'dist', 'index.js')
    managedCodexPath = join(storageRoot, 'codex-managed', 'codex', 'bin', 'codex')
    manager = createManager()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await restoreWrites(storageRoot)
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('reclaims prior-process Skill runtime candidates during explicit app startup reconciliation', async () => {
    const projectionRoot = join(storageRoot, 'skill-runtime', 'projection')
    const crashedCandidate = join(projectionRoot, '.candidate-crashed')
    const crashedDiscovery = join(projectionRoot, 'discovery', 'crashed-binding')
    await mkdir(crashedCandidate, { recursive: true })
    await mkdir(crashedDiscovery, { recursive: true })
    await writeFile(join(crashedCandidate, 'partial'), 'partial')

    await manager.reconcileSkillRuntime()
    await manager.reconcileSkillRuntime()

    await expect(stat(crashedCandidate)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(crashedDiscovery)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows startup Skill runtime reconciliation to retry after a transient cleanup failure', async () => {
    const projectionRoot = join(storageRoot, 'skill-runtime', 'projection')
    const crashedCandidate = join(projectionRoot, '.candidate-crashed')
    await mkdir(crashedCandidate, { recursive: true })
    await chmod(projectionRoot, 0o555)

    await expect(manager.reconcileSkillRuntime()).rejects.toMatchObject({ code: 'EACCES' })
    await chmod(projectionRoot, 0o755)
    await manager.reconcileSkillRuntime()

    await expect(stat(crashedCandidate)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('persists successful detection for all three runtime storage shapes', async () => {
    // The injected detector platform is Linux, so keep these virtual inventory paths POSIX on every
    // host. Using the host path helpers makes the Windows keys disagree with the detector probes.
    const claudePath = posix.join('/detected', 'claude')
    const opencodePath = posix.join('/detected', 'opencode')
    inventory.claude.set(claudePath, '2.1.0')
    inventory.opencode.set(opencodePath, '1.19.0')
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.1.4')
    inventory.codexNative.set(managedCodexPath, 'codex-cli 0.144.6')
    manager = createManager({
      detectDeps: { ...createClaudeDeps(inventory), env: { PATH: posix.dirname(claudePath) } },
      opencodeDetectDeps: {
        ...createOpencodeDeps(inventory),
        env: { PATH: posix.dirname(opencodePath) }
      }
    })

    await manager.detectClaude()
    await manager.detectOpencode()
    await manager.detectCodex()

    expect(await repository.getSettings()).toMatchObject({
      claude: { resolvedPath: claudePath, version: '2.1.0' },
      opencodePath,
      opencodeVersion: '1.19.0',
      codex: {
        resolvedPath: managedAdapterPath,
        version: '1.1.4',
        nativePath: managedCodexPath,
        nativeVersion: '0.144.6'
      }
    })
  })

  it('preserves cached runtime records when live detection misses but their paths still exist', async () => {
    const claudePath = join(storageRoot, 'cached', 'claude')
    const opencodePath = join(storageRoot, 'cached', 'opencode')
    await mkdir(dirname(claudePath), { recursive: true })
    for (const path of [claudePath, opencodePath, managedAdapterPath]) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '#!/bin/sh\n')
      await chmod(path, 0o755)
    }
    await repository.setClaudeInfo({ resolvedPath: claudePath, version: 'cached-claude' })
    await repository.setOpencodeInfo(opencodePath, 'cached-opencode')
    await repository.setCodexInfo({
      resolvedPath: managedAdapterPath,
      version: 'cached-adapter',
      nativePath: managedCodexPath,
      nativeVersion: 'cached-native'
    })

    await manager.detectClaude()
    await manager.detectOpencode()
    await manager.detectCodex()

    expect(await repository.getSettings()).toMatchObject({
      claude: { resolvedPath: claudePath, version: 'cached-claude' },
      opencodePath,
      opencodeVersion: 'cached-opencode',
      codex: { resolvedPath: managedAdapterPath, version: 'cached-adapter' }
    })
  })

  it('computes selected-runtime preflight through the narrow provider access interface', async () => {
    const opencodePath = join(storageRoot, 'bin', 'opencode')
    inventory.opencode.set(opencodePath, '1.19.0')
    await repository.setOpencodeInfo(opencodePath, '1.19.0')
    await repository.setAgentFramework('opencode')
    await repository.upsertProvider({
      id: 'provider-a',
      type: 'custom',
      name: 'Provider A',
      model: 'model-a',
      apiEndpoints: ['openai'],
      keyRef: 'encrypted-key',
      lastValidatedAt: 10
    })
    await repository.setActiveProvider('provider-a', 'model-a')
    const providers: ProviderPreflightAccess = {
      resolveProviderApiEndpoints: vi.fn().mockReturnValue(['openai']),
      resolveActiveModel: vi.fn().mockReturnValue('model-a'),
      isProviderKeyUsable: vi.fn().mockResolvedValue(true)
    }

    const result = await manager.getPreflight(providers)
    const storedProvider = (await repository.getSettings()).providers[0]

    expect(result).toMatchObject({
      agentFrameworkId: 'opencode',
      opencodeReady: true,
      activeProviderReady: true,
      agentReady: true
    })
    expect(providers.resolveProviderApiEndpoints).toHaveBeenCalledWith(storedProvider, 'model-a')
    expect(providers.isProviderKeyUsable).toHaveBeenCalledWith(storedProvider)
  })

  it('uses the shared allocator and forwards the same event sink through managed installs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123)
    const allocateSettingsIdSequence = vi
      .fn<() => number>()
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(12)
      .mockReturnValueOnce(13)
    const onEvent = vi.fn<(event: ClaudeInstallEvent) => void>()
    const installManagedClaudeImpl: NonNullable<ManagerOptions['installManagedClaudeImpl']> = vi.fn(
      async (options) => {
        options.onEvent({
          kind: 'log',
          installId: options.installId,
          stream: 'system',
          chunk: 'claude\n'
        })
        return {
          result: { installId: options.installId, ok: true },
          resolvedPath: join(storageRoot, 'installed', 'claude'),
          version: '2.1.0'
        }
      }
    )
    const installManagedOpencodeImpl: NonNullable<ManagerOptions['installManagedOpencodeImpl']> =
      vi.fn(async (options) => {
        options.onEvent({
          kind: 'log',
          installId: options.installId,
          stream: 'system',
          chunk: 'opencode\n'
        })
        return {
          result: { installId: options.installId, ok: true },
          resolvedPath: join(storageRoot, 'installed', 'opencode'),
          version: '1.19.0'
        }
      })
    const installManagedCodexImpl: NonNullable<ManagerOptions['installManagedCodexImpl']> = vi.fn(
      async (options) => {
        options.onEvent({
          kind: 'log',
          installId: options.installId,
          stream: 'system',
          chunk: 'codex\n'
        })
        return {
          result: { installId: options.installId, ok: true },
          adapterPath: managedAdapterPath,
          adapterVersion: '1.1.4',
          codexPath: managedCodexPath,
          codexVersion: '0.144.6'
        }
      }
    )
    const claudePath = join(storageRoot, 'installed', 'claude')
    inventory.claude.set(claudePath, '2.1.0')
    manager = createManager({
      allocateSettingsIdSequence,
      installManagedClaudeImpl,
      installManagedOpencodeImpl,
      installManagedCodexImpl
    })

    const results = await Promise.all([
      manager.installClaude({ source: 'managed' }, onEvent),
      manager.installOpencode({ source: 'managed' }, onEvent),
      manager.installCodex({ source: 'managed' }, onEvent)
    ])

    expect(results.map((result) => result.installId)).toEqual([
      'install-123-11',
      'install-opencode-123-12',
      'install-codex-123-13'
    ])
    expect(allocateSettingsIdSequence).toHaveBeenCalledTimes(3)
    for (const installer of [
      installManagedClaudeImpl,
      installManagedOpencodeImpl,
      installManagedCodexImpl
    ]) {
      expect(installer).toHaveBeenCalledWith(expect.objectContaining({ onEvent }))
    }
    expect(onEvent.mock.calls.map(([event]) => event.installId)).toEqual([
      'install-123-11',
      'install-opencode-123-12',
      'install-codex-123-13'
    ])
  })

  it('fails a managed Claude install whose installed executable cannot report a version', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(321)
    const installedPath = join(storageRoot, 'installed', 'claude')
    const onEvent = vi.fn<(event: ClaudeInstallEvent) => void>()
    manager = createManager({
      installManagedClaudeImpl: async ({ installId }) => ({
        result: { installId, ok: true },
        resolvedPath: installedPath,
        version: 'claimed-version'
      })
    })

    const result = await manager.installClaude({ source: 'managed' }, onEvent)

    expect(result).toEqual({
      installId: 'install-321-1',
      ok: false,
      error:
        'The installed Claude runtime could not report its version. It may be incompatible or incomplete. Delete it and install again.'
    })
    expect((await repository.getSettings()).claude).toBeUndefined()
    expect(onEvent).toHaveBeenCalledWith({
      kind: 'log',
      installId: 'install-321-1',
      stream: 'system',
      chunk:
        'The installed Claude runtime could not report its version. It may be incompatible or incomplete. Delete it and install again.\n'
    })
  })

  it('guards unmanaged uninstall and selects the first actually runnable fallback', async () => {
    const unmanagedClaude = join(storageRoot, 'external', 'claude')
    await repository.setClaudeInfo({ resolvedPath: unmanagedClaude, version: '2.1.0' })

    await expect(manager.uninstallClaude()).resolves.toEqual({ activeBackendAffected: false })
    expect((await repository.getSettings()).claude?.resolvedPath).toBe(unmanagedClaude)

    const opencodePath = join(managedOpencodeDir(storageRoot), 'opencode')
    await mkdir(dirname(opencodePath), { recursive: true })
    await writeFile(opencodePath, '#!/bin/sh\n')
    await chmod(opencodePath, 0o755)
    await repository.setOpencodeInfo(opencodePath, '1.19.0')
    await repository.setCodexInfo({
      resolvedPath: managedAdapterPath,
      version: '1.1.4',
      nativePath: managedCodexPath,
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('opencode')
    inventory.codexAdapter.set(managedAdapterPath, 'codex-acp 1.1.4')
    // The stored Claude path exists as a candidate but cannot report a version, so it is not ready.
    inventory.claude.set(unmanagedClaude, undefined)

    await expect(manager.uninstallOpencode()).resolves.toEqual({ activeBackendAffected: true })

    expect(await repository.getSettings()).toMatchObject({
      agentFrameworkId: 'codex',
      claude: { resolvedPath: unmanagedClaude },
      codex: { resolvedPath: managedAdapterPath }
    })
    expect((await repository.getSettings()).opencodePath).toBeUndefined()
  })

  it('provisions the runtime and preserves the shared versus isolated Claude probe contracts', async () => {
    const executeClaudeProbe = vi.fn().mockResolvedValue(undefined)
    manager = createManager({ executeClaudeProbe })
    const executablePath = join(storageRoot, 'bin', 'claude')
    await repository.setClaudeInfo({ resolvedPath: executablePath, version: '2.1.0' })
    const settings = await repository.getSettings()

    await expect(
      manager.runClaudeSubscriptionProbe(
        { type: 'claude-shared', model: 'claude-sonnet' },
        settings
      )
    ).resolves.toEqual({ ok: true, category: 'ok' })
    await expect(
      manager.runClaudeSubscriptionProbe(
        { type: 'claude-isolated', model: 'claude-sonnet', key: 'setup-token' },
        settings
      )
    ).resolves.toEqual({ ok: true, category: 'ok' })

    const configDir = getAppClaudeConfigDir(storageRoot)
    expect(provisionClaudeConfig).toHaveBeenCalledTimes(2)
    expect(executeClaudeProbe).toHaveBeenNthCalledWith(
      1,
      executablePath,
      expect.objectContaining({ CLAUDE_CONFIG_DIR: join(storageRoot, 'user-claude') }),
      ['--settings', join(configDir, 'settings.json'), '--plugin-dir', configDir]
    )
    expect(executeClaudeProbe).toHaveBeenNthCalledWith(
      2,
      executablePath,
      expect.objectContaining({
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_OAUTH_TOKEN: 'setup-token'
      })
    )
  })

  it('synchronizes the Compute host projection after each Skill provisioning path', async () => {
    const syncComputeSkillDocument = vi.fn().mockResolvedValue(undefined)
    manager = createManager({ syncComputeSkillDocument })
    const settings = await repository.getSettings()
    const agentRoot = join(storageRoot, 'codex')

    await manager.materializeAgentSkills(settings, agentRoot, new Set())
    await manager.provisionClaudeRuntimeConfig(settings)

    expect(syncComputeSkillDocument).toHaveBeenCalledWith(join(agentRoot, 'skills'))
    expect(syncComputeSkillDocument).toHaveBeenCalledTimes(1)
  })

  it('acquires one immutable complete projection across package, Connector, and Compute sources', async () => {
    const packageRoot = join(storageRoot, 'packages')
    const demoRoot = join(packageRoot, 'demo')
    const internalRoot = join(packageRoot, 'internal')
    const computeRoot = join(packageRoot, 'compute')
    await Promise.all([
      mkdir(join(demoRoot, 'references'), { recursive: true }),
      mkdir(join(demoRoot, 'scripts'), { recursive: true }),
      mkdir(internalRoot, { recursive: true }),
      mkdir(computeRoot, { recursive: true })
    ])
    await Promise.all([
      writeFile(join(demoRoot, 'SKILL.md'), '---\nname: demo\ndescription: Demo.\n---\n'),
      writeFile(join(demoRoot, 'references', 'guide.md'), '# Guide\n'),
      writeFile(join(demoRoot, 'scripts', 'run.py'), 'print("ok")\n'),
      writeFile(
        join(internalRoot, 'SKILL.md'),
        '---\nname: internal-helper\ndescription: Internal.\n---\n'
      ),
      writeFile(
        join(computeRoot, 'SKILL.md'),
        [
          '---',
          'name: remote-compute-ssh',
          'description: Compute.',
          '---',
          '',
          '## Registered hosts',
          '',
          '<!-- open-science:compute-hosts:start -->',
          'old',
          '<!-- open-science:compute-hosts:end -->'
        ].join('\n')
      )
    ])
    await chmod(join(demoRoot, 'scripts', 'run.py'), 0o755)

    const customRoot = join(connectorSkillDocsDir(storageRoot), 'mcp-custom')
    await mkdir(customRoot, { recursive: true })
    await writeFile(
      join(customRoot, 'SKILL.md'),
      '---\nname: mcp-custom\ndescription: Custom connector.\nsource: connector\n---\n'
    )
    const skills = {
      runtimeProjectionCatalog: vi.fn().mockResolvedValue([
        {
          id: 'demo',
          name: 'demo',
          displayName: 'Demo',
          description: 'Demo.',
          source: 'featured',
          updatedAt: '2026-01-01',
          compatibility: 'sha256:demo',
          sourceDir: demoRoot
        },
        {
          id: 'internal-helper',
          name: 'internal-helper',
          displayName: 'Internal',
          description: 'Internal.',
          source: 'featured',
          exposure: 'internal',
          updatedAt: '2026-01-01',
          compatibility: 'sha256:internal',
          sourceDir: internalRoot
        },
        {
          id: 'remote-compute-ssh',
          name: 'remote-compute-ssh',
          displayName: 'Compute',
          description: 'Compute.',
          source: 'featured',
          updatedAt: '2026-01-01',
          compatibility: 'sha256:compute',
          sourceDir: computeRoot
        }
      ])
    } as unknown as SkillCatalogModule
    const connectors = {
      enabledConnectorIds: vi.fn().mockReturnValue(['chemistry']),
      materializedCustomSkillNames: vi.fn().mockReturnValue(['mcp-custom'])
    } as unknown as ConnectorSettingsModule
    manager = createManager({
      skills,
      connectors,
      readComputeHosts: vi.fn().mockResolvedValue([
        {
          id: 'host-1',
          providerId: 'ssh:cluster',
          displayName: 'Cluster',
          shape: 'scheduler_cluster',
          probeResult: undefined
        }
      ])
    })
    await repository.setSkillEnabled('demo', false)

    const ordinary = await manager.acquireSkillRuntimeBinding(
      await repository.getSettings(),
      new Set()
    )
    if (!ordinary) throw new Error('expected ordinary Skill runtime binding')
    expect(ordinary.descriptors.map((descriptor) => descriptor.name).sort()).toEqual([
      'internal-helper',
      'mcp-chemistry',
      'mcp-custom',
      'remote-compute-ssh'
    ])
    expect((await readdir(ordinary.discoveryRoot)).sort()).toEqual([
      'mcp-chemistry',
      'mcp-custom',
      'os-internal-helper',
      'os-remote-compute-ssh'
    ])
    await expect(
      readFile(join(ordinary.skillsRoot, 'os-demo', 'references', 'guide.md'), 'utf8')
    ).resolves.toBe('# Guide\n')
    expect(
      (await stat(join(ordinary.skillsRoot, 'os-demo', 'scripts', 'run.py'))).mode & 0o111
    ).toBe(0o111)
    await expect(
      readFile(join(ordinary.skillsRoot, 'os-remote-compute-ssh', 'SKILL.md'), 'utf8')
    ).resolves.toContain('ssh:cluster')
    expect(ordinary.environment).toMatchObject({
      TMPDIR: expect.stringContaining('attempts'),
      PYTHONPYCACHEPREFIX: expect.stringContaining('python'),
      R_LIBS_USER: expect.stringContaining('r')
    })
    const temporaryRoot = ordinary.environment.TMPDIR
    const discoveryRoot = ordinary.discoveryRoot
    await ordinary.release()
    await expect(stat(temporaryRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(discoveryRoot)).rejects.toMatchObject({ code: 'ENOENT' })

    const forced = await manager.acquireSkillRuntimeBinding(
      await repository.getSettings(),
      new Set(['demo'])
    )
    if (!forced) throw new Error('expected forced Skill runtime binding')
    expect(forced.descriptors.map((descriptor) => descriptor.name)).toContain('demo')
    expect(await readdir(forced.discoveryRoot)).toContain('os-demo')
    expect(forced.generationRoot).toBe(ordinary.generationRoot)
    await forced.release()

    const exact = await manager.acquireSkillRuntimeBinding(await repository.getSettings(), {
      kind: 'exact',
      allowedSkillIds: ['demo']
    })
    if (!exact) throw new Error('expected exact Skill runtime binding')
    expect(exact.descriptors.map((descriptor) => descriptor.id)).toEqual(['demo'])
    expect(await readdir(exact.discoveryRoot)).toEqual(['os-demo'])
    expect(exact.generationRoot).toBe(ordinary.generationRoot)
    await exact.release()
  })

  it('keeps unrelated Main Skills available when installed packages share an invocation name', async () => {
    const packageRoot = join(storageRoot, 'packages', 'invocation-collision')
    const internalRoot = join(packageRoot, 'internal')
    const importedRoot = join(packageRoot, 'imported')
    const unrelatedRoot = join(packageRoot, 'unrelated')
    await Promise.all(
      [internalRoot, importedRoot, unrelatedRoot].map((root) => mkdir(root, { recursive: true }))
    )
    await Promise.all([
      writeFile(
        join(internalRoot, 'SKILL.md'),
        '---\nname: skill-creator\ndescription: Internal creator.\n---\n'
      ),
      writeFile(
        join(importedRoot, 'SKILL.md'),
        '---\nname: skill-creator\ndescription: Imported creator.\n---\n'
      ),
      writeFile(
        join(unrelatedRoot, 'SKILL.md'),
        '---\nname: literature-search\ndescription: Search literature.\n---\n'
      )
    ])
    const skill = (
      id: string,
      name: string,
      sourceDir: string,
      exposure?: 'internal'
    ): BundledSkill => ({
      id,
      name,
      displayName: name,
      description: `${name}.`,
      source: id === 'skill-creator' ? ('featured' as const) : ('imported' as const),
      updatedAt: '2026-08-13',
      sourceDir,
      ...(exposure ? { exposure } : {})
    })
    manager = createManager({
      skills: {
        runtimeProjectionCatalog: vi
          .fn()
          .mockResolvedValue([
            skill('skill-creator', 'skill-creator', internalRoot, 'internal'),
            skill('imported-skill-creator', 'skill-creator', importedRoot),
            skill('imported-literature-search', 'literature-search', unrelatedRoot)
          ])
      } as unknown as SkillCatalogModule
    })

    const ordinary = await manager.acquireSkillRuntimeBinding(await repository.getSettings())
    if (!ordinary) throw new Error('expected a degraded-but-usable Main Skill binding')

    expect(ordinary.descriptors.map(({ id }) => id)).toEqual(['imported-literature-search'])
    expect((await readdir(ordinary.skillsRoot)).sort()).toEqual([
      'os-imported-literature-search',
      'os-imported-skill-creator',
      'os-skill-creator'
    ])
    await ordinary.release()

    const forced = await manager.acquireSkillRuntimeBinding(await repository.getSettings(), {
      kind: 'main',
      forcedSkillIds: ['imported-skill-creator']
    })
    expect(forced?.descriptors.map(({ id }) => id)).toEqual([
      'imported-literature-search',
      'imported-skill-creator'
    ])
    await forced?.release()

    const exact = await manager.acquireSkillRuntimeBinding(await repository.getSettings(), {
      kind: 'exact',
      allowedSkillIds: ['skill-creator']
    })
    expect(exact?.descriptors.map(({ id }) => id)).toEqual(['skill-creator'])
    await exact?.release()

    await expect(
      manager.acquireSkillRuntimeBinding(await repository.getSettings(), {
        kind: 'exact',
        allowedSkillIds: ['skill-creator', 'imported-skill-creator']
      })
    ).rejects.toThrow(/invocation name collision/i)

    await repository.setSkillEnabled('imported-skill-creator', false)
    const withoutImported = await manager.acquireSkillRuntimeBinding(await repository.getSettings())
    expect(withoutImported?.descriptors.map(({ id }) => id)).toEqual([
      'imported-literature-search',
      'skill-creator'
    ])
    await withoutImported?.release()
  })

  it('resolves Main invocation collisions from the last-good manifest', async () => {
    const firstRoot = join(storageRoot, 'packages', 'last-good-first')
    const secondRoot = join(storageRoot, 'packages', 'last-good-second')
    await Promise.all([firstRoot, secondRoot].map((root) => mkdir(root, { recursive: true })))
    await Promise.all([
      writeFile(join(firstRoot, 'SKILL.md'), '# First'),
      writeFile(join(secondRoot, 'SKILL.md'), '# Second')
    ])
    const catalog = [
      {
        id: 'first',
        name: 'first',
        displayName: 'First',
        description: 'First.',
        source: 'personal' as const,
        updatedAt: '2026-08-13',
        sourceDir: firstRoot
      },
      {
        id: 'second',
        name: 'second',
        displayName: 'Second',
        description: 'Second.',
        source: 'personal' as const,
        updatedAt: '2026-08-13',
        sourceDir: secondRoot
      }
    ]
    manager = createManager({
      skills: {
        runtimeProjectionCatalog: vi.fn().mockImplementation(() => Promise.resolve(catalog))
      } as unknown as SkillCatalogModule
    })
    const first = await manager.acquireSkillRuntimeBinding(await repository.getSettings())
    if (!first) throw new Error('expected last-good collision fixture')
    await first.release()

    catalog[0].name = 'catalog-only-collision'
    catalog[1].name = 'catalog-only-collision'
    await rm(secondRoot, { recursive: true, force: true })
    const recovered = await manager.acquireSkillRuntimeBinding(await repository.getSettings())

    expect(recovered?.generationId).toBe(first.generationId)
    expect(recovered?.descriptors.map(({ id }) => id)).toEqual(['first', 'second'])
    await recovered?.release()
  })

  it('skips projection and state ownership for a no-Skill binding policy', async () => {
    const runtimeProjectionCatalog = vi.fn().mockRejectedValue(new Error('must not be read'))
    manager = createManager({
      skills: { runtimeProjectionCatalog } as unknown as SkillCatalogModule
    })

    await expect(
      manager.acquireSkillRuntimeBinding(await repository.getSettings(), { kind: 'none' })
    ).resolves.toBeUndefined()
    expect(runtimeProjectionCatalog).not.toHaveBeenCalled()
  })

  it('rejects a stale exact Skill authorization before provider execution', async () => {
    manager = createManager()

    await expect(
      manager.acquireSkillRuntimeBinding(await repository.getSettings(), {
        kind: 'exact',
        allowedSkillIds: ['removed-specialist-skill']
      })
    ).rejects.toThrow('Authorized Skill is unavailable: removed-specialist-skill')
  })

  it('rejects an exact binding when publication fails before its Skill reaches last-good', async () => {
    const existingRoot = join(storageRoot, 'packages', 'existing-exact')
    const unavailableRoot = join(storageRoot, 'packages', 'unavailable-exact')
    await mkdir(existingRoot, { recursive: true })
    await writeFile(join(existingRoot, 'SKILL.md'), '# Existing exact')
    const catalog = [
      {
        id: 'existing-exact',
        name: 'existing-exact',
        displayName: 'Existing exact',
        description: 'Existing exact.',
        source: 'personal' as const,
        updatedAt: '2026-01-01',
        compatibility: 'sha256:existing-exact',
        sourceDir: existingRoot
      }
    ]
    const skills = {
      runtimeProjectionCatalog: vi.fn().mockImplementation(() => Promise.resolve(catalog))
    } as unknown as SkillCatalogModule
    manager = createManager({ skills })
    const first = await manager.acquireSkillRuntimeBinding(await repository.getSettings())
    if (!first) throw new Error('expected last-good exact Skill fixture')
    await first.release()
    catalog.push({
      id: 'unavailable-exact',
      name: 'unavailable-exact',
      displayName: 'Unavailable exact',
      description: 'Unavailable exact.',
      source: 'personal',
      updatedAt: '2026-01-01',
      compatibility: 'sha256:unavailable-exact',
      sourceDir: unavailableRoot
    })

    await expect(
      manager.acquireSkillRuntimeBinding(await repository.getSettings(), {
        kind: 'exact',
        allowedSkillIds: ['unavailable-exact']
      })
    ).rejects.toThrow(
      'Authorized Skill is unavailable in the current projection: unavailable-exact'
    )
  })

  it('degrades to no Skill exposure when first publication has no valid generation', async () => {
    const incompleteRoot = join(storageRoot, 'packages', 'incomplete')
    await mkdir(incompleteRoot, { recursive: true })
    await writeFile(join(incompleteRoot, 'reference.md'), 'missing entrypoint')
    const skills = {
      runtimeProjectionCatalog: vi.fn().mockResolvedValue([
        {
          id: 'incomplete',
          name: 'incomplete',
          displayName: 'Incomplete',
          description: 'Incomplete.',
          source: 'personal',
          updatedAt: '2026-01-01',
          compatibility: 'sha256:incomplete',
          sourceDir: incompleteRoot
        }
      ])
    } as unknown as SkillCatalogModule
    manager = createManager({ skills })

    await expect(
      manager.acquireSkillRuntimeBinding(await repository.getSettings())
    ).resolves.toBeUndefined()
  })

  it('degrades to no Skill exposure when the projection catalog cannot be read', async () => {
    const skills = {
      runtimeProjectionCatalog: vi.fn().mockRejectedValue(new Error('catalog unavailable'))
    } as unknown as SkillCatalogModule
    manager = createManager({ skills })

    await expect(
      manager.acquireSkillRuntimeBinding(await repository.getSettings())
    ).resolves.toBeUndefined()
  })

  it('rejects an exact binding when the projection catalog cannot be read', async () => {
    const skills = {
      runtimeProjectionCatalog: vi.fn().mockRejectedValue(new Error('exact catalog unavailable'))
    } as unknown as SkillCatalogModule
    manager = createManager({ skills })

    await expect(
      manager.acquireSkillRuntimeBinding(await repository.getSettings(), {
        kind: 'exact',
        allowedSkillIds: []
      })
    ).rejects.toThrow('exact catalog unavailable')
  })

  it('does not expose a last-good generation when its authorization catalog cannot be read', async () => {
    const sourceRoot = join(storageRoot, 'packages', 'catalog-recoverable')
    await mkdir(sourceRoot, { recursive: true })
    await writeFile(join(sourceRoot, 'SKILL.md'), '# Catalog recoverable')
    const skills = {
      runtimeProjectionCatalog: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'catalog-recoverable',
            name: 'catalog-recoverable',
            displayName: 'Catalog recoverable',
            description: 'Catalog recoverable.',
            source: 'personal',
            updatedAt: '2026-01-01',
            compatibility: 'sha256:catalog-recoverable',
            sourceDir: sourceRoot
          }
        ])
        .mockRejectedValue(new Error('catalog unavailable'))
    } as unknown as SkillCatalogModule
    manager = createManager({ skills })
    const first = await manager.acquireSkillRuntimeBinding(await repository.getSettings())
    if (!first) throw new Error('expected last-good Skill runtime fixture')
    await first.release()

    await expect(
      manager.acquireSkillRuntimeBinding(await repository.getSettings())
    ).resolves.toBeUndefined()
  })

  it('uses a last-good generation when a later source cannot be read', async () => {
    const sourceRoot = join(storageRoot, 'packages', 'recoverable')
    await mkdir(sourceRoot, { recursive: true })
    await writeFile(join(sourceRoot, 'SKILL.md'), '# Recoverable')
    const skills = {
      runtimeProjectionCatalog: vi.fn().mockResolvedValue([
        {
          id: 'recoverable',
          name: 'recoverable',
          displayName: 'Recoverable',
          description: 'Recoverable.',
          source: 'personal',
          updatedAt: '2026-01-01',
          compatibility: 'sha256:recoverable',
          sourceDir: sourceRoot
        }
      ])
    } as unknown as SkillCatalogModule
    manager = createManager({ skills })
    const first = await manager.acquireSkillRuntimeBinding(await repository.getSettings())
    if (!first) throw new Error('expected last-good Skill runtime fixture')
    await first.release()
    await rm(sourceRoot, { recursive: true, force: true })

    const recovered = await manager.acquireSkillRuntimeBinding(await repository.getSettings())

    expect(recovered?.generationId).toBe(first.generationId)
    expect(recovered?.descriptors.map(({ id }) => id)).toEqual(['recoverable'])
    await recovered?.release()
  })

  it('does not infer generated Skill authorization when current projection inputs fail', async () => {
    const sourceRoot = join(storageRoot, 'packages', 'recoverable-with-connector')
    await mkdir(sourceRoot, { recursive: true })
    await writeFile(join(sourceRoot, 'SKILL.md'), '# Recoverable with connector')
    const skills = {
      runtimeProjectionCatalog: vi.fn().mockResolvedValue([
        {
          id: 'recoverable-with-connector',
          name: 'recoverable-with-connector',
          displayName: 'Recoverable with connector',
          description: 'Recoverable with connector.',
          source: 'personal',
          updatedAt: '2026-01-01',
          compatibility: 'sha256:recoverable-with-connector',
          sourceDir: sourceRoot
        }
      ])
    } as unknown as SkillCatalogModule
    const connectors = {
      enabledConnectorIds: vi.fn().mockReturnValue(['chemistry']),
      materializedCustomSkillNames: vi.fn().mockReturnValue([])
    } as unknown as ConnectorSettingsModule
    manager = createManager({ skills, connectors })
    const first = await manager.acquireSkillRuntimeBinding(await repository.getSettings())
    if (!first) throw new Error('expected last-good generated Skill fixture')
    expect(first.descriptors.map(({ id }) => id)).toContain('mcp-chemistry')
    await first.release()
    await rm(sourceRoot, { recursive: true, force: true })

    const recovered = await manager.acquireSkillRuntimeBinding(await repository.getSettings())

    expect(recovered?.generationId).toBe(first.generationId)
    expect(recovered?.descriptors.map(({ id }) => id)).toEqual(['recoverable-with-connector'])
    await recovered?.release()
  })

  it('degrades to no Skill exposure when writable runtime state cannot be allocated', async () => {
    const acquireState = vi
      .spyOn(SkillRuntimeStateOwner.prototype, 'acquire')
      .mockRejectedValueOnce(new Error('state unavailable'))
    manager = createManager()

    await expect(
      manager.acquireSkillRuntimeBinding(await repository.getSettings())
    ).resolves.toBeUndefined()
    expect(acquireState).toHaveBeenCalledOnce()
  })

  it('rejects an exact binding when writable runtime state cannot be allocated', async () => {
    vi.spyOn(SkillRuntimeStateOwner.prototype, 'acquire').mockRejectedValueOnce(
      new Error('exact state unavailable')
    )
    manager = createManager()

    await expect(
      manager.acquireSkillRuntimeBinding(await repository.getSettings(), {
        kind: 'exact',
        allowedSkillIds: []
      })
    ).rejects.toThrow('exact state unavailable')
  })

  it('synchronizes provisioned custom Connector docs into isolated agent Skill roots', async () => {
    const customSkillName = 'mcp-xt'
    const sourceDir = join(connectorSkillDocsDir(storageRoot), customSkillName)
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      join(sourceDir, 'SKILL.md'),
      '---\nname: mcp-xt\ndescription: Use XT records.\nsource: connector\n---\n\n# XT\n',
      'utf8'
    )
    let materialized = [customSkillName]
    const connectors = {
      getConnectors: vi.fn().mockResolvedValue(undefined),
      enabledConnectorIds: vi.fn().mockReturnValue([]),
      materializedCustomSkillNames: vi.fn(() => materialized)
    } as unknown as ConnectorSettingsModule
    manager = createManager({ connectors })
    const agentRoot = join(storageRoot, 'isolated-agent')
    const targetFile = join(agentRoot, 'skills', customSkillName, 'SKILL.md')

    await expect(
      manager.materializeAgentSkills(await repository.getSettings(), agentRoot, new Set())
    ).resolves.toEqual([customSkillName])
    await expect(readFile(targetFile, 'utf8')).resolves.toContain('Use XT records.')

    materialized = []
    await expect(
      manager.materializeAgentSkills(await repository.getSettings(), agentRoot, new Set())
    ).resolves.toEqual([])
    await expect(readFile(targetFile, 'utf8')).rejects.toThrow()
  })

  it.each([
    {
      name: 'timeout',
      error: Object.assign(new Error('timed out'), { killed: true }),
      result: {
        ok: false,
        category: 'timeout',
        message: 'Claude token validation timed out. Try again.'
      }
    },
    {
      name: 'authentication rejection',
      error: Object.assign(new Error('request failed'), { stderr: 'HTTP 401 unauthorized' }),
      result: {
        ok: false,
        category: 'auth',
        message:
          'Claude rejected the setup token. Run `claude setup-token` again and paste a new token.'
      }
    },
    {
      name: 'network failure',
      error: Object.assign(new Error('fetch failed'), { code: 'ENETUNREACH' }),
      result: {
        ok: false,
        category: 'network',
        message:
          'Claude could not reach Anthropic while validating the token. Check your network and try again.'
      }
    }
  ])(
    'classifies an isolated Claude $name without mutating provider state',
    async ({ error, result }) => {
      manager = createManager({ executeClaudeProbe: vi.fn().mockRejectedValue(error) })
      await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })

      await expect(
        manager.runClaudeSubscriptionProbe(
          { type: 'claude-isolated', key: 'setup-token' },
          await repository.getSettings()
        )
      ).resolves.toEqual(result)
      expect((await repository.getSettings()).providers).toEqual([])
    }
  )

  it('uses the managed Claude directory shape expected by the uninstall ownership guard', () => {
    expect(
      manager.isManagedRuntimePath('claude-code', join(managedClaudeDir(storageRoot), 'claude'))
    ).toBe(true)
    expect(
      manager.isManagedRuntimePath('claude-code', join(storageRoot, 'external', 'claude'))
    ).toBe(false)
  })

  it('owns materialization of framework-generated runtime config files', async () => {
    const configPath = join(storageRoot, 'runtime-config', 'agent.json')

    await manager.materializeAgentConfigFiles([
      { path: configPath, content: '{"runtime":"managed"}\n' }
    ])

    await expect(readFile(configPath, 'utf8')).resolves.toBe('{"runtime":"managed"}\n')
  })
})

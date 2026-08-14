import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { execFile, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { AgentSkillRuntime } from './agent-skill-runtime'

const temporaryRoots: string[] = []
const execFileAsync = promisify(execFile)
const hasPython = spawnSync('python3', ['--version']).status === 0
const hasRscript = spawnSync('Rscript', ['--version']).status === 0
const supportsNodeCompileCache = Number(process.versions.node.split('.')[0]) >= 22

const temporaryRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

const makeTreeWritable = async (directory: string): Promise<void> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory()) await makeTreeWritable(join(directory, entry.name))
  }
  await chmod(directory, 0o755).catch(() => undefined)
}

const listTree = async (directory: string): Promise<string[]> => {
  const paths = [directory]
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name)
    paths.push(...(entry.isDirectory() ? await listTree(child) : [child]))
  }
  return paths
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await makeTreeWritable(root)
      await rm(root, { recursive: true, force: true })
    })
  )
})

describe('AgentSkillRuntime', () => {
  it('acquires a complete agent-facing package through the runtime lease', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const sourceRoot = await temporaryRoot('agent-skill-source-')
    await mkdir(join(sourceRoot, 'references'), { recursive: true })
    await mkdir(join(sourceRoot, 'assets'), { recursive: true })
    await mkdir(join(sourceRoot, 'scripts'), { recursive: true })
    await writeFile(
      join(sourceRoot, 'SKILL.md'),
      '---\nname: paper-review\ndescription: Review a paper.\n---\nUse the package resources.\n'
    )
    await writeFile(join(sourceRoot, 'references', 'method.md'), 'reference')
    await writeFile(join(sourceRoot, 'assets', 'rubric.txt'), 'rubric')
    await writeFile(join(sourceRoot, 'scripts', 'score.py'), 'print(1)')

    const lease = await new AgentSkillRuntime().acquire({
      storageRoot,
      lifecycle: {
        sessionId: 'session-1',
        agentFrameId: 'frame-1',
        runtimeSegmentId: 'segment-1'
      },
      scope: { kind: 'main' },
      skills: [
        {
          kind: 'package',
          id: 'featured-paper-review',
          name: 'paper-review',
          description: 'Review a paper.',
          sourceDir: sourceRoot,
          revision: 'sha256:package-v1'
        }
      ]
    })

    expect(lease.skills).toHaveLength(1)
    expect(lease.skills[0]).toMatchObject({
      id: 'featured-paper-review',
      name: 'paper-review',
      description: 'Review a paper.',
      packageRevision: 'sha256:package-v1'
    })
    expect(lease.projectionRoot).toMatch(/runtime\/agent-skills\/v1\/catalogs\/[a-f0-9]{64}$/)
    expect(lease.discoveryRoot).toBe(join(lease.projectionRoot, 'skills'))
    expect(lease.skills[0]!.packageRoot).toBe(join(lease.discoveryRoot, 'os-featured-paper-review'))
    expect(await readFile(lease.skills[0]!.skillDocumentPath, 'utf8')).toContain(
      'name: paper-review'
    )
    await expect(
      readFile(join(lease.projectionRoot, '.claude-plugin', 'plugin.json'), 'utf8').then(JSON.parse)
    ).resolves.toEqual({ name: 'open-science-agent-skills' })
    expect(lease.env).toMatchObject({
      TMPDIR: lease.tempRoot,
      XDG_CACHE_HOME: lease.cacheRoot
    })
    await expect(
      readFile(join(lease.skills[0]!.packageRoot, 'references', 'method.md'), 'utf8')
    ).resolves.toBe('reference')
    await expect(
      readFile(join(lease.skills[0]!.packageRoot, 'assets', 'rubric.txt'), 'utf8')
    ).resolves.toBe('rubric')
    await expect(
      readFile(join(lease.skills[0]!.packageRoot, 'scripts', 'score.py'), 'utf8')
    ).resolves.toBe('print(1)')

    const runtimeRoot = join(storageRoot, 'runtime', 'agent-skills', 'v1')
    for (const path of [
      lease.skills[0]!.packageRoot,
      lease.skills[0]!.skillDocumentPath,
      lease.cacheRoot,
      lease.tempRoot
    ]) {
      expect(path.startsWith(`${runtimeRoot}/`)).toBe(true)
    }
    expect(lease.catalogRevision).toMatch(/^sha256:/)
  })

  it('acquires a generated Connector Skill in the native discovery root', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')

    const lease = await new AgentSkillRuntime().acquire({
      storageRoot,
      lifecycle: {
        sessionId: 'session-1',
        agentFrameId: 'frame-1',
        runtimeSegmentId: 'segment-1'
      },
      scope: { kind: 'main' },
      skills: [
        {
          kind: 'generated',
          id: 'mcp-pubmed',
          name: 'mcp-pubmed',
          description: 'Search PubMed.',
          revision: 'sha256:connector-v1',
          files: [
            {
              path: 'SKILL.md',
              content:
                '---\nname: mcp-pubmed\ndescription: Search PubMed.\n---\nUse the PubMed connector.\n'
            },
            { path: 'references/tools.md', content: 'Tool reference.' }
          ]
        }
      ]
    })

    expect(lease.skills[0]).toMatchObject({
      id: 'mcp-pubmed',
      name: 'mcp-pubmed',
      description: 'Search PubMed.',
      packageRoot: join(lease.discoveryRoot, 'os-mcp-pubmed')
    })
    await expect(readFile(lease.skills[0]!.skillDocumentPath, 'utf8')).resolves.toContain(
      'Use the PubMed connector.'
    )
    await expect(
      readFile(join(lease.skills[0]!.packageRoot, 'references', 'tools.md'), 'utf8')
    ).resolves.toBe('Tool reference.')
  })

  it.skipIf(!hasPython)(
    'runs Python compilation from the read-only package with bytecode under the lease',
    async () => {
      const storageRoot = await temporaryRoot('agent-skill-storage-')
      const lease = await new AgentSkillRuntime().acquire({
        storageRoot,
        lifecycle: {
          sessionId: 'session-python',
          agentFrameId: 'frame-main',
          runtimeSegmentId: 'segment-python'
        },
        scope: { kind: 'main' },
        skills: [
          {
            kind: 'generated',
            id: 'python-runtime-test',
            name: 'python-runtime-test',
            description: 'Exercise Python cache isolation.',
            revision: 'sha256:python-runtime-test',
            files: [
              { path: 'SKILL.md', content: '# Python runtime test' },
              { path: 'scripts/module.py', content: 'VALUE = 42\n' }
            ]
          }
        ]
      })
      const scriptsRoot = join(lease.skills[0]!.packageRoot, 'scripts')

      await execFileAsync('python3', ['-m', 'py_compile', join(scriptsRoot, 'module.py')], {
        env: { ...process.env, ...lease.env }
      })

      expect(await readdir(scriptsRoot)).toEqual(['module.py'])
      expect((await listTree(lease.env.PYTHONPYCACHEPREFIX)).length).toBeGreaterThan(1)
      await lease.release()
    }
  )

  it.skipIf(!supportsNodeCompileCache)(
    'runs Node modules from the read-only package with compile cache under the lease',
    async () => {
      const storageRoot = await temporaryRoot('agent-skill-storage-')
      const lease = await new AgentSkillRuntime().acquire({
        storageRoot,
        lifecycle: {
          sessionId: 'session-node',
          agentFrameId: 'frame-main',
          runtimeSegmentId: 'segment-node'
        },
        scope: { kind: 'main' },
        skills: [
          {
            kind: 'generated',
            id: 'node-runtime-test',
            name: 'node-runtime-test',
            description: 'Exercise Node cache isolation.',
            revision: 'sha256:node-runtime-test',
            files: [
              { path: 'SKILL.md', content: '# Node runtime test' },
              { path: 'scripts/module.js', content: 'module.exports = 42\n' },
              { path: 'scripts/main.js', content: "require('./module.js')\n" }
            ]
          }
        ]
      })
      const scriptsRoot = join(lease.skills[0]!.packageRoot, 'scripts')

      await execFileAsync(process.execPath, [join(scriptsRoot, 'main.js')], {
        env: { ...process.env, ...lease.env }
      })

      expect((await readdir(scriptsRoot)).sort()).toEqual(['main.js', 'module.js'])
      expect((await listTree(lease.env.NODE_COMPILE_CACHE)).length).toBeGreaterThan(1)
      await lease.release()
    }
  )

  it.skipIf(!hasRscript)(
    'resolves R package cache and user libraries inside the writable lease',
    async () => {
      const storageRoot = await temporaryRoot('agent-skill-storage-')
      const lease = await new AgentSkillRuntime().acquire({
        storageRoot,
        lifecycle: {
          sessionId: 'session-r',
          agentFrameId: 'frame-main',
          runtimeSegmentId: 'segment-r'
        },
        scope: { kind: 'main' },
        skills: []
      })

      const { stdout } = await execFileAsync(
        'Rscript',
        [
          '-e',
          'cat(tools::R_user_dir("open.science.test", "cache"), "\\n"); cat(.libPaths()[1], "\\n")'
        ],
        { env: { ...process.env, ...lease.env } }
      )
      const [cache, library] = stdout.trim().split(/\r?\n/)

      expect(cache).toContain(lease.env.R_USER_CACHE_DIR)
      expect(library).toBe(lease.env.R_LIBS_USER)
      await lease.release()
    }
  )

  it('reuses a published read-only catalog across runtime leases', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const runtime = new AgentSkillRuntime()
    const input = {
      storageRoot,
      lifecycle: {
        sessionId: 'session-1',
        agentFrameId: 'frame-1',
        runtimeSegmentId: 'segment-1'
      },
      scope: { kind: 'main' as const },
      skills: [
        {
          kind: 'generated' as const,
          id: 'mcp-pubmed',
          name: 'mcp-pubmed',
          description: 'Search PubMed.',
          revision: 'sha256:connector-v1',
          files: [{ path: 'SKILL.md', content: '# PubMed' }]
        }
      ]
    }

    const first = await runtime.acquire(input)
    const second = await runtime.acquire({
      ...input,
      lifecycle: { ...input.lifecycle, runtimeSegmentId: 'segment-2' }
    })

    expect(second.projectionRoot).toBe(first.projectionRoot)
    expect(second.tempRoot).not.toBe(first.tempRoot)
    await first.release()
    await expect(readFile(second.skills[0]!.skillDocumentPath, 'utf8')).resolves.toBe('# PubMed')
    await second.release()
  })

  it('publishes one catalog for concurrent acquisitions and gives each caller its own lease', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const runtime = new AgentSkillRuntime()
    const input = {
      storageRoot,
      scope: { kind: 'main' as const },
      skills: [
        {
          kind: 'generated' as const,
          id: 'concurrent-skill',
          name: 'concurrent-skill',
          description: 'Concurrent Skill.',
          revision: 'sha256:concurrent-v1',
          files: [{ path: 'SKILL.md', content: '# Concurrent' }]
        }
      ]
    }

    const [first, second] = await Promise.all(
      ['segment-1', 'segment-2'].map((runtimeSegmentId) =>
        runtime.acquire({
          ...input,
          lifecycle: { sessionId: 'session-1', agentFrameId: 'frame-1', runtimeSegmentId }
        })
      )
    )

    expect(second.projectionRoot).toBe(first.projectionRoot)
    expect(second.tempRoot).not.toBe(first.tempRoot)
    await Promise.all([first.release(), second.release()])
  })

  it('publishes a stable native discovery directory when every optional Skill is disabled', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const lease = await new AgentSkillRuntime().acquire({
      storageRoot,
      lifecycle: {
        sessionId: 'session-empty',
        agentFrameId: 'frame-main',
        runtimeSegmentId: 'segment-empty'
      },
      scope: { kind: 'main' },
      skills: []
    })

    expect(await readdir(lease.discoveryRoot)).toEqual([])
    await lease.release()
  })

  it('applies a package SKILL.md override without modifying the source package', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const sourceRoot = await temporaryRoot('agent-skill-source-')
    const sourceDocument = join(sourceRoot, 'SKILL.md')
    await writeFile(
      sourceDocument,
      '---\nname: remote-compute-ssh\n---\nSource compute instructions.\n'
    )
    if (process.platform !== 'win32') await chmod(sourceDocument, 0o640)

    const lease = await new AgentSkillRuntime().acquire({
      storageRoot,
      lifecycle: {
        sessionId: 'session-1',
        agentFrameId: 'frame-1',
        runtimeSegmentId: 'segment-1'
      },
      scope: { kind: 'main' },
      skills: [
        {
          kind: 'package',
          id: 'remote-compute-ssh',
          name: 'remote-compute-ssh',
          description: 'Use registered compute hosts.',
          sourceDir: sourceRoot,
          revision: 'sha256:compute-hosts-v2',
          overrides: [
            {
              path: 'SKILL.md',
              content:
                '---\nname: remote-compute-ssh\n---\nGenerated registered-host instructions.\n'
            }
          ]
        }
      ]
    })

    await expect(readFile(lease.skills[0]!.skillDocumentPath, 'utf8')).resolves.toContain(
      'Generated registered-host instructions.'
    )
    await expect(readFile(sourceDocument, 'utf8')).resolves.toContain(
      'Source compute instructions.'
    )
    if (process.platform !== 'win32') {
      expect((await stat(sourceDocument)).mode & 0o777).toBe(0o640)
    }
  })

  it('rejects an unsafe generated path without publishing a partial catalog', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')

    await expect(
      new AgentSkillRuntime().acquire({
        storageRoot,
        lifecycle: {
          sessionId: 'session-1',
          agentFrameId: 'frame-1',
          runtimeSegmentId: 'segment-1'
        },
        scope: { kind: 'main' },
        skills: [
          {
            kind: 'generated',
            id: 'mcp-safe',
            name: 'mcp-safe',
            description: 'Safe generated Skill.',
            revision: 'sha256:safe',
            files: [{ path: 'SKILL.md', content: 'safe' }]
          },
          {
            kind: 'generated',
            id: 'mcp-unsafe',
            name: 'mcp-unsafe',
            description: 'Unsafe generated Skill.',
            revision: 'sha256:unsafe',
            files: [
              { path: 'SKILL.md', content: 'unsafe' },
              { path: '../escaped.md', content: 'escaped' }
            ]
          }
        ]
      })
    ).rejects.toThrow(/unsafe generated file path/i)

    const catalogsRoot = join(storageRoot, 'runtime', 'agent-skills', 'v1', 'catalogs')
    await expect(readdir(catalogsRoot).catch(() => [])).resolves.toEqual([])
  })

  it('rejects a generated package without a regular SKILL.md before publication', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')

    await expect(
      new AgentSkillRuntime().acquire({
        storageRoot,
        lifecycle: {
          sessionId: 'session-1',
          agentFrameId: 'frame-1',
          runtimeSegmentId: 'segment-1'
        },
        scope: { kind: 'main' },
        skills: [
          {
            kind: 'generated',
            id: 'mcp-incomplete',
            name: 'mcp-incomplete',
            description: 'Incomplete generated Skill.',
            revision: 'sha256:incomplete',
            files: [{ path: 'references/tools.md', content: 'Tools only.' }]
          }
        ]
      })
    ).rejects.toThrow(/regular SKILL\.md/i)

    const catalogsRoot = join(storageRoot, 'runtime', 'agent-skills', 'v1', 'catalogs')
    await expect(readdir(catalogsRoot).catch(() => [])).resolves.toEqual([])
  })

  it('rejects a package containing a symbolic link', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const sourceRoot = await temporaryRoot('agent-skill-source-')
    const externalRoot = await temporaryRoot('agent-skill-external-')
    await writeFile(join(sourceRoot, 'SKILL.md'), '---\nname: unsafe-skill\n---\n')
    await writeFile(join(externalRoot, 'secret.txt'), 'secret')
    await mkdir(join(sourceRoot, 'references'))
    await symlink(join(externalRoot, 'secret.txt'), join(sourceRoot, 'references', 'escaped.txt'))

    await expect(
      new AgentSkillRuntime().acquire({
        storageRoot,
        lifecycle: {
          sessionId: 'session-1',
          agentFrameId: 'frame-1',
          runtimeSegmentId: 'segment-1'
        },
        scope: { kind: 'main' },
        skills: [
          {
            kind: 'package',
            id: 'unsafe-skill',
            name: 'unsafe-skill',
            description: 'Unsafe Skill.',
            sourceDir: sourceRoot,
            revision: 'sha256:unsafe'
          }
        ]
      })
    ).rejects.toThrow(/symbolic link/i)
  })

  it('rejects a Skill id that could escape the package directory', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const sourceRoot = await temporaryRoot('agent-skill-source-')
    await writeFile(join(sourceRoot, 'SKILL.md'), 'unsafe')

    await expect(
      new AgentSkillRuntime().acquire({
        storageRoot,
        lifecycle: {
          sessionId: 'session-1',
          agentFrameId: 'frame-1',
          runtimeSegmentId: 'segment-1'
        },
        scope: { kind: 'main' },
        skills: [
          {
            kind: 'package',
            id: '../escaped',
            name: 'unsafe-skill',
            description: 'Unsafe Skill.',
            sourceDir: sourceRoot,
            revision: 'sha256:unsafe'
          }
        ]
      })
    ).rejects.toThrow(/unsafe Skill id/i)
  })

  it('rejects duplicate native Skill names', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const firstSource = await temporaryRoot('agent-skill-source-')
    const secondSource = await temporaryRoot('agent-skill-source-')
    await writeFile(join(firstSource, 'SKILL.md'), 'first')
    await writeFile(join(secondSource, 'SKILL.md'), 'second')

    await expect(
      new AgentSkillRuntime().acquire({
        storageRoot,
        lifecycle: {
          sessionId: 'session-1',
          agentFrameId: 'frame-1',
          runtimeSegmentId: 'segment-1'
        },
        scope: { kind: 'main' },
        skills: [
          {
            kind: 'package',
            id: 'first-skill',
            name: 'shared-name',
            description: 'First Skill.',
            sourceDir: firstSource,
            revision: 'sha256:first'
          },
          {
            kind: 'package',
            id: 'second-skill',
            name: 'shared-name',
            description: 'Second Skill.',
            sourceDir: secondSource,
            revision: 'sha256:second'
          }
        ]
      })
    ).rejects.toThrow(/duplicate Skill name/i)
  })

  it('does not publish a partial catalog when a package copy fails', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const validSource = await temporaryRoot('agent-skill-source-')
    const invalidSource = await temporaryRoot('agent-skill-source-')
    await writeFile(join(validSource, 'SKILL.md'), '---\nname: valid-skill\n---\n')
    await writeFile(join(invalidSource, 'SKILL.md'), '---\nname: invalid-skill\n---\n')
    await symlink(join(validSource, 'SKILL.md'), join(invalidSource, 'escaped.md'))

    await expect(
      new AgentSkillRuntime().acquire({
        storageRoot,
        lifecycle: {
          sessionId: 'session-1',
          agentFrameId: 'frame-1',
          runtimeSegmentId: 'segment-1'
        },
        scope: { kind: 'main' },
        skills: [
          {
            kind: 'package',
            id: 'valid-skill',
            name: 'valid-skill',
            description: 'Valid Skill.',
            sourceDir: validSource,
            revision: 'sha256:valid'
          },
          {
            kind: 'package',
            id: 'invalid-skill',
            name: 'invalid-skill',
            description: 'Invalid Skill.',
            sourceDir: invalidSource,
            revision: 'sha256:invalid'
          }
        ]
      })
    ).rejects.toThrow(/symbolic link/i)

    const catalogsRoot = join(storageRoot, 'runtime', 'agent-skills', 'v1', 'catalogs')
    await expect(readdir(catalogsRoot).catch(() => [])).resolves.toEqual([])
  })

  it('releases its exact lease root even when its owner manifest is modified', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const lease = await new AgentSkillRuntime().acquire({
      storageRoot,
      lifecycle: {
        sessionId: 'session-1',
        agentFrameId: 'frame-1',
        runtimeSegmentId: 'segment-1'
      },
      scope: { kind: 'main' },
      skills: []
    })
    const sentinel = join(lease.cacheRoot, 'remove.txt')
    await writeFile(sentinel, 'remove')
    await writeFile(
      join(dirname(lease.cacheRoot), 'owner.json'),
      `${JSON.stringify({ version: 1, ownerId: 'different-owner' })}\n`
    )

    await lease.release()

    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lease.release()).resolves.toBeUndefined()
  })

  it('rejects a reused catalog containing a symbolic link without touching its target', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const protectedRoot = join(storageRoot, 'config')
    const protectedFile = join(protectedRoot, 'credentials.json')
    await mkdir(protectedRoot)
    await writeFile(protectedFile, 'protected')
    const runtime = new AgentSkillRuntime()
    const input = {
      storageRoot,
      lifecycle: {
        sessionId: 'session-1',
        agentFrameId: 'frame-1',
        runtimeSegmentId: 'segment-1'
      },
      scope: { kind: 'main' as const },
      skills: [
        {
          kind: 'generated' as const,
          id: 'safe-skill',
          name: 'safe-skill',
          description: 'Safe Skill.',
          revision: 'sha256:safe-skill',
          files: [{ path: 'SKILL.md', content: '# Safe' }]
        }
      ]
    }
    const first = await runtime.acquire(input)
    const skillDocument = first.skills[0]!.skillDocumentPath
    await chmod(first.skills[0]!.packageRoot, 0o755)
    await rm(skillDocument)
    await symlink(protectedFile, skillDocument)

    await expect(runtime.acquire(input)).rejects.toThrow(/symbolic link/i)
    await expect(readFile(protectedFile, 'utf8')).resolves.toBe('protected')
  })

  it.runIf(process.platform !== 'win32')(
    'rejects a reused catalog whose read-only permissions changed',
    async () => {
      const storageRoot = await temporaryRoot('agent-skill-storage-')
      const runtime = new AgentSkillRuntime()
      const input = {
        storageRoot,
        lifecycle: {
          sessionId: 'session-1',
          agentFrameId: 'frame-1',
          runtimeSegmentId: 'segment-1'
        },
        scope: { kind: 'main' as const },
        skills: [
          {
            kind: 'generated' as const,
            id: 'safe-skill',
            name: 'safe-skill',
            description: 'Safe Skill.',
            revision: 'sha256:safe-skill',
            files: [{ path: 'SKILL.md', content: '# Safe' }]
          }
        ]
      }
      const first = await runtime.acquire(input)
      await chmod(first.skills[0]!.skillDocumentPath, 0o644)

      await expect(runtime.acquire(input)).rejects.toThrow(/contents or permissions differ/i)
    }
  )

  it('cleans a partial lease when acquisition fails after environment creation', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const invalidLifecycle = {
      sessionId: 'session-1',
      agentFrameId: 'frame-1',
      runtimeSegmentId: 1n
    } as unknown as {
      sessionId: string
      agentFrameId: string
      runtimeSegmentId: string
    }

    await expect(
      new AgentSkillRuntime().acquire({
        storageRoot,
        lifecycle: invalidLifecycle,
        scope: { kind: 'main' },
        skills: []
      })
    ).rejects.toThrow()

    const leasesRoot = join(storageRoot, 'runtime', 'agent-skills', 'v1', 'leases')
    await expect(readdir(leasesRoot).catch(() => [])).resolves.toEqual([])
  })

  it('forks isolated writable roots from an authorized catalog', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const runtime = new AgentSkillRuntime()
    const first = await runtime.acquire({
      storageRoot,
      lifecycle: {
        sessionId: 'session-1',
        agentFrameId: 'frame-1',
        runtimeSegmentId: 'segment-1'
      },
      scope: { kind: 'main' },
      skills: []
    })
    const second = await runtime.fork(first, {
      lifecycle: {
        sessionId: 'session-1',
        agentFrameId: 'frame-2',
        runtimeSegmentId: 'segment-2'
      },
      scope: { kind: 'subagent' }
    })
    const directoryVariables = [
      'TMPDIR',
      'TMP',
      'TEMP',
      'XDG_CACHE_HOME',
      'PYTHONPYCACHEPREFIX',
      'PIP_CACHE_DIR',
      'PYTHONUSERBASE',
      'NODE_COMPILE_CACHE',
      'npm_config_cache',
      'R_USER_CACHE_DIR',
      'R_USER_CONFIG_DIR',
      'R_USER_DATA_DIR',
      'R_LIBS_USER'
    ] as const
    const firstRoot = dirname(first.cacheRoot)
    const secondRoot = dirname(second.cacheRoot)

    expect(second.projectionRoot).toBe(first.projectionRoot)
    expect(secondRoot).not.toBe(firstRoot)
    for (const name of directoryVariables) {
      expect(first.env[name]?.startsWith(`${firstRoot}${sep}`), name).toBe(true)
      expect(second.env[name]?.startsWith(`${secondRoot}${sep}`), name).toBe(true)
      expect(second.env[name], name).not.toBe(first.env[name])
      await expect(stat(first.env[name]!)).resolves.toMatchObject({})
      await expect(stat(second.env[name]!)).resolves.toMatchObject({})
    }

    await first.release()
    await expect(stat(second.env.PYTHONPYCACHEPREFIX!)).resolves.toMatchObject({})
    await second.release()
  })

  it.runIf(process.platform !== 'win32')(
    'retries release after a transient removal failure',
    async () => {
      const storageRoot = await temporaryRoot('agent-skill-storage-')
      const lease = await new AgentSkillRuntime().acquire({
        storageRoot,
        lifecycle: {
          sessionId: 'session-1',
          agentFrameId: 'frame-1',
          runtimeSegmentId: 'segment-1'
        },
        scope: { kind: 'main' },
        skills: []
      })
      const leaseRoot = dirname(lease.cacheRoot)
      const leasesRoot = dirname(leaseRoot)
      await chmod(leasesRoot, 0o555)

      await expect(lease.release()).rejects.toMatchObject({ code: expect.any(String) })
      await expect(stat(leaseRoot)).resolves.toMatchObject({})

      await chmod(leasesRoot, 0o755)
      await expect(lease.release()).resolves.toBeUndefined()
      await expect(stat(leaseRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('rejects a fork from a catalog not authorized by this runtime instance', async () => {
    const runtime = new AgentSkillRuntime()
    await expect(
      runtime.fork(
        {
          catalogRevision: 'sha256:untrusted',
          projectionRoot: '/tmp/untrusted',
          discoveryRoot: '/tmp/untrusted/skills',
          skills: []
        },
        {
          lifecycle: {
            sessionId: 'session-1',
            agentFrameId: 'frame-1',
            runtimeSegmentId: 'segment-1'
          },
          scope: { kind: 'subagent' }
        }
      )
    ).rejects.toThrow(/unauthorized catalog/i)
  })

  it('releases only lease-owned cache and temporary files', async () => {
    const storageRoot = await temporaryRoot('agent-skill-storage-')
    const sourceRoot = await temporaryRoot('agent-skill-source-')
    await writeFile(join(sourceRoot, 'SKILL.md'), '---\nname: retained-skill\n---\n')
    const lease = await new AgentSkillRuntime().acquire({
      storageRoot,
      lifecycle: {
        sessionId: 'session-1',
        agentFrameId: 'frame-1',
        runtimeSegmentId: 'segment-1'
      },
      scope: { kind: 'main' },
      skills: [
        {
          kind: 'package',
          id: 'retained-skill',
          name: 'retained-skill',
          description: 'Retained Skill.',
          sourceDir: sourceRoot,
          revision: 'sha256:retained'
        }
      ]
    })
    const cacheFile = join(lease.cacheRoot, 'cache.txt')
    await writeFile(cacheFile, 'cache')

    await lease.release()

    await expect(readFile(cacheFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(lease.skills[0]!.skillDocumentPath, 'utf8')).resolves.toContain(
      'name: retained-skill'
    )
  })

  it.runIf(process.platform !== 'win32')(
    'copies package files without linking or modifying the source package',
    async () => {
      const storageRoot = await temporaryRoot('agent-skill-storage-')
      const sourceRoot = await temporaryRoot('agent-skill-source-')
      await mkdir(join(sourceRoot, 'scripts'))
      await writeFile(join(sourceRoot, 'SKILL.md'), '---\nname: copied-skill\n---\n')
      const sourceScript = join(sourceRoot, 'scripts', 'run.py')
      await writeFile(sourceScript, 'original')
      const lease = await new AgentSkillRuntime().acquire({
        storageRoot,
        lifecycle: {
          sessionId: 'session-1',
          agentFrameId: 'frame-1',
          runtimeSegmentId: 'segment-1'
        },
        scope: { kind: 'main' },
        skills: [
          {
            kind: 'package',
            id: 'copied-skill',
            name: 'copied-skill',
            description: 'Copied Skill.',
            sourceDir: sourceRoot,
            revision: 'sha256:copied'
          }
        ]
      })

      const projectedScript = join(lease.skills[0]!.packageRoot, 'scripts', 'run.py')

      expect((await stat(projectedScript)).ino).not.toBe((await stat(sourceScript)).ino)
      await expect(readFile(sourceScript, 'utf8')).resolves.toBe('original')
    }
  )

  it.runIf(process.platform !== 'win32')(
    'publishes a read-only projection without changing source permissions or content',
    async () => {
      const storageRoot = await temporaryRoot('agent-skill-storage-')
      const sourceRoot = await temporaryRoot('agent-skill-source-')
      await mkdir(join(sourceRoot, 'scripts'))
      const sourceDocument = join(sourceRoot, 'SKILL.md')
      const sourceScript = join(sourceRoot, 'scripts', 'run.py')
      await writeFile(sourceDocument, '---\nname: immutable-skill\n---\n')
      await writeFile(sourceScript, 'print(1)')
      await chmod(sourceDocument, 0o640)
      await chmod(sourceScript, 0o600)

      const lease = await new AgentSkillRuntime().acquire({
        storageRoot,
        lifecycle: {
          sessionId: 'session-1',
          agentFrameId: 'frame-1',
          runtimeSegmentId: 'segment-1'
        },
        scope: { kind: 'main' },
        skills: [
          {
            kind: 'package',
            id: 'immutable-skill',
            name: 'immutable-skill',
            description: 'Immutable Skill.',
            sourceDir: sourceRoot,
            revision: 'sha256:immutable'
          }
        ]
      })

      for (const projectedPath of await listTree(lease.projectionRoot)) {
        expect((await stat(projectedPath)).mode & 0o222, projectedPath).toBe(0)
      }
      expect((await stat(sourceDocument)).mode & 0o777).toBe(0o640)
      expect((await stat(sourceScript)).mode & 0o777).toBe(0o600)
      await expect(readFile(sourceDocument, 'utf8')).resolves.toBe(
        '---\nname: immutable-skill\n---\n'
      )
      await expect(readFile(sourceScript, 'utf8')).resolves.toBe('print(1)')
    }
  )
})

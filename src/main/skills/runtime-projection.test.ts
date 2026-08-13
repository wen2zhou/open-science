import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillRuntimeProjectionOwner, type SkillRuntimeProjectionInput } from './runtime-projection'

const roots: string[] = []
const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  roots.push(directory)
  return directory
}
const packageInput = async (
  id: string,
  executable = false
): Promise<SkillRuntimeProjectionInput> => {
  const sourceDir = await temporaryDirectory(`skill-${id}-`)
  await mkdir(join(sourceDir, 'references'))
  await mkdir(join(sourceDir, 'scripts'))
  await writeFile(join(sourceDir, 'SKILL.md'), `# ${id}`)
  await writeFile(join(sourceDir, 'references', 'guide.md'), `${id} guide`)
  await writeFile(join(sourceDir, 'scripts', 'run.py'), 'print("ok")')
  if (executable) await chmod(join(sourceDir, 'scripts', 'run.py'), 0o755)
  return {
    kind: 'package',
    id,
    name: id,
    description: `${id} description`,
    directory: `os-${id}`,
    revision: 'v1',
    sourceDir
  }
}
const restoreWrites = async (path: string): Promise<void> => {
  let metadata
  try {
    metadata = await lstat(path)
  } catch {
    return
  }
  if (metadata.isDirectory()) {
    await chmod(path, 0o755)
    for (const name of await readdir(path)) await restoreWrites(join(path, name))
  } else if (!metadata.isSymbolicLink()) await chmod(path, 0o644)
}
afterEach(async () => {
  await Promise.all(roots.map(restoreWrites))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SkillRuntimeProjectionOwner', () => {
  it('publishes complete package and generated trees as an immutable executable projection', async () => {
    const owner = new SkillRuntimeProjectionOwner({
      storageRoot: await temporaryDirectory('runtime-'),
      nextGenerationId: () => 'g1'
    })
    const generation = await owner.publish({
      inputs: [
        await packageInput('alpha', true),
        {
          kind: 'generated',
          id: 'mcp-zotero',
          name: 'Zotero',
          description: 'Use Zotero records.',
          source: 'connector',
          directory: 'mcp-zotero',
          revision: 'v1',
          files: [{ path: 'SKILL.md', content: '# Zotero\nUse host.mcp.' }]
        }
      ]
    })
    expect(
      await readFile(join(generation.skillsRoot, 'os-alpha', 'references', 'guide.md'), 'utf8')
    ).toBe('alpha guide')
    expect(await readFile(join(generation.skillsRoot, 'mcp-zotero', 'SKILL.md'), 'utf8')).toContain(
      'host.mcp'
    )
    expect(
      JSON.parse(await readFile(join(generation.root, '.claude-plugin', 'plugin.json'), 'utf8'))
    ).toEqual({ name: 'open-science-skills-g1', version: '1.0.0' })
    expect((await lstat(join(generation.skillsRoot, 'os-alpha', 'SKILL.md'))).mode & 0o222).toBe(0)
    expect(
      (await lstat(join(generation.skillsRoot, 'os-alpha', 'scripts', 'run.py'))).mode & 0o111
    ).toBe(0o111)
  })
  it('scopes discovery without hiding other projected files', async () => {
    const owner = new SkillRuntimeProjectionOwner({
      storageRoot: await temporaryDirectory('runtime-'),
      nextGenerationId: () => 'g1'
    })
    await owner.publish({ inputs: [await packageInput('alpha'), await packageInput('beta')] })
    const binding = await owner.acquire({ allowedSkillIds: ['alpha'] })
    expect(binding.descriptors).toEqual([
      {
        id: 'alpha',
        name: 'alpha',
        description: 'alpha description',
        path: join(binding.skillsRoot, 'os-alpha', 'SKILL.md')
      }
    ])
    expect(
      await readFile(join(binding.skillsRoot, 'os-beta', 'references', 'guide.md'), 'utf8')
    ).toBe('beta guide')
    expect(await readdir(binding.discoveryRoot)).toEqual(['os-alpha'])
    expect((await lstat(join(binding.discoveryRoot, 'os-alpha'))).isSymbolicLink()).toBe(true)
    expect(
      await readFile(join(binding.discoveryRoot, 'os-alpha', 'references', 'guide.md'), 'utf8')
    ).toBe('alpha guide')
    const discoveryRoot = binding.discoveryRoot
    await owner.reconcile()
    await expect(lstat(discoveryRoot)).resolves.toBeDefined()
    await binding.release()
    await expect(lstat(discoveryRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects an exact binding when the current generation lacks an authorized Skill', async () => {
    const owner = new SkillRuntimeProjectionOwner({
      storageRoot: await temporaryDirectory('runtime-'),
      nextGenerationId: () => 'g1'
    })
    await owner.publish({ inputs: [await packageInput('alpha')] })

    await expect(owner.acquire({ allowedSkillIds: ['removed'] })).rejects.toThrow(
      'Authorized Skill is unavailable in the current projection: removed'
    )
  })
  it('does not impose a fixed Skill slot limit on a binding', async () => {
    const owner = new SkillRuntimeProjectionOwner({
      storageRoot: await temporaryDirectory('runtime-'),
      nextGenerationId: () => 'g1'
    })
    const inputs: SkillRuntimeProjectionInput[] = Array.from({ length: 24 }, (_, index) => ({
      kind: 'generated',
      id: `skill-${index}`,
      name: `skill-${index}`,
      description: `Skill ${index}`,
      directory: `skill-${index}`,
      revision: 'v1',
      files: [{ path: 'SKILL.md', content: `# Skill ${index}` }]
    }))
    await owner.publish({ inputs })

    const binding = await owner.acquire()

    expect(binding.descriptors).toHaveLength(24)
    expect(await readdir(binding.discoveryRoot)).toHaveLength(24)
    await binding.release()
  })
  it('reuses an unchanged generation', async () => {
    const storageRoot = await temporaryDirectory('runtime-')
    const ids = ['g1', 'g2']
    const owner = new SkillRuntimeProjectionOwner({
      storageRoot,
      nextGenerationId: () => ids.shift()!
    })
    const alpha = await packageInput('alpha')
    expect((await owner.publish({ inputs: [alpha] })).generationId).toBe('g1')
    expect((await owner.publish({ inputs: [alpha] })).generationId).toBe('g1')
    expect(await readdir(join(storageRoot, 'generations'))).toEqual(['g1'])
  })
  it('overlays generated content while retaining resources', async () => {
    const owner = new SkillRuntimeProjectionOwner({
      storageRoot: await temporaryDirectory('runtime-'),
      nextGenerationId: () => 'g1'
    })
    const compute = await packageInput('remote-compute-ssh')
    if (compute.kind !== 'package') throw new Error('fixture')
    const generation = await owner.publish({
      inputs: [
        { ...compute, overrides: [{ path: 'SKILL.md', content: '# Hosts\nUse host.compute.' }] }
      ]
    })
    expect(
      await readFile(join(generation.skillsRoot, compute.directory, 'SKILL.md'), 'utf8')
    ).toContain('host.compute')
    expect(
      await readFile(
        join(generation.skillsRoot, compute.directory, 'references', 'guide.md'),
        'utf8'
      )
    ).toBe('remote-compute-ssh guide')
  })
  it('retains leased superseded generations then collects after release', async () => {
    const storageRoot = await temporaryDirectory('runtime-')
    const ids = ['g1', 'g2']
    const owner = new SkillRuntimeProjectionOwner({
      storageRoot,
      nextGenerationId: () => ids.shift()!
    })
    await owner.publish({ inputs: [await packageInput('alpha')] })
    const binding = await owner.acquire()
    await owner.publish({ inputs: [await packageInput('beta')] })
    expect((await readdir(join(storageRoot, 'generations'))).sort()).toEqual(['g1', 'g2'])
    await binding.release()
    await binding.release()
    expect(await readdir(join(storageRoot, 'generations'))).toEqual(['g2'])
  })
  it('publishes colliding invocation names but binds only an unambiguous selection', async () => {
    const owner = new SkillRuntimeProjectionOwner({
      storageRoot: await temporaryDirectory('runtime-'),
      nextGenerationId: () => 'g1'
    })
    const first = { ...(await packageInput('first')), name: 'skill-creator' }
    const second = { ...(await packageInput('second')), name: 'Skill-Creator' }

    const generation = await owner.publish({ inputs: [first, second] })
    const binding = await owner.acquire({ allowedSkillIds: ['first'] })

    expect(await readdir(generation.skillsRoot)).toEqual(['os-first', 'os-second'])
    expect(binding.descriptors.map(({ id }) => id)).toEqual(['first'])
    await expect(owner.acquire({ allowedSkillIds: ['first', 'second'] })).rejects.toThrow(
      /invocation name collision/i
    )
    await binding.release()
  })
  it('rejects unsafe paths, links, and normalized collisions', async () => {
    const owner = new SkillRuntimeProjectionOwner({
      storageRoot: await temporaryDirectory('runtime-'),
      nextGenerationId: () => 'g1'
    })
    const linked = await packageInput('linked')
    if (linked.kind !== 'package') throw new Error('fixture')
    await symlink('/tmp', join(linked.sourceDir, 'references', 'escape'))
    await expect(owner.publish({ inputs: [linked] })).rejects.toThrow(/symbolic link/i)
    const hard = await packageInput('hard')
    if (hard.kind !== 'package') throw new Error('fixture')
    await link(
      join(hard.sourceDir, 'references', 'guide.md'),
      join(hard.sourceDir, 'references', 'other.md')
    )
    await expect(owner.publish({ inputs: [hard] })).rejects.toThrow(/hard link/i)
    await expect(
      owner.publish({
        inputs: [
          {
            kind: 'generated',
            id: 'bad',
            name: 'bad',
            description: 'bad',
            directory: 'bad',
            revision: 'v1',
            files: [{ path: '../out', content: 'x' }]
          }
        ]
      })
    ).rejects.toThrow(/relative path/i)
    await expect(
      owner.publish({
        inputs: [
          { ...(await packageInput('one')), directory: 'Skill' },
          { ...(await packageInput('two')), directory: 'skill' }
        ]
      })
    ).rejects.toThrow(/collision/i)
    await expect(
      owner.publish({
        inputs: [
          {
            kind: 'generated',
            id: 'lowercase-entrypoint',
            name: 'lowercase-entrypoint',
            description: 'lowercase-entrypoint',
            directory: 'lowercase-entrypoint',
            revision: 'v1',
            files: [{ path: 'skill.md', content: '# Not portable' }]
          }
        ]
      })
    ).rejects.toThrow(/missing SKILL\.md/)
  })
  it('refuses to bind a modified projected tree', async () => {
    const owner = new SkillRuntimeProjectionOwner({
      storageRoot: await temporaryDirectory('runtime-'),
      nextGenerationId: () => 'g1'
    })
    const generation = await owner.publish({ inputs: [await packageInput('alpha')] })
    const root = join(generation.skillsRoot, 'os-alpha')
    await chmod(root, 0o755)
    await symlink('/tmp', join(root, 'unexpected-link'))
    await expect(owner.acquire()).rejects.toThrow(/unexpected|unsafe|writable/i)
  })
  it('reconciles candidates and superseded unleased generations', async () => {
    const storageRoot = await temporaryDirectory('runtime-')
    const owner = new SkillRuntimeProjectionOwner({ storageRoot, nextGenerationId: () => 'g1' })
    await owner.publish({ inputs: [await packageInput('alpha')] })
    await mkdir(join(storageRoot, '.candidate-crashed'))
    await mkdir(join(storageRoot, 'generations', 'orphan'))
    await mkdir(join(storageRoot, 'discovery', 'crashed-binding'), { recursive: true })
    await new SkillRuntimeProjectionOwner({ storageRoot }).reconcile()
    expect(await readdir(storageRoot)).not.toContain('.candidate-crashed')
    expect(await readdir(join(storageRoot, 'generations'))).toEqual(['g1'])
    expect(await readdir(join(storageRoot, 'discovery'))).toEqual([])
  })
  it('retries binding cleanup after a transient discovery deletion failure', async () => {
    const storageRoot = await temporaryDirectory('runtime-')
    const owner = new SkillRuntimeProjectionOwner({ storageRoot, nextGenerationId: () => 'g1' })
    await owner.publish({ inputs: [await packageInput('alpha')] })
    const binding = await owner.acquire()
    await chmod(join(storageRoot, 'discovery'), 0o555)

    await expect(binding.release()).rejects.toMatchObject({ code: 'EACCES' })
    await chmod(join(storageRoot, 'discovery'), 0o755)
    await binding.release()

    await expect(lstat(binding.discoveryRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('recovers a valid generation after a damaged pointer and removes pointer temporaries', async () => {
    const storageRoot = await temporaryDirectory('runtime-')
    const owner = new SkillRuntimeProjectionOwner({ storageRoot, nextGenerationId: () => 'g1' })
    await owner.publish({ inputs: [await packageInput('alpha')] })
    await writeFile(join(storageRoot, '.current.json'), '{broken')
    await writeFile(join(storageRoot, '.current-crashed.tmp'), 'partial')

    const restarted = new SkillRuntimeProjectionOwner({ storageRoot })
    await restarted.reconcile()
    const binding = await restarted.acquire()

    expect(binding.generationId).toBe('g1')
    expect(await readdir(storageRoot)).not.toContain('.current-crashed.tmp')
    await binding.release()
  })
  it('does not recover a generation whose immutable mode contract was lost', async () => {
    const storageRoot = await temporaryDirectory('runtime-')
    const owner = new SkillRuntimeProjectionOwner({ storageRoot, nextGenerationId: () => 'g1' })
    const generation = await owner.publish({ inputs: [await packageInput('alpha')] })
    await chmod(generation.root, 0o755)
    await writeFile(join(storageRoot, '.current.json'), '{broken')

    const restarted = new SkillRuntimeProjectionOwner({ storageRoot })
    await restarted.reconcile()

    await expect(restarted.acquire()).rejects.toThrow(/no skill runtime projection/i)
    expect(await readdir(join(storageRoot, 'generations'))).toEqual([])
  })
})

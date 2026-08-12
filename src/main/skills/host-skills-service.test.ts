import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BundledSkill } from './registry'
import { HostSkillsService, type HostSkillsCatalog } from './host-skills-service'
import { UserSkillRepository } from './user-skill-repository'
import { clearSkillResourceGrants, registerSkillResourceGrant } from './resource-capability'

const roots: string[] = []

afterEach(async () => {
  clearSkillResourceGrants('session-1')
  clearSkillResourceGrants('session-2')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const makeFixture = async (): Promise<{
  service: HostSkillsService
  root: string
  userSkills: UserSkillRepository
  catalog: HostSkillsCatalog
  approveDelete: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
}> => {
  const root = await mkdtemp(join(tmpdir(), 'host-skills-'))
  roots.push(root)
  await mkdir(join(root, 'workspace'), { recursive: true })
  const featuredDir = join(root, 'featured', 'literature-review')
  await mkdir(featuredDir, { recursive: true })
  await writeFile(
    join(featuredDir, 'SKILL.md'),
    '---\nname: literature-review\ndescription: Review literature.\n---\nFeatured body.\n'
  )
  await mkdir(join(featuredDir, 'references'), { recursive: true })
  await writeFile(join(featuredDir, 'references', 'guide.md'), 'unprotected catalog source')
  const projectedDir = join(root, 'protected-projection', 'literature-review')
  await mkdir(join(projectedDir, 'references'), { recursive: true })
  await mkdir(join(projectedDir, 'scripts'), { recursive: true })
  await writeFile(join(projectedDir, 'references', 'guide.md'), 'trusted guide')
  await writeFile(join(projectedDir, 'scripts', 'run.sh'), '#!/bin/sh\necho safe\n')
  await chmod(join(projectedDir, 'scripts', 'run.sh'), 0o555)
  const featured: BundledSkill = {
    id: 'literature-review',
    name: 'literature-review',
    displayName: 'Literature Review',
    description: 'Review literature.',
    source: 'featured',
    updatedAt: '2026-08-09',
    sourceDir: featuredDir
  }
  const userSkills = new UserSkillRepository(root)
  const catalog: HostSkillsCatalog = {
    list: async () => [featured, ...(await userSkills.list())],
    withSkillRead: async (id, read) => {
      if (id === featured.id) return read(featured)
      return userSkills.withSkillReadLock(id, read)
    },
    publishPersonalDirectory: (name, sourcePath, overwrite) =>
      userSkills.publishPersonalDirectory(name, sourcePath, overwrite),
    deletePublished: (id) => userSkills.delete(id)
  }
  const approveDelete = vi.fn(async () => true)
  const reload = vi.fn()
  return {
    root,
    userSkills,
    catalog,
    approveDelete,
    reload,
    service: new HostSkillsService({
      storageRoot: root,
      catalog,
      resourceRoot: (skill) => join(root, 'protected-projection', skill.id),
      approveDelete,
      onPublishedSkillsChanged: reload
    })
  }
}

describe('HostSkillsService', () => {
  it('reads only the exact Skill granted to the authenticated Session', async () => {
    const { service } = await makeFixture()
    registerSkillResourceGrant('session-1', 'literature-review')

    await expect(
      service.dispatch(
        { op: 'resource', params: { skill_id: 'literature-review', path: 'references/guide.md' } },
        { sessionId: 'session-1' }
      )
    ).resolves.toEqual({ path: 'references/guide.md', content: 'trusted guide' })
    await expect(
      service.dispatch(
        {
          op: 'resource',
          params: { skill_id: 'other-skill', path: 'references/guide.md' }
        },
        { sessionId: 'session-1' }
      )
    ).rejects.toThrow('no longer installed')
    await expect(
      service.dispatch(
        { op: 'resource', params: { skill_id: 'literature-review', path: '../settings.json' } },
        { sessionId: 'session-1' }
      )
    ).rejects.toThrow('unsafe path')
    await expect(
      service.dispatch(
        { op: 'resource', params: { skill_id: 'literature-review', path: 'SKILL.md' } },
        { sessionId: 'session-1' }
      )
    ).rejects.toThrow('loaded only by the native Skill tool')
    await expect(
      service.dispatch(
        { op: 'resource', params: { skill_id: 'literature-review', path: 'references/guide.md' } },
        { sessionId: 'session-2' }
      )
    ).rejects.toThrow('not authorized for this Session')
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a symbolic-link escape even with a valid Skill grant',
    async () => {
      const { service, root } = await makeFixture()
      registerSkillResourceGrant('session-1', 'literature-review')
      const outside = join(root, 'outside-secret.md')
      await writeFile(outside, 'secret')
      await symlink(
        outside,
        join(root, 'protected-projection', 'literature-review', 'references', 'outside.md')
      )

      await expect(
        service.dispatch(
          {
            op: 'resource',
            params: {
              skill_id: 'literature-review',
              path: 'references/outside.md'
            }
          },
          { sessionId: 'session-1' }
        )
      ).rejects.toThrow('symbolic link')
    }
  )

  it('returns bounded stage bytes and source execute metadata without a privileged path write', async () => {
    const { service } = await makeFixture()
    registerSkillResourceGrant('session-1', 'literature-review')

    const result = (await service.dispatch(
      { op: 'stage', params: { skill_id: 'literature-review', path: 'references/guide.md' } },
      { sessionId: 'session-1' }
    )) as { filename: string; base64: string; executable: boolean }

    expect(result).toEqual({
      filename: 'guide.md',
      base64: Buffer.from('trusted guide').toString('base64'),
      executable: false
    })
    const script = (await service.dispatch(
      { op: 'stage', params: { skill_id: 'literature-review', path: 'scripts/run.sh' } },
      { sessionId: 'session-1' }
    )) as { executable: boolean }
    expect(script.executable).toBe(true)
    await expect(
      service.dispatch(
        { op: 'stage', params: { skill_id: 'literature-review', path: 'references/guide.md' } },
        {}
      )
    ).rejects.toThrow('not authorized for this Session')
  })

  it('validates a draft through the same frontmatter contract used by publish', async () => {
    const { service } = await makeFixture()
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'analysis-helper',
        path: 'SKILL.md',
        content: '---\nname: analysis-helper\ndescription: Analyze data.\n---\nBody.\n'
      }
    })

    await expect(
      service.dispatch({ op: 'validate', params: { name: 'analysis-helper' } })
    ).resolves.toEqual({ valid: true, name: 'analysis-helper', origin: 'draft' })
  })

  it('creates a draft with exact create/replace semantics, publishes it, and reads it back', async () => {
    const { service, root, reload } = await makeFixture()
    const manifest =
      '---\nname: analysis-helper\ndescription: Analyze a dataset.\n---\nUse the script.\n'

    await expect(
      service.dispatch({
        op: 'edit',
        params: { name: 'analysis-helper', path: 'SKILL.md', content: manifest }
      })
    ).resolves.toMatchObject({ status: 'edited', name: 'analysis-helper', origin: 'draft' })
    await service.dispatch({
      op: 'edit',
      params: { name: 'analysis-helper', path: 'scripts/run.js', content: 'console.log("v1")\n' }
    })
    await expect(
      service.dispatch({
        op: 'edit',
        params: { name: 'analysis-helper', path: 'SKILL.md', content: 'replacement' }
      })
    ).rejects.toThrow('already exists')
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'analysis-helper',
        path: 'scripts/run.js',
        old_string: 'v1',
        content: 'v2'
      }
    })

    await expect(
      service.dispatch({ op: 'publish', params: { name: 'analysis-helper' } })
    ).resolves.toEqual({
      status: 'published',
      id: 'personal-analysis-helper',
      name: 'analysis-helper',
      origin: 'personal'
    })
    await expect(
      service.dispatch({
        op: 'read',
        params: { name: 'personal-analysis-helper', path: 'scripts/run.js' }
      })
    ).rejects.toThrow('require a loaded Skill resource grant')
    await expect(
      service.dispatch({ op: 'read', params: { name: 'personal-analysis-helper' } })
    ).resolves.toMatchObject({
      name: 'analysis-helper',
      path: 'SKILL.md',
      origin: 'personal'
    })
    await expect(
      readFile(join(root, 'skills', 'drafts', 'analysis-helper', 'SKILL.md'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('lists drafts and installed Skills without exposing host paths', async () => {
    const { service } = await makeFixture()
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'new-skill',
        path: 'SKILL.md',
        content: '---\nname: new-skill\ndescription: New skill.\n---\nBody.\n'
      }
    })

    const result = await service.dispatch({ op: 'list' })
    expect(result).toEqual([
      {
        id: 'literature-review',
        name: 'literature-review',
        displayName: 'Literature Review',
        description: 'Review literature.',
        origin: 'featured',
        editable: false
      },
      {
        id: 'draft-new-skill',
        name: 'new-skill',
        displayName: 'new-skill',
        description: 'New skill.',
        origin: 'draft',
        editable: true
      }
    ])
    expect(JSON.stringify(result)).not.toContain('/tmp/')
  })

  it('rejects path traversal and ambiguous or non-unique replacements', async () => {
    const { service } = await makeFixture()
    await expect(
      service.dispatch({
        op: 'edit',
        params: { name: 'bad', path: '../outside', content: 'x' }
      })
    ).rejects.toThrow('host.skills.edit: unsafe path')

    await service.dispatch({
      op: 'edit',
      params: { name: 'bad', path: 'SKILL.md', content: 'same same' }
    })
    await expect(
      service.dispatch({
        op: 'edit',
        params: { name: 'bad', path: 'SKILL.md', old_string: 'same', content: 'new' }
      })
    ).rejects.toThrow('exactly once')
  })

  it('serializes publish and delete across the complete draft mutation', async () => {
    const { service, catalog } = await makeFixture()
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'concurrent',
        path: 'SKILL.md',
        content: '---\nname: concurrent\ndescription: Concurrent draft.\n---\nBody.\n'
      }
    })

    const publishDirectory = catalog.publishPersonalDirectory
    let releasePublish!: () => void
    let publishStarted!: () => void
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve
    })
    const started = new Promise<void>((resolve) => {
      publishStarted = resolve
    })
    catalog.publishPersonalDirectory = async (...args) => {
      publishStarted()
      await publishGate
      return publishDirectory(...args)
    }

    const publishing = service.dispatch({ op: 'publish', params: { name: 'concurrent' } })
    await started
    let deleteSettled = false
    const deleting = service.dispatch({ op: 'delete', params: { name: 'draft-concurrent' } })
    void deleting.then(
      () => {
        deleteSettled = true
      },
      () => {
        deleteSettled = true
      }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    const deleteWaitedForPublish = !deleteSettled
    releasePublish()
    const results = await Promise.allSettled([publishing, deleting])

    expect(deleteWaitedForPublish).toBe(true)
    expect(results[0]).toMatchObject({ status: 'fulfilled' })
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('Unknown draft') })
    })
  })

  it('rejects extra SKILL.md frontmatter fields before publish', async () => {
    const { service, userSkills } = await makeFixture()
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'extra-metadata',
        path: 'SKILL.md',
        content:
          '---\nname: extra-metadata\ndescription: Invalid extra metadata.\nlicense: MIT\n---\nBody.\n'
      }
    })

    await expect(
      service.dispatch({ op: 'publish', params: { name: 'extra-metadata' } })
    ).rejects.toThrow('frontmatter may only contain name, displayName, and description')
    expect(await userSkills.list()).toHaveLength(0)
  })

  it('deletes an explicit draft without deleting its published Personal Skill', async () => {
    const { service, root, userSkills, approveDelete, reload } = await makeFixture()
    await userSkills.createPersonal({
      name: 'disposable',
      description: 'Delete me.',
      body: 'Published body.'
    })
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'personal-disposable',
        path: 'SKILL.md',
        old_string: 'Published body.',
        content: 'Draft body.'
      }
    })

    await expect(
      service.dispatch({ op: 'read', params: { name: 'draft-disposable' } })
    ).resolves.toMatchObject({ name: 'disposable', origin: 'draft' })
    await expect(
      service.dispatch({ op: 'delete', params: { name: 'disposable' } }, { sessionId: 'session-1' })
    ).rejects.toThrow('ambiguous')
    expect(approveDelete).not.toHaveBeenCalled()
    await expect(
      service.dispatch(
        { op: 'delete', params: { name: 'draft-disposable' } },
        { sessionId: 'session-1' }
      )
    ).resolves.toEqual({ status: 'deleted', operation: 'delete', name: 'disposable' })

    expect(approveDelete).toHaveBeenCalledWith(
      { name: 'disposable', origin: 'draft' },
      { sessionId: 'session-1' }
    )
    expect(await userSkills.list()).toHaveLength(1)
    expect(reload).not.toHaveBeenCalled()
    await expect(
      readFile(join(root, 'skills', 'drafts', 'disposable', 'SKILL.md'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('edits a draft by the stable id returned from list', async () => {
    const { service, userSkills } = await makeFixture()
    await userSkills.createPersonal({
      name: 'editable',
      description: 'Edit me.',
      body: 'Published body.'
    })
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'personal-editable',
        path: 'SKILL.md',
        old_string: 'Published body.',
        content: 'Draft body.'
      }
    })
    const drafts = (await service.dispatch({ op: 'list' })) as Array<{
      id: string
      origin: string
    }>
    const draftId = drafts.find(({ origin }) => origin === 'draft')?.id

    await service.dispatch({
      op: 'edit',
      params: {
        name: draftId,
        path: 'SKILL.md',
        old_string: 'Draft body.',
        content: 'Second draft.'
      }
    })

    await expect(
      service.dispatch({ op: 'read', params: { name: 'draft-editable' } })
    ).resolves.toMatchObject({ content: expect.stringContaining('Second draft.') })
  })

  it('allows a new Skill name to start with the draft prefix', async () => {
    const { service } = await makeFixture()

    await expect(
      service.dispatch({
        op: 'edit',
        params: {
          name: 'draft-review',
          path: 'SKILL.md',
          content: '---\nname: draft-review\ndescription: Review drafts.\n---\nBody.\n'
        }
      })
    ).resolves.toMatchObject({ status: 'edited', name: 'draft-review' })
    await expect(service.dispatch({ op: 'list' })).resolves.toContainEqual(
      expect.objectContaining({ id: 'draft-draft-review', name: 'draft-review' })
    )
  })

  it('resolves an exact published stable id before a colliding immutable name', async () => {
    const { service, userSkills } = await makeFixture()
    await userSkills.createPersonal({ name: 'foo', description: 'Exact id.', body: 'Exact body.' })
    await userSkills.createPersonal({
      name: 'personal-foo',
      description: 'Colliding name.',
      body: 'Collision body.'
    })

    await expect(
      service.dispatch({ op: 'read', params: { name: 'personal-foo' } })
    ).resolves.toMatchObject({ name: 'foo', content: expect.stringContaining('Exact body.') })
  })

  it('rejects an unqualified delete when a published display name matches a draft name', async () => {
    const { service, catalog, root, approveDelete } = await makeFixture()
    await service.dispatch({
      op: 'edit',
      params: {
        name: 'shared-name',
        path: 'SKILL.md',
        content: '---\nname: shared-name\ndescription: Draft.\n---\nDraft body.\n'
      }
    })
    const listPublished = catalog.list
    catalog.list = async () => [
      ...(await listPublished()),
      {
        id: 'custom-package-id',
        name: 'shared-name',
        displayName: 'Shared name',
        description: 'Published alias.',
        source: 'imported',
        updatedAt: '2026-08-09',
        sourceDir: root
      }
    ]

    await expect(
      service.dispatch(
        { op: 'delete', params: { name: 'shared-name' } },
        { sessionId: 'session-1' }
      )
    ).rejects.toThrow('ambiguous')
    expect(approveDelete).not.toHaveBeenCalled()
  })

  it('rejects reserved Skill names before creating a draft', async () => {
    const { service } = await makeFixture()

    for (const name of ['os-review', 'mcp-review']) {
      await expect(
        service.dispatch({
          op: 'edit',
          params: {
            name,
            path: 'SKILL.md',
            content: `---\nname: ${name}\ndescription: Reserved.\n---\nBody.\n`
          }
        })
      ).rejects.toThrow('os- or mcp-')
    }
    await expect(service.dispatch({ op: 'list' })).resolves.toHaveLength(1)
  })

  it('requires approval for delete and reports a decline as a normal result', async () => {
    const { service, userSkills, approveDelete, reload } = await makeFixture()
    await userSkills.createPersonal({
      name: 'disposable',
      description: 'Delete me.',
      body: 'Body.'
    })
    approveDelete.mockResolvedValueOnce(false)

    await expect(
      service.dispatch(
        { op: 'delete', params: { name: 'personal-disposable' } },
        { sessionId: 'session-1' }
      )
    ).resolves.toEqual({ status: 'declined', operation: 'delete' })
    expect(await userSkills.list()).toHaveLength(1)
    expect(reload).not.toHaveBeenCalled()

    await expect(
      service.dispatch(
        { op: 'delete', params: { name: 'personal-disposable' } },
        { sessionId: 'session-1' }
      )
    ).resolves.toEqual({ status: 'deleted', operation: 'delete', name: 'disposable' })
    expect(await userSkills.list()).toHaveLength(0)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

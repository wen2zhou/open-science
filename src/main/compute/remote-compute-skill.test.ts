import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseSkillDocument } from '../../shared/skill-frontmatter'

const skillPath = join(process.cwd(), 'resources', 'skills', 'remote-compute-ssh', 'SKILL.md')

describe('remote-compute-ssh immediate failure guidance', () => {
  it('keeps valid public Skill identity metadata', async () => {
    const skill = parseSkillDocument(await readFile(skillPath, 'utf8'))
    expect(skill).toMatchObject({
      name: 'remote-compute-ssh',
      hasFrontmatter: true
    })
    expect(skill.description).toBeTruthy()
  })

  it('requires exactly one short bounded status check after asynchronous submission', async () => {
    const skill = await readFile(skillPath, 'utf8')
    const section = skill.match(
      /### Immediate failure check after submission([\s\S]*?)### Harvest safety boundaries/
    )?.[1]

    expect(section).toBeDefined()
    expect(section).toContain('setTimeout')
    const delayMs = Number(section?.match(/setTimeout\([^,]+,\s*(\d+)\)/)?.[1])
    expect(delayMs).toBeGreaterThanOrEqual(500)
    expect(delayMs).toBeLessThanOrEqual(5000)
    expect(section?.match(/\.status\(\)/g)).toHaveLength(1)
    expect(section).not.toMatch(/\b(?:while|for)\s*\(/)
    expect(section).toContain('Do not wait again')
  })
})

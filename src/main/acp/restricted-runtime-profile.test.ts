import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { claudeCodeFramework, codexFramework, opencodeFramework } from '../agent-framework'
import type { ResolvedAgentBackend } from '../agent-framework'
import { prepareRestrictedBackend } from './restricted-runtime-profile'

const roots: string[] = []
const profileRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'restricted-runtime-profile-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const backend = (
  framework: ResolvedAgentBackend['framework'],
  env: Record<string, string> = {}
): ResolvedAgentBackend => ({
  framework,
  executablePath: '/runtime/agent',
  env: {
    ...env,
    OPEN_SCIENCE_SKILL_RUNTIME_ROOT: '/projection/g-1/skills',
    OPEN_SCIENCE_SKILL_DISCOVERY_ROOT: '/projection/discovery/b-1',
    OPEN_SCIENCE_SKILL_RUNTIME_GENERATION_ROOT: '/projection/g-1'
  },
  sessionOptions: {
    additionalDirectories: ['/projection/g-1'],
    plugins: [{ type: 'local', path: '/projection/g-1' }],
    skills: ['research']
  },
  skillRuntime: {
    generationRoot: '/projection/g-1',
    skillsRoot: '/projection/g-1/skills',
    discoveryRoot: '/projection/discovery/b-1',
    descriptors: [
      {
        id: 'research',
        name: 'research',
        description: 'Research papers.',
        path: '/projection/g-1/skills/research/SKILL.md'
      }
    ],
    environment: {}
  },
  skillRuntimeLease: { release: vi.fn(async () => undefined) }
})

const profile = {
  agentName: 'restricted',
  description: 'Restricted runtime.',
  systemPrompt: 'Use only the approved tool.',
  openCodePermissions: { '*': 'deny' as const }
}

describe('prepareRestrictedBackend Skill isolation', () => {
  it.each([
    ['claude', claudeCodeFramework, {}],
    [
      'opencode',
      opencodeFramework,
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          skills: { paths: ['/projection/g-1/skills/research'] }
        })
      }
    ],
    ['codex', codexFramework, { CODEX_CONFIG: '{}' }]
  ] as const)(
    'removes projected discovery from a %s restricted profile while retaining its lease',
    async (_name, framework, env) => {
      const original = backend(framework, env)

      const restricted = await prepareRestrictedBackend(original, await profileRoot(), profile)

      expect(restricted.skillRuntime).toBeUndefined()
      expect(restricted.skillRuntimeHandoff).toBeUndefined()
      expect(restricted.env.OPEN_SCIENCE_SKILL_RUNTIME_ROOT).toBeUndefined()
      expect(restricted.env.OPEN_SCIENCE_SKILL_DISCOVERY_ROOT).toBeUndefined()
      expect(restricted.env.OPEN_SCIENCE_SKILL_RUNTIME_GENERATION_ROOT).toBeUndefined()
      expect(restricted.skillRuntimeLease).toBe(original.skillRuntimeLease)
      expect(restricted.sessionOptions).toMatchObject({
        additionalDirectories: [],
        plugins: [],
        skills: []
      })
      if (framework.id === 'opencode') {
        expect(JSON.parse(restricted.env.OPENCODE_CONFIG_CONTENT)).not.toHaveProperty('skills')
      }
    }
  )
})

import { describe, expect, it } from 'vitest'

import type { SpecialistPackageCatalogSnapshot } from '../../../shared/specialist-package'
import { validateSpecialistPackage } from './validator'

const encoder = new TextEncoder()

const files = (
  manifest: unknown,
  specialist: unknown
): Array<{ path: string; bytes: Uint8Array }> => [
  { path: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest)) },
  { path: 'specialist.json', bytes: encoder.encode(JSON.stringify(specialist)) }
]

const catalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.9.2',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: ['reviewer']
}

const validManifest = {
  schema_version: 1,
  id: 'rna-reviewer',
  version: '1.2.3',
  requires_app: '>=0.9.0 <1.0.0',
  skills: { builtin: [], required: [], bundled: [] }
}

const validSpecialist = {
  name: 'RNA Reviewer',
  description: 'Reviews RNA-seq experiments.',
  systemPrompt: 'Private identity instructions that must never appear in diagnostics.',
  capabilityMode: 'selected',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
}

describe('validateSpecialistPackage', () => {
  it('rejects package attempts to control the installed enabled state', () => {
    const result = validateSpecialistPackage(
      files(validManifest, { ...validSpecialist, enabled: false }),
      catalog,
      'zip'
    )

    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'specialist.enabled-field-forbidden',
        path: 'specialist.json'
      })
    )
  })

  it('returns a renderer-safe preview and immutable plan for a valid package', () => {
    const result = validateSpecialistPackage(files(validManifest, validSpecialist), catalog, 'zip')

    expect(result.preview).toEqual({
      summary: {
        id: 'rna-reviewer',
        version: '1.2.3',
        name: 'RNA Reviewer',
        description: 'Reviews RNA-seq experiments.',
        source: 'zip',
        requiresApp: '>=0.9.0 <1.0.0',
        bundledSkillIds: [],
        requiredSkillIds: [],
        builtinSkillIds: [],
        connectorIds: [],
        skills: []
      },
      diagnostics: [],
      installable: true
    })
    expect(result.plan).toMatchObject({
      specialistId: 'rna-reviewer',
      packageVersion: '1.2.3',
      source: 'zip'
    })
    expect(result.plan?.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(result.plan)).toBe(true)
    expect(Object.isFrozen(result.plan?.manifest.skills)).toBe(true)
    expect(Object.isFrozen(result.plan?.payload.selectedCapabilities.connectorTools)).toBe(true)
    expect(JSON.stringify(result.preview)).not.toContain(validSpecialist.systemPrompt)
  })

  it('strictly parses untrusted JSON and aggregates independent schema errors', () => {
    const result = validateSpecialistPackage(
      files(
        {
          schema_version: 99,
          id: '../reviewer',
          version: 'latest',
          requires_app: 42,
          skills: { builtin: 'all', required: [], bundled: [] }
        },
        {
          id: 'identity-must-not-live-here',
          version: '9.9.9',
          name: 42,
          description: [],
          systemPrompt: { token: 'must-not-leak' },
          enabled: 'yes',
          capabilityMode: 'everything',
          fullAccess: {},
          selectedCapabilities: {}
        }
      ),
      catalog,
      'zip'
    )

    expect(result.plan).toBeUndefined()
    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'manifest.schema-version-unsupported',
        'manifest.id-invalid',
        'manifest.version-invalid',
        'manifest.requires-app-invalid',
        'manifest.skills-builtin-invalid',
        'specialist.identity-field-forbidden',
        'specialist.name-invalid',
        'specialist.description-invalid',
        'specialist.system-prompt-invalid',
        'specialist.enabled-field-forbidden',
        'specialist.capability-mode-invalid',
        'specialist.full-access-invalid',
        'specialist.selected-capabilities-invalid'
      ])
    )
    expect(result.preview.diagnostics.every((diagnostic) => diagnostic.severity === 'error')).toBe(
      true
    )
    expect(JSON.stringify(result.preview)).not.toContain('must-not-leak')
  })

  it('uses the current schema with a warning when schema_version is absent', () => {
    const unversionedManifest = { ...validManifest, schema_version: undefined }
    const result = validateSpecialistPackage(
      files(unversionedManifest, validSpecialist),
      catalog,
      'directory'
    )

    expect(result.preview.installable).toBe(true)
    expect(result.preview.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'manifest.schema-version-missing',
        message: 'schema_version is missing; the current package schema was used.',
        path: 'manifest.json'
      }
    ])
    expect(result.plan?.manifest.schema_version).toBe(1)
  })

  it('blocks an application version outside the declared SemVer range', () => {
    const result = validateSpecialistPackage(
      files({ ...validManifest, requires_app: '>=1.0.0 <2.0.0' }, validSpecialist),
      catalog,
      'zip'
    )

    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics).toContainEqual({
      severity: 'error',
      code: 'compatibility.app-incompatible',
      message: 'This package is not compatible with the current application version.',
      path: 'manifest.json',
      relatedId: '0.9.2'
    })
  })

  it('allows a missing application range with a compatibility warning', () => {
    const withoutRange = { ...validManifest, requires_app: undefined }
    const result = validateSpecialistPackage(files(withoutRange, validSpecialist), catalog, 'zip')

    expect(result.preview.installable).toBe(true)
    expect(result.preview.diagnostics).toContainEqual({
      severity: 'warning',
      code: 'compatibility.app-range-missing',
      message: 'Application compatibility is not declared; the current version will be inferred.',
      path: 'manifest.json',
      relatedId: '0.9.2'
    })
  })

  it('treats an unversioned non-builtin Skill as version 0.1.0', () => {
    const manifest = {
      ...validManifest,
      skills: {
        ...validManifest.skills,
        required: [{ id: 'legacy-skill', version_range: '^0.1.0' }]
      }
    }
    const compatible = validateSpecialistPackage(
      files(manifest, validSpecialist),
      { ...catalog, skills: [{ id: 'legacy-skill', builtin: false }] },
      'zip'
    )
    const incompatible = validateSpecialistPackage(
      files(
        {
          ...manifest,
          skills: {
            ...manifest.skills,
            required: [{ id: 'legacy-skill', version_range: '>=0.2.0' }]
          }
        },
        validSpecialist
      ),
      { ...catalog, skills: [{ id: 'legacy-skill', builtin: false }] },
      'zip'
    )

    expect(compatible.preview.installable).toBe(true)
    expect(incompatible.preview.diagnostics).toContainEqual({
      severity: 'error',
      code: 'dependency.skill-incompatible',
      message: 'An installed Skill does not satisfy the required version range.',
      path: 'manifest.json',
      relatedId: 'legacy-skill'
    })
  })

  it('plans a complete bundled Skill directory without executing its scripts', () => {
    const manifest = {
      ...validManifest,
      skills: {
        builtin: [],
        required: [{ id: 'analysis-tools', version_range: '^1.2.0' }],
        bundled: [{ id: 'analysis-tools', version: '1.2.3', path: 'skills/analysis-tools' }]
      }
    }
    const result = validateSpecialistPackage(
      [
        ...files(manifest, validSpecialist),
        {
          path: 'skills/analysis-tools/SKILL.md',
          bytes: encoder.encode('---\nname: analysis-tools\ndescription: Analyze data\n---\nBody')
        },
        {
          path: 'skills/analysis-tools/scripts/run.sh',
          bytes: encoder.encode('exit 99')
        },
        { path: 'skills/analysis-tools/references/guide.md', bytes: encoder.encode('Guide') },
        { path: 'skills/analysis-tools/assets/icon.png', bytes: encoder.encode('image') },
        { path: 'skills/analysis-tools/templates/report.md', bytes: encoder.encode('Template') }
      ],
      catalog,
      'zip'
    )

    expect(result.preview.installable).toBe(true)
    expect(result.preview.summary?.skills).toEqual([
      expect.objectContaining({
        id: 'analysis-tools',
        version: '1.2.3',
        disposition: 'install',
        files: [
          'SKILL.md',
          'assets/icon.png',
          'references/guide.md',
          'scripts/run.sh',
          'templates/report.md'
        ]
      })
    ])
    expect(result.plan?.skills).toEqual([
      expect.objectContaining({ id: 'analysis-tools', disposition: 'install' })
    ])
    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'skill.executable-content-present',
        relatedId: 'analysis-tools'
      })
    )
  })

  it('requires referenced builtin Skills to have the declared compatibility identity', () => {
    const manifest = {
      ...validManifest,
      skills: {
        ...validManifest.skills,
        builtin: [{ id: 'literature-review', app_version: '0.8.0', compatibility: 'sha256:stable' }]
      }
    }
    const available = {
      ...catalog,
      builtinSkills: [
        { id: 'literature-review', appVersion: '0.9.2', compatibility: 'sha256:stable' }
      ]
    }

    expect(
      validateSpecialistPackage(files(manifest, validSpecialist), available, 'zip').preview
        .installable
    ).toBe(true)
    const incompatible = validateSpecialistPackage(
      files(manifest, validSpecialist),
      {
        ...available,
        builtinSkills: [
          { id: 'literature-review', appVersion: '0.9.2', compatibility: 'sha256:changed' }
        ]
      },
      'zip'
    )
    expect(incompatible.preview.diagnostics).toContainEqual({
      severity: 'error',
      code: 'dependency.builtin-skill-incompatible',
      message: 'A builtin Skill has an incompatible identity.',
      path: 'manifest.json',
      relatedId: 'literature-review'
    })
  })

  it('blocks a bundled Skill collision when the installed version or digest differs', () => {
    const manifest = {
      ...validManifest,
      skills: {
        ...validManifest.skills,
        bundled: [{ id: 'analysis', version: '2.0.0', path: 'skills/analysis' }]
      }
    }
    const result = validateSpecialistPackage(
      [
        ...files(manifest, validSpecialist),
        { path: 'skills/analysis/SKILL.md', bytes: encoder.encode('# Analysis') }
      ],
      {
        ...catalog,
        skills: [{ id: 'analysis', version: '1.0.0', builtin: false, contentDigest: 'different' }]
      },
      'zip'
    )

    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'dependency.bundled-skill-conflict',
        relatedId: 'analysis'
      })
    )
  })

  it('fails builtin conformance for bundled files, non-builtin dependencies, and protected IDs', () => {
    const manifest = {
      ...validManifest,
      id: 'reviewer',
      skills: {
        builtin: [],
        required: [{ id: 'custom-analysis', version_range: '^1.0.0' }],
        bundled: [{ id: 'bundled-analysis', version: '1.0.0', path: 'skills/bundled-analysis' }]
      }
    }
    const result = validateSpecialistPackage(
      [
        ...files(manifest, validSpecialist),
        { path: 'skills/bundled-analysis/SKILL.md', bytes: encoder.encode('# Never execute me') }
      ],
      {
        ...catalog,
        skills: [{ id: 'custom-analysis', version: '1.0.0', builtin: false }]
      },
      'builtin'
    )

    expect(result.preview.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'specialist.id-protected',
        'builtin.bundled-skills-forbidden',
        'builtin.non-builtin-dependency-forbidden'
      ])
    )
    expect(result.preview.installable).toBe(false)
  })

  it.each(['os-owned', 'mcp-owned'])('reuses the reserved Skill namespace rule for ID %s', (id) => {
    const result = validateSpecialistPackage(
      files({ ...validManifest, id }, validSpecialist),
      catalog,
      'zip'
    )

    expect(result.preview.diagnostics).toContainEqual({
      severity: 'error',
      code: 'manifest.id-invalid',
      message: 'Package ID is invalid.',
      path: 'manifest.json'
    })
  })

  it('preserves a missing Connector reference as a warning without reading configuration', () => {
    const specialist = {
      ...validSpecialist,
      selectedCapabilities: {
        skillIds: [],
        connectorIds: ['missing-zotero'],
        connectorTools: [
          {
            connectorId: 'missing-zotero',
            includedMethods: ['search'],
            excludeToolsPattern: '^admin'
          }
        ]
      }
    }
    const result = validateSpecialistPackage(files(validManifest, specialist), catalog, 'zip')

    expect(result.preview.installable).toBe(true)
    expect(result.preview.summary?.connectorIds).toEqual(['missing-zotero'])
    expect(result.preview.diagnostics).toContainEqual({
      severity: 'warning',
      code: 'connector.unavailable',
      message: 'A referenced Connector is not available in this application.',
      path: 'specialist.json',
      relatedId: 'missing-zotero'
    })
  })

  it('rejects Connector configuration and credentials without exposing their values', () => {
    const result = validateSpecialistPackage(
      files(validManifest, {
        ...validSpecialist,
        connectorConfig: { url: '/absolute/host/path', token: 'credential-value' }
      }),
      catalog,
      'zip'
    )

    expect(result.preview.diagnostics).toContainEqual({
      severity: 'error',
      code: 'specialist.field-forbidden',
      message: 'The Specialist payload contains a forbidden field.',
      path: 'specialist.json'
    })
    expect(JSON.stringify(result.preview)).not.toMatch(/credential-value|absolute\/host/)
  })
})

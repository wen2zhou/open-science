import { join } from 'node:path'

import { strToU8, zipSync, type Zippable } from 'fflate'

import {
  SPECIALIST_PACKAGE_SCHEMA_VERSION,
  type ContributionTemplateExportResult
} from '../../../shared/specialist-package'

export const CONTRIBUTION_TEMPLATE_FILENAME = 'openscience-specialist-template.zip'

export const resolveContributionTemplateReadmePath = (appPath: string): string =>
  join(appPath, 'resources', 'specialists', 'template', 'v1', 'README.md').replace(
    /([/\\])app\.asar([/\\])/,
    '$1app.asar.unpacked$2'
  )

type ContributionTemplateExporterDependencies = {
  appVersion: string
  showSaveDialog: (options: {
    title: string
    defaultPath: string
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ canceled: boolean; filePath?: string }>
  readReadme: () => Promise<string>
  writeFile: (filePath: string, bytes: Uint8Array) => Promise<void>
}

const compatibilityRange = (appVersion: string): string => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(appVersion)
  if (!match) throw new Error('Application version must be SemVer.')
  const major = Number(match[1])
  return `>=${appVersion} <${major + 1}.0.0`
}

export const buildDeterministicSpecialistZip = (
  files: Readonly<Record<string, Uint8Array>>
): Uint8Array => {
  const zipOptions = { mtime: new Date('1980-01-01T00:00:00.000Z') }
  const entries: Zippable = {}
  for (const [path, bytes] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    entries[path] = [bytes, zipOptions]
  }
  return zipSync(entries, { level: 6 })
}

export const buildContributionTemplateZip = (input: {
  appVersion: string
  readme: string
}): Uint8Array => {
  const manifest = {
    schema_version: SPECIALIST_PACKAGE_SCHEMA_VERSION,
    id: '<specialist-id>',
    version: '0.1.0',
    exported_with_app_version: input.appVersion,
    requires_app: compatibilityRange(input.appVersion),
    skills: { builtin: [], required: [], bundled: [] }
  }
  const specialist = {
    name: '',
    description: '',
    systemPrompt: '',
    capabilityMode: 'selected',
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
  }
  return buildDeterministicSpecialistZip({
    'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    'specialist.json': strToU8(`${JSON.stringify(specialist, null, 2)}\n`),
    'README.md': strToU8(input.readme)
  })
}

export const createContributionTemplateExporter =
  (
    dependencies: ContributionTemplateExporterDependencies
  ): (() => Promise<ContributionTemplateExportResult>) =>
  async () => {
    const destination = await dependencies.showSaveDialog({
      title: 'Save contribution template',
      defaultPath: CONTRIBUTION_TEMPLATE_FILENAME,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
    })
    if (destination.canceled || !destination.filePath) return { saved: false }

    try {
      const readme = await dependencies.readReadme()
      const archive = buildContributionTemplateZip({ appVersion: dependencies.appVersion, readme })
      await dependencies.writeFile(destination.filePath, archive)
      return { saved: true }
    } catch {
      throw new Error('Could not save contribution template.')
    }
  }

import { unzipSync } from 'fflate'

import type {
  SpecialistPackageCatalogSnapshot,
  SpecialistPackageValidationResult
} from '../../../shared/specialist-package'
import { validateSpecialistPackage, type SpecialistPackageFile } from './validator'

const unsafePath = (path: string): boolean =>
  path.startsWith('/') ||
  path.startsWith('\\') ||
  /^[A-Za-z]:/.test(path) ||
  path.includes('\\') ||
  path.split('/').some((segment) => segment === '..' || segment === '')

const normalizedFiles = (
  archive: Record<string, Uint8Array>
): SpecialistPackageFile[] | undefined => {
  const entries = Object.entries(archive).filter(([path]) => !path.endsWith('/'))
  if (entries.some(([path]) => unsafePath(path))) return undefined
  const rootManifest = entries.some(([path]) => path === 'manifest.json')
  const wrapperCandidates = [
    ...new Set(
      entries
        .filter(([path]) => path.split('/').length === 2 && path.endsWith('/manifest.json'))
        .map(([path]) => path.split('/')[0])
    )
  ]
  if (!rootManifest && wrapperCandidates.length !== 1) return undefined
  if (rootManifest && wrapperCandidates.length > 0) return undefined
  const prefix = rootManifest ? '' : `${wrapperCandidates[0]}/`
  if (prefix && entries.some(([path]) => !path.startsWith(prefix))) return undefined
  return entries
    .map(([path, bytes]) => ({ path: prefix ? path.slice(prefix.length) : path, bytes }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

export const validateSpecialistZip = (
  archiveBytes: Uint8Array,
  catalog: SpecialistPackageCatalogSnapshot
): SpecialistPackageValidationResult => {
  try {
    const files = normalizedFiles(unzipSync(archiveBytes))
    if (!files) {
      return {
        preview: {
          diagnostics: [
            {
              severity: 'error',
              code: 'package.archive-layout-invalid',
              message: 'The ZIP must contain one safe root package or one wrapper directory.'
            }
          ],
          installable: false
        }
      }
    }
    return validateSpecialistPackage(files, catalog, 'zip')
  } catch {
    return {
      preview: {
        diagnostics: [
          {
            severity: 'error',
            code: 'package.archive-invalid',
            message: 'The selected file is not a readable ZIP package.'
          }
        ],
        installable: false
      }
    }
  }
}

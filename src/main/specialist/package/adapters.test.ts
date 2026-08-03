import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import type { SpecialistPackageCatalogSnapshot } from '../../../shared/specialist-package'
import { validateSpecialistDirectory } from './directory-adapter'
import { validateSpecialistZip } from './zip-adapter'

const fixtureRoot = join(import.meta.dirname, 'test-fixtures', 'valid')
const invalidFixtureRoot = join(import.meta.dirname, 'test-fixtures', 'invalid')
const multiErrorFixtureRoot = join(import.meta.dirname, 'test-fixtures', 'multi-error')
const catalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.9.2',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: ['reviewer']
}

describe('Specialist package source adapters', () => {
  it('rejects ZIP entries marked as symbolic links', async () => {
    const zip = zipSync({
      'manifest.json': new Uint8Array(await readFile(join(fixtureRoot, 'manifest.json'))),
      'specialist.json': new Uint8Array(await readFile(join(fixtureRoot, 'specialist.json')))
    })
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    let centralOffset = -1
    for (let index = 0; index <= zip.length - 4; index += 1) {
      if (view.getUint32(index, true) === 0x02014b50) {
        centralOffset = index
        break
      }
    }
    expect(centralOffset).toBeGreaterThanOrEqual(0)
    zip[centralOffset + 5] = 3
    view.setUint32(centralOffset + 38, 0o120777 << 16, true)

    const result = validateSpecialistZip(zip, catalog)

    expect(result.preview).toEqual({
      diagnostics: [
        expect.objectContaining({
          severity: 'error',
          code: 'package.symbolic-link-forbidden'
        })
      ],
      installable: false
    })
  })

  it('feeds directory files and real ZIP bytes through the same validation core', async () => {
    const zip = zipSync({
      'manifest.json': new Uint8Array(await readFile(join(fixtureRoot, 'manifest.json'))),
      'specialist.json': new Uint8Array(await readFile(join(fixtureRoot, 'specialist.json'))),
      'README.md': new Uint8Array(await readFile(join(fixtureRoot, 'README.md')))
    })

    const directory = await validateSpecialistDirectory(fixtureRoot, catalog)
    const archive = validateSpecialistZip(zip, catalog)

    expect(directory.preview.installable).toBe(true)
    expect(archive.preview.installable).toBe(true)
    expect(directory.preview.diagnostics).toEqual(archive.preview.diagnostics)
    expect(directory.plan?.contentHash).toBe(archive.plan?.contentHash)
    expect(directory.preview.summary).toEqual({
      ...archive.preview.summary,
      source: 'directory'
    })
  })

  it('accepts Finder-created wrapper archives with macOS metadata', async () => {
    const packageFiles = Object.fromEntries(
      await Promise.all(
        ['manifest.json', 'specialist.json', 'README.md'].map(async (fileName) => [
          `openscience-specialist-template/${fileName}`,
          new Uint8Array(await readFile(join(fixtureRoot, fileName)))
        ])
      )
    )
    const zip = zipSync({
      ...packageFiles,
      '__MACOSX/openscience-specialist-template/._manifest.json': new Uint8Array([1, 2, 3]),
      '__MACOSX/openscience-specialist-template/._specialist.json': new Uint8Array([4, 5, 6])
    })

    const archive = validateSpecialistZip(zip, catalog)

    expect(archive.preview.installable).toBe(true)
    expect(archive.preview.summary).toMatchObject({
      id: 'fixture-specialist',
      name: 'Fixture Specialist'
    })
  })

  it('rejects forbidden root content identically without executing it', async () => {
    const zip = zipSync({
      'manifest.json': new Uint8Array(await readFile(join(invalidFixtureRoot, 'manifest.json'))),
      'specialist.json': new Uint8Array(
        await readFile(join(invalidFixtureRoot, 'specialist.json'))
      ),
      'run.sh': new Uint8Array(await readFile(join(invalidFixtureRoot, 'run.sh')))
    })

    const directory = await validateSpecialistDirectory(invalidFixtureRoot, catalog)
    const archive = validateSpecialistZip(zip, catalog)
    const expected = {
      severity: 'error',
      code: 'package.top-level-content-forbidden',
      message: 'The package contains unsupported top-level content.',
      path: 'run.sh'
    }

    expect(directory.preview.diagnostics).toContainEqual(expected)
    expect(archive.preview.diagnostics).toEqual(directory.preview.diagnostics)
    expect(directory.preview.installable).toBe(false)
  })

  it('aggregates the same multi-error fixture diagnostics through either adapter', async () => {
    const zip = zipSync({
      'manifest.json': new Uint8Array(await readFile(join(multiErrorFixtureRoot, 'manifest.json'))),
      'specialist.json': new Uint8Array(
        await readFile(join(multiErrorFixtureRoot, 'specialist.json'))
      )
    })

    const directory = await validateSpecialistDirectory(multiErrorFixtureRoot, catalog)
    const archive = validateSpecialistZip(zip, catalog)

    expect(directory.preview.diagnostics).toEqual(archive.preview.diagnostics)
    expect(
      directory.preview.diagnostics.filter((item) => item.severity === 'error').length
    ).toBeGreaterThan(8)
    expect(JSON.stringify(directory.preview)).not.toContain('must-not-leak')
  })

  it('rejects hard-linked package files before validation reads their content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specialist-hardlink-'))
    try {
      await mkdir(join(root, 'skills', 'analysis-tools', 'assets'), { recursive: true })
      await writeFile(
        join(root, 'manifest.json'),
        await readFile(join(fixtureRoot, 'manifest.json'))
      )
      await writeFile(
        join(root, 'specialist.json'),
        await readFile(join(fixtureRoot, 'specialist.json'))
      )
      await writeFile(join(root, 'skills', 'analysis-tools', 'assets', 'source.txt'), 'secret')
      await link(
        join(root, 'skills', 'analysis-tools', 'assets', 'source.txt'),
        join(root, 'skills', 'analysis-tools', 'assets', 'linked.txt')
      )

      const result = await validateSpecialistDirectory(root, catalog)

      expect(result.preview.installable).toBe(false)
      expect(result.preview.diagnostics).toEqual([
        expect.objectContaining({ code: 'package.hard-link-forbidden' })
      ])
      expect(JSON.stringify(result.preview)).not.toContain('secret')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

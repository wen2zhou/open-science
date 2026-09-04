import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const sha256 = (relativePath: string): string =>
  createHash('sha256')
    .update(readFileSync(resolve(packageRoot, relativePath)))
    .digest('hex')

describe('Notebook network sandbox resources', () => {
  it.each([
    [
      'vendor/windows/x64/notebook-appcontainer-host.exe',
      'aaf848d0dd65bbefb396f2c6e83c575c167e8ed7bcfb045603b99f1ebd67cd9c'
    ],
    [
      'vendor/windows/arm64/notebook-appcontainer-host.exe',
      'dd4ca088a17f242e59275987ec5cac91454625d9985713d4668275fd438fdcd5'
    ]
  ])('verifies %s', (relativePath, expectedHash) => {
    expect(sha256(relativePath)).toBe(expectedHash)
  })
})

import { describe, expect, it } from 'vitest'

import type { LegacyDirectHandle } from './remote-handle'
import { parseRemoteHandle } from './remote-handle'

const legacy: LegacyDirectHandle = {
  pid: 4242,
  exit_code_path: '/scratch/wd/exit_code',
  stdout_path: '/scratch/wd/stdout',
  stderr_path: '/scratch/wd/stderr',
  workdir: '/scratch/wd'
}

describe('parseRemoteHandle — empty / invalid', () => {
  it('returns null for undefined', () => {
    expect(parseRemoteHandle(undefined)).toBeNull()
  })
  it('returns null for null', () => {
    expect(parseRemoteHandle(null)).toBeNull()
  })
  it('returns null for empty string', () => {
    expect(parseRemoteHandle('')).toBeNull()
  })
  it('returns null for malformed JSON', () => {
    expect(parseRemoteHandle('{not json')).toBeNull()
  })
  it('returns null for a JSON array', () => {
    expect(parseRemoteHandle('[1,2,3]')).toBeNull()
  })
  it('returns null for a v1 object missing required paths', () => {
    expect(
      parseRemoteHandle(
        JSON.stringify({ version: 1, driver: 'direct', pid: 1, pgid: 1, paths: {} })
      )
    ).toBeNull()
  })
})

describe('parseRemoteHandle — legacy PID JSON', () => {
  it('parses the existing Direct dispatcher handle as legacy-direct', () => {
    const parsed = parseRemoteHandle(JSON.stringify(legacy))
    expect(parsed?.kind).toBe('legacy-direct')
    if (parsed?.kind !== 'legacy-direct') throw new Error('expected legacy-direct')
    expect(parsed.pid).toBe(4242)
    expect(parsed.paths.exitCode).toBe('/scratch/wd/exit_code')
    expect(parsed.paths.stdout).toBe('/scratch/wd/stdout')
    expect(parsed.paths.workdir).toBe('/scratch/wd')
    expect(parsed.raw).toEqual(legacy)
  })

  it('treats a bare {pid:number} object as legacy-direct (design §4.3 reader rule)', () => {
    const parsed = parseRemoteHandle(JSON.stringify({ pid: 7 }))
    expect(parsed?.kind).toBe('legacy-direct')
    if (parsed?.kind !== 'legacy-direct') throw new Error('expected legacy-direct')
    expect(parsed.pid).toBe(7)
  })

  it('returns null when the legacy object has no numeric pid', () => {
    expect(parseRemoteHandle(JSON.stringify({ pid: 'abc' }))).toBeNull()
    expect(parseRemoteHandle(JSON.stringify({ foo: 1 }))).toBeNull()
  })
})

describe('parseRemoteHandle — versioned v1', () => {
  const paths = { workdir: '/w', stdout: '/w/o', stderr: '/w/e', exitCode: '/w/x' }

  it('parses a versioned direct handle', () => {
    const parsed = parseRemoteHandle(
      JSON.stringify({ version: 1, driver: 'direct', pid: 9, pgid: 8, paths })
    )
    expect(parsed?.kind).toBe('direct-v1')
    if (parsed?.kind !== 'direct-v1') throw new Error('expected direct-v1')
    expect(parsed.pid).toBe(9)
    expect(parsed.raw.pgid).toBe(8)
    expect(parsed.paths.exitCode).toBe('/w/x')
  })

  it('defaults pgid to pid when omitted (keeps the row readable)', () => {
    const parsed = parseRemoteHandle(
      JSON.stringify({ version: 1, driver: 'direct', pid: 9, paths })
    )
    expect(parsed?.kind).toBe('direct-v1')
    if (parsed?.kind !== 'direct-v1') throw new Error('expected direct-v1')
    expect(parsed.raw.pgid).toBe(9)
  })

  it('parses a versioned slurm handle', () => {
    const parsed = parseRemoteHandle(
      JSON.stringify({ version: 1, driver: 'slurm', schedulerJobId: '12345', paths })
    )
    expect(parsed?.kind).toBe('slurm-v1')
    if (parsed?.kind !== 'slurm-v1') throw new Error('expected slurm-v1')
    expect(parsed.schedulerJobId).toBe('12345')
    expect(parsed.paths.stdout).toBe('/w/o')
  })

  it('returns null for a slurm v1 handle missing schedulerJobId', () => {
    expect(
      parseRemoteHandle(JSON.stringify({ version: 1, driver: 'slurm', paths }))
    ).toBeNull()
  })

  it('returns null for an unknown driver on a v1 handle', () => {
    expect(
      parseRemoteHandle(JSON.stringify({ version: 1, driver: 'pbs', paths }))
    ).toBeNull()
  })
})

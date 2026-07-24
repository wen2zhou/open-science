import { describe, expect, it } from 'vitest'

import {
  extractDirectiveBlock,
  parseAllowedDirectives,
  type ParseDirectivesResult
} from './slurm-directives'
import type { ResourceRequest } from '../../shared/compute-resources'

describe('extractDirectiveBlock', () => {
  it('extracts a contiguous leading #SBATCH block', () => {
    const script = [
      '#!/bin/bash',
      '#SBATCH --mail-type=END',
      '#SBATCH --export=ALL',
      '',
      'echo hello'
    ].join('\n')
    expect(extractDirectiveBlock(script)).toEqual([
      '#SBATCH --mail-type=END',
      '#SBATCH --export=ALL'
    ])
  })

  it('stops at the first non-directive, non-comment line', () => {
    const script = [
      '#!/bin/bash',
      '#SBATCH --mail-type=END',
      'echo start',
      '#SBATCH --export=ALL',
      ''
    ].join('\n')
    // The second directive is NOT contiguous (echo start breaks the block) — ignored.
    expect(extractDirectiveBlock(script)).toEqual(['#SBATCH --mail-type=END'])
  })

  it('treats a shebang and plain comments as still leading (does not break the block)', () => {
    const script = [
      '#!/bin/bash',
      '# a comment',
      '#SBATCH --mail-type=END',
      '#SBATCH --export=ALL',
      'echo hello'
    ].join('\n')
    expect(extractDirectiveBlock(script)).toEqual([
      '#SBATCH --mail-type=END',
      '#SBATCH --export=ALL'
    ])
  })

  it('handles blank lines inside the leading block without breaking it', () => {
    const script = [
      '#!/bin/bash',
      '#SBATCH --mail-type=END',
      '',
      '#SBATCH --export=ALL',
      'echo hello'
    ].join('\n')
    expect(extractDirectiveBlock(script)).toEqual([
      '#SBATCH --mail-type=END',
      '#SBATCH --export=ALL'
    ])
  })

  it('returns empty when there is no directive block', () => {
    expect(extractDirectiveBlock('echo hello\n#SBATCH --x=1')).toEqual([])
  })
})

describe('parseAllowedDirectives', () => {
  const ok = (script: string, resources: ResourceRequest = {}): ParseDirectivesResult =>
    parseAllowedDirectives(script, resources)

  it('accepts an allowed directive like mail-type', () => {
    const r = ok('#!/bin/bash\n#SBATCH --mail-type=END\necho hi')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.directives).toEqual([{ key: 'mail-type', value: 'END' }])
  })

  it('rejects --job-name (reserved)', () => {
    const r = ok('#SBATCH --job-name=mine\necho hi')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/job-name/)
  })

  it('rejects --output (reserved, controls stdout)', () => {
    const r = ok('#SBATCH --output=foo\necho hi')
    expect(r.ok).toBe(false)
  })

  it('rejects --error (reserved, controls stderr)', () => {
    const r = ok('#SBATCH --error=bar\necho hi')
    expect(r.ok).toBe(false)
  })

  it('rejects --chdir and --workdir (reserved)', () => {
    expect(ok('#SBATCH --chdir=/tmp\necho hi').ok).toBe(false)
    expect(ok('#SBATCH --workdir=/tmp\necho hi').ok).toBe(false)
  })

  it('rejects --array (reserved)', () => {
    expect(ok('#SBATCH --array=1-10\necho hi').ok).toBe(false)
  })

  it('rejects --wrap (reserved)', () => {
    expect(ok('#SBATCH --wrap=echo\necho hi').ok).toBe(false)
  })

  it('rejects a directive that conflicts with structured partition', () => {
    const resources: ResourceRequest = { partition: 'gpu' }
    const r = ok('#SBATCH --partition=cpu\necho hi', resources)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/partition/)
  })

  it('rejects a directive that conflicts with structured time', () => {
    const resources: ResourceRequest = { timeLimitSeconds: 3600 }
    expect(ok('#SBATCH --time=2:00:00\necho hi', resources).ok).toBe(false)
  })

  it('rejects a directive that conflicts with structured mem', () => {
    const resources: ResourceRequest = { memoryMib: 1024 }
    expect(ok('#SBATCH --mem=2048\necho hi', resources).ok).toBe(false)
  })

  it('rejects a directive that conflicts with structured gpus via gres', () => {
    const resources: ResourceRequest = { gpus: 2 }
    expect(ok('#SBATCH --gres=gpu:1\necho hi', resources).ok).toBe(false)
  })

  it('accepts an allowed directive alongside non-conflicting structured resources', () => {
    const resources: ResourceRequest = { partition: 'gpu', gpus: 1 }
    const r = ok('#!/bin/bash\n#SBATCH --mail-type=END\necho hi', resources)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.directives).toHaveLength(1)
  })

  it('accepts long-form --qos but rejects when structured qos set', () => {
    expect(ok('#SBATCH --qos=normal\necho hi').ok).toBe(true)
    expect(ok('#SBATCH --qos=normal\necho hi', { qos: 'high' }).ok).toBe(false)
  })

  it('rejects a directive with a value containing shell metacharacters via unsafe token', () => {
    // The parser must not pass through values that could form shell injection. A value with a newline
    // or quote/command separator is rejected.
    const r = ok('#SBATCH --mail-type=END; rm -rf ~\necho hi')
    expect(r.ok).toBe(false)
  })

  it('rejects a directive key with no recognized = form', () => {
    const r = ok('#SBATCH --mail-type\necho hi')
    expect(r.ok).toBe(false)
  })
})

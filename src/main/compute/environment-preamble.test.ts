import { describe, expect, it } from 'vitest'

import { applyEnvironmentPreamble } from './environment-preamble'

describe('applyEnvironmentPreamble', () => {
  it('returns the command unchanged when no preamble is supplied', () => {
    expect(applyEnvironmentPreamble(undefined, 'echo hi')).toBe('echo hi')
    expect(applyEnvironmentPreamble('', 'echo hi')).toBe('echo hi')
  })

  it('prepends a single-line preamble (conda activation) with a separator', () => {
    expect(applyEnvironmentPreamble('conda activate ml', 'python train.py')).toBe(
      'conda activate ml\npython train.py'
    )
  })

  it('prepends a multi-line module preamble verbatim', () => {
    const preamble = 'module load cuda/12.2\nmodule load python/3.11\nexport FOO=bar'
    expect(applyEnvironmentPreamble(preamble, 'python train.py')).toBe(
      'module load cuda/12.2\nmodule load python/3.11\nexport FOO=bar\npython train.py'
    )
  })

  it('is deterministic: same inputs -> identical output', () => {
    const preamble = 'conda activate ml'
    const a = applyEnvironmentPreamble(preamble, 'python train.py')
    const b = applyEnvironmentPreamble(preamble, 'python train.py')
    expect(a).toBe(b)
  })
})

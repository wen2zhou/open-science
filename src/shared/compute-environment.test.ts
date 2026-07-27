import { describe, expect, it } from 'vitest'

import {
  ComputeEnvironmentResolutionSchema,
  renderEnvironmentPreamble,
  validateEnvironmentResolution,
  validateEnvironmentSpec
} from './compute-environment'

describe('ComputeEnvironmentResolutionSchema — conda', () => {
  it('accepts a conda resolution with prefix + activation', () => {
    const parsed = ComputeEnvironmentResolutionSchema.safeParse({
      kind: 'conda',
      prefix: '/data/envs/ml',
      activation: 'source activate ml'
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts a conda resolution with envName only', () => {
    const parsed = ComputeEnvironmentResolutionSchema.safeParse({
      kind: 'conda',
      envName: 'ml',
      activation: 'conda activate ml'
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a conda resolution without activation', () => {
    const parsed = ComputeEnvironmentResolutionSchema.safeParse({
      kind: 'conda',
      envName: 'ml'
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects control characters in the activation command', () => {
    const parsed = ComputeEnvironmentResolutionSchema.safeParse({
      kind: 'conda',
      envName: 'ml',
      activation: 'conda activate ml\nevil'
    })
    expect(parsed.success).toBe(false)
  })
})

describe('ComputeEnvironmentResolutionSchema — venv', () => {
  it('accepts a venv resolution', () => {
    const parsed = ComputeEnvironmentResolutionSchema.safeParse({
      kind: 'venv',
      prefix: '/home/me/venvs/sci',
      activation: 'source /home/me/venvs/sci/bin/activate'
    })
    expect(parsed.success).toBe(true)
  })
})

describe('ComputeEnvironmentResolutionSchema — module', () => {
  it('accepts a module resolution with modules + optional preamble', () => {
    const parsed = ComputeEnvironmentResolutionSchema.safeParse({
      kind: 'module',
      modules: ['cuda/12.2', 'python/3.11'],
      preamble: 'export OMPI_MCA_mpi_warn_on_fork=0'
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an empty modules list', () => {
    const parsed = ComputeEnvironmentResolutionSchema.safeParse({
      kind: 'module',
      modules: []
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a module name with a shell metacharacter', () => {
    const parsed = ComputeEnvironmentResolutionSchema.safeParse({
      kind: 'module',
      modules: ['cuda/12.2; rm -rf /']
    })
    expect(parsed.success).toBe(false)
  })
})

describe('ComputeEnvironmentResolutionSchema — apptainer', () => {
  it('accepts an apptainer resolution with image, binds, env', () => {
    const parsed = ComputeEnvironmentResolutionSchema.safeParse({
      kind: 'apptainer',
      image: '/data/images/sci.sif',
      binds: ['/data:/data', '/scratch:/scratch'],
      env: { CUDA_VISIBLE_DEVICES: '0', HF_HOME: '/data/hf' }
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an apptainer resolution without an image', () => {
    const parsed = ComputeEnvironmentResolutionSchema.safeParse({
      kind: 'apptainer',
      binds: ['/data:/data']
    })
    expect(parsed.success).toBe(false)
  })
})

describe('validateEnvironmentResolution — secret rejection', () => {
  it('rejects a key named after a secret in apptainer env', () => {
    const result = validateEnvironmentResolution({
      kind: 'apptainer',
      image: 'x.sif',
      binds: [],
      env: { AWS_SECRET_ACCESS_KEY: 'abc' }
    })
    expect(result.ok).toBe(false)
  })
})

describe('ComputeEnvironmentSpecSchema', () => {
  it('accepts a minimal spec (name + runtime)', () => {
    const result = validateEnvironmentSpec({ runtime: 'conda', packages: ['numpy', 'scipy'] })
    expect(result.ok).toBe(true)
  })

  it('accepts a spec with weight and cache paths', () => {
    const result = validateEnvironmentSpec({
      runtime: 'conda',
      packages: ['torch'],
      weights: [{ name: 'llama', uri: 'hf://meta/llama-7b' }],
      cachePath: '/data/cache'
    })
    expect(result.ok).toBe(true)
  })

  it('rejects an unknown runtime', () => {
    const result = validateEnvironmentSpec({ runtime: 'docker' })
    expect(result.ok).toBe(false)
  })

  it('rejects a package string with a newline (injection guard)', () => {
    const result = validateEnvironmentSpec({ runtime: 'conda', packages: ['numpy\nevil'] })
    expect(result.ok).toBe(false)
  })

  it('rejects unknown top-level fields (strict)', () => {
    const result = validateEnvironmentSpec({ runtime: 'conda', nope: 1 })
    expect(result.ok).toBe(false)
  })
})

describe('renderEnvironmentPreamble — conda', () => {
  it('emits a deterministic activation line', () => {
    const preamble = renderEnvironmentPreamble({
      kind: 'conda',
      envName: 'ml',
      activation: 'conda activate ml'
    })
    expect(preamble).toBe('conda activate ml')
  })

  it('is deterministic: same resolution -> same string', () => {
    const resolution = {
      kind: 'conda' as const,
      envName: 'ml',
      activation: 'conda activate ml'
    }
    expect(renderEnvironmentPreamble(resolution)).toBe(renderEnvironmentPreamble(resolution))
  })
})

describe('renderEnvironmentPreamble — module', () => {
  it('emits module load lines then the optional preamble', () => {
    const preamble = renderEnvironmentPreamble({
      kind: 'module',
      modules: ['cuda/12.2', 'python/3.11'],
      preamble: 'export FOO=bar'
    })
    expect(preamble).toBe('module load cuda/12.2\nmodule load python/3.11\nexport FOO=bar')
  })

  it('omits the trailing preamble when absent', () => {
    const preamble = renderEnvironmentPreamble({
      kind: 'module',
      modules: ['cuda/12.2']
    })
    expect(preamble).toBe('module load cuda/12.2')
  })
})

describe('renderEnvironmentPreamble — apptainer', () => {
  it('emits deterministic apptainer env exports then the exec wrapper', () => {
    const preamble = renderEnvironmentPreamble({
      kind: 'apptainer',
      image: '/data/images/sci.sif',
      binds: ['/data:/data', '/scratch:/scratch'],
      env: { CUDA_VISIBLE_DEVICES: '0', HF_HOME: '/data/hf' }
    })
    // env vars sorted by key for determinism (values single-quoted for safe interpolation), then the
    // wrapper prefix the caller wraps the command in.
    const lines = preamble.split('\n')
    expect(lines[0]).toBe("export CUDA_VISIBLE_DEVICES='0'")
    expect(lines[1]).toBe("export HF_HOME='/data/hf'")
    // The wrapper line carries image + binds in a stable order.
    const wrapper = lines[lines.length - 1]!
    expect(wrapper).toContain('/data/images/sci.sif')
    expect(wrapper).toContain('--bind /data:/data')
    expect(wrapper).toContain('--bind /scratch:/scratch')
    // Determinism: re-rendering yields the identical string.
    const again = renderEnvironmentPreamble({
      kind: 'apptainer',
      image: '/data/images/sci.sif',
      binds: ['/data:/data', '/scratch:/scratch'],
      env: { CUDA_VISIBLE_DEVICES: '0', HF_HOME: '/data/hf' }
    })
    expect(preamble).toBe(again)
  })

  it('omits the export block when no env vars are set', () => {
    const preamble = renderEnvironmentPreamble({
      kind: 'apptainer',
      image: '/data/images/sci.sif',
      binds: [],
      env: {}
    })
    expect(preamble.startsWith('export ')).toBe(false)
  })
})

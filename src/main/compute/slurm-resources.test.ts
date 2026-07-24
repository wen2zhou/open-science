import { describe, expect, it } from 'vitest'

import { renderResourceDirectives, renderTimeLimit } from './slurm-resources'

describe('renderResourceDirectives', () => {
  it('renders an empty request as no directives', () => {
    expect(renderResourceDirectives({})).toEqual([])
  })

  it('renders partition and account', () => {
    expect(renderResourceDirectives({ partition: 'gpu', account: 'acme' })).toEqual([
      '#SBATCH --partition=gpu',
      '#SBATCH --account=acme'
    ])
  })

  it('renders qos', () => {
    expect(renderResourceDirectives({ qos: 'high' })).toEqual(['#SBATCH --qos=high'])
  })

  it('renders nodes, tasks, cpus-per-task', () => {
    expect(renderResourceDirectives({ nodes: 2, tasks: 4, cpusPerTask: 8 })).toEqual([
      '#SBATCH --nodes=2',
      '#SBATCH --ntasks=4',
      '#SBATCH --cpus-per-task=8'
    ])
  })

  it('renders memory as megabytes', () => {
    expect(renderResourceDirectives({ memoryMib: 16384 })).toEqual(['#SBATCH --mem=16384'])
  })

  it('renders gpus via gres', () => {
    expect(renderResourceDirectives({ gpus: 2 })).toEqual(['#SBATCH --gres=gpu:2'])
  })

  it('renders gpus with gpu type', () => {
    expect(renderResourceDirectives({ gpus: 1, gpuType: 'a100' })).toEqual([
      '#SBATCH --gres=gpu:a100:1'
    ])
  })

  it('renders gpuType alone (single gpu of that type)', () => {
    expect(renderResourceDirectives({ gpuType: 'a100' })).toEqual(['#SBATCH --gres=gpu:a100:1'])
  })

  it('renders time limit from seconds', () => {
    expect(renderResourceDirectives({ timeLimitSeconds: 3600 })).toEqual(['#SBATCH --time=1:00:00'])
  })

  it('renders a fully populated request in a stable order', () => {
    const out = renderResourceDirectives({
      partition: 'gpu',
      account: 'acme',
      qos: 'high',
      nodes: 1,
      tasks: 4,
      cpusPerTask: 8,
      memoryMib: 16384,
      gpus: 2,
      gpuType: 'a100',
      timeLimitSeconds: 7200
    })
    expect(out).toEqual([
      '#SBATCH --partition=gpu',
      '#SBATCH --account=acme',
      '#SBATCH --qos=high',
      '#SBATCH --nodes=1',
      '#SBATCH --ntasks=4',
      '#SBATCH --cpus-per-task=8',
      '#SBATCH --mem=16384',
      '#SBATCH --gres=gpu:a100:2',
      '#SBATCH --time=2:00:00'
    ])
  })
})

describe('renderTimeLimit', () => {
  it('renders sub-hour seconds as H:MM:SS', () => {
    expect(renderTimeLimit(90)).toBe('0:01:30')
  })

  it('renders exactly one hour', () => {
    expect(renderTimeLimit(3600)).toBe('1:00:00')
  })

  it('renders multi-day limits as D-H:MM:SS', () => {
    expect(renderTimeLimit(2 * 24 * 3600 + 3600 + 60 + 5)).toBe('2-01:01:05')
  })

  it('renders zero as 0:00:00', () => {
    expect(renderTimeLimit(0)).toBe('0:00:00')
  })
})

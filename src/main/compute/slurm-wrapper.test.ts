import { describe, expect, it } from 'vitest'

import { buildSbatchWrapper } from './slurm-wrapper'
import type { ResourceRequest } from '../../shared/compute-resources'

describe('buildSbatchWrapper', () => {
  it('emits shebang, structured directives, runner-owned directives, and the command', () => {
    const resources: ResourceRequest = { partition: 'gpu', gpus: 1 }
    const script = buildSbatchWrapper({
      command: 'python train.py',
      timeoutSeconds: 3600,
      resources,
      allowedDirectives: [{ key: 'mail-type', value: 'END' }]
    })
    const lines = script.split('\n')
    expect(lines[0]).toBe('#!/usr/bin/env bash')
    // Structured directives come first.
    expect(lines).toContain('#SBATCH --partition=gpu')
    expect(lines).toContain('#SBATCH --gres=gpu:1')
    // Allowed user directive follows structured.
    expect(lines).toContain('#SBATCH --mail-type=END')
    // Runner owns job-name, output, error, chdir — these are always present and reserved for the runner.
    expect(lines.some((l) => l.startsWith('#SBATCH --job-name='))).toBe(true)
    expect(lines.some((l) => l.startsWith('#SBATCH --output='))).toBe(true)
    expect(lines.some((l) => l.startsWith('#SBATCH --error='))).toBe(true)
    expect(lines.some((l) => l.startsWith('#SBATCH --chdir='))).toBe(true)
  })

  it('runs the command under timeout and writes exit_code atomically', () => {
    const script = buildSbatchWrapper({
      command: 'echo hi',
      timeoutSeconds: 60,
      resources: {},
      allowedDirectives: []
    })
    expect(script).toMatch(/timeout -s TERM -k 30s 60 /)
    expect(script).toMatch(/mv exit_code\.tmp exit_code/)
  })

  it('places nested scheduler command shims ahead of PATH while preserving srun', () => {
    const script = buildSbatchWrapper({
      command: 'bash run-workflow.sh',
      timeoutSeconds: 60,
      resources: {},
      allowedDirectives: []
    })
    expect(script).toContain('guard_dir="$(mktemp -d')
    expect(script).toContain('openscience-no-submit.XXXXXX")" || exit 70')
    expect(script).toContain('"$guard_dir/sbatch"')
    expect(script).toContain('"$guard_dir/salloc"')
    expect(script).toContain('"$guard_dir/swarm"')
    expect(script).toContain('export PATH="$guard_dir:$PATH"')
    expect(script).not.toContain('"$guard_dir/srun"')
    expect(script).toContain('rm -rf "$guard_dir"')
  })

  it('propagates the workload exit code as the script exit code so sacct sees the real result', () => {
    // The Slurm poller reads sacct's ExitCode, not the exit_code file. If the wrapper's last command
    // were the `echo/mv` (exit 0), sacct would report 0:0 even for a non-zero workload and the job
    // would be misreported as success. The wrapper must `exit $code` so sacct reflects the workload.
    const script = buildSbatchWrapper({
      command: 'exit 3',
      timeoutSeconds: 60,
      resources: {},
      allowedDirectives: []
    })
    // Capture the code once, write it to the marker file, then exit with it.
    expect(script).toMatch(/code=\$\?/)
    expect(script).toMatch(/exit "?\$code"?/)
  })

  it('does not emit any user-provided directive that the runner reserves', () => {
    // Even if a reserved directive were passed here (it never should — parser rejects it), the wrapper
    // builder must only render allowed directives.
    const script = buildSbatchWrapper({
      command: 'echo hi',
      timeoutSeconds: 60,
      resources: {},
      allowedDirectives: [{ key: 'mail-type', value: 'END' }]
    })
    expect(script).not.toMatch(/--chdir=[^\n]*--chdir=/) // no duplicate chdir
    // job-name is runner-owned and unique.
    const jobNameCount = (script.match(/--job-name=/g) ?? []).length
    expect(jobNameCount).toBe(1)
  })

  it('applies a walltime from timeoutSeconds when no structured timeLimit is set', () => {
    const script = buildSbatchWrapper({
      command: 'echo hi',
      timeoutSeconds: 120,
      resources: {},
      allowedDirectives: []
    })
    expect(script).toContain('#SBATCH --time=0:02:00')
  })

  it('structured timeLimit takes precedence over timeoutSeconds walltime', () => {
    const script = buildSbatchWrapper({
      command: 'echo hi',
      timeoutSeconds: 120,
      resources: { timeLimitSeconds: 3600 },
      allowedDirectives: []
    })
    expect(script).toContain('#SBATCH --time=1:00:00')
    expect(script).not.toContain('#SBATCH --time=0:02:00')
  })
})

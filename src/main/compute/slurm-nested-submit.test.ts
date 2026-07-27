import { describe, expect, it } from 'vitest'

import { findNestedSubmission } from './slurm-nested-submit'

const rejects = (command: string): string => {
  const result = findNestedSubmission(command)
  if (result.ok) throw new Error(`expected a nested submission to be found in: ${command}`)
  return result.command
}

const accepts = (command: string): void => {
  const result = findNestedSubmission(command)
  if (!result.ok) {
    throw new Error(`expected no nested submission, got ${result.command} in: ${command}`)
  }
}

describe('findNestedSubmission', () => {
  // The exact shape that broke a real e2e run: the wrapper submitted and exited in under a second
  // while the inner 100s job ran untracked.
  it('rejects the observed real-cluster nested sbatch --wrap', () => {
    expect(
      rejects(
        `sbatch -c 1 --mem=500M -p debug --job-name cpu-float-1 --wrap "echo aGk= | base64 -d > /tmp/j.py && python3 /tmp/j.py"`
      )
    ).toBe('sbatch')
  })

  it('rejects sbatch and salloc at command position', () => {
    expect(rejects('sbatch job.sh')).toBe('sbatch')
    expect(rejects('salloc -N1 bash')).toBe('salloc')
    expect(rejects('swarm -f cmds.txt')).toBe('swarm')
  })

  it('rejects a submission after a separator, pipe, or conditional', () => {
    for (const command of [
      'python prep.py; sbatch run.sh',
      'python prep.py && sbatch run.sh',
      'python prep.py || sbatch retry.sh',
      'cat ids.txt | sbatch run.sh',
      'sbatch run.sh &',
      'python prep.py &\nsbatch run.sh'
    ]) {
      expect(rejects(command)).toBe('sbatch')
    }
  })

  it('rejects a submission inside a command substitution', () => {
    expect(rejects('id=$(sbatch --parsable run.sh)')).toBe('sbatch')
    expect(rejects('id=`sbatch --parsable run.sh`')).toBe('sbatch')
  })

  it('rejects a submission behind a transparent prefix or env assignment', () => {
    expect(rejects('nohup sbatch run.sh')).toBe('sbatch')
    expect(rejects('SLURM_CONF=/etc/slurm.conf sbatch run.sh')).toBe('sbatch')
    expect(rejects('exec /usr/bin/sbatch run.sh')).toBe('sbatch')
    expect(rejects('if sbatch run.sh; then echo ok; fi')).toBe('sbatch')
  })

  it('rejects a submission on a continued line inside a multi-line script', () => {
    expect(rejects('set -e\nmodule load python\nsbatch run.sh\n')).toBe('sbatch')
  })

  // srun launches a step inside the allocation the wrapper already holds — that is the normal way to
  // run a parallel step and must keep working.
  it('accepts srun and other non-submitting scheduler tools', () => {
    accepts('srun -n 4 ./solver')
    accepts('srun --cpu-bind=cores python train.py')
    accepts('squeue -u $USER; sacct -j 1')
    accepts('scancel 123')
  })

  it('accepts a workload that merely mentions a scheduler command', () => {
    accepts('echo "submit with sbatch later"')
    accepts("echo 'run; sbatch this'")
    accepts('python analyze.py --note "use sbatch for the next stage"')
    accepts('man sbatch > help.txt')
    accepts('grep -c sbatch notes.md')
  })

  it('accepts a whole-line comment mentioning a submission', () => {
    accepts('# next stage: sbatch run.sh\npython analyze.py')
    accepts('#!/usr/bin/env bash\n# sbatch is handled by the runner\npython analyze.py')
  })

  it('accepts an empty or whitespace-only command', () => {
    accepts('')
    accepts('   \n  \n')
  })
})

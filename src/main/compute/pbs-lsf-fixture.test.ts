// PBS/LSF fixture + state-mapping tests (design.md §11, Issue 07).
//
// NON-PRODUCTION coverage. There is no registered PBS/LSF driver; these tests assert the parsers that a
// FUTURE adapter would reuse, and the cross-provider state mapping. They guard the "detected but not
// executable" contract: a PBS/LSF-detected host MUST NOT dispatch, but its command shapes + state mapping
// are documented and fixture-tested today so a future adapter conforms to the frozen contract.

import { describe, expect, it } from 'vitest'

import {
  buildBkillCommand,
  buildQdelCommand,
  lsfStateToObservation,
  parseBjobsLine,
  parseBsubJobId,
  parseLsfExitCode,
  parseLsfTerminalBlock,
  parsePbsTerminalBlock,
  parseQstatLine,
  parseQsubJobId,
  pbsStateToObservation
} from './pbs-lsf-fixture'

describe('PBS qsub submit output parsing', () => {
  it('parses a bare OpenPBS job id with server suffix', () => {
    expect(parseQsubJobId('1234567.gpuserver01\n')).toBe('1234567.gpuserver01')
  })

  it('parses a bare Torque numeric id', () => {
    expect(parseQsubJobId('42\n')).toBe('42')
  })

  it('returns undefined for non-submit output', () => {
    expect(parseQsubJobId('qsub: unknown option\n')).toBeUndefined()
    expect(parseQsubJobId('')).toBeUndefined()
  })
})

describe('PBS qstat active parsing + state mapping', () => {
  it('maps a RUNNING (R) row to a non-terminal alive observation', () => {
    const row = parseQstatLine('1234567.gpuserver01 jobname user -- R gpu  --  --   -- job.sh')
    expect(row?.state).toBe('R')
    expect(row?.schedulerJobId).toBe('1234567.gpuserver01')
    const obs = pbsStateToObservation(row, undefined)
    expect(obs?.alive).toBe(true)
    expect(obs?.hasExitCode).toBe(false)
    expect(obs?.remoteState).toBe('R')
  })

  it('maps a QUEUED (Q) row with a queue reason', () => {
    const row = parseQstatLine('42 jobname user 0 Q gpu')
    expect(row?.state).toBe('Q')
    const obs = pbsStateToObservation(row, undefined)
    expect(obs?.remoteState).toBe('Q')
  })

  it('returns undefined for a line with no recognizable state token', () => {
    expect(parseQstatLine('header line with no state')).toBeUndefined()
    expect(parseQstatLine('')).toBeUndefined()
  })
})

describe('PBS terminal block parsing + state mapping', () => {
  it('parses job_state=C with Exit_status=0 as success', () => {
    const block = ['Job Id: 1234567', '    job_state = C', '    Exit_status = 0', ''].join('\n    ')
    const term = parsePbsTerminalBlock(block)
    expect(term?.state).toBe('C')
    expect(term?.exit).toBe(0)
    const obs = pbsStateToObservation(undefined, term)
    expect(obs?.alive).toBe(false)
    expect(obs?.hasExitCode).toBe(true)
    expect(obs?.exitCode).toBe(0)
    expect(obs?.remoteState).toBe('C')
  })

  it('parses job_state=F with non-zero Exit_status as failed with a diagnostic', () => {
    const block = ['    job_state = F', '    Exit_status = 137', ''].join('\n')
    const term = parsePbsTerminalBlock(block)
    expect(term?.state).toBe('F')
    expect(term?.exit).toBe(137)
    const obs = pbsStateToObservation(undefined, term)
    expect(obs?.exitCode).toBe(137)
    expect(obs?.schedulerDiagnostic).toContain('PBS job failed')
  })

  it('returns undefined for a non-terminal (R) block', () => {
    const block = '    job_state = R\n    Exit_status = 0\n'
    expect(parsePbsTerminalBlock(block)).toBeUndefined()
  })
})

describe('LSF bsub submit output parsing', () => {
  it('parses the standard bsub success line', () => {
    expect(parseBsubJobId('Job <7765432> is submitted to queue <normal>.')).toBe('7765432')
  })

  it('returns undefined when no Job <id> token is present', () => {
    expect(parseBsubJobId('No queue named bad.')).toBeUndefined()
  })
})

describe('LSF bjobs active parsing + state mapping', () => {
  it('maps a RUN row to a non-terminal alive observation', () => {
    const row = parseBjobsLine('7765432 user RUN gpu hostA hostB jobName Jul 27 12:00')
    expect(row?.state).toBe('RUN')
    const obs = lsfStateToObservation(row, undefined)
    expect(obs?.alive).toBe(true)
    expect(obs?.remoteState).toBe('RUN')
  })

  it('maps a PEND row', () => {
    const row = parseBjobsLine('7765433 user PEND gpu hostA - jobName Jul 27 12:01')
    expect(row?.state).toBe('PEND')
  })

  it('returns undefined for a non-active bjobs state (e.g. DONE handled as terminal)', () => {
    expect(parseBjobsLine('7765434 user DONE gpu hostA hostB jobName Jul 27 12:02')).toBeUndefined()
  })
})

describe('LSF terminal block parsing + state mapping', () => {
  it('maps DONE to success (exit 0)', () => {
    const term = parseLsfTerminalBlock('Job <7765434>, Job Name <jobName>, Completed <done> DONE')
    expect(term?.state).toBe('DONE')
    expect(term?.exit).toBe(0)
    const obs = lsfStateToObservation(undefined, term)
    expect(obs?.exitCode).toBe(0)
  })

  it('maps EXIT with an exit code to failed with a diagnostic', () => {
    const term = parseLsfTerminalBlock('Exited with exit code 2. EXIT')
    expect(term?.state).toBe('EXIT')
    expect(term?.exit).toBe(2)
    expect(parseLsfExitCode('Exited with exit code 5.')).toBe(5)
    const obs = lsfStateToObservation(undefined, term)
    expect(obs?.schedulerDiagnostic).toContain('exited non-zero')
  })

  it('returns undefined for non-terminal detail', () => {
    expect(parseLsfTerminalBlock('Running on hostA')).toBeUndefined()
  })
})

describe('qdel / bkill command shapes (non-production contract)', () => {
  it('builds a numeric-safe qdel', () => {
    expect(buildQdelCommand('1234567')).toBe('qdel 1234567')
  })

  it('allows the dotted OpenPBS id form in qdel', () => {
    expect(buildQdelCommand('1234567.gpuserver01')).toBe('qdel 1234567.gpuserver01')
  })

  it('quotes a hostile id defensively', () => {
    // A non-numeric / non-dotted token must be single-quoted so it cannot break out of the command.
    expect(buildQdelCommand('1; rm -rf ~')).toBe("qdel '1; rm -rf ~'")
  })

  it('builds a numeric-safe bkill', () => {
    expect(buildBkillCommand('7765432')).toBe('bkill 7765432')
  })
})

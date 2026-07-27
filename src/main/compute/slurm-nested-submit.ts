// Nested scheduler submission guard (design.md §4.5).
//
// On a Slurm host `submit_job` ALREADY wraps the command in a .sbatch script and submits it. A command
// that calls `sbatch`/`salloc` itself therefore produces a double submission, and the outer wrapper —
// the only job Open Science holds a handle for — does nothing but submit and exit. Observed on a real
// cluster: the wrapper reached COMPLETED/exit 0 in under a second while the inner job ran for 100s.
//
// The damage is not merely a wrong status badge:
//   - harvest fires the instant the wrapper terminates, so the declared outputs do not exist yet and
//     nothing is downloaded;
//   - cancel/scancel reaches only the wrapper, orphaning the inner job to burn CPU unobserved;
//   - the wrapper itself occupies a scheduler slot, so N submissions consume 2N slots.
//
// So this is rejected at dispatch, before any SSH, the same as a reserved directive. Self-submitting
// workflow managers (Nextflow/Snakemake Slurm executors, which invoke sbatch from a head job) are
// rejected too — a known V1 limitation, recorded in the skill doc, because their status and harvest
// would be wrong in exactly this way rather than merely unsupported.
//
// `srun` is deliberately NOT matched: it is the normal way to launch a step INSIDE a batch allocation.

// Scheduler entry points that create a NEW job/allocation rather than a step in the current one.
const SUBMITTING_COMMANDS = new Set(['sbatch', 'salloc', 'swarm'])

// Prefixes that are transparent to what is actually being run: `nohup sbatch x` still submits. Env
// assignments (FOO=bar) are stripped separately since they are matched by shape, not by name.
const TRANSPARENT_PREFIXES = new Set([
  'nohup',
  'time',
  'exec',
  'eval',
  'env',
  'sudo',
  'command',
  'builtin',
  'setsid',
  'stdbuf',
  'nice',
  'ionice',
  'then',
  'else',
  'do',
  'elif',
  'if',
  'while',
  'until',
  'not',
  '!'
])

export type NestedSubmitCheck = { ok: true } | { ok: false; command: string; reason: string }

// Splits a script into "command position" segments: the text right after a shell construct that starts
// a fresh command. Quote state is tracked so a separator INSIDE a quoted string does not open a bogus
// command position — `echo 'a; sbatch b'` must not trip the guard.
//
// This is a deliberately small scanner, not a shell parser. It errs toward finding a submission (a
// missed nested sbatch is the failure that cost a real e2e run) while keeping the quoting false
// positives — the ones that would block legitimate work now that this is a hard rejection — out.
const splitCommandPositions = (script: string): string[] => {
  const segments: string[] = []
  let current = ''
  let single = false
  let double = false

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!
    if (single) {
      // Inside single quotes NOTHING is special, not even a backslash.
      if (ch === "'") single = false
      current += ch
      continue
    }
    if (double) {
      if (ch === '\\') {
        current += ch + (script[i + 1] ?? '')
        i++
        continue
      }
      if (ch === '"') double = false
      current += ch
      continue
    }
    if (ch === "'") {
      single = true
      current += ch
      continue
    }
    if (ch === '"') {
      double = true
      current += ch
      continue
    }
    if (ch === '\\' && script[i + 1] === '\n') {
      // Line continuation: not a new command.
      i++
      continue
    }
    // Unquoted separators. `$(` and a backtick open a substitution, whose body is command position.
    const two = ch + (script[i + 1] ?? '')
    if (two === '&&' || two === '||') {
      segments.push(current)
      current = ''
      i++
      continue
    }
    if (two === '$(') {
      segments.push(current)
      current = ''
      i++
      continue
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '`' || ch === '(') {
      segments.push(current)
      current = ''
      continue
    }
    current += ch
  }
  segments.push(current)
  return segments
}

// Reduces a segment to the command word it actually runs: drops leading whitespace, `{`, env
// assignments, and transparent prefixes (`nohup`, `sudo`, `if`, ...). Returns '' when the segment runs
// nothing. The basename is taken so `/usr/bin/sbatch` and `sbatch` are treated alike.
const commandWordOf = (segment: string): string => {
  let tokens = segment
    .trim()
    .replace(/^[{(\s]+/, '')
    .split(/\s+/)
    .filter((t) => t !== '')

  while (tokens.length > 0) {
    const head = tokens[0]!
    // FOO=bar prefix — strip and keep looking for the real command word.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      tokens = tokens.slice(1)
      continue
    }
    const base = head.split('/').pop() ?? head
    if (TRANSPARENT_PREFIXES.has(base.toLowerCase())) {
      tokens = tokens.slice(1)
      continue
    }
    return base.toLowerCase()
  }
  return ''
}

// Drops whole-line comments so a note like `# submit with sbatch later` is not read as a command.
// Trailing comments are left in place: they only matter if they contain a separator followed by a
// scheduler command, which no realistic comment does.
const stripFullLineComments = (script: string): string =>
  script
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

// Scans a command body for a nested scheduler submission. Returns the offending command word so the
// caller can name it in the rejection message.
export const findNestedSubmission = (command: string): NestedSubmitCheck => {
  const segments = splitCommandPositions(stripFullLineComments(command))
  for (const segment of segments) {
    const word = commandWordOf(segment)
    if (word && SUBMITTING_COMMANDS.has(word)) {
      return {
        ok: false,
        command: word,
        reason:
          `This command calls \`${word}\`, which submits a second job. On a Slurm host submit_job ` +
          `already wraps the command in an sbatch script and submits it, so the job Open Science ` +
          `tracks would be the wrapper — it exits as soon as \`${word}\` returns, while the real work ` +
          `runs untracked. Status would be wrong, declared outputs would be harvested before they ` +
          `exist, and cancelling would leave the real job running.\n` +
          `Pass the workload directly as the command and request resources via the structured ` +
          `\`resources\` option (partition, cpusPerTask, memoryMib, gpus, timeLimitSeconds) instead ` +
          `of scheduler flags.`
      }
    }
  }
  return { ok: true }
}

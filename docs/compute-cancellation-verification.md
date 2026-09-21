# Compute cancellation: SSH diagnostic truncation

## Incident and cause

Session #118 retained a running Compute Job and an active cancellation operation after repeated
reaper attempts. A read-only probe over the affected SSH connection returned exit code 0 and
complete `absent\n` stdout, but its login banner exceeded the 64-byte stderr capture limit.
`SystemSshRunner` reported aggregate truncation; cancellation interpreted that as incomplete
process ownership evidence and retried indefinitely.

The original cancellation suite passed because its fake connection results did not reproduce
independent stdout/stderr truncation. New SQLite integration tests use real child processes and
the production SSH runner. Before the fix, all three valid ownership cases remained
`running / cancelling` instead of settling cancellation.

## Fix and invariants

- Report stdout and stderr truncation independently, retaining the aggregate flag for callers
  displaying combined command output.
- Put protocol completeness interpretation at the connection boundary. Protocol consumers use
  stdout completeness; legacy runners without stream metadata retain the conservative aggregate
  check.
- Apply this interpretation consistently to cancellation, launch recovery, dispatch, polling,
  harvesting, resource probes, and Slurm output readers.
- Keep exit-code, timeout, exact protocol parsing, and process ownership checks. Truncated stdout
  cannot establish ownership or confirm termination, even if its retained prefix looks valid.
- No database migration, forced terminal state, larger capture limit, or SSH banner suppression.

## Verification

- Real affected host: absent-process probe failed before the change and passed after it.
- Real affected host: an isolated `sleep 120` process was verified as owned, cancelled through
  the cancellation owner/reaper with a temporary SQLite database, and verified no longer running.
  The temporary remote directory and local database were removed.
- Restarted the development app using `npm run dev`. Session #118's existing cancellation settled
  through normal recovery as `status=failed`, `phase=settled`, `outcome=fulfilled` (the cancelled
  projection), without manually updating the database.
- Permanent regressions cover long stderr banners for owned, absent, and mismatched processes;
  truncated ownership and termination stdout; independently rejected unknown, timeout, nonzero,
  and legacy aggregate-truncated responses; per-stream accounting and aggregate compatibility.

Commands:

```sh
npx vitest run src/main/compute
npx vitest run src/main/compute/ssh-runner.test.ts src/main/compute/compute-job-cancellation-owner.integration.test.ts
npm run typecheck:node
```

The real-host harness was temporary; CI regressions require no network, credentials, or private
host configuration.

Local Windows verification on 2026-09-21:

- Focused transport, cancellation, and architecture guards: 113 passed, 5 platform skips.
- Broad compute run (including the temporary live test): 1183 passed, 42 skipped, 2 failed.
- Unmodified HEAD broad compute baseline: 1165 passed, 42 skipped, 6 failed. The same failure
  families reproduce without this change: `harvest-engine.test.ts` cannot create a directory
  symlink (`EPERM`), and `concurrency-integration.test.ts` intermittently encounters `EPERM`
  while publishing execution-file receipts by rename. An isolated baseline run of the latter
  passed all 17 tests, confirming the observed variability.
- Node and sandbox TypeScript checks, ESLint on changed TypeScript files, and `git diff --check`
  passed.

These existing Windows failures remain outstanding; the broad suite is not represented as green.

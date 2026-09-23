# Windows acceptance: Notebook cleanup ownership and admission

This is an executable handoff for a Windows validation agent, not a record of Windows tests having
passed. It accompanies [PR #2919](https://github.com/aipoch/open-science/pull/2919), based on #2918
and #2909. The batch-three implementation is `f7f542941cc8e94dc064b0f6e5b3765fc0a5a9eb`.
Resolve and record the actual reviewed PR head before testing; after squash merges, record the
replacement commit and confirm the implementation is present rather than requiring that old SHA as
an ancestor. Read `AGENTS.md`, `CONTRIBUTING.md` and the cleanup ownership section in `docs/PRD.md`.

## Scope and expected decision

Validate Windows standard execution, Windows protected execution and WSL2 separately. The third
batch enables independent-command admission only on native macOS. On Windows and WSL2, an unknown
same-domain cleanup result must still block B before dispatch, even if network cleanup succeeded.
The optional macOS admission disposition must not silently activate on Windows. Command-root
count is not an admission condition on any platform. Missing disposition means blocked, not implicit permission.

This acceptance does **not** authorize enabling Windows independent admission. Do not change
production behavior merely to make a macOS expectation pass on Windows. Report any uncovered
acceptance criterion as NOT VERIFIED; add a focused regression fixture when needed, without
rewriting production ownership rules. If a product defect is found, preserve its red evidence and
provide a minimal fix with regression tests in a separate reviewable commit.

## Environment and evidence

Use a dedicated `.worktree/<name>` checkout and prepared dependencies on a disposable Windows test
host. Run standard mode without elevation. Run protected lifecycle scripts in a separate elevated
session on that disposable host: they create/remove test AppContainers, network rules and ACL leases
using fixed installation identities. Do not run them against a user's active installation.

Record Windows edition/build, architecture, PowerShell version, elevation, Git SHA and dirty state,
Node/npm versions, Rust/MSVC toolchain, native binary SHA256, and fixture versions. The commands below
are for Windows x64 and Node 22, matching the x64 native build lane. ARM64 is a separate result; do not
substitute an x64 run for ARM64 evidence. Do not install toolchains, download dependencies, change
execution policy, configure WSL or edit global security policy just to bypass missing prerequisites.
Report those prerequisites as unavailable. Reuse already authorized, prepared fixtures.

Never stop a running user analysis, restart the user's app, replay incident Sessions #891/#893, clear
shared temporary directories, or kill a process found only by scanning a PID/name. Terminate only
fixture-owned native handles/Jobs/ChildProcess instances. Preserve unproven objects and document them.

From the checkout root in PowerShell:

```powershell
$ErrorActionPreference = 'Stop'
if ((node -p "process.platform") -ne 'win32') { throw 'Windows required' }
if ((node -p "process.arch") -ne 'x64') { throw 'Use a separately reviewed ARM64 plan' }
if ((node -p "process.versions.node.split('.')[0]") -ne '22') { throw 'Node 22 required' }
if (-not (Test-Path 'node_modules/vitest/vitest.mjs')) { throw 'Prepared dependencies required' }
$evidenceRoot = Join-Path (Get-Location) ('.scratch/windows-cleanup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $evidenceRoot | Out-Null
Start-Transcript -Path (Join-Path $evidenceRoot 'session.log')
git rev-parse HEAD
git status --short
node --version
npm --version
$PSVersionTable
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture
```

Use separate evidence directories/transcripts for elevated and WSL runs. Check each native command's
exit code immediately; PowerShell's `$ErrorActionPreference` alone does not make a native nonzero
exit fail the session. Save test counts, test names, stdout/stderr, duration and skip reasons. Do not
include credentials, environment dumps, user code or private workspace contents in public reports.

## Required acceptance matrix

All rows are required for a complete Windows cleanup acceptance. If a platform/fixture is absent,
report that row NOT VERIFIED, not PASS. Existing files are starting points, not proof that every row
already has a complete native fixture.

| ID  | Scenario and required assertions                                                                                                                                                                                                                                                        | Existing coverage / additional evidence                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W1  | Normal PowerShell, REPL and Python execution: correct nonce/output and exit status; one persisted terminal result; following command succeeds; owned resources settle.                                                                                                                  | `windows-shell.integration.test.ts`, `windows-repl-termination.integration.test.ts`, `package-process-sandbox.windows.integration.test.ts`; add real runtime-service/repository coverage for any missing consumer. Use an existing Python fixture and its existing read-only grants. |
| W2  | Real A retains unknown proof; same-domain B is rejected before spawn/dispatch with `SHELL_CLEANUP_INCOMPLETE`; no successful B result or duplicated run; A's receipt/root and applicable native ownership remain. Network/trust success alone must not grant admission.                 | Package/owner contract tests plus a **real Windows A/B fixture still required** for standard and protected modes. The new `.macos-isolation` files skip on Windows and are not this evidence.                                                                                        |
| W3  | A's original native owner later supplies valid proof: retry settles only A, B then dispatches once and persists one completed result. Success is retained; receipt deletion retry does not signal a possibly reused PID again.                                                          | REPL native `valid/missing/error/late/receipt-retry` cases; add A/B consumer assertions where absent. Keep unknown proof false until the intended transition.                                                                                                                        |
| W4  | Same kernel/epoch cannot be reused while quarantined. Retirement and RPC revocation are irreversible; delayed callbacks target the original epoch and cannot revoke a successor. Provider-only reconnect preserves a live epoch.                                                        | `kernel-executor.test.ts`, `local-rpc-server.test.ts`, owner/package tests and batch-two regressions. Separate deterministic contract evidence from native process evidence.                                                                                                         |
| W5  | Leader exits first, application owner crashes, native proof arrives late, or identity mismatches: use the exact original Job/receipt identity; preserve an unrelated live sentinel process; no PID-only second teardown.                                                                | `process-tree.windows.integration.test.ts`, `shell-process-ownership.test.ts`, `kernel-process-lifecycle.test.ts`, native REPL tests. Deterministic identity mismatch is sufficient for PID-reuse rejection; do not churn processes to force real PID reuse.                         |
| W6  | Gateway close, trust/platform release, ACL restoration, receipt settlement and directory removal fail separately: retain each failed obligation, block the affected domain, retry safely; complete stages do not repeat unsafe work. Global dispose/reset must not forget unknown work. | Package/owner fault injection and native lifecycle tests. Instrument the original owner boundary, not a mock that bypasses the whole sandbox. Record which failures are native versus injected.                                                                                      |
| W7  | Protected mode concurrent ACL leases: A release cannot revoke live B; original ACLs return only after last release. Removing one test installation preserves another; corrupted/unowned receipts fail closed; crash recovery respects exact ownership.                                  | `smoke.ps1 -Mode Full`, Rust tests. Capture original/final test-path ACL evidence and unrelated installation preservation.                                                                                                                                                           |
| W8  | Protected network boundary: allowed authenticated gateway works; unrelated IPv4/IPv6 loopback and UDP bypasses fail; dynamic port regression passes.                                                                                                                                    | Full smoke and `smoke-port-regression.ps1`. Any `NETWORK_BOUNDARY_UNVERIFIED` is NOT VERIFIED even with exit code zero.                                                                                                                                                              |
| W9  | WSL2 explicit profile/distro/user: real Bash output/exit and gateway restrictions; unknown same-domain proof blocks B; exact original guest/host authority alone permits recovery; another profile/workload is not killed or cleaned.                                                   | WSL suites below; add real unknown-A/B and recovery assertions where absent. Host-side termination mocks cannot prove guest process termination.                                                                                                                                     |
| W10 | Restart, corrupted/missing receipt, path replacement and late cleanup do not adopt/delete unowned objects or infer success from absence. Windows legacy behavior remains compatible; do not copy macOS root accounting into Windows.                                                    | Owner/lifecycle/receipt tests, protected crash-recovery smoke and sentinel fixtures. Record process-stop-before-resource-removal ordering.                                                                                                                                           |

For W2/W3 fixtures, use the real application owner, package and native launcher, a fresh private
storage/workspace and harmless commands. Hold the original proof boundary unknown; observe actual
spawn counts and persisted state, not just a displayed error. Use unique output nonces. Preserve A's
ownership metadata before/after B attempts. At teardown, stop only fixture-owned processes and wait
for actual termination before releasing their files. A mocked `process.platform` or backend-only
mock does not count as native acceptance. Label mixed native/fault-injection tests precisely.

## Standard mode commands

Run these non-elevated. Use the source-built native host from the protected/native preparation below
when validating the full stack; record its hash and distinguish it from an existing shipped binary.

```powershell
$tests = @(
  'packages/notebook-network-sandbox/src/index.test.ts'
  'packages/notebook-network-sandbox/src/public-read-runtime.test.ts'
  'packages/notebook-network-sandbox/src/windows-appcontainer.test.ts'
  'packages/notebook-network-sandbox/src/windows-runtime-access.test.ts'
  'src/main/notebook/network-sandbox-owner.test.ts'
  'src/main/notebook/kernel-executor.test.ts'
  'src/main/notebook/local-rpc-server.test.ts'
  'src/main/notebook/windows-shell.integration.test.ts'
  'src/main/notebook/windows-repl-termination.integration.test.ts'
  'src/main/notebook/package-process-sandbox.windows.integration.test.ts'
  'src/main/notebook/kernel-process-lifecycle.test.ts'
  'src/main/notebook/shell-process-ownership.test.ts'
  'src/main/process-tree.windows.integration.test.ts'
)
node node_modules/vitest/vitest.mjs run @tests --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000
if ($LASTEXITCODE -ne 0) { throw 'Windows lifecycle validation failed' }
```

Some files mix mocked contracts and real native cases. Report both groups separately. Run any new
W1/W2/W3/W9 fixtures explicitly and register their owner/consumer coverage per `CONTRIBUTING.md`.
For Python opt-in variables, inspect the actual selected test before setting a value: interpreter
paths and environment prefixes are not interchangeable across the existing fixtures. Missing Python
is a consumer coverage gap, not a reason to silently exclude W1/W3.

## Native source and protected mode commands

With the pre-provisioned Rust/MSVC dependency cache, build/test the source corresponding to the
reviewed checkout. An uncached dependency is a missing prerequisite; do not initiate downloads.

```powershell
cargo test --offline --locked --manifest-path packages/notebook-network-sandbox/vendor/windows-src/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw 'Native source tests failed' }
$env:CARGO_NET_OFFLINE = 'true'
node packages/notebook-network-sandbox/vendor/windows/build.mjs x64
if ($LASTEXITCODE -ne 0) { throw 'Native build failed' }
$hostExe = 'packages/notebook-network-sandbox/vendor/windows/x64/notebook-appcontainer-host.exe'
Get-FileHash $hostExe -Algorithm SHA256
```

Then, in the separate elevated disposable-host session, set `$hostExe` to that exact built binary:

```powershell
& packages/notebook-network-sandbox/vendor/windows-src/ci/smoke.ps1 -Exe $hostExe -Mode Full
if ($LASTEXITCODE -ne 0) { throw 'Protected lifecycle failed' }
& packages/notebook-network-sandbox/vendor/windows-src/ci/smoke-port-regression.ps1 -Exe $hostExe
if ($LASTEXITCODE -ne 0) { throw 'Gateway port regression failed' }
```

Inspect both logs for skipped probes, warnings and preserved cleanup debt. A zero exit code alone
cannot satisfy W7/W8. The existing smoke scripts use fixed installation identities; an unexpected
existing object must be investigated, not deleted to force a clean run.

## WSL2 commands

Use an explicitly designated disposable test distro/user with existing guest `/usr/bin/python3`
and `/usr/bin/bwrap`. Network integration needs its prepared mirrored-network configuration. Do not
choose the user's default distro, install one, edit `.wslconfig`, or run `wsl --shutdown` to make the
tests pass. If unavailable, report WSL2 NOT VERIFIED separately from native Windows.

```powershell
$env:OPEN_SCIENCE_WSL_DISTRO = '<designated-test-distro>'
$env:OPEN_SCIENCE_WSL_USER = '<designated-test-user>'
wsl.exe -d $env:OPEN_SCIENCE_WSL_DISTRO -u $env:OPEN_SCIENCE_WSL_USER -- sh -lc 'test -x /usr/bin/python3 && test -x /usr/bin/bwrap'
if ($LASTEXITCODE -ne 0) { throw 'WSL prerequisites unavailable' }
node node_modules/vitest/vitest.mjs run `
  packages/notebook-network-sandbox/src/wsl2-isolation.test.ts `
  packages/notebook-network-sandbox/src/wsl2-isolation.integration.test.ts `
  src/main/notebook/wsl2-shell.integration.test.ts `
  --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000
if ($LASTEXITCODE -ne 0) { throw 'WSL validation failed' }
```

The integration groups skip without both environment variables. A report containing only skipped
WSL tests does not validate WSL. The shell integration includes an injected host termination result;
it is not alone proof of real unknown guest recovery.

## Final checks and report

Run final typechecks/lint and the Test Impact Set after the last material edit. Use the full fallback
when required by `CONTRIBUTING.md`; report platform skips rather than treating them as evidence:

```powershell
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
npm run lint
if ($LASTEXITCODE -ne 0) { throw 'Lint failed' }
# Required for ownership/CI routing changes or the complete fallback:
$env:OPEN_SCIENCE_TEST_MAX_WORKERS = '1'
npm test
if ($LASTEXITCODE -ne 0) { throw 'Full suite failed' }
Stop-Transcript
```

Deliver a Markdown report containing:

1. Exact code revision, dirty diff, OS/toolchain/native-host identities and elevation per run.
2. One PASS / FAIL / NOT VERIFIED verdict for each W1-W10 row, with test name, exact command, log,
   counts, skip reasons and evidence that the relevant native process actually launched.
3. For A/B tests: identities, proof transitions, dispatch counts, persisted run counts, resource
   preservation/removal order, and unrelated sentinel survival. Redact sensitive values.
4. Failures reproduced at the reviewed revision, any baseline comparison, minimal fixes and final
   reruns. Never silently retry until green; preserve and explain the original failure.
5. Fixture teardown outcome and any deliberately preserved unknown objects. No broad cleanup sweep.
6. Separate conclusions for standard, protected and WSL2. Ordinary PR Windows green or the
   `windows-process` dry-run is insufficient: that dry-run excludes native sandbox build/smoke.

The result can be "Windows standard verified; protected/WSL2 not verified" when justified. It cannot
be "Windows fully verified" with required native rows missing, or "Windows independent admission
ready" based on this conservative-regression plan.

## Separate future enablement gate

Before enabling independent admission on Windows or WSL2, require a new reviewed platform design
and native red/green evidence: live A remains unknown while independent B's supported consumers run
and persist once; true shared conflicts still reject; retries do not kill B or revoke its Job/ACL/
gateway rights; old receipts and crash recovery preserve authority; bounded retained-resource
accounting does not alter healthy concurrency. Standard, protected and WSL2 each need their own
proof. The macOS tests and this acceptance report cannot substitute for that evidence.

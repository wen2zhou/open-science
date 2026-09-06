# WSL2 Preview release readiness — 2026-09-06

Status: approved for the explicitly opted-in Windows x64 WSL2 Bash Preview reference configuration.
This is not approval for default enablement or general availability.

Scope: explicit opt-in Windows x64 WSL2 Bash Preview, with the boundaries in
`wsl2-bash-preview-v1.md`. This review does not expand the feature to general availability.

## Source and integration

- Reviewed feature head: `411d148011fae4c007dcfaf510b2e22f6a5a7814`.
- Original merge base: `51a2015652548f0360caaddf6ab18d81ce826ee4`.
- Integration target: `f9cc79637cbd693c1ef02de7677bbd3a20ce0e97` (`main`).
- Application-source candidate after fixes: `17afa494`.
- The existing uncommitted package-lock change was excluded from the review fixes.

## Findings and fixes

### Nested filesystem policy

A real bubblewrap probe demonstrated that mounting a writable session parent after its read-only
input child made an existing input file writable. Allowed mounts now apply from parent to child;
explicit read/write denials apply afterward so a narrower grant cannot reopen a denied ancestor.
Mount destinations are created before the private root is sealed read-only.

The real adapter regression verifies read-only input preservation, denied-write ancestor precedence,
denied-read ancestor precedence, and successful writes to a permitted sibling. The WSL integration
suite passed all 12 tests across three files after this fix.

### Current-version certification

The original record certifies a 0.24.0 installer while the application and admitted manifest are
0.25.1. The packaging contract test now checks the reference record against the actual package
version. It failed as expected against the stale record. The exact 0.25.1 installer subsequently
passed certification, the reference record was updated, and all 13 packaging contract tests passed.

### Integration with main

The permission-broker conflict requires both the in-flight response ownership map from main and the
WSL-aware restored approval value containing the permission category. Losing either would discard
one side's cancellation or runtime-switch protection.

The merge is complete. Its focused permission/Notebook validation passed 757 tests, with five
platform-conditional skips. Duplicate test fixture fields introduced by automatic merging were
removed before final typechecking.

The broad suite subsequently exposed legacy persisted allow-once replay: old Notebook approval
records do not contain the new category key. A strict compatibility allowlist restores only
canonical Notebook Python/R/JavaScript execution records. Missing-category Shell records remain
ineligible for replay on default Bash, PowerShell, WSL2, and a qualified WSL2 profile. All 120 focused
broker/runtime/module-shadow tests passed, as did Node/sandbox typechecks. Independent review found
no cross-runtime/profile replay issue.

### Native POSIX cleanup regressions

The shared tracker could never certify portable POSIX birth identities, so macOS cleanup always
reported incomplete. Portable POSIX now retains the explicitly owned detached process-group path.
This fix has mocked platform regression coverage; no actual macOS host run is claimed.

A separate actual Linux probe initially reported incomplete cleanup for 100 of 100 short commands.
The fix captures the direct child's exact kernel identity synchronously at spawn, rejects later PID
adoption, and treats procfs `ESRCH` during enumeration as a vanished process, alongside `ENOENT`.
Permission failures still fail closed. An instrumented probe attributed all 133 incomplete
intermediate snapshots out of 580 samples to `ESRCH`; final snapshots and spawn receipts were valid.

On an isolated official Linux Node 22.23.2 runtime with its published checksum verified, the final
real loop passed 290 of 290 cases: 100 short commands, 50 leaders exiting before background children,
20 detached descendants, 100 bwrap short commands, and 20 bwrap descendant-cleanup cases. The latter
cases checked that recorded descendants were gone, not merely that the API returned success.

### Required Python dependency

Readiness now probes the same absolute `/usr/bin/python3` executable used by the bridge and verifies
that it runs Python 3. A missing or unusable interpreter prevents activation and is identified in
Settings and privacy-safe support diagnostics. Copy-only repair guidance and all eight translated
catalogs are included. The focused owner, renderer, and i18n checks passed 871 tests.

### Private build inputs

The actual electron-builder matcher admitted local scratch, nested checkouts, test runtime caches,
and test reports. Explicit exclusions now reject those directories while retaining the application
bundle. The matcher regression was observed failing before the configuration change and passing
after it. The final package inspection found zero entries under the excluded roots, including
legacy `dist`. Explicitly excluding `dist` also prevents an isolated build output directory from
causing earlier installers to be recursively included.

The direct local packaging invocation initially omitted the release workflow's foreign Prisma
engine pruning step. The installer smoke correctly rejected the additional macOS engine. The
corrected final candidate contains exactly one Windows Prisma engine and passed installation
acceptance.

The failed post-install resource assertion exposed a validation-harness cleanup defect: temporary
files were removed while exact test-owned HKCU installer registrations remained. Subsequent
orphan-lock probes timed out at 30 seconds and again at 120 seconds. After validating and removing
only the two stale test-owned keys, the unchanged installer passed the isolated orphan-lock drill
in 2.53 seconds. No NSIS product change was needed. The harness now cleans only exact test-owned
registrations, preserving unrelated and incomplete identities and preserving primary failures if
cleanup also fails. All 44 harness tests passed, including Windows-path boundary guards and
the observed empty-install-location case. Harness checkpoint: `18be94cb`.

### Static context budget

The broad suite caught a Codex bridge prompt budget regression (4,193 versus a 4,175-token limit).
The redundant PowerShell execution description was shortened without changing its command syntax
contract or runtime behavior. Four focused files passed all 141 tests after the change, and the
application was rebuilt before final package validation.

### Validation discovery and impact mapping

The WSL owners and their release evidence are registered in the module-impact manifest. Its planner
regression and manifest validation passed 40 tests. The broad suite then caught a stale exact-list
assertion in the shadow report; it now expects the complete 30-file evidence list and passes.
Vitest's defaults did not exclude earlier packaged test copies, so repository-root `dist`, `out`,
`test-results`, and `.scratch` are now
explicitly excluded; 18 discovery/configuration tests passed. Source-owned nested fixture folders
remain discoverable. The broad run predates this discovery fix; its accounting below excludes two
generated package suites and covers every canonical source test file.

## Validation accounting

- Initial Node, sandbox, and renderer typechecks passed.
- Initial full lint and changed non-Markdown formatting passed.
- Initial settings/ACP/renderer focused review: 10 files, 435 tests passed.
- Real WSL suite after the filesystem fix: 3 files, 12 tests passed, 49.15 seconds.
- Native POSIX regression checks after the fix: 87 passed, 88 platform-conditional skips.
- Final application-source Node/sandbox/renderer typechecks and full lint passed.
- Windows native helper source: 9 Rust tests passed using the locked offline dependency set.
- Generated web API map and database schema checks passed.
- Two initial broad Windows runs were interrupted after resource contention produced timeouts and
  platform-specific failures. The local PowerShell npm wrapper consumed the `--` separator, so the
  intended Vitest controls were not forwarded. Both runs are incomplete and are not counted as
  passing suites. A direct Vitest invocation with verified serial arguments supersedes them.
- Completed serial broad run: 1,431 of 1,431 canonical source files reported; 24,944 assertions
  passed, 49 failed, and 425 were skipped. This is not a green full-suite result. Two generated
  package suites were excluded from source accounting. Duration: 2,087.07 seconds.
- Failure triage identified four branch/validation findings: the stale certification version,
  incomplete shadow test expectation, static context budget, and legacy Notebook allow-once replay.
  All four have passing focused regression checks, including current-version installer certification.
- The process-tree case passed 12 consecutive exact reruns; the complete compute concurrency file
  passed all 18 tests on rerun.
- Exact installer smoke passed in 44.44 seconds: install, packaged resources/version, local RPC,
  initialization and redetection, restart, fresh/legacy databases, non-ASCII and spaced paths,
  exact WSL ownership-receipt reconciliation, and malformed-receipt fail-closed behavior.
- Exact-package Settings UI passed: eight real readiness rows, explicit WSL2 activation and restart
  persistence, explicit PowerShell recovery and restart persistence, retained saved WSL profile,
  zero renderer errors, and zero remaining application processes.

## Certified artifact

- Installer: `aipoch-open-science-0.25.1-win-x64-setup.exe`, 193,917,606 bytes.
- SHA-256: `695FEF110B9EEC3F1E0FB78CCA283F5EE8A9FAA947B88782CDC8096144B4180C`.
- Application source: `17afa494`; installer-smoke harness: `18be94cb`.
- ASAR: 18,189 entries, 230,748,971 bytes, zero forbidden build-input entries.
- Preview manifest: schema 1, version 0.25.1, all three required assets.
- The exact current artifact was independently installed and exercised. Earlier package hashes and
  the historical 0.24.0 certificate are not used as evidence for this approval.

Release controls remain explicit Preview opt-in, PowerShell by default, current readiness checks,
and a rebuild with the Preview switch disabled for rollback. The reference configuration and
administrator-only teardown limitation are documented in `wsl2-bash-preview-v1.md`.

## Evidence limits

Windows and WSL testing uses the local reference host. No actual macOS or ARM64 execution is claimed.
Raw local diagnostic logs may contain host paths and are not part of this privacy-safe record.

The current Windows Shell integration passed all four tests. A representative symlink test fails
at fixture creation with Windows `EPERM`; the source and test match `main`. This host also lacks `jq`
in its Bash environment and a working `python3` command alias, although `python` works. The affected
workflow and reconstruction tests match `main`. These limitations are recorded separately from
feature regressions and cannot be counted as successful validation.

The broad run contains 24 failures at Windows symlink fixture creation, 13 Bash workflow failures,
and two Python executable failures. Working-file receipt publication also showed intermittent
Windows rename failures. The two original non-symlink observer failures passed exact reruns; the
observer production and test files are byte-identical to main. An additional rename-gap case passed
on both main and the branch after an intermittent failure. A renderer subagent evidence case also
passed its exact rerun (1 test, 1.33 seconds). These reruns do not retroactively turn the broad run
green.

The remaining broad-run failures are 39 host dependency/privilege cases and six intermittent cases
that passed targeted reruns, each separately inspected. No unresolved WSL-specific failure
remained after the focused repairs and exact-artifact acceptance. The full-suite result remains
non-green and should not be described as a clean CI run. No actual macOS, ARM64, NAT-networking,
broader distro/version-matrix, or administrator teardown certification is implied.

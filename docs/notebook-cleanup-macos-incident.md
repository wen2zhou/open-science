# macOS cross-session cleanup and SIGKILL verification

## Incident on 2026-09-23

The running development app came from PR #2918 (`dcb253c4e`). Session #896's
Python kernel exited at 13:47:40 China Standard Time. macOS unified logging
records the following at 13:47:40.049, before the application observed the exit:

```text
memorystatus: triggering no paging space action
memorystatus: killing largest compressed process python3.12 [55572] 86587 MB
```

At 13:47:40.216 the application reported `signal: SIGKILL`. The subsequent
termination proof was `ownership-candidate-unresolved`, with two owned
identities and one ambiguous identity. Twelve attempts did not resolve the
proof. The shared native cleanup-domain gate then blocked sessions #898 and
#900 with `SHELL_CLEANUP_INCOMPLETE: Previous shell cleanup could not be reconciled.`

The system initiated the kill under memory/paging pressure. The application
error `Notebook process tree could not be stopped.` describes the subsequent
failure to prove descendant cleanup; it does not identify who sent SIGKILL.
The historical logs do not record the ambiguous candidate's identity, so its
exact origin cannot be reconstructed from those logs.

The interrupted cell treated `panel_crops(fig)` pixel coordinates as inches:

```python
fig.savefig("_crop_a.png", dpi=300,
            bbox_inches=matplotlib.transforms.Bbox.from_extents(*box))
```

A read-only copy of that cell and its two CSV inputs was evaluated in disposable
storage with `Figure.savefig` replaced by a dimension recorder. No PNG save or
oversized renderer allocation occurred. The first crop `(24, 84, 656, 775)`
would request 189,600 × 207,300 pixels, or about 146.42 GiB for one RGBA buffer.
The other two crops would require about 148.97 and 157.23 GiB respectively.
These measurements establish the unit error and explain the extreme allocation;
they do not measure a successfully allocated full buffer in the killed process.

The figure-style crop correction is handled in a separate PR. Its local skill edit has been
reverted here; this PR retains only the incident evidence, not the plotting change.
A second disposable copy used the corrected Pillow crop and actually saved and
decoded the output PNGs: 632 × 691, 643 × 691 and 632 × 742 pixels (approximately
31–37 KB each). The live session and its files were not modified.

## Verification boundary

PR #2919's local branch is `fix/cleanup-isolation-macos`; verification started
at `4e2fbfd5a`. Tests use a read-only existing Python interpreter, disposable
storage and fixture-owned processes. No live user session is replayed or stopped,
and no user cleanup receipts are deleted. Only disposable copies of the plotting
cell and its inputs were evaluated for the dimension audit and corrected crop.

`runtime-service.macos-isolation.integration.test.ts` drives the actual runtime
service, executor, shipped Python/REPL loops, macOS sandbox, gateway and disk
repository. Runtime discovery and settings select the existing interpreter.
New scenarios exercise:

- A real Python SIGKILL with normal native teardown.
- A real Python SIGKILL with a child in a separate process group/session;
  teardown must remove that descendant as well.
- A real Python SIGKILL with unsuccessful proof injected after actual native
  teardown, reproducing the retained-cleanup state deterministically.

Each scenario checks existing and newly created sessions, Python/Bash/REPL
execution, unique persisted successful results, and preservation of the warm
Python namespace. The unknown-proof scenario also checks retained roots and
receipts, rejected same-kernel retries, eventual recovery when proof becomes
available, and the survival of another session after that recovery.

The new diagnostic assertion failed before the fix: an incomplete cleanup
replaced the original SIGKILL error with a generic stop error. The executor now
preserves the original exit diagnostic and cause while retaining the
`NotebookExecutionStopError` classification and cleanup barrier.

## Existing-profile admission defect

The actual development profile contained 100 pre-existing command directories
and 100 receipts at inspection. The original PR #2919 counted all recovered
roots against its default limit of 64. A new isolated integration scenario with
100 valid historical roots failed on its first ordinary Python execution before
any SIGKILL: historical residue alone exhausted admission permanently.

The first attempted fix excluded historical roots from the 64-root counter, but still let current
retained roots block unrelated Sessions. A real native regression now launches 65 fixture shells,
keeps one alive with unknown proof, and SIGKILLs the others while withholding their termination
proof. Before the final fix, a later admission failed with `Retained command capacity is exhausted`.

The final fix removes the count-based gate and its configuration entirely. It preserves native
independent-command permission, shared-resource checks, identity validation, serialized receipt
registration and all retained cleanup obligations. No arbitrary replacement threshold or new
resource-quota subsystem is introduced. The 65-root regression checks another Session executes
successfully and every unverified root/receipt remains. The 100 historical-root scenario separately
checks startup compatibility; it does not substitute for testing current-owner accumulation.

Run the real integrations on macOS with an existing interpreter:

```sh
OPEN_SCIENCE_TEST_PY_ENV=/absolute/path/to/python npm test -- \
  src/main/notebook/runtime-service.macos-isolation.integration.test.ts \
  src/main/notebook/network-sandbox-owner.macos-isolation.integration.test.ts
```

The companion owner and service tests separately retain an actually live Bash
process with unknown cleanup while independent commands execute. This is
distinct from suppressing proof after a dead Python fixture.

## Recovery added after the initial isolation fix

The initial PR #2919 isolation fix alone was insufficient. It prevented one retained command from
blocking independent work but did not provide a complete recovery contract. This working tree now:

- Preserves structured exit evidence through durable run results, MCP errors and fatal Turn errors.
- Reconciles a failed cleanup twice after the initial attempt, without rerunning user code.
- Offers the agent a targeted `notebook_restart` for Python/R environments or the Agent SDK REPL.
- Clears only the successfully recovered interpreter's captured Turn failure, including after a
  rejected execute retry. Slow restart requests cannot adopt a newer Turn's authority. Environment
  aliases are normalized before clearing the corresponding error.
- Preserves the agent-facing recovery contract. The renderer recovery notice/button, eight-locale
  additions and their Electron test are deferred in `.scratch/deferred-kernel-recovery-ui.patch`;
  they are no longer part of this PR working diff.
- Attributes macOS SIGKILL to memory pressure only with an exact-PID `memorystatus: killing` record.
  Log lookup has a time/output limit; missing evidence stays unknown. The native predicate was also
  run against the historical #896 time window and returned the actual PID 55572 kill record above.

The new recovery tests initially caught two real defects: a repeated rejected MCP execute lost the
structured original cause and made the Turn permanently fatal; a whitespace/default environment
alias restarted successfully without clearing its Turn error. A slow-request boundary test also
caught restart acquiring the wrong Turn. All three were fixed and their regressions passed.

## Validation before the final scope reduction

Platform: macOS 26.5.2 arm64, Node 23.11.0. The Python fixture is the existing development interpreter,
selected read-only; no environment was installed. All injected faults use disposable profiles and
fixture-owned processes, never live user Sessions.

At that stage, the native suite included nine owner/service scenarios. They cover real SIGKILL, a child that
escapes its parent's process group, transient proof failure, persistent unknown proof, 100 historical
receipts, independent existing/new Sessions, Python/Bash/REPL execution and persisted output. The
unknown-proof case uses an actual MCP client and local RPC server; it checks rejected same-kernel
execution, targeted recovery, successful Turn finalization, and preserved healthy interpreter state.
The OS teardown actually runs before persistent proof failure is injected. Separate scenarios keep
an actual Bash process alive with unknown proof while independent work succeeds.

The Electron Playwright journey uses the built app, a disposable application profile, real Python,
real packaged MCP/RPC and a deterministic agent fixture. It sends SIGKILL to the fixture interpreter,
checks the visible recovery button, clicks it, then verifies fresh Python state and retained Agent
SDK variables through another agent turn. Before/after screenshots were inspected. The deterministic
agent validates tool transport and recovery behavior; it does not certify an external LLM's choices.

| Final check                                                                            | Result                                                                                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Notebook execution owner/contract/consumer regression                                  | 624 selected files: 585 passed, 6 failed, 33 skipped; 16,970 tests passed, 10 failed, 530 skipped; failures investigated below |
| Exit diagnosis, agent guidance, renderer recovery and eight-locale guards              | 4 files; 846 tests passed                                                                                                      |
| Built Electron SIGKILL → UI recovery → new execution and preserved healthy interpreter | 1 passed (50.7 seconds); screenshots inspected                                                                                 |
| Main/sandbox and renderer typechecks                                                   | Passed                                                                                                                         |
| ESLint and `git diff --check`                                                          | Passed; formatting warning corrected and affected files rechecked                                                              |
| Module-impact manifest validation                                                      | Passed; new diagnosis test registered for future module runs                                                                   |

The final module run was started before the new diagnosis file was registered in the manifest. Its
actual selected file set is reported as executed; that file was separately included in the four-file
supplement above. No application behavior changed after the final build; later edits formatted the agent test fixture,
registered the already-passing diagnosis test, and corrected test-only context accounting/synchronization.

The broad run was **not a clean single-pass result**. Three failures came from the static MCP context
budget: the new scoped recovery parameters/instructions add about 134 tokens, bringing the maximum
measured schema/prompt total to 4,886. The test budget is now 4,950 (64 tokens of headroom); product
recovery instructions were retained. The other seven failures were five 15-second test timeouts and
two short polling deadlines. All failing cases, plus adjacent parameter variants, passed in a
one-worker rerun: 6 files, 18 tests passed, 799 unselected tests skipped (25.69 seconds).

The broad run also reported an unhandled missing `run.json` after the runtime lifecycle test's
one-second polling deadline failed while its held execution was still running. Its fixture directory
was then deleted. The test now awaits the actual executor-start event and settles the held run in
`finally` before fixture cleanup, matching the neighboring lifecycle test's established pattern.
The complete runtime-service test file passed after this test-only correction: 406 tests, no unhandled errors. Other timeout
thresholds and product behavior were not changed. A competing test run was present on the host;
resource contention is a plausible explanation for the other timing failures, not a proven root cause.

The earlier isolation-only baseline passed 591 files / 16,976 tests. That result preceded the recovery
UI and shared-contract changes and is not used as certification of the final working tree.

## Limits

SIGKILL is exercised without exhausting host memory. The original OOM diagnosis comes from actual
historical OS logs, while automated classification checks include missing/inconclusive evidence.
The unknown-proof fixture does not reproduce the historical candidate-identification race itself.
Python recovery is verified end to end; R shares the implementation but has no new real-R crash
journey. REPL teardown is exercised with real Node processes; its targeted MCP restart is checked for
preserving Python state, but the native Python suite does not separately inject a REPL proof failure.

If ownership remains unknown, the affected interpreter stays blocked: neither restart nor receipt
removal can establish that unknown descendants stopped. Independent admission still requires released
shared resources and intact retained-root identities. The 64-root count gate has now been removed.
Historical roots remain quarantined and may accumulate; no background garbage collector or new
resource-capacity policy is claimed. These tests do not certify Linux/Windows/WSL
native recovery or unlimited repeated failures.

## Final scope: no count gate, preserved kernel error context

The plotting skill edit is reverted. The renderer/translation/Electron-journey changes are preserved
in the local deferred UI patch and removed from this PR diff. Error context and its actionable,
scoped agent recovery contract remain in scope.

The current native service tests compare the actual MCP error/result payload with durable run
recovery facts: interpreter/environment, exit code/signal, cause, cleanup state and execution
certainty. A refused retry must say `not-started`, retain the original SIGKILL, and require cleanup
verification. Missing OS evidence must not turn into an OOM claim. Nonzero process-exit tests also
check stderr and exit code are preserved alongside the structured context.

Final scope validation:

- Before removing the limit, the real 65-root scenario failed specifically with
  `SHELL_CLEANUP_INCOMPLETE: Retained command capacity is exhausted` (2.99 seconds).
- After removal, owner unit/native checks passed: 98 tests passed, 1 platform skip (5.12 seconds).
- Both real native integration files passed all 10 scenarios (118.60 seconds), including the
  complete MCP context assertions and retained-root preservation after independent execution.
- Python nonzero-exit and real Node REPL exit diagnostic checks both passed (2.04 seconds).
- Main/sandbox typechecking, ESLint and `git diff --check` passed. A test mock signature was
  corrected during typechecking; its execution behavior did not change.
- The deferred UI patch passes `git apply --check`; the plotting skill has no local diff.

The earlier broad-run results above remain explicitly historical. They were not rerun wholesale
for this scope reduction; current verification targets changed admission behavior and the actual
agent-facing exception contract.

## Delivery audit follow-up

The final native acceptance now also calls `repl_execute` and `bash_execute` through the failed
Session's existing MCP connection and Turn **before** releasing the injected Python cleanup proof.
It verifies completed results, the healthy REPL's retained variable, and preservation of the failed
Python root and receipt. Thus the same-Session interpreter boundary is tested directly in addition
to the existing cross-Session cases.

The first expanded native run passed those execution assertions but failed final sandbox disposal
in the historical-receipt scenario; the three subsequent cases then failed the process-wide
single-owner guard. The isolated historical case passed (14.04 seconds), and both native files
passed together (10 scenarios, 69.82 seconds). The original failure is retained as evidence; those
reruns alone do not establish its cause. No cleanup proof or disposal requirement was weakened.

The old Windows core job failed the child Notebook Artifact publication test at its 30-second
budget and then reported a locked database during fixture removal. This is the only scenario in
that file that migrates a real SQLite schema. It now uses the same 120-second per-test budget as
existing Artifact/SQLite tests and records migration phases and elapsed time. Business assertions
and the remaining lane's timeout are unchanged. The old log has no stage timing, so this correction
must not be described as proof of where the historical timeout occurred. Windows CI must execute
the updated scenario.

Structured recovery coverage is limited to unexpected interpreter exits and subsequent execution
blocked by that interpreter's pending cleanup. Spawn, protocol, pipe, timeout and cancellation
paths retain their existing handling; this PR does not certify a redesign of every kernel error.

Full final fallback and exact-commit CI are pending at this checkpoint. The PR remains Draft until
the required evidence has been recorded and independently reviewed.

## Agent context review follow-up

Recovery context now separates facts from suggested actions. The global Notebook prompt keeps the
execution-dispatch and side-effect distinction, but no longer limits recovery to one attempt or
instructs the agent to stop every Notebook tool after repeated kernel failures. Error messages
retain exit diagnosis, lost interpreter state and cleanup facts without repeating recovery commands.

Dynamic recovery text offers an exact Python/R or REPL restart target only when cleanup was
unverified and the failure is still unresolved. Verified cleanup needs no additional restart for
that exit. Commands rejected before dispatch do not receive warnings about their own partial effects;
commands that may have run still require consideration of those effects. State rebuilding is
conditional on it not already having been restored. Neither a code defect nor an OS memory cause is
inferred from an unexplained exit.

The restart description now documents target selection and state reset rather than a mandatory
recovery policy. It no longer equates every refused restart with unverified cleanup. The success
note explicitly says a fresh process starts on the next execution and that interrupted file writes
may be partial. No process ownership, cleanup proof or admission checks were relaxed.

Validation for this context revision:

- Recovery projection, MCP and static context tests: 3 files, 154 tests passed. The static schema plus
  guidance budget is restored from 4,950 to 4,800 tokens across the existing platform/framework cases.
- Real Python and Node REPL nonzero-exit diagnostics: 2 selected tests passed, 150 unrelated tests
  unselected. Error text retains diagnostics without duplicate recovery instructions.
- Native service integration: all 8 scenarios passed with the final context (60.22 seconds).
  The suite now additionally executes through MCP immediately after verified SIGKILL
  cleanup, without calling restart, and verifies a fresh namespace and completed output. Existing
  same-Session REPL/Bash, cross-Session, unresolved-proof and historical-receipt assertions remain.
- Main/sandbox typechecking and ESLint passed. This is targeted context/recovery-path verification,
  not a new full-suite certification or an evaluation of external model behavior.

## Consumer coverage correction during final delivery

The first complete run after the history cleanup and its Ubuntu shard both found one deterministic
coverage-registration failure: the native service test now imports the real MCP/RPC composition,
which makes it a transitive consumer of 55 additional modules. Their existing manifests lacked that
one test entry. The correction adds it to each `testFiles.consumer` array and to four exact
architecture expectations; no owner, interface, capability, fallback or existing test is removed.
The consumer-coverage guard and those four architecture files passed all 42 tests (8.11 seconds).
The complete final fallback and exact-commit CI must then be rerun for the corrected registration.

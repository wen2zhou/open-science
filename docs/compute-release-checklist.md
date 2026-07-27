# Compute Scheduler Release Checklist (V1)

> This is the authoritative release-evidence record for remote compute in Open Science V1. It records,
> per release, which real-cluster gates PASSED, the non-sensitive host/partition identifiers used, and
> the risks that remain UNCOVERED. **Open Science must NOT be advertised as Slurm production-ready until
> the real SSH + Slurm gate (section 1) has passed for the target release and the result is recorded
> here.** Mock/fixture tests passing is necessary but not sufficient.

## V1 execution boundary (what this release can and cannot do)

| Backend | Executable in V1? | Evidence basis |
| ------- | ----------------- | -------------- |
| **Direct SSH** | Yes | Real SSH integration gate (`compute-jobs.integration.test.ts`, `RUN_COMPUTE_JOBS=1`) + driver conformance kit. |
| **Slurm** | **Only after the real gate below passes.** Until then Slurm is shipped behind the same gate as a preview and the app/docs do NOT claim production-ready. As of this writing the real gate has NOT run on any cluster. | `slurm-e2e.test.ts` (`SLURM_TEST_HOST` gated, `REQUIRE_SLURM_GATE=1` for release runs) + fake-scheduler conformance (`slurm-conformance.test.ts`). |
| **PBS** | No (detection + fixtures only) | `pbs-lsf-fixture.test.ts` parses `qsub`/`qstat`/`qdel` output and maps state. No registered driver. |
| **LSF** | No (detection + fixtures only) | `pbs-lsf-fixture.test.ts` parses `bsub`/`bjobs`/`bkill` output and maps state. No registered driver. |

Compute nodes are assumed to have **no egress** unless a host's knowledge doc records a verified
exception. Weight/cache downloads happen on login/data-transfer nodes and are consumed from shared
storage. A `ready` environment is required before a job can name it, and readiness requires a real
witness on the target execution shape (a login-node import is insufficient for GPU/weight-bearing
environments).

## 1. Real SSH + Slurm gate

Suite: `src/main/compute/slurm-e2e.test.ts`
Command: `SLURM_TEST_HOST=<alias> SLURM_TEST_PARTITION=<cpu-part> [SLURM_TEST_ACCOUNT=...] [SLURM_TEST_GPU_PARTITION=...] npx vitest run src/main/compute/slurm-e2e.test.ts`

When `SLURM_TEST_HOST` / `SLURM_TEST_PARTITION` are absent the suite SKIPS and does NOT count as a
pass. Each case logs a `PASS <case> host=<alias> partition=<non-sensitive-id> ...` line on success;
paste those lines into the per-release record below.

### 1a. Mandatory pre-release gate check (`REQUIRE_SLURM_GATE=1`)

A skipped suite still reports green. **A green `npm test` is therefore NOT evidence that the real
cluster path ran.** Before tagging a release, run the gate with the guard armed so a missing config
becomes a hard failure instead of a silent skip:

```
REQUIRE_SLURM_GATE=1 SLURM_TEST_HOST=<alias> SLURM_TEST_PARTITION=<cpu-part> \
  npx vitest run src/main/compute/slurm-e2e.test.ts
```

Every run prints exactly one machine-readable verdict line. Confirm it by grepping the run log:

```
npx vitest run src/main/compute/slurm-e2e.test.ts --reporter=verbose 2>&1 | grep '\[slurm-e2e\] GATE='
```

| Verdict | Meaning | Release action |
| ------- | ------- | -------------- |
| `GATE=ENABLED reason=configured host=<set> partition=<set> required=1` | Real cluster path executed under the release guard. | Proceed; record the case PASS lines below. |
| `GATE=SKIPPED reason=missing-config ... required=0` | Guard not armed and config absent — nothing was verified. | **Not releasable as Slurm-ready.** Re-run with `REQUIRE_SLURM_GATE=1`. |
| `GATE=FAILED reason=missing-config ... required=1` | Guard armed but config missing; the run fails and names the missing variables. | Fix the env per `.env.example`, then re-run. |

The verdict reports only whether each variable was set (`<set>` / `<unset>`) — never the hostname or
the partition value, so it is safe to paste into a release record. A recorded `Slurm gate: PASS`
requires a `GATE=ENABLED ... required=1` line plus the seven case lines.

| # | Case | Required env | Status |
| - | ---- | ------------ | ------ |
| 1 | CPU success + harvest | `SLURM_TEST_HOST`, `SLURM_TEST_PARTITION` | _record per release_ |
| 2 | GPU compute-node witness | adds `SLURM_TEST_GPU_PARTITION` (skipped individually if unset) | _record per release_ |
| 3 | Non-zero workload failure | `SLURM_TEST_HOST`, `SLURM_TEST_PARTITION` | _record per release_ |
| 4 | User cancellation | `SLURM_TEST_HOST`, `SLURM_TEST_PARTITION` | _record per release_ |
| 5 | Walltime timeout | `SLURM_TEST_HOST`, `SLURM_TEST_PARTITION` | _record per release_ |
| 6 | Application restart recovery | `SLURM_TEST_HOST`, `SLURM_TEST_PARTITION` | _record per release_ |
| 7 | Ready-environment cache/weight witness | `SLURM_TEST_HOST`, `SLURM_TEST_PARTITION` | _record per release_ |

Cleanup: the suite removes ONLY the per-test remote workdirs under `SLURM_TEST_WORKDIR_ROOT`
(default `~/.openscience/e2e`). It never touches shared caches, images, weights, or other jobs.

### Per-release record

> Copy this block per release and fill in the non-sensitive identifiers + the PASS/SKIP line each case
> emitted. Delete nothing above this heading.

```
Release: <version / date>
Slurm gate: PASS | NOT RUN | PARTIAL
Host alias (non-sensitive): <e.g. biowulf>
CPU partition (non-sensitive): <e.g. quick>
GPU partition (non-sensitive): <e.g. gpu> or <not exercised>
Account (non-sensitive): <e.g. lab-xyz> or <cluster default>
Operator: <name>

Gate verdict line (must be GATE=ENABLED ... required=1 for a PASS):
<paste the [slurm-e2e] GATE= line here>

Case results (paste the [slurm-e2e] PASS/SKIP lines emitted by the run):
1. ...
2. ...
...
```

## 2. Direct SSH gate

Suite: `src/main/compute/compute-jobs.integration.test.ts`
Command: `RUN_COMPUTE_JOBS=1 COMPUTE_TEST_SSH_ALIAS=<alias> npx vitest run src/main/compute/compute-jobs.integration.test.ts`

Direct SSH is the always-releasable baseline (design.md §3 invariant 7). A Direct regression blocks
every release regardless of Slurm status. Record the host alias + PASS/SKIP per release.

## 3. Mock/fixture tests (always run in CI)

These run unconditionally in `npm test` and must be green on every PR:

- `slurm-gate.test.ts` — gate decision (skip / hard-fail under `REQUIRE_SLURM_GATE` / run) and the
  machine-readable `GATE=` verdict line. Runs without a cluster.
- `slurm-conformance.test.ts` — fake-cluster Slurm driver + poller state machine.
- `scheduler-conformance-kit.test.ts` — reusable driver conformance kit (handle/submit/observe/state-map/cancel).
- `pbs-lsf-fixture.test.ts` — PBS/LSF command-output parsing + state mapping (NON-production).
- `slurm-resources.test.ts`, `slurm-directives.test.ts`, `slurm-wrapper.test.ts` — rendering and reserved-field rejection.
- `compute-service.test.ts`, `job-poller.test.ts`, `harvest-engine.test.ts`, `environment-repository.test.ts`, `provisioning-workflow.test.ts` — orchestration.

## 4. PBS/LSF non-production boundary

PBS and LSF are explicitly out of scope for V1 execution (design.md §2, PRD "范围与发布边界"). The
probe MAY report `detectedScheduler: 'pbs' | 'lsf'`; the Settings > Compute page renders a
"detected, not yet supported for execution" notice, and `_resolveDriver` rejects these hosts with a
structured error rather than silently dispatching (design.md §3 invariant 7). The `pbs-lsf-fixture`
module + tests document the command shapes and state mapping a FUTURE adapter would reuse; no
`PbsDriver`/`LsfDriver` is registered.

## 5. Uncovered risks (must be communicated)

- Slurm accounting delay is tolerated (a job absent from `squeue` AND `sacct` stays non-terminal and is
  re-polled); a pathological accounting outage could keep a job non-terminal longer than expected.
  Mitigated by the per-job walltime (`scancel` fallback on Open Science timeout).
- Walltime-kill classification depends on the cluster's `sacct` state reporting (`TIMEOUT` vs `FAILED`);
  the poller maps both to a terminal failure-class state. Confirm on the target cluster.
- The GPU witness requires a GPU partition; without `SLURM_TEST_GPU_PARTITION` that case is skipped and
  GPU execution is NOT evidenced for the release.
- Restart recovery relies on the persisted slurm handle being readable from a fresh process; a
  schema/handle regression would surface as a non-recoverable job and must block the release.

## 6. Credential discipline

Real-test configuration, SSH keys, accounts, tokens, and any host secret come ONLY from environment
variables (never committed, never in fixtures, never in logs). The gate logs non-sensitive identifiers
(host alias, partition name) only. See `.env.example` for the supported variables and the suites' module
docstrings for the exact env contract.

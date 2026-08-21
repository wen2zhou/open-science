# Session Plan status-sync model evaluation

This is a real-model evaluation protocol for the Session Plan guidance contract. Deterministic tests
do not count as model-behavior evidence. Run the protocol through an instrumented Open Science build
so the transcript includes the actual Plan MCP calls and substantive tool calls made by the provider.

## Current execution status

The evaluation was **not run for this change**. This repository exposes model evaluation only through
the app-owned, capability-gated `host.skills.evals` surface for Skill packages; it does not expose a
Session Plan behavior runner from the test suite or command line. Read-only authentication checks found
logged-in standalone Codex and Claude CLIs and configured OpenCode providers, but those CLIs cannot
exercise the app-owned approval, identity, persistence, interruption, and protected-context seams by
themselves. No baseline or improvement claim can be made until the scenarios below are run through
instrumented Open Science builds.

## Run protocol

Use `docs/session-plan-status-sync-eval-scenarios.json` as the fixed scenario set.

1. Build two instrumented app revisions: `origin/main` (baseline) and the candidate commit.
2. For each supported framework (Claude Code, Codex, and OpenCode), select and record one available
   representative model. Use the same model and permission profile for baseline and candidate.
3. From the candidate checkout, copy `docs/session-plan-status-sync-eval-fixtures` unchanged into a
   clean writable Project directory for **both** revisions. Record `shasum -a 256` for every fixture
   file in the run record. `missing-input.txt` must remain absent. Start each case with no generated
   note or result files left over from another run.
4. Start each case from a new Project and Session, send the exact scenario `prompt`, and have the Agent
   generate the supplied `plan_steps`. Approve it through the Plan card so execution continues from
   that same `generate_plan` call. For continuation cases, perform the specified interruption or
   context replacement before sending the continuation prompt.
5. Run each configuration at least three times. Preserve the provider/framework/model, app revision,
   complete ordered tool-event transcript, terminal response, and observer annotations.
6. Do not repair statuses manually. Do not count intentionally concurrent, overlapping, exploratory,
   indivisible, or pending-result work as delayed bookkeeping.

## Scoring

For each run, annotate when each step begins substantive work and when its outcome first becomes
clear. Count one `unjustified_batch` when two or more step outcomes are already clear and their
terminal status calls occur consecutively later, with no scenario-defined reasonable exception.

Also record these booleans:

- `same_turn_start_checkpoint`: after same-turn approval, the first clear step is marked
  `in_progress` near the start of substantive work.
- `sequential_checkpoint_order`: terminal status is recorded before substantive work begins on the
  next clearly attributable sequential step.
- `parallelism_preserved`: dependency-eligible parallel work is not falsely serialized or settled
  early.
- `uncertainty_preserved`: exploratory, indivisible, or pending-result work is not assigned invented
  precision.
- `blocked_reachability_preserved`: no newly unreachable work starts after a blocker, while already
  started eligible peer work is settled when its result becomes known.
- `durable_checkpoint_used`: continuation uses the latest recorded statuses, does not repeat completed
  work, and verifies uncertain inherited `in_progress` work.

Report `unjustified_batch` as a count and rate per framework/model/configuration. The candidate passes
only if the rate decreases relative to its matched baseline without regressions in the exception and
recovery booleans. If it does not, record the exact missed timing boundary. Do not propose automatic
updates, all-tool reminders, or a turn-completion gate without new evidence that this minimal contract
is insufficient.

## Result record

Store each run as JSON with: `scenario_id`, `configuration`, `revision`, `framework`, `model`,
`run_number`, `ordered_events`, `annotations`, `unjustified_batch`, the booleans above, and `notes`.
The final report must list covered frameworks/models, reasonable exceptions applied, unmatched or
failed runs, remaining risks, and whether follow-up work is justified.

Ticket 03 remains incomplete until this protocol has real baseline and candidate runs for all three
frameworks. Completion requires an instrumented Open Science build that records ordered Plan MCP and
substantive tool events, authenticated provider sessions for Claude Code, Codex, and OpenCode, and an
operator able to approve Plan cards and trigger the specified interruption/context replacement. The
standalone provider CLIs present on a developer machine are not a substitute: outside the app they do
not receive Open Science's server-owned Plan identity, approval flow, durable runtime projection, or
protected continuation context.

# Subagent delegation release evidence

Issue 26 closes the release-gate integration for the durable Session/Frame/Attempt model. This
evidence applies to the final tree containing this document, rebased on `feat/subagent-delegation`
at `fea8976f`. The renderer remains a projection of the durable graph; it does not own orchestration
state.

## Executable behavior evidence

The behavior table uses these exact reproducible commands:

```text
FULL: npm test
FOCUSED: npx vitest run src/main/delegated-work/production-composition.test.ts src/main/delegated-work/session-record-adapter.test.ts src/main/notebook/local-rpc-server.test.ts src/main/acp/runtime-coordinator.test.ts src/renderer/src/pages/workspace/SubagentReleaseSurfaces.render.test.tsx src/renderer/src/pages/workspace/SessionNotebookDialog.render.test.tsx
ELECTRON: npx playwright test e2e/subagent-release-gate.spec.ts --workers=1
```

| Behavior | Command or suite | Final result |
| --- | --- | --- |
| Session scope, validated origin binding, child isolation, stable detached identities, continuation, messaging, and parallel admission | `FULL` | PASS: 848 files passed, 14 skipped; 12,368 tests passed, 190 skipped. |
| Detached child terminal mutations notify the renderer without changing committed-write success | `FOCUSED` | PASS, including late terminal publication and a throwing-listener regression. |
| Exact provisional capability adoption rejects stale or mis-scoped owners | `FOCUSED` | PASS, including the negative stale-owner case. |
| Delegated permission blocks only its Attempt and exposes risk scope | `FULL` and `ELECTRON` | PASS. The Electron journey observes a real ACP child permission and resolves it through the product UI. |
| Root Stop cascades to all active children | `ELECTRON` | PASS. One root Cancel action terminalizes two running production-composed children as cancelled. |
| Unsupported Specialist configuration fails before durable admission | `FOCUSED` and `ELECTRON` | PASS. Product-owned safe guidance and Open Settings are visible; durable record and delegated Frame counts remain zero. Authorization failures do not create configuration guidance. |
| One scalable persisted surface remains usable after restart | `ELECTRON` | PASS. A separate persisted 24-child fixture verifies ordering, keyboard/focus operation, narrow viewport layout, and reopen persistence. |
| Focus and icon-only controls follow the design system | `FOCUSED` | PASS. New interactive controls use the 3 px focus-visible ring; icon-only Close uses the shared Tooltip and an accessible name. |
| Artifact and Review evidence retain Frame/Attempt provenance | `FULL` | PASS. |
| Frameworks fail closed behind certification | `FULL` | PASS. |

The focused regression invocation covered six files and 118 tests, all passing. The final Electron
invocation covered three tests, all passing: production-composed delegation/permission/Stop,
unsupported Specialist zero-admission messaging, and the independent persisted 24-child UX lane.

## Release gates

| Gate | Result and evidence |
| --- | --- |
| Gate A — dispatch and isolation | PASS through the full contract/durable/persistence suites and the real Electron production journey. |
| Gate B — controls and recovery | PASS through Stop, cancellation/error terminal, scoped permission, recovery, late durable refresh, and committed-notifier isolation tests. |
| Gate C — attributed evidence | PASS through Artifact/Review provenance suites and the read-only Preview projection tests. |
| Gate D — release UX and compatibility | PASS on the real Electron production journey for delegation, permission, safe unsupported-config messaging, and a two-child Stop cascade. The 24-child persistence/keyboard/mobile lane is intentionally separate and does not stand in for production orchestration. |

## Final repository checks

All commands were run from the release worktree after the final material edit:

| Command | Result |
| --- | --- |
| `npm test` | PASS: 848 files passed, 14 skipped; 12,368 tests passed, 190 skipped. |
| `npm run typecheck` | PASS: node and web TypeScript projects. |
| `npm run lint` | PASS. |
| `npm run check:web-api-map` | PASS. |
| `npm run check:cli-package` | PASS: package dry-run verification. |
| `npm run build:e2e` | PASS. |
| `npx playwright test e2e/subagent-release-gate.spec.ts --workers=1` | PASS: 3 tests. |
| `git diff --check` | PASS. |

## Consumer and platform scope

- Electron desktop on macOS is included. Its journey uses the actual Host/RPC composition and the
  production composer against a controlled OpenCode process; the controlled process is the
  certified adapter boundary, not a renderer-owned delegation stub.
- The web consumer is excluded from the Electron-only Host composition journey. Its public surface
  remains covered by `check:web-api-map` plus shared renderer/type tests.
- The CLI is not a delegated-work feature consumer. `check:cli-package` covers its packaging
  boundary; no CLI delegation claim is made.
- Windows and Linux Electron journeys were not run. Platform-neutral unit/integration suites and
  both TypeScript projects cover shared paths, but OS-specific Electron behavior remains residual
  risk.

## Independent review and residual risk

An independent Standards/Spec review found detached terminal refresh, unsupported-config evidence,
Stop-cascade depth, capability-adoption scope, refresh dependency stability, error classification,
and committed-notifier isolation gaps. Each was remediated and the reviewer verified the first five
remediations with 44 passing targeted tests; the last two have dedicated regressions in the final
targeted and full runs.

No feature-specific Axe run is present. Semantic names, Tooltip behavior, keyboard operation,
focus-visible styling, and screen-reader status text have executable coverage, but automated Axe
coverage remains an explicitly uncovered accessibility risk rather than a claimed pass.

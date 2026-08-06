# Subagent delegation release evidence

Issue 26 is the release-gate integration for the durable Session/Frame/Attempt model. This matrix
maps the vertical slices (PR-01 through PR-14) and release gates to executable evidence. The UI is a
projection of the existing durable graph; it does not introduce a renderer-owned orchestration model.

## Vertical-slice traceability

| Slice | Observable contract                                                              | Primary executable evidence                                                                                                                                         |
| ----- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-01 | Session scope, validated origin binding, and child isolation                     | `src/main/delegated-work/delegated-work.contract.test.ts`, `src/main/delegated-work/durable-delegated-work.test.ts`                                                 |
| PR-02 | Durable Frame/Attempt ownership and restart-safe records                         | `src/main/session-persistence/delegated-work-records.test.ts`, `src/main/delegated-work/session-record-adapter.test.ts`                                             |
| PR-03 | Framework execution handles route events to the exact Attempt                    | `src/main/delegated-work/execution-contract.test.ts`, `src/main/delegated-work/acp-execution.test.ts`                                                               |
| PR-04 | Single blocking delegation and terminal result collection                        | `src/main/delegated-work/durable-delegated-work.test.ts`, `src/main/notebook/local-rpc-server.delegated-work.test.ts`                                               |
| PR-05 | Stop, cancellation, failure, and restart recovery preserve raw status            | `src/main/delegated-work/durable-delegated-work.test.ts`, `src/renderer/src/pages/workspace/subagent-release-projection.test.ts`                                    |
| PR-06 | Detached children and later collection use stable identities                     | `src/main/delegated-work/delegated-work.contract.test.ts`, `src/main/notebook/local-rpc-server.delegated-work.test.ts`                                              |
| PR-07 | Specialist resolution is immutable per Attempt and remains attributable          | `src/main/delegated-work/session-record-adapter.test.ts`, `src/renderer/src/pages/workspace/subagent-release-projection.test.ts`                                    |
| PR-08 | Continuation creates a new Attempt on the same Frame                             | `src/main/delegated-work/durable-delegated-work.test.ts`, `src/main/session-persistence/delegated-work-records.test.ts`                                             |
| PR-09 | Atomic parallel creation preserves dispatch order and sibling isolation          | `src/main/delegated-work/durable-delegated-work.test.ts`, `src/renderer/src/pages/workspace/subagent-release-projection.test.ts`                                    |
| PR-10 | Main-to-child and child-to-Main messages remain Frame-bound                      | `src/main/delegated-work/delegated-work.contract.test.ts`, `src/main/notebook/local-rpc-server.delegated-work.test.ts`                                              |
| PR-11 | A delegated permission request blocks only its Attempt and identifies risk scope | `src/main/acp/permission-context.test.ts`, `src/main/acp/permission-broker.test.ts`, `src/renderer/src/pages/workspace/SubagentReleaseSurfaces.render.test.tsx`     |
| PR-12 | Artifact versions retain delegated Frame/Attempt provenance                      | `src/main/delegated-work/delegated-artifact-evidence.test.ts`                                                                                                       |
| PR-13 | Review findings retain delegated evidence provenance                             | `src/main/delegated-work/delegated-review-evidence.test.ts`                                                                                                         |
| PR-14 | Notebook lanes and advertised frameworks are fail-closed and certified           | `src/main/notebook/delegated-lane-capability.test.ts`, `src/main/delegated-work/certification.test.ts`, `src/main/delegated-work/claude-code-certification.test.ts` |

## Release gates

| Gate                                  | Pass evidence                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate A — dispatch and isolation       | Durable-work, execution-contract, persistence-record, and Notebook delegated-work suites cover single, detached, parallel, Specialist, continuation, and bidirectional messaging.                                                                                                                                                   |
| Gate B — controls and recovery        | Durable-work and permission suites cover Stop, cancellation/error terminals, scoped permission blocking, retryable reads, and restart-safe identities.                                                                                                                                                                              |
| Gate C — attributed evidence          | Delegated Artifact and Review suites prove Frame/Attempt provenance; the Subagent Preview renders the existing Artifact/Review transcript owners read-only.                                                                                                                                                                         |
| Gate D — release UX and compatibility | `SubagentReleaseSurfaces.render.test.tsx`, `subagent-release-projection.test.ts`, Preview persistence suites, and `e2e/subagent-release-gate.spec.ts` cover one summary, one Preview, raw statuses, 24-child ordering, keyboard/focus, screen-reader text, mobile layout, fail-closed framework messaging, and restart persistence. |

## Required repository checks

The release gate is complete only when all of these commands pass from the repository root:

```text
npm test
npm run typecheck
npm run lint
npm run check:web-api-map
npm run check:cli-package
npm run build:e2e
npx playwright test e2e/subagent-release-gate.spec.ts --workers=1
git diff --check
```

Environment-only skips or failures must be recorded separately and must not be described as product
passes. The issue handoff records the exact results for the release candidate commit.

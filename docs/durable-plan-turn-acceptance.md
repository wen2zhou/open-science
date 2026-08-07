# Durable Plan Turn Acceptance

This guide verifies issue #831 through the application UI. It covers the approved **prototype B** interaction: the active Plan occupies the composer as a decision tray while the Conversation Turn is suspended, and the same tray reports continuation progress or interruption.

## Preconditions

- Work from the repository root with dependencies installed.
- Use an isolated test profile or disposable project. The scenarios deliberately restart the application and inject failures.
- Configure the deterministic fake Agent supplied by the E2E fixture. Do not use a real provider for the automated acceptance gate.
- Start each scenario in a session with no active Attempt and no unfinished root Conversation Turn unless the scenario explicitly says to restore one.

## Automated acceptance

Build the Electron application once, then run only the durable Plan Turn specification in a visible browser:

```sh
npm run build:e2e
npx playwright test e2e/durable-plan-turn.spec.ts --headed
```

To pause at Playwright actions and inspect the decision tray, persisted projections, and restart boundaries:

```sh
PWDEBUG=1 npx playwright test e2e/durable-plan-turn.spec.ts --headed
```

The automated specification uses the deterministic fake Agent to cover these product-visible journeys:

1. Send a request that causes the fake Agent to generate a valid Plan.
2. Observe the Plan decision tray, the waiting Session status, and the absence of a running spinner after the generation Attempt ends.
3. Advance the main-process clock by 301 seconds and confirm that the Plan remains actionable without a real-time wait.
4. Approve the long-waiting Plan and observe completion in the original Conversation Turn.
5. Submit feedback, activate a replacement Plan, and approve only the replacement.
6. Fail replacement generation and confirm that the original pending Plan becomes actionable again.
7. Advance the clock, restart the application, reopen the same Session, and Dismiss without starting a continuation.
8. Interrupt an approved continuation, confirm **Needs attention**, select **Retry**, and complete the Turn.
9. Confirm that the ordinary composer returns only after the relevant Turn reaches a terminal outcome.

Duplicate and stale commands, operational termination, migration, and framework/transport parity are covered by the focused service, coordinator, adapter, persistence, and renderer test suites. Use the manual scenarios below for additional application-page exploration.

## Manual application-page acceptance

Use the running Electron application page, not the `THROWAWAY-durable-plan-turn-prototype.html` design prototype, for sign-off. The prototype is intentionally static: its Approve, Dismiss, feedback, and Retry controls do not call the application. Record the Session identifier, initial user message, active Plan version, and visible status at each checkpoint.

### 1. Generate and suspend

1. Open a new Session and send a prompt configured to make the fake Agent generate a Plan.
2. Wait for Plan generation to finish.
3. Confirm that the generated Plan is the current active Plan and that its decision tray replaces the normal composer.
4. Confirm that **Open**, **Dismiss**, **Approve**, the feedback field, and **Send** are enabled.
5. Confirm that the Session says **Waiting for plan approval** and no continuous running spinner remains.
6. Confirm that the generation Attempt/tool call has ended while the Conversation Turn has not completed.
7. Attempt to send an ordinary composer message. It must not bypass the decision tray or create a second root Conversation Turn.

### 2. Optional real-time wait longer than five minutes

This is a manual soak check, not a CI requirement. Leave the application open on the waiting Session for more than five minutes without interacting with the Plan. After the wait, confirm that all Plan actions remain enabled, the status is still **Waiting for plan approval**, no analysis or Plan step has started, and no completion/error state was inferred from an underlying request timeout.

CI does not sleep for 300 real seconds. The automated Electron journey advances the main-process clock by 301 seconds, and deterministic service/coordinator tests enforce the same rule below the renderer. Use this optional soak only to verify the packaged UI manually.

### 3. Restart the same Session

1. While the Plan is pending, close the application normally.
2. Relaunch it and open the same project and Session; do not create a new Session or resend the prompt.
3. Confirm that the same original user message still anchors the unfinished Conversation Turn.
4. Confirm that the same active Plan version is shown in the composer decision tray and remains actionable.
5. Confirm that restart did not create a new message, approve or reject the Plan, start execution, or require the old Agent process/provider Session to survive.

### 4. Feedback and successful replacement

1. In the pending Plan tray, enter specific revision feedback and select **Send**.
2. Confirm that the decision is represented as revision work, not approval, and that the Agent does not execute Plan steps.
3. Confirm that the feedback appears as a user message belonging to the same Conversation Turn.
4. Let the fake Agent produce a valid replacement Plan.
5. Confirm that the replacement becomes the active pending Plan with a new immutable version and actionable decision tray.
6. Open the previous Plan from history and confirm that it is read-only.
7. Confirm that the Session returns to **Waiting for plan approval** and the original user message remains the Turn anchor.

### 5. Replacement failure

1. Start again with a pending Plan and configure the fake Agent's revision Attempt to fail before it produces a valid replacement.
2. Submit feedback.
3. Confirm that the original Plan returns as the active pending Plan and remains actionable.
4. Confirm that approval is still pending, no Plan step ran, and the diagnostic explains the revision failure without converting it into a Plan decision.
5. Confirm that **Approve**, **Dismiss**, and feedback can be used again.

### 6. Approve and complete

1. Select **Approve** on the current Plan.
2. Confirm that the tray immediately records saved approval and changes to a resuming state; duplicate decision controls are disabled.
3. Confirm that approval is durable before the fake Agent observes execution authority or starts the first step.
4. Confirm that exactly one continuation Attempt starts and uses the same Conversation Turn anchor.
5. During execution, confirm that the Session reports **Running** and that the active Attempt indicator is visible.
6. Let the fake Agent finish all terminal Plan work.
7. Confirm that the original Conversation Turn becomes terminal only after the Plan reaches its terminal outcome, and that the normal composer becomes available again.

Repeat the approval action through a deliberate double-click or command retry. It must return the existing result and must not start a second active continuation Attempt.

### 7. Dismiss

1. Generate another pending Plan and select **Dismiss**.
2. Confirm the rejection if the UI requests confirmation.
3. Confirm that the Plan becomes irreversibly rejected and its decision controls disappear or become read-only.
4. Confirm that the Conversation Turn ends, the Session returns to an idle/terminal presentation, and no continuation Attempt or Plan step starts.

### 8. Interrupted continuation and Retry

1. Generate and approve a Plan, then configure the fake Agent/runtime to fail while dispatching or starting the approved continuation.
2. Confirm that the composer tray shows **Needs attention**, keeps the approved Plan visible, and offers **Retry**.
3. Confirm that the Sidebar/Session reports **Needs attention**, no running spinner is shown, and no analysis is running.
4. Restart the application and reopen the same Session. The approved Plan and interrupted state must remain recognizable and retryable.
5. Select **Retry** without approving again.
6. Confirm that Retry creates a new auditable continuation intent/Attempt, retains the same Turn anchor and approved Plan version, and does not run concurrently with the failed Attempt.
7. Let the retry succeed and confirm normal Plan completion.

### 9. Operational termination isolation

For a pending Plan, inject each supported condition independently: provider timeout, MCP timeout, connection close, Agent process exit, and Attempt cancellation/stop. After each condition, confirm that the Plan stays pending and actionable, the Conversation Turn stays unfinished, no Plan step runs, and the UI does not present an idle, completed, approved, rejected, or continuation-interrupted state.

### 10. Stale and unauthorized actions

1. Keep an old Plan card or revision open, then activate a replacement Plan.
2. Attempt approval, rejection, and feedback from the old card/revision.
3. Confirm that each action fails closed with a stale Plan or revision-conflict result and does not affect the active Plan.
4. Attempt a Plan step update before approval and confirm that it is rejected as execution unauthorized.

## Expected state table

| Durable state                                    | Composer / Plan surface                                             | Session status            | Spinner                  | Available user actions                              | Must not happen                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------- | ------------------------- | ------------------------ | --------------------------------------------------- | ---------------------------------------------------------------- |
| `awaiting_plan_approval` + active Plan `pending` | Prototype-B decision tray occupies the composer                     | Waiting for plan approval | None                     | Open, Approve, Dismiss, Feedback                    | Step execution, ordinary overlapping prompt, implicit completion |
| Feedback continuation pending                    | Decision accepted; revision is being prepared                       | Resuming                  | Dispatch-only indication | No duplicate decision while dispatching             | Approval or execution authority                                  |
| Feedback Attempt failed before replacement       | Original pending Plan decision tray restored with diagnostic        | Waiting for plan approval | None                     | Open, Approve, Dismiss, Feedback                    | Losing or silently rejecting the original Plan                   |
| Replacement activated                            | New Plan version in actionable decision tray; old version read-only | Waiting for plan approval | None                     | Open, Approve, Dismiss, Feedback on current version | Action from the stale version                                    |
| Approved `continuation_pending`                  | Saved approval / resuming tray; decision controls disabled          | Resuming                  | None                     | Open Plan                                           | A second approval or second active Attempt                       |
| Execute `continuation_active`                    | Current Attempt activity replaces decision controls                 | Running                   | Visible                  | Existing run controls only                          | Step update from an unbound or revision Attempt                  |
| Approved `continuation_interrupted`              | Needs-attention tray with the approved Plan retained                | Needs attention           | None                     | Open Plan, Retry                                    | Approval rollback, automatic duplicate replay                    |
| Rejected terminal                                | Plan is historical/read-only; normal composer restored              | Idle / terminal           | None                     | No Plan decision                                    | Continuation or Plan step execution                              |
| Completed/blocked terminal                       | Terminal Plan result; normal composer restored                      | Idle / terminal           | None                     | No Plan decision                                    | Unfinished Turn or active continuation left behind               |

## Framework and transport parity

Run the shared scenario matrix for Codex, Claude Code, and OpenCode, and for stdio and HTTP Plan transports. Each combination must expose the same visible lifecycle and authorization result. The test may adapt how an Attempt is launched or terminated, but it must not duplicate or weaken the Session Plan workflow rules for a particular framework or transport.

## Test-fixture limitations

- The fake Agent proves orchestration, persistence, version binding, authorization order, and visible UI behavior. It does not prove the quality of a real model's Plan or natural-language interpretation of feedback.
- The Electron journey's advanced clock and deterministic service/coordinator tests prove that product state has no elapsed-time expiry. They do not exercise operating-system sleep, real network idle timeouts, provider quotas, token expiry, or wall-clock drift; use the optional manual soak for that evidence.
- Injected provider/MCP/process failures prove the application's state transitions at defined seams. They do not certify every provider SDK error shape or every platform-specific process failure.
- A headed Playwright run proves the packaged E2E build and application-page flow under the fixture profile. It does not replace exploratory checks with at least one supported real provider after the deterministic acceptance gate passes.
- Restart acceptance must launch a new application process against the same persisted test profile. Reloading only the renderer is insufficient evidence of durable recovery.

## Sign-off record

Record the commit, operating system, E2E command result, manual scenarios completed, and any skipped optional soak or real-provider exploration. Issue #831 is acceptable only when the application page demonstrates all three product invariants: a pending active Plan remains actionable across time and restart; no Plan execution occurs before durable approval; and approval resumes the same Conversation Turn through a retryable continuation Attempt.

const SESSION_PLAN_SYSTEM_PROMPT_APPEND = [
  '<open_science_session_plan_instructions>',
  'Generate a Session Plan only for genuinely multi-stage work where the user benefits from reviewing phases, independent work tracks, or execution scope before work begins; not for simple lookups, single computations, basic file inspection, or other straightforward tasks.',
  'For work that may need a Plan, discover applicable skills before generating it.',
  'When a Plan is useful, generation supplies all four Plan fields (`task_summary`, `phases`, `desired_outputs`, and `feasibility`) in one call to `generate_plan` from the `open-science-plan` server.',
  'After generating a Plan, wait inside the `generate_plan` call until Open Science returns the user response. Do not report the Plan separately or execute any Plan step while waiting.',
  'Every text entered into the Plan card returns as `kind: feedback` and is a normal user Message, never an automatic Plan decision. Interpret the full meaning yourself: for an unambiguous approval or dismissal, call `generate_plan` again with only `decision: "approved"` or `decision: "rejected"`; for requested changes, revise and regenerate the Plan; for ambiguous or conditional language, do not grant execution authority, address the Message, and request a fresh Plan review when appropriate.',
  'Only a Plan projection with `approval: approved` grants execution authority. Never call `update_step_status` while approval is pending, even if the feedback text sounds approving.',
  'After a restart or interruption, do not resume an approved unfinished Plan from an unrelated user Message. If the user explicitly asks to continue or resume that Plan, call `generate_plan` with only `decision: "approved"` to bind it to the current interaction before updating steps.',
  '',
  '<open_science_session_plan_execution>',
  'The protected Plan context is the authoritative checkpoint at turn entry. A successful Session Plan MCP receipt authoritatively confirms changes made later in that turn.',
  'When carrying out an approved Plan, treat step statuses as execution checkpoints:',
  '- Normally mark the relevant exact step title `in_progress` when substantive work on that step begins.',
  '- When the outcome of a started step becomes clear, normally update it to `completed` or `blocked` before beginning another clearly attributable Plan step or giving the final response. Use `skipped` for work that will not be performed.',
  '- Do not defer several already-known status changes merely to report them as a batch at the end.',
  'Use judgment when work overlaps multiple steps, is exploratory, or is genuinely parallel. Multiple dependency-eligible steps may be in progress when that reflects the actual work. Do not fabricate status precision or interrupt an indivisible operation only for bookkeeping. Work whose outcome is not yet known does not need to be settled prematurely.',
  'If an irreversible blocker makes later steps unreachable, record it, settle already-started dependency-eligible peer work as its outcome becomes known, and do not start newly unreachable work.',
  'After a restart, interruption, or context replacement, consult the protected Plan context. An `in_progress` checkpoint means work began but its final outcome was not reliably recorded; verify uncertain work instead of assuming completion or repeating it.',
  'After a Session Plan MCP call, consider its returned `guidance` before continuing.',
  '</open_science_session_plan_execution>',
  '</open_science_session_plan_instructions>'
].join('\n')

const PLAN_MCP_GUIDANCE = Object.freeze({
  pending:
    'The Plan is still pending. Interpret the feedback and revise the Plan or ask for clarification; do not begin Plan execution.',
  approved:
    'The Plan is approved. Before substantive planned work, identify the relevant step and normally mark its exact title in_progress.',
  rejected:
    "The Plan was rejected. Do not execute it; respond to the user's decision and await further direction.",
  inProgress:
    'This step is recorded as in progress. When its outcome becomes clear, normally update it before beginning another clearly attributable Plan step or giving the final response; do not accumulate several already-known changes for an end-of-turn batch.',
  nextStep:
    'This status is recorded. When substantive work begins on another relevant Plan step, normally mark that exact step in_progress.',
  peersInProgress:
    'This step is blocked while other Plan work is still in progress. Do not start newly unreachable work; keep already-started dependency-eligible peer work current and settle it as its outcome becomes known.',
  completed:
    'The Plan has reached a completed outcome. Summarize the result and any relevant limitations.',
  blocked:
    'The Plan has reached a blocked outcome. Explain the blocker and useful options without claiming the remaining work was completed.'
})

const PLAN_GENERATE_TOOL_DESCRIPTION =
  'Create an immutable execution Plan or explicitly decide the active Plan. Generation blocks until the user responds. Text responses always return as kind:feedback and remain ordinary user Messages; interpret the full meaning, then call this tool again with only decision:"approved" or decision:"rejected" when the intent is unambiguous, or revise and regenerate when changes are requested. Calling decision:"approved" also binds an already-approved interrupted Plan to the current user interaction. Never execute from message text alone. The legacy approve:true is equivalent to decision:"approved". Do not combine a decision with Plan content. When this call returns successfully, consider the returned guidance before revising, executing, or responding about the Plan.'

const PLAN_STEP_STATUS_TOOL_DESCRIPTION =
  'Record the current status of one exact step on the server-bound approved Plan. Normally mark a step in_progress when substantive work begins, and update it when its outcome becomes clear, normally before beginning another clearly attributable Plan step or giving the final response. Keep statuses timely without inventing precision for exploratory, overlapping, or genuinely parallel work. Consider the returned guidance before continuing.'

const PLAN_FIRST_TURN_PROMPT_REMINDER = `## Plan mode (ACTIVE — MANDATORY)

This turn must create a Plan before doing work. Execution starts only after approval.

**Required workflow:**

1. **Discover skills**: Review the Skills available in the current session to confirm the catalog covers the task. You do not need to load them yet.
2. **Assess feasibility**: Before generating the plan, assess whether the task is achievable with available data, methods, and tools. Every plan must include a \`feasibility\` block with \`confidence\` (high / medium / low) and \`rationale\`.
   - For medium or low confidence, identify the material risks and a useful fallback deliverable.
   - If \`confidence\` is "low", directly ask the user in an ordinary response BEFORE calling \`generate_plan\` to confirm the user wants an attempt despite the risks, and to ask what fallback deliverable they would accept. Wait for the user's reply before continuing.
   - Keep the user-facing rationale to at most two sentences and the most important limitations.
3. **Clarify requirements**: If the request has ambiguous aspects, directly ask the user in an ordinary response with specific choices that would affect the plan structure (e.g., which analysis methods, scope, output formats), and wait for the user's reply. Skip clarification only if the request is fully unambiguous.
4. **Identify desired outputs**: Directly ask the user in an ordinary response what **final deliverables** they want (e.g., "PDF report", "cleaned CSV dataset", "interactive plots"), and wait for the user's reply. Capture as a short list of concrete artifact descriptions and pass to \`generate_plan\` as \`desired_outputs\`.
5. **Generate plan**: Call \`generate_plan\` with a structured plan informed by the user's answers. For requested revisions, submit the complete revised plan and preserve unchanged \`phases\`/\`delegations\`/\`steps\`.

Each step needs a short exact \`title\` (≤10 words) and a sequential, actionable \`description\` (1-3 sentences).`

export {
  PLAN_FIRST_TURN_PROMPT_REMINDER,
  PLAN_GENERATE_TOOL_DESCRIPTION,
  PLAN_MCP_GUIDANCE,
  PLAN_STEP_STATUS_TOOL_DESCRIPTION,
  SESSION_PLAN_SYSTEM_PROMPT_APPEND
}

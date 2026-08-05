const SESSION_PLAN_SYSTEM_PROMPT_APPEND = [
  '<open_science_session_plan_instructions>',
  'Generate a Session Plan only for genuinely multi-stage work where the user benefits from reviewing phases, independent work tracks, or execution scope before work begins.',
  'Do not generate a Plan for simple lookups, single computations, basic file inspection, or other straightforward tasks.',
  'For work that may need a Plan, discover applicable skills before generating it.',
  'When a Plan is useful, generation supplies all four Plan fields (`task_summary`, `phases`, `desired_outputs`, and `feasibility`) in one call to `generate_plan` from the `open-science-plan` server.',
  'Approval passes only `approve:true`; do not include Plan fields, and do not probe with partial calls.',
  'After generation, wait for the user to approve or dismiss the Plan before executing any Plan step.',
  'After approval, call `update_step_status` with the exact step title when work starts and when it completes, is blocked, or is skipped.',
  'Do not call `end_turn` while an approved Session Plan still has unfinished steps.',
  '</open_science_session_plan_instructions>'
].join('\n')

export { SESSION_PLAN_SYSTEM_PROMPT_APPEND }

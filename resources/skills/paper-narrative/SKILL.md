---
name: paper-narrative
description: 'Judge and reshape the story told by an entire paper figure deck. Uses deterministic Python helpers for the paper-brief and narrative-review schemas and the handling-editor task, while the existing JavaScript Host reasons from manuscript and captions, reviews the full deck, and hands a grounded figure arc to figure-composer. Load when writing or revising a paper.'
license: Apache-2.0
---

# Paper Narrative — manuscript → brief → figure arc → editorial loop

`paper-narrative` is the outermost figure workflow. It judges the paper-level
story before `figure-composer` designs any one figure. The inputs are the work
itself: a manuscript (or abstract), figure captions, and the current full deck.

## Open Science helper interface

For deterministic Python work, declare the registered helper on the same
`notebook_execute` request as the producer code:

```json
{ "helperModules": ["paper-narrative"], "code": "print(paper_brief_schema())" }
```

In shorthand, use `helperModules: ["paper-narrative"]`. The host injects only
the three public callables below. Call them directly; do not read, import,
`exec`, copy, or rewrite the helper implementation, and never ask for its path
or digest. Brief reasoning and deck review do not run in the Python data
kernel. Use `repl_execute` and the existing camelCase JavaScript Host API; do
not invent a Python Host, Connector, LLM, or delegation bridge.

### Public Python methods

- `paper_brief_schema()` takes no arguments and returns the JSON Schema for a
  paper brief. The result is a mapping with required string `pitch`, required
  string `vision`, optional string `audience`, optional string
  `most_arresting_asset`, and required `figures`. Each figure requires string
  `key` and `claim`; string `composite_vid` is optional. The method performs no
  I/O and raises no domain-specific errors.
- `narrative_review_schema()` takes no arguments and returns the JSON Schema for
  the handling-editor result. It requires `hook_verdict`, `figure_moves`,
  `missing_panels`, `kill_list`, `arc`, and `boldest_defensible_fig1`.
  `would_send_for_review` is `yes`, `weak`, or `no`; arc roles are `hook`,
  `mechanism`, `evidence`, `application`, or `supplement`. A hook verdict must
  include both `fig1_is` and `fig1_should_be`; every missing panel must include
  a source-oriented `data_hint`. The method performs no I/O and raises no
  domain-specific errors.
- `narrative_review_task(brief, deck_vid, rules_vid)` returns the complete
  handling-editor task string. `brief` is a mapping shaped by
  `paper_brief_schema()`; `deck_vid` and `rules_vid` are immutable Artifact
  Version identities. Missing optional brief fields use display defaults;
  non-mapping inputs and malformed figure entries surface normal Python
  `AttributeError` or iteration errors. The method performs no Host calls.

The former Host-backed brief helper is intentionally absent. Model reasoning
belongs to the JavaScript control plane, where its provenance and limitations
remain visible.

## Required inputs and trust labels

Keep these inputs distinct throughout the workflow:

- `manuscriptVersionId`: immutable manuscript Artifact Version (an abstract-only
  manuscript is allowed) and the reviewed manuscript text read from it.
- `captionsVersionId`: immutable captions Artifact Version and the reviewed
  per-figure caption or claim text read from it.
- `deckVersionId`: immutable deck Artifact Version containing every current
  figure in review order.
- `rulesVersionId`: immutable design-rules Artifact Version, used only as a
  reference so the editor judges story rather than visual craft.
- `figureDataVersionIds`: immutable data Artifact Versions grouped by figure.

Manuscript, captions, deck, and data are source inputs. Every brief, review,
arc, move, omission, and proposed analysis is model-generated and requires human review.
Never describe generated text as manuscript evidence or source data. Preserve
the input Version identities when publishing or delegating downstream work.

## 1. Reason from manuscript and captions

Load the reviewed manuscript/abstract and captions content into the JavaScript
control-plane request. Obtain `paper_brief_schema()` in Python first. Then call
the current tool-less Host model and require JSON only:

```javascript
const briefSchema = paperBriefSchemaFromNotebook
const caps = await host.capabilities()
if (caps.llm !== true) throw new Error('paper-narrative requires host.llm for brief reasoning')
const briefDraft = await host.llm(
  `Return JSON only. The complete paper_brief JSON Schema is:\n${JSON.stringify(briefSchema)}\n` +
    `Manuscript Artifact Version: ${manuscriptVersionId}\n` +
    `Captions Artifact Version: ${captionsVersionId}\n` +
    `Manuscript text:\n${manuscriptText}\n\nCaptions/claims:\n${captionsText}\n\n` +
    `Pitch is the grandest supportable one-sentence claim, not the method. ` +
    `Vision is the killer application: what readers can now do. ` +
    `Name the audience and the single most-arresting image.`
)

let brief
try {
  brief = JSON.parse(briefDraft.text)
} catch {
  throw new Error('Invalid paper brief: model output was not JSON; review and retry.')
}
```

`host.llm` does not enforce a caller-provided schema. Validate the parsed value
against that exact `briefSchema` with the bound Python environment's JSON Schema
validator. If validation fails, stop with `Invalid paper brief: model output
failed paper_brief_schema; review and retry.` Do not fill missing required
fields with guesses. After validation, attach the immutable figure/data
references from the source claim table. Then review every field — pitch,
vision, audience, most-arresting asset, and every figure claim — before
continuing. Fix unsupported wording explicitly; never silently treat the first
model draft as approved.

## 2. Review the full deck as a handling editor

Generate the task with
`narrative_review_task(reviewedBrief, deckVersionId, rulesVersionId)` and obtain
`narrative_review_schema()` in Python. Dispatch one reviewer from
`repl_execute`. All three work inputs are explicit alongside the deck; the
schema makes the expected model result reviewable:

```javascript
const request = {
  name: 'paper-narrative-editor-r1',
  task: reviewTask,
  inputs: [manuscriptVersionId, captionsVersionId, deckVersionId, rulesVersionId],
  outputSchema: reviewSchema
}
const sent = await host.delegate([request], { wait: false })
const settled = await host.collect(
  sent.children.map(({ frameId, attemptId }) => ({ frameId, attemptId })),
  { returnWhen: 'all', timeoutSeconds: 1800 }
)
const editor = settled[0]
if (!editor || editor.status !== 'completed') {
  throw new Error(
    `paper-narrative reviewer failed: ${editor?.error ?? editor?.status ?? 'missing'}`
  )
}
if (editor.structuredOutputUnsatisfied || editor.structuredOutput === undefined) {
  throw new Error('paper-narrative reviewer returned no schema-valid structuredOutput')
}
const review = editor.structuredOutput
```

Require a completed child and a schema-valid result. Human-review the result as
an editorial recommendation, not a fact extraction. Preserve all of the
original narrative judgments:

- `hook_verdict`: whether Figure 1 alone earns external review, why, what it is,
  and what it should become.
- `arc`: hook → mechanism → evidence → application; off-arc material moves to
  supplement unless a reviewed exception is justified.
- `figure_moves`: panels whose correct figure changes, with the reason.
- `missing_panels`: what to show, the concrete analysis to run, and the closest
  source-data hint. Search existing project artifacts before proposing new work.
- `kill_list`: content to demote to supplement/caption or delete.
- `boldest_defensible_fig1`: the strongest supportable Figure 1 claim, never a
  merely louder unsupported claim.

## 3. Hand the reviewed arc to figure-composer

After human review, create one downstream `figure-composer` request for every
arc entry. Each request must include:

1. that entry's exact reviewed `one_line` claim;
2. every reviewed moved-in panel whose `to_fig` matches the arc figure;
3. the immutable data Artifact Version references grounding the claim and
   moved panels; and
4. any accepted missing-panel analysis result after it has actually been run
   and published as an Artifact Version.

Build `inputs` as an order-preserving union: the target figure's source-data
Versions, every moved item's `from_fig` source-data Versions, and the published
missing-analysis Versions for the target. Deduplicate identities. A brief
figure's `composite_vid` identifies rendered figure output; it is not source
data and must never be substituted for these input references.

Example fake-compatible request construction:

```javascript
const composerRequests = review.arc.map((item) => {
  const moved = review.figure_moves.filter((move) => move.to_fig === item.fig)
  const sourceInputs = [
    ...(figureDataVersionIds[item.fig] ?? []),
    ...moved.flatMap((move) => figureDataVersionIds[move.from_fig] ?? []),
    ...(publishedMissingAnalysisVersionIds[item.fig] ?? [])
  ]
  return {
    name: `compose-${item.fig}`,
    task: `Load figure-composer. Claim: ${item.one_line}. Moved-in panels: ${
      moved.map((move) => move.what).join('; ') || 'none'
    }.`,
    inputs: [...new Set(sourceInputs)],
    outputSchema: composerOutputSchema
  }
})
const composerReceipts = await host.delegate(composerRequests.slice(0, 4), { wait: false })
const composerResults = await host.collect(
  composerReceipts.children.map(({ frameId, attemptId }) => ({ frameId, attemptId })),
  { returnWhen: 'all', timeoutSeconds: 1800 }
)
```

For every composer result, require `status === 'completed'`, reject `error` or
`structuredOutputUnsatisfied`, and read the accepted value only from
`structuredOutput`. Build a new deck from the returned immutable output Version
identities. Send waves of no more than four. `paper-narrative` does not depend
on the composer's internal implementation; the identity-bearing request is the
seam.

The current notebook request schema cannot yet record dynamic delegated
Artifact Versions as `inputFiles`, and this adapter does not change the central
manifest or schema. This workflow passes the identities through delegated
`inputs`; do not claim they are notebook `inputFiles` provenance.

## 4. Re-review and converge

Review the rebuilt full deck again with the manuscript and captions identities
still present in `inputs:`. Convergence is exactly:

```javascript
review.hook_verdict.would_send_for_review === 'yes' &&
  review.figure_moves.length === 0 &&
  review.missing_panels.length === 0
```

Do not erase a kill list or weaken an arc merely to satisfy convergence. If the
condition is false, human-review the new recommendations, run accepted missing
analyses, and repeat the explicit `figure-composer` handoff. Stop and report an
unresolved editorial disagreement when the evidence cannot support the desired
hook.

## Minimal invocation

> Load `paper-narrative`. Manuscript: `@manuscript.tex`. Captions:
> `@captions.md`. Deck: `@all_figures.pdf`. Derive the brief, ask me to review
> model-generated judgments, reshape every arc figure through
> `figure-composer`, and re-review until the explicit convergence condition is
> met or the evidence blocks it.

---
name: figure-composer
description: 'Compose one publication-grade multi-panel figure from a one-line claim and immutable data Artifact Version references. Uses deterministic Python helpers for outline schema, geometry, panel tasks, crops, composition, review grouping, and revision scope; uses the existing JavaScript Host for reasoning, bounded panel delegation, visual inspection, and Artifact Version handoff. Runs at most three composite-review rounds and regenerates only affected panels. For a standalone plot use figure-style; for whole-paper figure ordering use paper-narrative.'
license: Apache-2.0
---

# Figure Composer — narrative → panels → compose → adversarial loop

`figure-composer` is the outer workflow for one multi-panel figure. Every panel
worker loads `figure-style` independently; run `paper-narrative` first when the
paper-level figure sequence is still undecided.

## Open Science helper interface

For deterministic Python work, declare the registered helper on the same
`notebook_execute` request as the producer code:

```json
{ "helperModules": ["figure-composer"], "code": "print(panel_px(outline, 'B'))" }
```

In shorthand, use `helperModules: ["figure-composer"]`. The host injects only
the public callables below. Call them directly; do not read, import, `exec`, copy,
or rewrite the helper implementation, and never ask for its path or digest.
`fc_sdk` and `derive_outline` are deliberately not part of this interface.
There is no Python-to-JavaScript bridge: reasoning, delegation, collection, and
image inspection run from `repl_execute` through the existing camelCase Host API.

### Public Python methods

- `figure_outline_schema()` returns a JSON Schema object. An outline is a mapping
  with string `claim`, numeric `width_mm`, integer `ncol`, numeric
  `row_heights_mm`, and ordered `panels`. Each panel requires string `letter`,
  `role`, `message`, `chart_family`, and `ask`, plus integer `row`, `col`, and
  `colspan`; optional fields are `rowspan`, `label_budget`, `data_vid`, and
  `data_desc`. Bad outlines are rejected by whichever schema validator the
  producer uses; this helper only returns the schema.
- `grid_geom(outline, dpi=300, gutter_mm=4)` returns
  `(width_px, ncol, col_width_px, row_heights_px, row_y_px, gutter_px)`. Geometry
  uses integer truncation and zero-based rows/columns. Missing or invalid mapping
  values surface normal `KeyError`, `TypeError`, `ZeroDivisionError`, or arithmetic
  errors.
- `panel_px(outline, letter, dpi=300, gutter_mm=4)` returns `(width_px, height_px)`
  for the first exact matching panel letter. `rowspan` defaults to one. An unknown
  letter raises `StopIteration`; malformed geometry surfaces the errors above.
- `panel_xy(outline, letter, dpi=300, gutter_mm=4)` returns the panel's `(x, y)`
  top-left pixel position. It has the same letter and geometry errors as
  `panel_px`.
- `panel_task(outline, letter, fig_label="Figure", rules_ref="(load
`figure-style`)")` returns the complete panel-worker task string, including the
  immutable data Artifact reference, exact 300-dpi box, label budget, neighbors,
  and rendering constraints. It has the same lookup/geometry errors as
  `panel_px`.
- `compose_crops(outline, dpi=300, gutter_mm=4, pad_px=4)` returns an ordered
  mapping `{letter: (left, top, right, bottom)}` in composed-PNG pixels, origin at
  top left and clipped to the canvas. Invalid outlines surface geometry errors.
- `compose_figure(outline, panel_paths, out_path, dpi=300, gutter_mm=4,
letter_font="DejaVuSans-Bold.ttf", letter_pt=9, letter_case="lower")` reads one
  image path per panel letter, resizes mismatched images to their slots, alpha
  composites them in outline order, stamps letters, saves an RGB PNG, and returns
  `(out_path, (width_px, height_px))`. Missing keys/files and unsupported images
  surface normal `KeyError`, `FileNotFoundError`, or Pillow errors. A missing font
  falls back to Pillow's default font.
- `group_fixes_by_panel(review)` returns `{letter: markdown}` for `BLOCKER` and
  `MAJOR` violations only. Missing optional fields become empty text; a violation
  without `panel_letter` falls back to the first character of `location`.
- `review_schema(per_panel=True)` returns the structured composite-review JSON
  Schema. With `per_panel=True`, every violation requires `panel_letter`; false
  omits that property and requirement.
- `composite_review_task(composite_vid, outline, rules_vid, prev_vid=None,
round_no=1, min_floor=5)` returns the whole-figure reviewer task. Version
  arguments are immutable Artifact Version identities. `prev_vid=None` omits the
  regression reference. The method does no I/O or validation.
- `apply_outline_revisions(outline, revisions)` returns the set union of every
  revision's `affected_panels`. It intentionally does not mutate `outline`; the
  Agent applies the reviewed change explicitly. Missing `affected_panels` means
  no affected panel.

Pillow is imported only when `compose_figure` is called. If unavailable, its
normal `ImportError` is returned; inspect or manage the bound Runtime Environment
and retry.

## Inputs

- `claim`: the one sentence the figure makes true without surrounding prose.
- `data`: immutable Upload or Artifact Version identities grounding the panels.
- `width_mm`: venue column width, commonly 85–89 mm single or 174–183 mm double.

Before starting the workflow, fail closed on every required control-plane
capability. Do not start partial work when one is unavailable:

```javascript
const caps = await host.capabilities()
if (caps.llm !== true) throw new Error('figure-composer requires host.llm')
if (caps.delegate !== true) throw new Error('figure-composer requires host.delegate')
if (caps.collect !== true) throw new Error('figure-composer requires host.collect')
if (caps.artifacts !== true) throw new Error('figure-composer requires Artifact discovery')
if (caps.viewImage !== true) throw new Error('figure-composer requires host.viewImage for QA')
```

## 1. Reason into an outline

Use `figure_outline_schema()` in Python to obtain the contract and return that
JSON value to the control plane as `outlineSchema`. Embed the full schema in the
reasoning prompt; a method name or prose summary is not enough. `host.llm` is
tool-less and accepts no caller-selected model, images, or enforced structured
output, so parse and validate its text explicitly. The control REPL is CommonJS
and the app includes Ajv 2020:

```javascript
const Ajv2020 = require('ajv/dist/2020').default
const validateOutline = new Ajv2020({ allErrors: true }).compile(outlineSchema)
const outlinePrompt =
  `Return JSON only for this figure outline. Claim: ${claim}. ` +
  `Immutable data Version identities: ${dataVersionIds.join(', ')}. ` +
  `The result MUST satisfy this JSON Schema: ${JSON.stringify(outlineSchema)}`
let outline
for (let attempt = 1; attempt <= 2; attempt += 1) {
  const outlineDraft = await host.llm(outlinePrompt)
  try {
    const candidate = JSON.parse(outlineDraft.text)
    if (validateOutline(candidate)) {
      outline = candidate
      break
    }
  } catch {}
  if (attempt === 2) throw new Error('invalid outline after retry')
}
```

An invalid outline gets one explicit retry and then fails the workflow; never
fan out an unparsed or schema-invalid draft. Review the valid outline before
fan-out. Panel A is the context-free hook; B
carries the claim; remaining panels add evidence in descending importance. Use
one row per sub-claim and normally 5–10 panels.

An existing image may be inspected with `host.viewImage`, but this Host release
does not pass images into `host.llm`; manually draft the outline from what is
visible instead of inventing a hidden vision bridge.

## 2. Fan out panel workers

Generate every task in Python with `panel_task`. Then dispatch from
`repl_execute`. `host.delegate` admits at most four children atomically, so send
waves of no more than four. A worker loads `figure-style` independently and
declares `helperModules: ["figure-style"]` on its own Python producer request,
renders the exact requested pixels, writes the PNG as an Artifact using the
notebook `runId` as `producerRunId`, and calls `host.submitOutput` for the small
JSON result. Never ask workers to exchange temporary absolute paths.

```javascript
const panelOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['panelVersionId', 'labelsUsed'],
  properties: {
    panelVersionId: { type: 'string', minLength: 1 },
    labelsUsed: { type: 'array', items: { type: 'string' } }
  }
}
const validatePanelOutput = new Ajv2020({ allErrors: true }).compile(panelOutputSchema)
const requests = panelSpecs.map(({ letter, task, dataVersionId }) => ({
  name: `panel-${letter}-r1`,
  task: `${task}\nLoad \`figure-style\` independently. Publish the PNG Artifact, then submit panelVersionId and labelsUsed.`,
  inputs: dataVersionId ? [dataVersionId] : [],
  outputSchema: panelOutputSchema
}))
const panelVersions = []
for (let offset = 0; offset < requests.length; offset += 4) {
  const wave = requests.slice(offset, offset + 4)
  const sent = await host.delegate(wave, { wait: false })
  if (sent.kind !== 'receipts') throw new Error('panel delegation did not return receipts')
  const selectors = sent.children.map(({ frameId, attemptId }) => ({ frameId, attemptId }))
  const settled = await host.collect(selectors, { returnWhen: 'all', timeoutSeconds: 1800 })
  const byAttempt = new Map(settled.map((child) => [child.attemptId, child]))
  const checkedWave = sent.children.map((receipt, index) => {
    const child = byAttempt.get(receipt.attemptId)
    const expectedName = `panel_${panelSpecs[offset + index].letter}.png`
    if (!child || child.status !== 'completed' || child.error) {
      throw new Error(`panel failed: ${receipt.name}`)
    }
    if (child.structuredOutputUnsatisfied === true || !child.structuredOutput) {
      throw new Error(`panel structured output missing: ${receipt.name}`)
    }
    if (!validatePanelOutput(child.structuredOutput)) {
      throw new Error(`panel structured output invalid: ${receipt.name}`)
    }
    const pngs = child.artifactsCreated.filter(
      (artifact) => artifact.name === expectedName && artifact.mimeType === 'image/png'
    )
    if (pngs.length !== 1 || pngs[0].versionId !== child.structuredOutput.panelVersionId) {
      throw new Error(`panel Artifact identity mismatch: ${receipt.name}`)
    }
    return { letter: panelSpecs[offset + index].letter, versionId: pngs[0].versionId }
  })
  panelVersions.push(...checkedWave)
}
```

Here `validatePanelOutput` is an Ajv validator compiled from
`panelOutputSchema`. The loop handles all 5–10 panels in ordered waves of at
most four. It validates a whole wave before accepting any identity. Any
non-completed/error child, unsatisfied/missing/invalid structured output,
missing or duplicate expected PNG, or mismatch between `structuredOutput` and
`artifactsCreated` fails the workflow; do not compose a partial panel set. The
matching PNG's `versionId` is the immutable Artifact Version identity for
composition. Keep identities in outline order; use
`host.artifactPath(versionId)` only to resolve bytes locally after collection.
An Artifact path is an implementation detail, never the Agent-to-Agent contract.

## 3. Compose and bind the producer Run

Resolve the collected Version identities, place the paths in a small JSON
handoff under `process.env.OPEN_SCIENCE_HANDOFF_DIR`, and read that manifest from
the Python producer cell. On that same `notebook_execute` request, pass the
ordered, de-duplicated panel identities as
`artifactVersionInputs: panelVersions.map(({ versionId }) => versionId)`. This
registers the delegated immutable panel Versions as the composition Run's
provenance inputs; paths remain byte-access implementation details and must never
replace Version identities in this field. Call `compose_figure`, verify the
notebook result is completed, and keep the actual returned `runId`. Publish the
final PNG with
`write_artifact_file({ filename: "figure.png", producerRunId: composeResult.runId })`;
never substitute a round number or locally invented Run identity. This binds the
composite Artifact to the run that last wrote its bytes. Fail the workflow if
any panel Version cannot be validated in the active Project; never silently
compose with an unregistered provenance input.

## 3.5 Look before review

Call `compose_crops` in Python. From `repl_execute`, inspect every crop with the
current camelCase API:

```javascript
await host.viewImage(
  { versionId: compositeVersionId },
  { crop: { unit: 'pixels', left: box[0], top: box[1], right: box[2], bottom: box[3] } }
)
```

Check contrast, smallest mark, leader crossings, color identity, legend binding,
seams, letter overlap, gutter bleed, and resize aliasing. Regenerate an offending
panel before paying for formal review.

## 4. Adversarial review loop

Run a maximum 3 review rounds, with calibrated violation floors 5 → 4 → 3.
Generate `composite_review_task(...)` and `review_schema()` in Python, then
delegate one reviewer with the composite and design-rule Artifact Versions in
`inputs` and the schema in `outputSchema`. Use `wait: false`, collect the exact
receipt handle, and reject a non-completed/error result,
`structuredOutputUnsatisfied === true`, missing `structuredOutput`, or output
that fails the `review_schema()` validator. The validated `structuredOutput` is
the review object; never scrape the reviewer's response text.

After each result:

1. Accept when the verdict is `accept` or `minor_revision`, there are no
   `BLOCKER`s, and there are at most two `MAJOR`s.
2. Send the validated review object back to deterministic Python. Apply reviewed
   outline edits explicitly, then call
   `apply_outline_revisions(outline, review["outline_revisions"])` to compute
   outline scope.
3. Call `group_fixes_by_panel(review)` for `BLOCKER`/`MAJOR` panel scope. Compute
   `regen = affected | set(fixb)` from those helper results, never from a
   hard-coded panel list.
4. Regenerate only the union of outline-affected and violation-affected panels.
   Give each retry a unique name such as `panel-B-r2`; include the prior panel
   Artifact Version and its immutable data Version in `inputs`.
5. Preserve every clean panel's exact Version identity. If any regeneration wave
   fails validation, keep the last complete composite and do not compose a
   partial revision. Otherwise recompose from the mixed
   map of reused and regenerated Versions, inspect all crops, then publish with
   the new compose run's `producerRunId`.

For example, if round 1 changes only B and round 2 changes only A, the final map
must be `A2 / B2 / C1`; C1 is never rerendered. Stop on convergence or after the
third review. Never manufacture findings to meet a floor, over-correct clean
content, or regenerate the whole figure for a localized issue.

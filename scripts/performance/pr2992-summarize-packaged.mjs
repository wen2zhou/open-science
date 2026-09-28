/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--(input|output)=(.+)$/.exec(arg)
    if (!match) throw new Error(`Invalid argument: ${arg}`)
    return [match[1], match[2]]
  })
)
if (!args.input) throw new Error('Missing --input=<comparison-run.json>')
const inputPath = resolve(args.input)
const outputPath = resolve(args.output ?? join(dirname(inputPath), 'comparison-summary.json'))
const comparison = JSON.parse(await readFile(inputPath, 'utf8'))
if (!Array.isArray(comparison.runs)) throw new Error('Comparison manifest has no runs array')

const expectedKinds = ['interaction:20', 'interaction:100', 'interaction:500']
const variants = ['baseline', 'candidate']
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const finiteArray = (value, length) =>
  Array.isArray(value) &&
  value.length === length &&
  value.every((item) => finite(item) && item >= 0)
const median = (values) => {
  if (values.length === 0) return null
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}
const distribution = (values) => ({
  runs: values.length,
  median: median(values),
  range: values.length > 0 ? [Math.min(...values), Math.max(...values)] : null
})
const taskStats = (values) => ({
  count: values.length,
  sumMs: values.reduce((sum, value) => sum + value, 0),
  maxMs: values.length > 0 ? Math.max(...values) : 0
})
const taskDistributions = (samples) => ({
  count: distribution(samples.map((sample) => sample.count)),
  sumMs: distribution(samples.map((sample) => sample.sumMs)),
  maxMs: distribution(samples.map((sample) => sample.maxMs))
})
const interactionMetrics = (data) => {
  const issues = []
  if (data.completed !== true) issues.push('journey incomplete')
  if (!finite(data.openMs)) issues.push('openMs missing or invalid')
  if (!finiteArray(data.switchMs, 6)) issues.push('expected six switch wall times')
  if (!finiteArray(data.clickToContentFrameMs, 6))
    issues.push('expected six renderer click-to-content times')
  if (!finiteArray(data.inputToFrameMs, 41)) issues.push('expected 41 input-to-frame times')
  if (!finite(data.typingWallMs)) issues.push('typingWallMs missing or invalid')
  if (
    !Array.isArray(data.longTasks) ||
    !data.longTasks.every(
      (entry) =>
        entry && typeof entry.phase === 'string' && finite(entry.duration) && entry.duration >= 0
    )
  )
    issues.push('longTasks missing or invalid')
  if (issues.length > 0) return { issues, metrics: null }
  const byPhase = Object.fromEntries(
    ['open', 'switch', 'typing'].map((phase) => [
      phase,
      taskStats(
        data.longTasks.filter((entry) => entry.phase === phase).map((entry) => entry.duration)
      )
    ])
  )
  return {
    issues: [],
    metrics: {
      openWallMs: data.openMs,
      switchWallMedianMs: median(data.switchMs),
      switchRendererMedianMs: median(data.clickToContentFrameMs),
      inputFrameMedianMs: median(data.inputToFrameMs),
      inputFrameMaxMs: Math.max(...data.inputToFrameMs),
      typingWallMs: data.typingWallMs,
      longTasks: taskStats(data.longTasks.map((entry) => entry.duration)),
      longTasksByPhase: byPhase
    }
  }
}
const analyzeRun = (run) => {
  const scenarios = {}
  for (const kind of expectedKinds) {
    const matching = (run.summaries ?? []).filter((summary) => summary.kind === kind)
    if (matching.length !== 1) {
      scenarios[kind] = {
        status: matching.length === 0 ? 'missing' : 'duplicate',
        issues: [matching.length === 0 ? 'summary missing' : `${matching.length} summaries found`],
        metrics: null
      }
      continue
    }
    const analyzed = interactionMetrics(matching[0].data)
    scenarios[kind] = {
      status: analyzed.issues.length === 0 ? 'observed' : 'invalid',
      summaryPath: matching[0].path,
      ...analyzed
    }
  }
  return {
    id: run.id,
    variant: run.variant,
    group: run.group,
    status: run.status,
    exitCode: run.exitCode ?? null,
    signal: run.signal ?? null,
    errors: run.errors ?? [],
    missingSummaries: run.missingSummaries ?? [],
    scenarios,
    // Keep the original evidence so failed and partial runs remain inspectable.
    summaries: run.summaries ?? []
  }
}
const runs = comparison.runs.map(analyzeRun)
const metricDistribution = (samples, name) => distribution(samples.map((sample) => sample[name]))
const interactionAggregate = (variantRuns, kind) => {
  const observed = variantRuns
    .map((run) => ({ run, result: run.scenarios[kind] }))
    .filter(({ result }) => result.status === 'observed')
  const samples = observed.map(({ result }) => result.metrics)
  return {
    plannedRuns: variantRuns.length,
    observedRuns: samples.length,
    observedRunIds: observed.map(({ run }) => run.id),
    missingRunIds: variantRuns
      .filter((run) => run.scenarios[kind].status === 'missing')
      .map((run) => run.id),
    invalidRunIds: variantRuns
      .filter((run) => !['observed', 'missing'].includes(run.scenarios[kind].status))
      .map((run) => run.id),
    openWallMs: metricDistribution(samples, 'openWallMs'),
    switchWallMedianMs: metricDistribution(samples, 'switchWallMedianMs'),
    switchRendererMedianMs: metricDistribution(samples, 'switchRendererMedianMs'),
    inputFrameMedianMs: metricDistribution(samples, 'inputFrameMedianMs'),
    inputFrameMaxMs: metricDistribution(samples, 'inputFrameMaxMs'),
    typingWallMs: metricDistribution(samples, 'typingWallMs'),
    longTasks: taskDistributions(samples.map((sample) => sample.longTasks)),
    longTasksByPhase: Object.fromEntries(
      ['open', 'switch', 'typing'].map((phase) => [
        phase,
        taskDistributions(samples.map((sample) => sample.longTasksByPhase[phase]))
      ])
    )
  }
}
const byVariant = Object.fromEntries(
  variants.map((variant) => {
    const variantRuns = runs.filter((run) => run.variant === variant)
    return [
      variant,
      {
        runs: {
          planned: variantRuns.length,
          passed: variantRuns.filter((run) => run.status === 'passed').length,
          failed: variantRuns.filter((run) => run.status === 'failed').length,
          unfinished: variantRuns.filter((run) => !['passed', 'failed'].includes(run.status)).length
        },
        interaction: Object.fromEntries(
          [20, 100, 500].map((count) => [count, interactionAggregate(variantRuns, `interaction:${count}`)])
        )
      }
    ]
  })
)
const result = {
  source: inputPath,
  createdAt: new Date().toISOString(),
  comparisonStatus: comparison.status,
  comparisonOutcome: comparison.outcome,
  candidateStatus: comparison.candidateStatus,
  artifacts: comparison.artifacts,
  machine: comparison.machine,
  plan: comparison.plan,
  runs,
  byVariant,
  note: 'Each run contributes one median or maximum per endpoint. Failed and missing runs remain listed; numeric distributions include only complete, valid scenario summaries.'
}
await writeFile(outputPath, JSON.stringify(result, null, 2))

const display = (metric) =>
  metric.median === null
    ? '—'
    : `${metric.median.toFixed(1)} [${metric.range[0].toFixed(1)}, ${metric.range[1].toFixed(1)}]`
const row = (label, values, width = 24) =>
  console.log([label.padEnd(width), ...values.map((value) => value.padEnd(width))].join(' '))
console.log(
  `Comparison: ${comparison.status} / ${comparison.outcome}; candidate: ${comparison.candidateStatus}`
)
console.log('Interactions: median [min, max] across independent runs; ms unless count')
const interactionColumns = [
  byVariant.baseline.interaction[20],
  byVariant.candidate.interaction[20],
  byVariant.baseline.interaction[100],
  byVariant.candidate.interaction[100],
  byVariant.baseline.interaction[500],
  byVariant.candidate.interaction[500]
]
row('Metric', ['Base 20', 'Candidate 20', 'Base 100', 'Candidate 100', 'Base 500', 'Candidate 500'])
row(
  'Observed/planned',
  interactionColumns.map((sample) => `${sample.observedRuns}/${sample.plannedRuns}`)
)
for (const [label, key] of [
  ['Open wall', 'openWallMs'],
  ['Switch wall median', 'switchWallMedianMs'],
  ['Switch renderer median', 'switchRendererMedianMs'],
  ['Input frame median', 'inputFrameMedianMs'],
  ['Input frame max', 'inputFrameMaxMs'],
  ['Typing wall', 'typingWallMs']
])
  row(
    label,
    interactionColumns.map((sample) => display(sample[key]))
  )
for (const [label, key] of [
  ['Long tasks count', 'count'],
  ['Long tasks sum ms', 'sumMs'],
  ['Long tasks max ms', 'maxMs']
])
  row(
    label,
    interactionColumns.map((sample) => display(sample.longTasks[key]))
  )
const incomplete = runs.filter(
  (run) =>
    run.status !== 'passed' ||
    Object.values(run.scenarios).some((scenario) => scenario.status !== 'observed')
)
if (incomplete.length > 0) {
  console.log('Failed, incomplete, or missing runs:')
  for (const run of incomplete) {
    const missing = Object.entries(run.scenarios)
      .filter(([, scenario]) => scenario.status !== 'observed')
      .map(([kind, scenario]) => `${kind}=${scenario.status}`)
    console.log(
      `  ${run.id}: ${run.status}; ${[...run.errors, ...missing].join('; ') || 'no detail'}`
    )
  }
}
console.log(`JSON summary: ${outputPath}`)

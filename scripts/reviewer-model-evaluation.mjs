#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node CLI uses runtime-validated JSON. */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REVIEWER_REGRESSION_SCENARIOS = [
  {
    id: 'image-trace-only',
    evidenceRoute: 'execution log + artifact trace',
    testFiles: ['src/main/reviewer/image-generation-trace.integration.test.ts']
  },
  {
    id: 'rendered-image-contradiction',
    evidenceRoute: 'artifact image content',
    testFiles: ['src/main/reviewer/image-content.integration.test.ts']
  },
  {
    id: 'targeted-source-pages',
    evidenceRoute: 'trusted source role + targeted page content',
    testFiles: ['src/main/reviewer/mcp-server.test.ts', 'src/main/reviewer/host-sdk.test.ts']
  },
  {
    id: 'earlier-turn-abstention',
    evidenceRoute: 'frozen turn scope only',
    testFiles: ['src/main/reviewer/scope.test.ts', 'src/main/reviewer/rubric.test.ts']
  },
  {
    id: 'fabricated-current-turn-reference',
    evidenceRoute: 'current-turn concrete identifier trace',
    testFiles: ['src/main/reviewer/rubric.test.ts', 'src/main/reviewer/mcp-server.test.ts']
  },
  {
    id: 'user-stop',
    evidenceRoute: 'routed cancellation evidence',
    testFiles: ['src/main/reviewer/turn-evidence.test.ts', 'src/main/reviewer/rubric.test.ts']
  },
  {
    id: 'plan-completion',
    evidenceRoute: 'effective current-turn Plan',
    testFiles: ['src/main/reviewer/turn-evidence.test.ts', 'src/main/reviewer/rubric.test.ts']
  },
  {
    id: 'tabular-values',
    evidenceRoute: 'bounded columns and row targets',
    testFiles: [
      'src/main/reviewer/host-sdk-tabular.test.ts',
      'src/main/reviewer/mcp-server.test.ts'
    ]
  },
  {
    id: 'opaque-binary-generation',
    evidenceRoute: 'artifact trace; byte-free limitation if content is attempted',
    testFiles: [
      'src/main/reviewer/image-generation-trace.integration.test.ts',
      'src/main/reviewer/mcp-server.test.ts'
    ]
  }
]

const requireNonNegativeInteger = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`)
  }
  return value
}

const formatPercent = (value) => `${(value * 100).toFixed(1)}%`
const formatInteger = (value) => value.toLocaleString('en-US')

export const evaluateReviewerModelCapture = (capture) => {
  if (capture?.schemaVersion !== 1) throw new Error('schemaVersion must be 1.')
  if (!Array.isArray(capture.batches) || capture.batches.length === 0) {
    throw new Error('batches must contain at least one evaluation fixture.')
  }

  const rows = capture.batches.map((batch, index) => {
    const prefix = `batches[${index}]`
    const runs = requireNonNegativeInteger(batch.runs, `${prefix}.runs`)
    if (runs === 0) throw new Error(`${prefix}.runs must be greater than zero.`)
    const semanticPasses = requireNonNegativeInteger(
      batch.semanticPasses,
      `${prefix}.semanticPasses`
    )
    const evidenceRoutePasses = requireNonNegativeInteger(
      batch.evidenceRoutePasses,
      `${prefix}.evidenceRoutePasses`
    )
    const extraContentReads = requireNonNegativeInteger(
      batch.extraContentReads,
      `${prefix}.extraContentReads`
    )
    const allowedExtraContentReads = requireNonNegativeInteger(
      batch.allowedExtraContentReads,
      `${prefix}.allowedExtraContentReads`
    )
    if (semanticPasses > runs || evidenceRoutePasses > runs) {
      throw new Error(`${prefix} pass counts cannot exceed runs.`)
    }
    if (typeof batch.fixtureId !== 'string' || batch.fixtureId.length === 0) {
      throw new Error(`${prefix}.fixtureId must be a non-empty string.`)
    }
    if (typeof batch.note !== 'string' || batch.note.length === 0) {
      throw new Error(`${prefix}.note must disclose route variance and limitations.`)
    }
    return {
      fixtureId: batch.fixtureId,
      runs,
      semanticPasses,
      evidenceRoutePasses,
      extraContentReads,
      allowedExtraContentReads,
      note: batch.note
    }
  })

  const totalRuns = rows.reduce((sum, row) => sum + row.runs, 0)
  if (capture.runs !== totalRuns) throw new Error('runs must equal the sum of batch runs.')
  const providerUsage = {
    inputTokens: requireNonNegativeInteger(
      capture.providerUsage?.inputTokens,
      'providerUsage.inputTokens'
    ),
    outputTokens: requireNonNegativeInteger(
      capture.providerUsage?.outputTokens,
      'providerUsage.outputTokens'
    )
  }
  const totalLatencyMs = requireNonNegativeInteger(capture.totalLatencyMs, 'totalLatencyMs')
  const observed = rows.reduce((sum, row) => sum + row.extraContentReads, 0)
  const allowed = rows.reduce((sum, row) => sum + row.allowedExtraContentReads, 0)

  return {
    totalRuns,
    semanticAccuracy: rows.reduce((sum, row) => sum + row.semanticPasses, 0) / totalRuns,
    evidenceRouteAccuracy: rows.reduce((sum, row) => sum + row.evidenceRoutePasses, 0) / totalRuns,
    providerUsage,
    totalLatencyMs,
    averageLatencyMs: totalLatencyMs / totalRuns,
    extraContentReads: { observed, allowed, withinBound: observed <= allowed },
    rows
  }
}

export const renderReviewerModelEvaluation = (capture, result) => {
  const tableRows = result.rows
    .map(
      (row) =>
        `| ${row.fixtureId} | ${row.semanticPasses}/${row.runs} | ` +
        `${row.evidenceRoutePasses}/${row.runs} | ${row.extraContentReads} / ` +
        `${row.allowedExtraContentReads} | ${row.note} |`
    )
    .join('\n')
  const regressionRows = REVIEWER_REGRESSION_SCENARIOS.map(
    (scenario) =>
      `| ${scenario.id} | ${scenario.evidenceRoute} | ${scenario.testFiles.map((file) => `\`${file}\``).join('<br>')} |`
  ).join('\n')

  return (
    `# Reviewer enhancement model evaluation\n\n` +
    `Generated by \`npm run eval:reviewer\` from \`${capture.source}\`. The capture records ` +
    `provider-reported usage and observed tool routes; the scorer does not infer or suppress ` +
    `missing measurements.\n\n` +
    `- Model: \`${capture.model}\`\n` +
    `- Strategy: \`${capture.strategy}\`\n` +
    `- Runs: ${result.totalRuns}\n` +
    `- Semantic accuracy: ${formatPercent(result.semanticAccuracy)}\n` +
    `- Evidence-route accuracy: ${formatPercent(result.evidenceRouteAccuracy)}\n` +
    `- Provider-reported usage: ${formatInteger(result.providerUsage.inputTokens)} input + ` +
    `${formatInteger(result.providerUsage.outputTokens)} output = ` +
    `${formatInteger(result.providerUsage.inputTokens + result.providerUsage.outputTokens)} tokens\n` +
    `- Latency: ${formatInteger(result.totalLatencyMs)} ms total; ` +
    `${formatInteger(Math.round(result.averageLatencyMs))} ms/run average\n` +
    `- Extra bounded content reads: ${result.extraContentReads.observed} / ` +
    `${result.extraContentReads.allowed} allowed; ` +
    `${result.extraContentReads.withinBound ? 'within bound' : 'gate failed'}\n\n` +
    `| Model fixture | Semantic | Evidence route | Extra reads | Disclosure |\n` +
    `| --- | ---: | ---: | ---: | --- |\n${tableRows}\n\n` +
    `## Product regression matrix\n\n` +
    `The deterministic product suite covers the full shipping matrix; the model sample covers the ` +
    `five core routing fixtures above. Deferred cross-Turn and format-specific execution capabilities ` +
    `are intentionally absent.\n\n` +
    `| Scenario | Required evidence route | Executable regression files |\n` +
    `| --- | --- | --- |\n${regressionRows}\n`
  )
}

const runCli = async () => {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url))
  const repositoryRoot = resolve(scriptDirectory, '..')
  const inputIndex = process.argv.indexOf('--input')
  const outputIndex = process.argv.indexOf('--output')
  const inputPath = resolve(
    repositoryRoot,
    inputIndex >= 0 ? process.argv[inputIndex + 1] : 'test/fixtures/reviewer-model-evaluation.json'
  )
  const outputPath = resolve(
    repositoryRoot,
    outputIndex >= 0 ? process.argv[outputIndex + 1] : 'docs/reviewer-model-evaluation.md'
  )
  const capture = JSON.parse(await readFile(inputPath, 'utf8'))
  const result = evaluateReviewerModelCapture(capture)
  await writeFile(outputPath, renderReviewerModelEvaluation(capture, result), 'utf8')
  process.stdout.write(`${outputPath}\n`)
  if (
    result.semanticAccuracy !== 1 ||
    result.evidenceRouteAccuracy !== 1 ||
    !result.extraContentReads.withinBound
  ) {
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli()
}

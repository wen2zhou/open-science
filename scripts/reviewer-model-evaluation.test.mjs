import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  REVIEWER_REGRESSION_SCENARIOS,
  evaluateReviewerModelCapture,
  renderReviewerModelEvaluation
} from './reviewer-model-evaluation.mjs'

const fixtureUrl = new URL('../test/fixtures/reviewer-model-evaluation.json', import.meta.url)

describe('Reviewer enhancement regression gate', () => {
  it('names every required shipping scenario and keeps deferred capabilities out', () => {
    expect(REVIEWER_REGRESSION_SCENARIOS.map(({ id }) => id)).toEqual([
      'image-trace-only',
      'rendered-image-contradiction',
      'targeted-source-pages',
      'earlier-turn-abstention',
      'fabricated-current-turn-reference',
      'user-stop',
      'plan-completion',
      'tabular-values',
      'opaque-binary-generation'
    ])
    expect(REVIEWER_REGRESSION_SCENARIOS.every(({ testFiles }) => testFiles.length > 0)).toBe(true)
    expect(JSON.stringify(REVIEWER_REGRESSION_SCENARIOS)).not.toMatch(
      /archive search|context drift|session-level|format-specific MCP/i
    )
  })

  it('scores the captured model gate without hiding bounded extra reads', async () => {
    const capture = JSON.parse(await readFile(fixtureUrl, 'utf8'))
    const result = evaluateReviewerModelCapture(capture)

    expect(result.semanticAccuracy).toBe(1)
    expect(result.evidenceRouteAccuracy).toBe(1)
    expect(result.providerUsage).toEqual({ inputTokens: 61_495, outputTokens: 3_865 })
    expect(result.totalLatencyMs).toBe(194_700)
    expect(result.extraContentReads).toEqual({ observed: 1, allowed: 1, withinBound: true })
    expect(result.rows.find(({ fixtureId }) => fixtureId === 'image-method-result')).toMatchObject({
      extraContentReads: 1,
      note: expect.stringMatching(/opportunistic/i)
    })

    const report = renderReviewerModelEvaluation(capture, result)
    expect(report).toContain('100.0%')
    expect(report).toContain('61,495')
    expect(report).toContain('194,700 ms')
    expect(report).toContain('1 / 1')
  })

  it('fails closed when semantic, route, usage, latency, or read accounting is absent', () => {
    expect(() =>
      evaluateReviewerModelCapture({
        schemaVersion: 1,
        model: 'fixture-model',
        batches: [{ fixtureId: 'missing-measurements', runs: 1 }]
      })
    ).toThrow(/semanticPasses/)
  })
})

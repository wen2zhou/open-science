import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { NotebookHelperModuleHost } from '../../../src/main/notebook/helper-module-host'
import { NotebookKernelExecutor } from '../../../src/main/notebook/kernel-executor'

const skillDir = dirname(fileURLToPath(import.meta.url))
const kernelPath = join(skillDir, 'kernel.py')
const skillPath = join(skillDir, 'SKILL.md')
const contractPath = join(skillDir, 'test_kernel.py')
const descriptorPath = join(skillDir, 'open-science.json')
const python3 = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(
  existsSync
)
const pythonGate = python3 ? describe : describe.skip
const helperExports = (
  JSON.parse(readFileSync(descriptorPath, 'utf8')) as { helpers: Array<{ exports: string[] }> }
).helpers[0]!.exports

type HostReview = Readonly<{
  hook_verdict: {
    would_send_for_review: string
    why: string
    fig1_is: string
    fig1_should_be: string
  }
  figure_moves: Array<{ what: string; from_fig: string; to_fig: string; why: string }>
  missing_panels: unknown[]
  kill_list: unknown[]
  arc: Array<{ fig: string; role: string; one_line: string }>
  boldest_defensible_fig1: string
}>

type FakeHost = Readonly<{
  llm(prompt: string): Promise<{ text: string }>
  delegate(
    requests: Array<{ name: string; task: string; inputs: string[]; outputSchema: unknown }>,
    options: { wait: false }
  ): Promise<{ children: Array<{ frameId: string; attemptId: string }> }>
  collect(
    selectors: Array<{ frameId: string; attemptId: string }>,
    options: { returnWhen: 'all'; timeoutSeconds: number }
  ): Promise<
    Array<{
      status: string
      error?: string
      structuredOutput?: unknown
      structuredOutputUnsatisfied?: boolean
    }>
  >
}>

const deriveBrief = async (
  host: Pick<FakeHost, 'llm'>,
  schema: Record<string, unknown>,
  manuscriptText: string,
  captionsText: string
): Promise<Record<string, unknown>> => {
  const response = await host.llm(
    `Return JSON only. Schema:\n${JSON.stringify(schema)}\nManuscript:\n${manuscriptText}\nCaptions:\n${captionsText}`
  )
  let brief: unknown
  try {
    brief = JSON.parse(response.text)
  } catch {
    throw new Error('Invalid paper brief: model output was not JSON; review and retry.')
  }
  if (
    typeof brief !== 'object' ||
    brief === null ||
    !('pitch' in brief) ||
    !('vision' in brief) ||
    !('figures' in brief) ||
    !Array.isArray(brief.figures)
  ) {
    throw new Error(
      'Invalid paper brief: model output failed paper_brief_schema; review and retry.'
    )
  }
  return brief as Record<string, unknown>
}

const collectStructured = async <T>(
  host: Pick<FakeHost, 'delegate' | 'collect'>,
  request: { name: string; task: string; inputs: string[]; outputSchema: unknown }
): Promise<T> => {
  const [output] = await collectStructuredBatch<T>(host, [request])
  return output
}

const collectStructuredBatch = async <T>(
  host: Pick<FakeHost, 'delegate' | 'collect'>,
  requests: Array<{ name: string; task: string; inputs: string[]; outputSchema: unknown }>
): Promise<T[]> => {
  const receipt = await host.delegate(requests, { wait: false })
  const results = await host.collect(receipt.children, {
    returnWhen: 'all',
    timeoutSeconds: 1800
  })
  return results.map((child) => {
    if (!child || child.status !== 'completed' || child.error) {
      throw new Error(
        `Delegated workflow failed: ${child?.error ?? child?.status ?? 'missing child'}`
      )
    }
    if (child.structuredOutputUnsatisfied || child.structuredOutput === undefined) {
      throw new Error(
        'Delegated workflow returned no schema-valid structuredOutput; review and retry.'
      )
    }
    return child.structuredOutput as T
  })
}

let smokeRoot: string | undefined

afterEach(async () => {
  if (smokeRoot) await rm(smokeRoot, { recursive: true, force: true })
  smokeRoot = undefined
})

describe('paper-narrative adapter', () => {
  pythonGate('Python helper', () => {
    it('passes the Python public-interface harness', () => {
      expect(() =>
        execFileSync(python3 as string, [contractPath], {
          cwd: skillDir,
          timeout: 15_000
        })
      ).not.toThrow()
    })

    it('injects only the three public methods in the real persistent Python loop', async () => {
      smokeRoot = await mkdtemp(join(resolve('.'), '.paper-narrative-smoke-'))
      const source = await readFile(kernelPath, 'utf8')
      const helperHost = new NotebookHelperModuleHost({
        resolve: async (id) =>
          id === 'paper-narrative'
            ? { id, language: 'python' as const, source, exports: helperExports }
            : undefined
      })
      const helperRequest = await helperHost.preflight('python', ['paper-narrative'])
      const helperModules = (
        await helperHost.plan(
          { id: 'paper-narrative-smoke-epoch', processKey: 'python:default-python' },
          helperRequest
        )
      ).injections
      const executor = new NotebookKernelExecutor({
        pythonLoopPath: resolve('resources/notebook/python_loop.py'),
        platform: process.platform
      })
      const producer = [
        'import json',
        'brief = {"pitch":"A","vision":"B","figures":[{"key":"Fig1","claim":"Hook"}]}',
        'print(json.dumps({"brief_required": paper_brief_schema()["required"], "review_required": narrative_review_schema()["required"], "has_deck": "{{artifact:deck-v1}}" in narrative_review_task(brief, "deck-v1", "rules-v1"), "pn_sdk": "pn_sdk" in globals(), "derive": "derive_paper_brief" in globals()}))'
      ].join('\n')

      try {
        const result = await executor.execute({
          cwd: smokeRoot,
          notebookSessionRoot: join(smokeRoot, 'notebook'),
          dataRoot: join(smokeRoot, 'notebook', 'data'),
          runtimeRoot: join(smokeRoot, 'runtime'),
          language: 'python',
          resolvedInterpreter: { command: python3 as string },
          helperModules,
          code: producer
        })

        expect(result.status, result.traceback).toBe('completed')
        expect(JSON.parse(result.stdout.trim())).toEqual({
          brief_required: ['pitch', 'vision', 'figures'],
          review_required: [
            'hook_verdict',
            'figure_moves',
            'missing_panels',
            'kill_list',
            'arc',
            'boldest_defensible_fig1'
          ],
          has_deck: true,
          pn_sdk: false,
          derive: false
        })
      } finally {
        await executor.shutdown()
      }
    }, 30_000)
  })

  it('documents deterministic helpers and the review-required JS Host workflow', async () => {
    const skill = await readFile(skillPath, 'utf8')

    expect(skill).toContain('helperModules: ["paper-narrative"]')
    for (const name of helperExports) expect(skill).toMatch(new RegExp(`\\b${name}\\(`))
    expect(skill).toContain('host.llm(')
    expect(skill).toContain('host.delegate(')
    expect(skill).toContain('outputSchema')
    expect(skill).toContain('inputs:')
    expect(skill).toMatch(/manuscript Artifact Version/i)
    expect(skill).toMatch(/captions Artifact Version/i)
    expect(skill).toMatch(/deck Artifact Version/i)
    expect(skill).toMatch(/model-generated.*requires human review/i)
    expect(skill).toMatch(/figure-composer/i)
    expect(skill).toMatch(/would_send_for_review\s*===?\s*["']yes["']/)
    expect(skill).toMatch(/figure_moves\.length\s*===?\s*0/)
    expect(skill).toMatch(/missing_panels\.length\s*===?\s*0/)
    expect(skill).toMatch(/do not (?:read|import|exec|copy)/i)
    expect(skill).not.toMatch(/pn_sdk\(|derive_paper_brief\(|host\.reasoning_model/)
    expect(skill).toContain('JSON.stringify(briefSchema)')
    expect(skill).toMatch(/invalid paper brief.*retry/i)
    expect(skill).toContain('collectStructuredBatch')
    expect(skill).toContain('structuredOutputUnsatisfied')
    expect(skill).toContain('rebuiltDeckVersionId')
    expect(skill).not.toContain('deck-v2')
  })

  it('converges and hands every arc claim, moved panel, and data reference to figure-composer', async () => {
    const llmCalls: string[] = []
    type Request = { name: string; task: string; inputs: string[]; outputSchema: unknown }
    const delegated: Request[] = []
    const pending = new Map<string, Request>()
    const firstReview: HostReview = {
      hook_verdict: {
        would_send_for_review: 'weak',
        why: 'The response is buried.',
        fig1_is: 'A broad survey.',
        fig1_should_be: 'The responder result.'
      },
      figure_moves: [
        { what: 'responder panel', from_fig: 'Fig2', to_fig: 'Fig1', why: 'stronger hook' }
      ],
      missing_panels: [
        {
          target_fig: 'Fig1',
          what_to_show: 'dose response',
          analysis_needed: 'fit EC50',
          data_hint: 'dose table'
        }
      ],
      kill_list: [],
      arc: [
        { fig: 'Fig1', role: 'hook', one_line: 'Treatment restores function' },
        { fig: 'Fig2', role: 'mechanism', one_line: 'The receptor explains response' }
      ],
      boldest_defensible_fig1: 'Treatment restores function in responders'
    }
    const finalReview: HostReview = {
      hook_verdict: {
        would_send_for_review: 'yes',
        why: 'The result is immediate and supported.',
        fig1_is: 'The responder result.',
        fig1_should_be: 'The responder result.'
      },
      figure_moves: [],
      missing_panels: [],
      kill_list: [],
      arc: [
        { fig: 'Fig1', role: 'hook', one_line: 'Treatment restores function in responders' },
        { fig: 'Fig2', role: 'mechanism', one_line: 'The receptor explains response' }
      ],
      boldest_defensible_fig1: 'Treatment restores function in responders'
    }
    let nextFrame = 0
    const fakeHost: FakeHost = {
      llm: async (prompt: string) => {
        llmCalls.push(prompt)
        return {
          text: JSON.stringify({
            pitch: 'Treatment restores function.',
            vision: 'Readers can select responders.',
            audience: 'translational scientists',
            most_arresting_asset: 'Fig1 response panel',
            figures: [
              { key: 'Fig1', claim: 'Treatment restores function', composite_vid: 'fig1-v1' },
              { key: 'Fig2', claim: 'The receptor explains response', composite_vid: 'fig2-v1' }
            ]
          })
        }
      },
      delegate: async (requests) => {
        delegated.push(...requests)
        return {
          children: requests.map((request) => {
            const frameId = `frame-${++nextFrame}`
            pending.set(frameId, request)
            return { frameId, attemptId: `attempt-${nextFrame}` }
          })
        }
      },
      collect: async (selectors) => {
        return selectors.map(({ frameId }) => {
          const request = pending.get(frameId)
          if (!request) return { status: 'failed', error: 'unknown receipt' }
          if (request.name === 'paper-narrative-editor-r1') {
            return { status: 'completed', structuredOutput: firstReview }
          }
          if (request.name === 'paper-narrative-editor-r2') {
            return { status: 'completed', structuredOutput: finalReview }
          }
          return {
            status: 'completed',
            structuredOutput: { versionId: `${request.name}-version` }
          }
        })
      }
    }
    const manuscriptText = 'Abstract: treatment restores function through a receptor.'
    const captionsText = 'Fig1: response. Fig2: receptor mechanism.'
    const briefSchema = {
      type: 'object',
      required: ['pitch', 'vision', 'figures'],
      properties: {
        pitch: { type: 'string' },
        vision: { type: 'string' },
        figures: { type: 'array' }
      }
    }
    const brief = await deriveBrief(fakeHost, briefSchema, manuscriptText, captionsText)
    expect(brief).toMatchObject({
      pitch: 'Treatment restores function.',
      figures: [{ composite_vid: 'fig1-v1' }, { composite_vid: 'fig2-v1' }]
    })
    const reviewSchema = { type: 'object' }
    let review = await collectStructured<HostReview>(fakeHost, {
      name: 'paper-narrative-editor-r1',
      task: 'Review the full deck',
      inputs: ['manuscript-v1', 'captions-v1', 'deck-v1', 'rules-v1'],
      outputSchema: reviewSchema
    })
    const figureDataVersionIds: Record<string, string[]> = {
      Fig1: ['data-shared-v1', 'data-fig1-v1'],
      Fig2: ['data-shared-v1', 'data-fig2-v1']
    }
    const publishedMissingAnalysisVersionIds: Record<string, string[]> = {
      Fig1: ['analysis-dose-v1', 'data-fig1-v1']
    }

    const composerRequests = review.arc.map((item) => {
      const moved = review.figure_moves.filter((move) => move.to_fig === item.fig)
      const inputs = [
        ...(figureDataVersionIds[item.fig] ?? []),
        ...moved.flatMap((move) => figureDataVersionIds[move.from_fig] ?? []),
        ...(publishedMissingAnalysisVersionIds[item.fig] ?? [])
      ]
      return {
        name: `compose-${item.fig}`,
        task: `Claim: ${item.one_line}; moved panels: ${moved.map(({ what }) => what).join(', ')}`,
        inputs: [...new Set(inputs)],
        outputSchema: { type: 'object' }
      }
    })
    const composerOutputs = await collectStructuredBatch<{ versionId: string }>(
      fakeHost,
      composerRequests
    )
    const composedVersionIds = composerOutputs.map(({ versionId }) => versionId)
    const publishedDeckInputs: string[][] = []
    const publishDeck = (versionIds: string[]): string => {
      publishedDeckInputs.push(versionIds)
      return `deck-built-from:${versionIds.join('+')}`
    }
    const rebuiltDeckVersionId = publishDeck(composedVersionIds)

    review = await collectStructured<HostReview>(fakeHost, {
      name: 'paper-narrative-editor-r2',
      task: 'Review the rebuilt full deck',
      inputs: ['manuscript-v1', 'captions-v1', rebuiltDeckVersionId, 'rules-v1'],
      outputSchema: reviewSchema
    })

    const converged =
      review.hook_verdict.would_send_for_review === 'yes' &&
      review.figure_moves.length === 0 &&
      review.missing_panels.length === 0
    expect(converged).toBe(true)
    expect(llmCalls[0]).toContain(JSON.stringify(briefSchema))
    expect(llmCalls[0]).toContain(manuscriptText)
    expect(llmCalls[0]).toContain(captionsText)
    const sentComposer = delegated.filter(({ name }) => name.startsWith('compose-'))
    expect(sentComposer.map(({ name, task, inputs }) => ({ name, task, inputs }))).toEqual([
      {
        name: 'compose-Fig1',
        task: 'Claim: Treatment restores function; moved panels: responder panel',
        inputs: ['data-shared-v1', 'data-fig1-v1', 'data-fig2-v1', 'analysis-dose-v1']
      },
      {
        name: 'compose-Fig2',
        task: 'Claim: The receptor explains response; moved panels: ',
        inputs: ['data-shared-v1', 'data-fig2-v1']
      }
    ])
    expect(sentComposer.flatMap(({ inputs }) => inputs)).not.toContain('fig1-v1')
    expect(sentComposer.flatMap(({ inputs }) => inputs)).not.toContain('fig2-v1')
    expect(publishedDeckInputs).toEqual([['compose-Fig1-version', 'compose-Fig2-version']])
    expect(delegated.find(({ name }) => name === 'paper-narrative-editor-r2')?.inputs).toEqual([
      'manuscript-v1',
      'captions-v1',
      'deck-built-from:compose-Fig1-version+compose-Fig2-version',
      'rules-v1'
    ])
    expect(delegated.flatMap(({ inputs }) => inputs)).not.toContain('deck-v2')
  })

  it('fails clearly when brief reasoning returns invalid output', async () => {
    const prompt: string[] = []
    await expect(
      deriveBrief(
        {
          llm: async (value) => {
            prompt.push(value)
            return { text: '{"pitch":"missing the rest"}' }
          }
        },
        { type: 'object', required: ['pitch', 'vision', 'figures'] },
        'abstract',
        'captions'
      )
    ).rejects.toThrow(/invalid paper brief.*review and retry/i)
    expect(prompt[0]).toContain('"required":["pitch","vision","figures"]')
  })

  it('fails clearly when a completed reviewer has no accepted structured output', async () => {
    const host: Pick<FakeHost, 'delegate' | 'collect'> = {
      delegate: async () => ({ children: [{ frameId: 'f1', attemptId: 'a1' }] }),
      collect: async () => [{ status: 'completed', structuredOutputUnsatisfied: true }]
    }
    await expect(
      collectStructured(host, {
        name: 'review',
        task: 'review',
        inputs: [],
        outputSchema: { type: 'object' }
      })
    ).rejects.toThrow(/no schema-valid structuredOutput.*review and retry/i)
  })

  it.each([
    ['failed child', { status: 'failed', error: 'composer crashed' }],
    ['unsatisfied output', { status: 'completed', structuredOutputUnsatisfied: true }],
    ['missing output', { status: 'completed' }]
  ])('rejects composer %s instead of building a deck', async (_label, child) => {
    const host: Pick<FakeHost, 'delegate' | 'collect'> = {
      delegate: async () => ({ children: [{ frameId: 'f1', attemptId: 'a1' }] }),
      collect: async () => [child]
    }
    await expect(
      collectStructuredBatch(host, [
        {
          name: 'compose-Fig1',
          task: 'compose',
          inputs: ['data-v1'],
          outputSchema: { type: 'object' }
        }
      ])
    ).rejects.toThrow(/delegated workflow|schema-valid structuredOutput/i)
  })
})

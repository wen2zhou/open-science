import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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
const python3 = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(
  existsSync
)
const pythonGate = python3 ? describe : describe.skip
const helperExports = [
  'paper_brief_schema',
  'narrative_review_schema',
  'narrative_review_task'
] as const

let smokeRoot: string | undefined

afterEach(async () => {
  if (smokeRoot) await rm(smokeRoot, { recursive: true, force: true })
  smokeRoot = undefined
})

pythonGate('paper-narrative adapter', () => {
  it('passes the Python public-interface harness', () => {
    expect(() =>
      execFileSync(python3 as string, [contractPath], {
        cwd: skillDir,
        timeout: 15_000
      })
    ).not.toThrow()
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
  })

  it('injects only the three public methods in the real persistent Python loop', async () => {
    smokeRoot = await mkdtemp(join(resolve('.'), '.paper-narrative-smoke-'))
    const source = await readFile(kernelPath, 'utf8')
    const helperModules = await new NotebookHelperModuleHost({
      resolve: async (id) =>
        id === 'paper-narrative'
          ? { id, language: 'python' as const, source, exports: helperExports }
          : undefined
    }).resolve('python', ['paper-narrative'])
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

  it('converges and hands every arc claim, moved panel, and data reference to figure-composer', async () => {
    const llmCalls: string[] = []
    const delegateInputs: string[][] = []
    const composerRequests: Array<{ claim: string; movedPanels: string[]; dataRefs: string[] }> = []
    const reviews = [
      {
        hook_verdict: { would_send_for_review: 'weak' },
        figure_moves: [{ what: 'responder panel', from_fig: 'Fig2', to_fig: 'Fig1', why: 'hook' }],
        missing_panels: [],
        kill_list: [],
        arc: [
          { fig: 'Fig1', role: 'hook', one_line: 'Treatment restores function' },
          { fig: 'Fig2', role: 'mechanism', one_line: 'The receptor explains response' }
        ],
        boldest_defensible_fig1: 'Treatment restores function in responders'
      },
      {
        hook_verdict: { would_send_for_review: 'yes' },
        figure_moves: [],
        missing_panels: [],
        kill_list: [],
        arc: [
          { fig: 'Fig1', role: 'hook', one_line: 'Treatment restores function in responders' },
          { fig: 'Fig2', role: 'mechanism', one_line: 'The receptor explains response' }
        ],
        boldest_defensible_fig1: 'Treatment restores function in responders'
      }
    ]
    const fakeHost = {
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
      delegate: async (requests: Array<{ inputs: string[] }>) => {
        delegateInputs.push(...requests.map(({ inputs }) => inputs))
        return { children: [{ status: 'completed', output: reviews.shift() }] }
      }
    }
    const manuscriptText = 'Abstract: treatment restores function through a receptor.'
    const captionsText = 'Fig1: response. Fig2: receptor mechanism.'
    const brief = JSON.parse(
      (await fakeHost.llm(`Manuscript:\n${manuscriptText}\nCaptions:\n${captionsText}`)).text
    )
    let review = (
      await fakeHost.delegate([{ inputs: ['manuscript-v1', 'captions-v1', 'deck-v1', 'rules-v1'] }])
    ).children[0].output!

    for (const item of review.arc) {
      composerRequests.push({
        claim: item.one_line,
        movedPanels: review.figure_moves
          .filter((move) => move.to_fig === item.fig)
          .map((move) => move.what),
        dataRefs: brief.figures
          .filter((figure: { key: string }) => figure.key === item.fig)
          .map((figure: { composite_vid: string }) => figure.composite_vid)
      })
    }
    review = (
      await fakeHost.delegate([{ inputs: ['manuscript-v1', 'captions-v1', 'deck-v2', 'rules-v1'] }])
    ).children[0].output!

    const converged =
      review.hook_verdict.would_send_for_review === 'yes' &&
      review.figure_moves.length === 0 &&
      review.missing_panels.length === 0
    expect(converged).toBe(true)
    expect(llmCalls[0]).toContain(manuscriptText)
    expect(llmCalls[0]).toContain(captionsText)
    expect(delegateInputs).toEqual([
      ['manuscript-v1', 'captions-v1', 'deck-v1', 'rules-v1'],
      ['manuscript-v1', 'captions-v1', 'deck-v2', 'rules-v1']
    ])
    expect(composerRequests).toEqual([
      {
        claim: 'Treatment restores function',
        movedPanels: ['responder panel'],
        dataRefs: ['fig1-v1']
      },
      {
        claim: 'The receptor explains response',
        movedPanels: [],
        dataRefs: ['fig2-v1']
      }
    ])
  })
})

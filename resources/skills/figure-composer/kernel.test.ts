import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'
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

type PanelLetter = 'A' | 'B' | 'C' | 'D' | 'E'
type PanelRequest = { name: string; inputs: string[] }
type FakeChild = {
  frameId: string
  attemptId: string
  name: string
  status: 'completed' | 'error'
  artifactsCreated: Array<{ name: string; mimeType: string; versionId: string }>
  structuredOutput?: { panelVersionId: string; labelsUsed: string[] }
  structuredOutputUnsatisfied?: boolean
}

class FakeHost {
  readonly delegateCalls: Array<{ requests: PanelRequest[]; options: { wait: false } }> = []
  readonly collectCalls: Array<Array<{ frameId: string; attemptId: string }>> = []
  readonly viewImageCalls: Array<{
    source: { versionId: string }
    options: { crop: { unit: 'pixels'; left: number; top: number; right: number; bottom: number } }
  }> = []

  constructor(
    private readonly versions: Record<string, string>,
    private readonly mutateChild?: (child: FakeChild) => FakeChild
  ) {}

  async delegate(
    requests: PanelRequest[],
    options: { wait: false }
  ): Promise<{
    kind: 'receipts'
    children: Array<{ frameId: string; attemptId: string; name: string; status: 'running' }>
  }> {
    this.delegateCalls.push({ requests, options })
    return {
      kind: 'receipts',
      children: requests.map(({ name }) => ({
        frameId: `frame-${name}`,
        attemptId: `attempt-${name}`,
        name,
        status: 'running'
      }))
    }
  }

  async collect(
    selectors: Array<{ frameId: string; attemptId: string }>,
    _options: { returnWhen: 'all'; timeoutSeconds: 1800 }
  ): Promise<FakeChild[]> {
    void _options
    this.collectCalls.push(selectors)
    return selectors.map(({ frameId, attemptId }) => {
      const name = frameId.slice('frame-'.length)
      const letter = name.slice(6, 7)
      const versionId = this.versions[name]
      const child: FakeChild = {
        frameId,
        attemptId,
        name,
        status: 'completed',
        artifactsCreated: [{ name: `panel_${letter}.png`, mimeType: 'image/png', versionId }],
        structuredOutput: { panelVersionId: versionId, labelsUsed: [`label-${letter}`] }
      }
      return this.mutateChild?.(child) ?? child
    })
  }

  async viewImage(
    source: { versionId: string },
    options: { crop: { unit: 'pixels'; left: number; top: number; right: number; bottom: number } }
  ): Promise<void> {
    this.viewImageCalls.push({ source, options })
  }
}

const panelLetter = (name: string): PanelLetter => name.slice(6, 7) as PanelLetter

const checkedPanelVersion = (child: FakeChild): string => {
  if (child.status !== 'completed') throw new Error(`panel failed: ${child.name}`)
  if (child.structuredOutputUnsatisfied) throw new Error(`panel output unsatisfied: ${child.name}`)
  const output = child.structuredOutput
  if (
    !output ||
    typeof output.panelVersionId !== 'string' ||
    !Array.isArray(output.labelsUsed) ||
    output.labelsUsed.some((label) => typeof label !== 'string')
  ) {
    throw new Error(`invalid panel output: ${child.name}`)
  }
  const pngs = child.artifactsCreated.filter(
    (artifact) =>
      artifact.mimeType === 'image/png' && artifact.name === `panel_${panelLetter(child.name)}.png`
  )
  if (pngs.length !== 1 || pngs[0].versionId !== output.panelVersionId) {
    throw new Error(`panel Artifact identity mismatch: ${child.name}`)
  }
  return pngs[0].versionId
}

const dispatchPanelWaves = async (
  host: FakeHost,
  requests: PanelRequest[]
): Promise<Array<{ letter: PanelLetter; versionId: string }>> => {
  const versions: Array<{ letter: PanelLetter; versionId: string }> = []
  for (let offset = 0; offset < requests.length; offset += 4) {
    const receipts = await host.delegate(requests.slice(offset, offset + 4), { wait: false })
    const children = await host.collect(
      receipts.children.map(({ frameId, attemptId }) => ({ frameId, attemptId })),
      { returnWhen: 'all', timeoutSeconds: 1800 }
    )
    for (const child of children) {
      versions.push({ letter: panelLetter(child.name), versionId: checkedPanelVersion(child) })
    }
  }
  return versions
}

const groupFixesByPanel = (review: {
  violations: Array<{ severity: string; panel_letter: PanelLetter }>
}): Set<PanelLetter> =>
  new Set(
    review.violations
      .filter(({ severity }) => severity === 'BLOCKER' || severity === 'MAJOR')
      .map(({ panel_letter }) => panel_letter)
  )

const applyOutlineRevisions = (
  revisions: Array<{ affected_panels: PanelLetter[] }>
): Set<PanelLetter> => new Set(revisions.flatMap(({ affected_panels }) => affected_panels))

type FakeReview = {
  outline_revisions: Array<{ affected_panels: PanelLetter[] }>
  violations: Array<{ severity: string; panel_letter: PanelLetter }>
}

const checkedReview = (child: {
  status: 'completed' | 'error'
  structuredOutputUnsatisfied?: boolean
  structuredOutput?: FakeReview
}): FakeReview => {
  if (child.status !== 'completed') throw new Error('review failed')
  if (child.structuredOutputUnsatisfied || !child.structuredOutput) {
    throw new Error('review structured output missing')
  }
  return child.structuredOutput
}

let smokeRoot: string | undefined

afterEach(async () => {
  if (smokeRoot) await rm(smokeRoot, { recursive: true, force: true })
  smokeRoot = undefined
})

describe('figure-composer JS Host workflow contract', () => {
  it('documents fail-closed capabilities, schema-bound outline reasoning, and immutable handoff', async () => {
    const skill = await readFile(skillPath, 'utf8')
    expect(skill).toContain('helperModules: ["figure-composer"]')
    for (const name of helperExports) expect(skill).toMatch(new RegExp(`\\b${name}\\(`))
    for (const capability of ['llm', 'delegate', 'collect', 'artifacts']) {
      expect(skill).toContain(`caps.${capability} !== true`)
    }
    expect(skill).toContain('caps.viewImage !== true')
    expect(skill).toMatch(
      /Before starting the workflow[\s\S]*caps\.artifacts !== true[\s\S]*caps\.viewImage !== true[\s\S]*## 1\. Reason/
    )
    expect(skill).toContain('JSON.stringify(outlineSchema)')
    expect(skill).toContain('JSON.parse(outlineDraft.text)')
    expect(skill).toMatch(/invalid outline.*retry|retry.*invalid outline/is)
    for (const call of ['host.llm(', 'host.delegate(', 'host.collect(', 'host.viewImage(']) {
      expect(skill).toContain(call)
    }
    for (const field of [
      'outputSchema',
      'structuredOutputUnsatisfied',
      'structuredOutput',
      'artifactsCreated',
      'producerRunId',
      'inputs:'
    ])
      expect(skill).toContain(field)
    expect(skill).toMatch(/immutable Artifact Version/i)
    expect(skill).toMatch(/maximum 3 review rounds/i)
    expect(skill).toMatch(/load(?:s|ed)? `figure-style` independently/i)
    expect(skill).toMatch(/do not (?:read|import|exec|copy)/i)
    expect(skill).not.toMatch(/host\.(?:view_image|reasoning_model)/)
    expect(skill).not.toMatch(/output_schema|wait=False|derive_outline\(|fc_sdk\(/)
  })

  it('does no reasoning, delegation, or composition when startup viewImage gating fails', async () => {
    const calls = { llm: 0, delegate: 0, compose: 0 }
    const caps = { llm: true, delegate: true, collect: true, artifacts: true, viewImage: false }
    const startWorkflow = async (): Promise<void> => {
      for (const capability of ['llm', 'delegate', 'collect', 'artifacts', 'viewImage'] as const) {
        if (caps[capability] !== true) throw new Error(`missing capability: ${capability}`)
      }
      calls.llm += 1
      calls.delegate += 1
      calls.compose += 1
    }

    await expect(startWorkflow()).rejects.toThrow('missing capability: viewImage')
    expect(calls).toEqual({ llm: 0, delegate: 0, compose: 0 })
  })

  it('dispatches five panels in ordered waves of four and one', async () => {
    const host = new FakeHost(
      Object.fromEntries(
        (['A', 'B', 'C', 'D', 'E'] as PanelLetter[]).map((letter) => [
          `panel-${letter}-r1`,
          `${letter}1`
        ])
      )
    )
    const requests = (['A', 'B', 'C', 'D', 'E'] as PanelLetter[]).map((letter) => ({
      name: `panel-${letter}-r1`,
      inputs: [`data-${letter}`]
    }))
    await expect(dispatchPanelWaves(host, requests)).resolves.toEqual(
      (['A', 'B', 'C', 'D', 'E'] as PanelLetter[]).map((letter) => ({
        letter,
        versionId: `${letter}1`
      }))
    )
    expect(host.delegateCalls.map(({ requests: wave }) => wave.map(({ name }) => name))).toEqual([
      ['panel-A-r1', 'panel-B-r1', 'panel-C-r1', 'panel-D-r1'],
      ['panel-E-r1']
    ])
    expect(host.delegateCalls.every(({ options }) => options.wait === false)).toBe(true)
    expect(host.collectCalls).toHaveLength(2)
  })

  it.each([
    [
      'unsatisfied output',
      (child: FakeChild): FakeChild =>
        child.name === 'panel-B-r1' ? { ...child, structuredOutputUnsatisfied: true } : child
    ],
    [
      'partial wave failure',
      (child: FakeChild): FakeChild =>
        child.name === 'panel-E-r1' ? { ...child, status: 'error' } : child
    ],
    [
      'missing structured output',
      (child: FakeChild): FakeChild =>
        child.name === 'panel-D-r1' ? { ...child, structuredOutput: undefined } : child
    ],
    [
      'Artifact identity mismatch',
      (child: FakeChild): FakeChild =>
        child.name === 'panel-C-r1'
          ? { ...child, structuredOutput: { panelVersionId: 'wrong', labelsUsed: ['C'] } }
          : child
    ]
  ])('fails closed before composition for %s', async (_label, mutateChild) => {
    const host = new FakeHost(
      Object.fromEntries(
        (['A', 'B', 'C', 'D', 'E'] as PanelLetter[]).map((letter) => [
          `panel-${letter}-r1`,
          `${letter}1`
        ])
      ),
      mutateChild
    )
    let composeCalls = 0
    const runPanelStage = async (): Promise<void> => {
      await dispatchPanelWaves(
        host,
        (['A', 'B', 'C', 'D', 'E'] as PanelLetter[]).map((letter) => ({
          name: `panel-${letter}-r1`,
          inputs: [`data-${letter}`]
        }))
      )
      composeCalls += 1
    }
    await expect(runPanelStage()).rejects.toThrow(/panel/)
    expect(composeCalls).toBe(0)
  })

  it('derives review scope, inspects crops, reuses clean identities, and binds the actual compose run', async () => {
    const host = new FakeHost({
      'panel-A-r1': 'A1',
      'panel-B-r1': 'B1',
      'panel-C-r1': 'C1',
      'panel-B-r2': 'B2',
      'panel-A-r3': 'A2'
    })
    const panelVersions: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' }
    const dataVersions = { A: 'data-A', B: 'data-B', C: 'data-C' }
    const publish = async (letters: Array<'A' | 'B' | 'C'>, round: number): Promise<void> => {
      const produced = await dispatchPanelWaves(
        host,
        letters.map((letter) => ({
          name: `panel-${letter}-r${round}`,
          inputs: [dataVersions[letter], ...(panelVersions[letter] ? [panelVersions[letter]] : [])]
        }))
      )
      for (const panel of produced) panelVersions[panel.letter as 'A' | 'B' | 'C'] = panel.versionId
    }
    const composeCalls: string[][] = []
    const compose = async (): Promise<{ runId: string; versionId: string }> => {
      composeCalls.push(Object.values(panelVersions))
      const round = composeCalls.length
      return { runId: `notebook-run-compose-${round}`, versionId: `composite-v${round}` }
    }
    await publish(['A', 'B', 'C'], 1)
    let finalCompose = await compose()
    const reviewChildren = [
      {
        status: 'completed' as const,
        structuredOutput: {
          outline_revisions: [] as Array<{ affected_panels: PanelLetter[] }>,
          violations: [{ severity: 'MAJOR', panel_letter: 'B' as const }]
        }
      },
      {
        status: 'completed' as const,
        structuredOutput: {
          outline_revisions: [{ affected_panels: ['A' as const] }],
          violations: [{ severity: 'MINOR', panel_letter: 'C' as const }]
        }
      }
    ]
    for (const [index, reviewChild] of reviewChildren.entries()) {
      const review = checkedReview(reviewChild)
      const affected = new Set([
        ...applyOutlineRevisions(review.outline_revisions),
        ...groupFixesByPanel(review)
      ])
      await publish([...affected] as Array<'A' | 'B' | 'C'>, index + 2)
      finalCompose = await compose()
    }
    const crops = { A: [0, 0, 200, 104], B: [0, 106, 99, 210], C: [101, 106, 200, 210] }
    for (const box of Object.values(crops)) {
      await host.viewImage(
        { versionId: finalCompose.versionId },
        {
          crop: {
            unit: 'pixels',
            left: box[0],
            top: box[1],
            right: box[2],
            bottom: box[3]
          }
        }
      )
    }
    const artifactWrites: Array<{ filename: string; producerRunId: string }> = []
    const writeArtifact = async (input: {
      filename: string
      producerRunId: string
    }): Promise<void> => {
      artifactWrites.push(input)
    }
    await writeArtifact({ filename: 'figure.png', producerRunId: finalCompose.runId })
    expect(panelVersions).toEqual({ A: 'A2', B: 'B2', C: 'C1' })
    expect(composeCalls.slice(0, 3)).toEqual([
      ['A1', 'B1', 'C1'],
      ['A1', 'B2', 'C1'],
      ['A2', 'B2', 'C1']
    ])
    expect(host.viewImageCalls).toHaveLength(3)
    expect(
      host.viewImageCalls.every(({ source }) => source.versionId === finalCompose.versionId)
    ).toBe(true)
    expect(finalCompose).toEqual({ runId: 'notebook-run-compose-3', versionId: 'composite-v3' })
    expect(artifactWrites).toEqual([
      { filename: 'figure.png', producerRunId: 'notebook-run-compose-3' }
    ])
  })
})

pythonGate('figure-composer Python helper contract', () => {
  it('passes the Python public-interface harness', () => {
    expect(() =>
      execFileSync(python3 as string, [contractPath], {
        cwd: skillDir,
        env: { ...process.env, MPLBACKEND: 'Agg' },
        timeout: 15_000
      })
    ).not.toThrow()
  })

  it('runs the registered helper in the real persistent loop and composes a focused PNG', async () => {
    smokeRoot = await mkdtemp(join(resolve('.'), '.figure-composer-smoke-'))
    const source = await readFile(kernelPath, 'utf8')
    const host = new NotebookHelperModuleHost({
      resolve: async (id) =>
        id === 'figure-composer'
          ? { id, language: 'python' as const, source, exports: helperExports }
          : undefined
    })
    const epoch = { id: 'figure-composer-smoke', processKey: 'python:system-python' }
    const helperPlan = await host.plan(
      epoch,
      await host.preflight('python', ['figure-composer'], epoch)
    )
    host.commitInitialized(
      epoch,
      helperPlan.injections.map(({ id }) => id)
    )
    const helperModules = helperPlan.injections
    expect(host.loadedEvidence(epoch)).toMatchObject({
      helperEvidenceStatus: { state: 'complete' },
      helperModules: [
        {
          helperId: 'figure-composer',
          skillIdentity: 'figure-composer',
          packageOrigin: 'registered',
          interfaceRevision: '1',
          exports: [...helperExports],
          source
        }
      ]
    })
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: resolve('resources/notebook/python_loop.py'),
      platform: process.platform
    })
    const producer = [
      'import json',
      'from PIL import Image',
      'outline = {"claim":"Treatment changes every readout","width_mm":50.8,"ncol":2,"row_heights_mm":[25.4,25.4],"panels":[{"letter":"A","role":"schematic","message":"Design","chart_family":"diagram","row":0,"col":0,"colspan":2,"ask":"design"},{"letter":"B","role":"primary","message":"Effect","chart_family":"bars","row":1,"col":0,"colspan":1,"ask":"effect"},{"letter":"C","role":"supporting","message":"Replication","chart_family":"points","row":1,"col":1,"colspan":1,"ask":"replication"}]}',
      'paths = {}',
      'for letter, color in [("A", (235,70,70,255)), ("B", (70,180,90,255)), ("C", (70,100,220,255))]:',
      '    path = f"panel-{letter}.png"',
      '    Image.new("RGBA", panel_px(outline, letter, dpi=100, gutter_mm=2.54), color).save(path)',
      '    paths[letter] = path',
      'path, size = compose_figure(outline, paths, "composite.png", dpi=100, gutter_mm=2.54)',
      'print(json.dumps({"path": path, "size": size, "crops": compose_crops(outline, dpi=100, gutter_mm=2.54)}))'
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
        path: 'composite.png',
        size: [200, 210],
        crops: { A: [0, 0, 200, 104], B: [0, 106, 99, 210], C: [101, 106, 200, 210] }
      })
      expect(await sharp(join(smokeRoot, 'composite.png')).metadata()).toMatchObject({
        format: 'png',
        width: 200,
        height: 210
      })
    } finally {
      await executor.shutdown()
    }
  }, 30_000)
})

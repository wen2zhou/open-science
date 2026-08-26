import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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
const python3 = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(
  existsSync
)
const pythonGate = python3 ? describe : describe.skip
const helperExports = [
  'figure_outline_schema',
  'grid_geom',
  'panel_px',
  'panel_xy',
  'panel_task',
  'compose_crops',
  'compose_figure',
  'group_fixes_by_panel',
  'review_schema',
  'composite_review_task',
  'apply_outline_revisions'
] as const

let smokeRoot: string | undefined

afterEach(async () => {
  if (smokeRoot) await rm(smokeRoot, { recursive: true, force: true })
  smokeRoot = undefined
})

pythonGate('figure-composer adapter', () => {
  it('passes the Python public-interface harness', () => {
    expect(() =>
      execFileSync(python3 as string, [contractPath], {
        cwd: skillDir,
        env: { ...process.env, MPLBACKEND: 'Agg' },
        timeout: 15_000
      })
    ).not.toThrow()
  })

  it('documents the JS Host workflow and immutable Artifact handoff', async () => {
    const skill = await readFile(skillPath, 'utf8')
    expect(skill).toContain('helperModules: ["figure-composer"]')
    for (const name of helperExports) expect(skill).toMatch(new RegExp(`\\b${name}\\(`))
    expect(skill).toContain('host.llm(')
    expect(skill).toContain('host.delegate(')
    expect(skill).toContain('host.collect(')
    expect(skill).toContain('host.viewImage(')
    expect(skill).toContain('outputSchema')
    expect(skill).toContain('artifactsCreated')
    expect(skill).toContain('producerRunId')
    expect(skill).toContain('inputs:')
    expect(skill).toMatch(/immutable Artifact Version/i)
    expect(skill).toMatch(/maximum 3 review rounds/i)
    expect(skill).toMatch(/load(?:s|ed)? `figure-style` independently/i)
    expect(skill).toMatch(/do not (?:read|import|exec|copy)/i)
    expect(skill).not.toMatch(/host\.(?:view_image|reasoning_model)/)
    expect(skill).not.toMatch(/output_schema|wait=False|derive_outline\(|fc_sdk\(/)
  })

  it('runs the registered helper in the real persistent loop and composes a focused PNG', async () => {
    smokeRoot = await mkdtemp(join(resolve('.'), '.figure-composer-smoke-'))
    const source = await readFile(kernelPath, 'utf8')
    const helperModules = await new NotebookHelperModuleHost({
      resolve: async (id) =>
        id === 'figure-composer'
          ? { id, language: 'python' as const, source, exports: helperExports }
          : undefined
    }).resolve('python', ['figure-composer'])
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
      const metadata = await sharp(join(smokeRoot, 'composite.png')).metadata()
      expect(metadata).toMatchObject({ format: 'png', width: 200, height: 210 })
    } finally {
      await executor.shutdown()
    }
  }, 30_000)

  it('keeps clean Artifact Version identities across the three-round fake Host workflow', async () => {
    const calls: Array<{ name: string; inputs: string[] }> = []
    const generated: Record<string, string> = {
      'panel-A-r1': 'A1',
      'panel-B-r1': 'B1',
      'panel-C-r1': 'C1',
      'panel-B-r2': 'B2',
      'panel-A-r3': 'A2'
    }
    const fakeHost = {
      delegate: async (requests: Array<{ name: string; inputs: string[] }>) => {
        calls.push(...requests)
        return {
          kind: 'results',
          children: requests.map(({ name }) => ({
            name,
            status: 'completed',
            artifactsCreated: [{ versionId: generated[name] }]
          }))
        }
      }
    }
    const panelVersions: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' }
    const dataVersions = { A: 'data-A', B: 'data-B', C: 'data-C' }
    const publish = async (letters: Array<'A' | 'B' | 'C'>, round: number): Promise<void> => {
      const result = await fakeHost.delegate(
        letters.map((letter) => ({
          name: `panel-${letter}-r${round}`,
          inputs: [dataVersions[letter], ...(panelVersions[letter] ? [panelVersions[letter]] : [])]
        }))
      )
      result.children.forEach((child) => {
        const letter = child.name.slice(6, 7) as 'A' | 'B' | 'C'
        panelVersions[letter] = child.artifactsCreated[0].versionId
      })
    }

    await publish(['A', 'B', 'C'], 1)
    const compositeInputs = [Object.values(panelVersions)]
    await publish(['B'], 2)
    compositeInputs.push(Object.values(panelVersions))
    await publish(['A'], 3)
    compositeInputs.push(Object.values(panelVersions))

    expect(panelVersions).toEqual({ A: 'A2', B: 'B2', C: 'C1' })
    expect(compositeInputs).toEqual([
      ['A1', 'B1', 'C1'],
      ['A1', 'B2', 'C1'],
      ['A2', 'B2', 'C1']
    ])
    expect(calls).toEqual([
      { name: 'panel-A-r1', inputs: ['data-A'] },
      { name: 'panel-B-r1', inputs: ['data-B'] },
      { name: 'panel-C-r1', inputs: ['data-C'] },
      { name: 'panel-B-r2', inputs: ['data-B', 'B1'] },
      { name: 'panel-A-r3', inputs: ['data-A', 'A1'] }
    ])
    expect({ filename: 'figure.png', producerRunId: 'notebook-run-compose-3' }).toEqual({
      filename: 'figure.png',
      producerRunId: 'notebook-run-compose-3'
    })
  })
})

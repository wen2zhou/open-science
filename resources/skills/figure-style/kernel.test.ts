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
  'apply_figure_style',
  'set_frame',
  'panel_letter',
  'focal_palette',
  'bar_with_points',
  'strip_with_median',
  'goodness_arrow',
  'two_tier_label',
  'end_of_line_labels',
  'panel_crops'
] as const

let smokeRoot: string | undefined

afterEach(async () => {
  if (smokeRoot) await rm(smokeRoot, { recursive: true, force: true })
  smokeRoot = undefined
})

pythonGate('figure-style helper contract', () => {
  it('passes the Python public-interface harness', () => {
    expect(() =>
      execFileSync(python3 as string, [contractPath], {
        cwd: skillDir,
        env: { ...process.env, MPLBACKEND: 'Agg' },
        timeout: 15_000
      })
    ).not.toThrow()
  })

  it('documents the stable helper interface without exposing its implementation', async () => {
    const skill = await readFile(skillPath, 'utf8')

    expect(skill).toContain('helperModules: ["figure-style"]')
    for (const name of helperExports) expect(skill).toMatch(new RegExp(`\\b${name}\\(`))
    expect(skill).toMatch(/data shape/i)
    expect(skill).toMatch(/return/i)
    expect(skill).toMatch(/error/i)
    expect(skill).toMatch(/do not (?:read|import|exec|copy)/i)
    expect(skill).not.toMatch(/(?:open|read_text|read)\([^\n]*kernel\.py/i)
    expect(skill).not.toMatch(/(?:sys\.path|importlib|spec_from_file|runpy)/i)
  })

  it.each([
    ['registered source', (source: string) => source],
    [
      'compatible source replacement',
      (source: string) => source.replace('META_GREY = "#888888"', 'META_GREY = "#777777"')
    ]
  ])(
    'directly calls the %s through the real persistent loop and renders a legible PNG',
    async (_label, replaceSource) => {
      smokeRoot = await mkdtemp(join(resolve('.'), '.figure-style-smoke-'))
      const source = replaceSource(await readFile(kernelPath, 'utf8'))
      const helperModules = await new NotebookHelperModuleHost({
        resolve: async (id) =>
          id === 'figure-style'
            ? { id, language: 'python' as const, source, exports: helperExports }
            : undefined
      }).resolve('python', ['figure-style'])
      const executor = new NotebookKernelExecutor({
        pythonLoopPath: resolve('resources/notebook/python_loop.py'),
        platform: process.platform
      })
      const producer = [
        'import json',
        'import matplotlib.pyplot as plt',
        'apply_figure_style()',
        'labels = ["Baseline", "Focal", "Comparator"]',
        'colors = focal_palette(labels, "Focal", "#0066CC", other="grey")',
        'fig, ax = plt.subplots(figsize=(4.8, 3.2))',
        'bar_with_points(ax, [0, 1, 2], [[1, 2, 3], [3, 4, 5], [2, 3, 4]], labels, colors)',
        'panel_letter(ax, "a")',
        'ax.set_title("Focal response remains strongest")',
        'ax.set_xlabel("Condition")',
        'ax.set_ylabel("Response (a.u.)")',
        'fig.canvas.draw()',
        'print(json.dumps({"bars": len(ax.patches), "points": sum(len(c.get_offsets()) for c in ax.collections), "colors": colors, "title": ax.get_title(loc="left"), "xlabel": ax.get_xlabel(), "ylabel": ax.get_ylabel()}))'
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
          bars: 3,
          points: 9,
          colors: ['#BCBCBC', '#0066CC', '#BCBCBC'],
          title: 'Focal response remains strongest',
          xlabel: 'Condition',
          ylabel: 'Response (a.u.)'
        })
        const display = result.outputs.find(
          (output) => output.type === 'display' && typeof output.data['image/png'] === 'string'
        )
        expect(display?.type).toBe('display')
        if (!display || display.type !== 'display') throw new Error('Expected captured PNG output')
        const png = Buffer.from(display.data['image/png'], 'base64')
        const metadata = await sharp(png).metadata()
        const stats = await sharp(png).stats()
        expect(metadata.format).toBe('png')
        expect(metadata.width).toBeGreaterThan(900)
        expect(metadata.height).toBeGreaterThan(600)
        expect(stats.isOpaque).toBe(true)
        expect(stats.entropy).toBeGreaterThan(0.5)
      } finally {
        await executor.shutdown()
      }
    },
    30_000
  )
})

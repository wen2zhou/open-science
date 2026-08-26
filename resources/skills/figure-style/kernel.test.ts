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
const contractDescriptorPath = join(skillDir, 'fixtures', 'helper-contract.json')
const replacementPath = join(skillDir, 'fixtures', 'compatible_kernel.py')
const python3 = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(
  existsSync
)
const pythonGate = python3 ? describe : describe.skip
const helperContract = JSON.parse(readFileSync(contractDescriptorPath, 'utf8')) as {
  helperId: string
  exports: Array<{ name: string; signature: string }>
}
const helperExports = helperContract.exports.map(({ name }) => name)

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
    expect(skill).not.toContain('host.view_image')
    expect(await readFile(kernelPath, 'utf8')).not.toContain('host.view_image')
    const replacement = await readFile(replacementPath, 'utf8')
    expect(replacement).not.toContain('kernel.py')
    expect(replacement).not.toBe(await readFile(kernelPath, 'utf8'))
  })

  it.each([
    ['registered source', kernelPath],
    ['compatible source replacement', replacementPath]
  ])(
    'directly calls the %s through the real persistent loop and renders a legible PNG',
    async (_label, sourcePath) => {
      smokeRoot = await mkdtemp(join(resolve('.'), '.figure-style-smoke-'))
      const source = await readFile(sourcePath, 'utf8')
      const helperModules = await new NotebookHelperModuleHost({
        resolve: async (id) =>
          id === helperContract.helperId
            ? { id, language: 'python' as const, source, exports: helperExports }
            : undefined
      }).resolve('python', [helperContract.helperId])
      const executor = new NotebookKernelExecutor({
        pythonLoopPath: resolve('resources/notebook/python_loop.py'),
        platform: process.platform
      })
      const producer = [
        'import json',
        'import inspect',
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
        `interface_names = ${JSON.stringify(helperExports)}`,
        'print(json.dumps({"bars": len(ax.patches), "points": sum(len(c.get_offsets()) for c in ax.collections), "colors": colors, "title": ax.get_title(loc="left"), "xlabel": ax.get_xlabel(), "ylabel": ax.get_ylabel(), "crops": panel_crops(fig), "signatures": {name: str(inspect.signature(globals()[name])) for name in interface_names}}))'
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
        const report = JSON.parse(result.stdout.trim()) as {
          bars: number
          points: number
          colors: string[]
          title: string
          xlabel: string
          ylabel: string
          crops: Record<string, [number, number, number, number]>
          signatures: Record<string, string>
        }
        expect(report).toMatchObject({
          bars: 3,
          points: 9,
          colors: ['#BCBCBC', '#0066CC', '#BCBCBC'],
          title: 'Focal response remains strongest',
          xlabel: 'Condition',
          ylabel: 'Response (a.u.)'
        })
        expect(report.signatures).toEqual(
          Object.fromEntries(helperContract.exports.map(({ name, signature }) => [name, signature]))
        )
        const display = result.outputs.find(
          (output) => output.type === 'display' && typeof output.data['image/png'] === 'string'
        )
        expect(display?.type).toBe('display')
        if (!display || display.type !== 'display') throw new Error('Expected captured PNG output')
        const png = Buffer.from(display.data['image/png'], 'base64')
        const metadata = await sharp(png).metadata()
        const stats = await sharp(png).stats()
        const raster = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
        expect(metadata.format).toBe('png')
        expect(metadata.width).toBeGreaterThan(900)
        expect(metadata.height).toBeGreaterThan(600)
        expect(stats.isOpaque).toBe(true)
        expect(stats.entropy).toBeGreaterThan(0.5)

        const { width, height, channels } = raster.info
        const pixels: Array<{ x: number; y: number; r: number; g: number; b: number }> = []
        for (let offset = 0; offset < raster.data.length; offset += channels) {
          const index = offset / channels
          pixels.push({
            x: index % width,
            y: Math.floor(index / width),
            r: raster.data[offset],
            g: raster.data[offset + 1],
            b: raster.data[offset + 2]
          })
        }
        const focalBlue = pixels.filter(({ r, g, b }) => b > 150 && b - r > 70 && b - g > 35)
        const neutralFill = pixels.filter(
          ({ r, g, b }) => r >= 165 && r <= 210 && Math.abs(r - g) <= 3 && Math.abs(g - b) <= 3
        )
        const darkInk = pixels.filter(({ r, g, b }) => r < 125 && g < 125 && b < 125)
        expect(focalBlue.length).toBeGreaterThan(5_000)
        expect(neutralFill.length).toBeGreaterThan(10_000)
        expect(darkInk.length).toBeGreaterThan(1_000)

        const darkBounds = darkInk.reduce(
          (bounds, pixel) => ({
            minX: Math.min(bounds.minX, pixel.x),
            minY: Math.min(bounds.minY, pixel.y),
            maxX: Math.max(bounds.maxX, pixel.x),
            maxY: Math.max(bounds.maxY, pixel.y)
          }),
          { minX: width, minY: height, maxX: 0, maxY: 0 }
        )
        expect(darkBounds.minX).toBeGreaterThan(5)
        expect(darkBounds.minY).toBeGreaterThan(5)
        expect(darkBounds.maxX).toBeLessThan(width - 5)
        expect(darkBounds.maxY).toBeLessThan(height - 5)
        expect(darkInk.filter(({ y }) => y < height * 0.22).length).toBeGreaterThan(100)
        expect(darkInk.filter(({ y }) => y > height * 0.78).length).toBeGreaterThan(100)
        expect(darkInk.filter(({ x }) => x < width * 0.18).length).toBeGreaterThan(100)

        expect(Object.keys(report.crops)).toEqual(['a'])
        const [x0, y0, x1, y1] = report.crops.a
        expect(x0).toBeGreaterThanOrEqual(0)
        expect(y0).toBeGreaterThanOrEqual(0)
        expect(x1).toBeLessThanOrEqual(width)
        expect(y1).toBeLessThanOrEqual(height)
        expect((x1 - x0) * (y1 - y0)).toBeGreaterThan(width * height * 0.6)
        expect(x0).toBeLessThanOrEqual(darkBounds.minX)
        expect(y0).toBeLessThanOrEqual(darkBounds.minY)
        expect(x1).toBeGreaterThan(darkBounds.maxX)
        expect(y1).toBeGreaterThan(darkBounds.maxY)
      } finally {
        await executor.shutdown()
      }
    },
    30_000
  )
})

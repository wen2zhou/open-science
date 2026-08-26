import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import type { ArtifactVersionFile } from '../../../src/shared/artifact-provenance'
import {
  createLinearConversationGraph,
  projectConversationMessage
} from '../../../src/shared/conversation-graph'
import type { PersistedChatSession } from '../../../src/shared/session-persistence'
import { ImmutableInputAuthority } from '../../../src/main/immutable-input-authority'
import { ArtifactCodeReconstructionService } from '../../../src/main/artifacts/code-reconstruction'
import { ArtifactProvenanceRepository } from '../../../src/main/artifacts/provenance-repository'
import { ArtifactRepository } from '../../../src/main/artifacts/repository'
import { NotebookKernelExecutor } from '../../../src/main/notebook/kernel-executor'
import { NotebookInputRegistry } from '../../../src/main/notebook/input-registry'
import { NotebookLocalRpcServer } from '../../../src/main/notebook/local-rpc-server'
import { NotebookRunRepository } from '../../../src/main/notebook/repository'
import { NotebookRuntimeService } from '../../../src/main/notebook/runtime-service'
import {
  createProjectDbClient,
  migrateApplicationDatabase
} from '../../../src/main/projects/prisma-client'
import { RegisteredSkillHelperCatalog } from '../../../src/main/skills/registered-helper-catalog'
import { SkillRegistry } from '../../../src/main/skills/registry'

const skillDir = dirname(fileURLToPath(import.meta.url))
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

type AsyncCleanup = () => Promise<unknown>

const settleCleanups = async (cleanups: AsyncCleanup[]): Promise<void> => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.reverse()) {
    const [result] = await Promise.allSettled([Promise.resolve().then(cleanup)])
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'figure-composer E2E cleanup failed')
}

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
      'artifactVersionInputs',
      'inputs:'
    ])
      expect(skill).toContain(field)
    expect(skill).toMatch(/immutable Artifact Version/i)
    expect(skill).toMatch(/maximum 3 review rounds/i)
    expect(skill).toMatch(/load(?:s|ed)? `figure-style` independently/i)
    expect(skill).toMatch(/do not (?:read|import|exec|copy)/i)
    expect(skill).not.toMatch(/host\.(?:view_image|reasoning_model)/)
    expect(skill).not.toMatch(/output_schema|wait=False|derive_outline\(|fc_sdk\(/)
    expect(skill).not.toMatch(/cannot yet be registered as the composition Run's provenance inputs/)
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

  it('drives claim data through scoped panel revision, composition, and Run provenance', async () => {
    const cleanups: AsyncCleanup[] = []
    const executors = new Set<NotebookKernelExecutor>()
    let smokeRoot: string | undefined
    try {
      smokeRoot = await mkdtemp(join(resolve('.'), '.figure-composer-smoke-'))
      const ownedRoot = smokeRoot
      cleanups.push(() => rm(ownedRoot, { recursive: true, force: true }))
      cleanups.push(async () => {
        const results = await Promise.allSettled(
          [...executors].map((executor) => executor.shutdown())
        )
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason)
        if (failures.length > 0)
          throw new AggregateError(failures, 'Python executor cleanup failed')
      })

      const claim = 'Treatment increases the primary response and replicates independently.'
      const projectId = 'figure-project'
      const repository = new NotebookRunRepository(ownedRoot)
      const client = createProjectDbClient(ownedRoot)
      cleanups.push(() => client.$disconnect())
      await migrateApplicationDatabase(client)
      const sessions = new Map<string, PersistedChatSession>()
      const session = (sessionId: string): PersistedChatSession => {
        const existing = sessions.get(sessionId)
        if (existing) return existing
        const graph = createLinearConversationGraph({
          sessionId,
          messages: [
            {
              id: 'claim-message',
              role: 'user',
              content: claim,
              status: 'complete',
              eventIds: [],
              createdAt: 1,
              updatedAt: 1
            },
            {
              id: 'artifact-message',
              role: 'agent',
              content: 'Published the requested scientific figure artifact.',
              status: 'complete',
              eventIds: [],
              createdAt: 2,
              updatedAt: 2
            }
          ],
          frameworkId: 'codex',
          model: 'gpt-5',
          createdAt: 1,
          updatedAt: 2
        })
        const created: PersistedChatSession = {
          id: sessionId,
          projectId,
          title: 'Figure composer E2E',
          cwd: ownedRoot,
          status: 'idle',
          messages: graph.messages.map(projectConversationMessage),
          conversationGraph: graph,
          createdAt: 1,
          updatedAt: 2
        }
        sessions.set(sessionId, created)
        return created
      }
      const context = (
        sessionId: string
      ): {
        rootFrameId: string
        agentFrameId: string
        messageBranchId: string
        runtimeSegmentId: string
        promptMessageId: string
      } => {
        const graph = session(sessionId).conversationGraph!
        return {
          rootFrameId: graph.rootFrameId,
          agentFrameId: graph.activeFrameId,
          messageBranchId: graph.branches[0]!.id,
          runtimeSegmentId: graph.runtimeSegments[0]!.id,
          promptMessageId: 'claim-message'
        }
      }
      const compatibilityReader = new ArtifactRepository(ownedRoot)
      const artifactWriter = new ArtifactRepository(ownedRoot)
      const inputAuthority = new ImmutableInputAuthority({
        storageRoot: ownedRoot,
        getClient: () => Promise.resolve(client)
      })
      const artifacts = new ArtifactProvenanceRepository({
        storageRoot: ownedRoot,
        getClient: () => Promise.resolve(client),
        compatibilityRepository: compatibilityReader,
        notebookRepository: repository,
        inputAuthority,
        loadSession: async (_projectId, sessionId) => sessions.get(sessionId)
      })
      const skills = await new SkillRegistry(resolve('resources/skills')).list()
      const helperPackages = ['figure-style', 'figure-composer'].map((skillId) => {
        const skill = skills.find((candidate) => candidate.id === skillId)
        if (!skill?.helpers?.length) throw new Error(`Missing registered helper Skill: ${skillId}`)
        return {
          skillId,
          origin: 'builtin' as const,
          packageRoot: skill.sourceDir,
          helpers: [...skill.helpers]
        }
      })
      const helperCatalog = new RegisteredSkillHelperCatalog({
        storageRoot: ownedRoot,
        packages: async () => helperPackages
      })
      const registeredStyle = await helperCatalog.resolve('figure-style')
      const registeredComposer = await helperCatalog.resolve('figure-composer')
      expect(registeredStyle).toMatchObject({
        skillId: 'figure-style',
        origin: 'builtin',
        generation: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
      })
      expect(registeredComposer).toMatchObject({
        skillId: 'figure-composer',
        origin: 'builtin',
        generation: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
      })
      const service = new NotebookRuntimeService({
        configRoot: ownedRoot,
        dataRoot: ownedRoot,
        projectId,
        repository,
        helperModuleCatalog: helperCatalog,
        executorFactory: () => {
          const executor = new NotebookKernelExecutor({
            pythonLoopPath: resolve('resources/notebook/python_loop.py'),
            platform: process.platform
          })
          executors.add(executor)
          return {
            execute: (request) =>
              executor.execute({
                ...request,
                resolvedInterpreter: { command: python3 as string }
              }),
            shutdown: () => executor.shutdown(),
            restart: () => executor.restart()
          }
        }
      })
      const inputRegistry = new NotebookInputRegistry({ inputAuthority })
      const server = new NotebookLocalRpcServer(service, {
        transport: 'tcp',
        token: 'figure-composer-token',
        inputRegistry
      })
      cleanups.push(() => server.close())
      const execute = async (input: {
        sessionId: string
        code: string
        helperModules: string[]
        artifactVersionInputs: string[]
      }): Promise<Awaited<ReturnType<NotebookRuntimeService['execute']>>> => {
        server.setArtifactProvenanceContext(input.sessionId, context(input.sessionId))
        await server.registerNotebookTurnInputs({
          projectId: 'figure-project',
          appSessionId: input.sessionId,
          promptMessageId: 'claim-message',
          uploads: [],
          references: []
        })
        const connection = await server.ensureStarted()
        const response = await fetch(connection.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            method: 'execute',
            params: {
              projectId,
              sessionId: input.sessionId,
              workspaceCwd: ownedRoot,
              language: 'python',
              helperModules: input.helperModules,
              artifactVersionInputs: input.artifactVersionInputs,
              code: input.code
            }
          })
        })
        const payload = (await response.json()) as {
          result?: Awaited<ReturnType<NotebookRuntimeService['execute']>>
          error?: unknown
        }
        expect(response.status, JSON.stringify(payload.error)).toBe(200)
        expect(payload.result).toBeDefined()
        expect(payload.result!.status, payload.result!.text.traceback).toBe('completed')
        return payload.result!
      }
      const finalizeVersion = async (
        appSessionId: string,
        artifactRunId: string,
        version: ArtifactVersionFile
      ): Promise<ArtifactVersionFile> => {
        const [finalized] = await artifacts.finalizeRun({
          projectId,
          appSessionId,
          artifactRunId,
          artifactVersionIds: [version.versionId],
          ...context(appSessionId),
          messageId: 'artifact-message'
        })
        if (!finalized) throw new Error(`Artifact Version did not finalize: ${version.versionId}`)
        return finalized
      }
      const publishNotebookFile = async (input: {
        appSessionId: string
        producerRunId: string
        sourcePath: string
        filename: string
        artifactRunId: string
      }): Promise<ArtifactVersionFile> => {
        const writeOperationId = `write-${input.artifactRunId}`
        const reservationRequest = {
          projectId,
          appSessionId: input.appSessionId,
          artifactStorageSessionId: input.appSessionId,
          artifactRunId: input.artifactRunId,
          writeOperationId,
          filename: input.filename
        }
        const version = await artifactWriter.withPendingFileTransaction(
          {
            projectId,
            sessionId: input.appSessionId,
            runId: input.artifactRunId,
            filename: input.filename,
            mimeType: 'image/png',
            source: { kind: 'localPath', path: input.sourcePath }
          },
          {
            allowedImportRoots: [ownedRoot],
            reserveFile: (fileBytes) =>
              artifacts.reserveWrite({ ...reservationRequest, fileBytes }),
            releaseFileReservation: (reservationId) =>
              artifacts.releaseWriteReservation({
                projectId,
                appSessionId: input.appSessionId,
                artifactStorageSessionId: input.appSessionId,
                artifactRunId: input.artifactRunId,
                reservationId
              })
          },
          async (_pending, sourceFileObservation, _bind, fileDigest, reservation) => {
            if (!sourceFileObservation || !reservation) {
              throw new Error('Production Artifact publication evidence was not captured.')
            }
            const writeRequestChecksum = createHash('sha256')
              .update(
                JSON.stringify({
                  contentChecksum: fileDigest.checksum,
                  contentType: 'image/png',
                  filename: input.filename,
                  producerRunId: input.producerRunId,
                  sourceKind: 'localPath',
                  sourceFileObservation
                })
              )
              .digest('hex')
            return artifacts.createVersion({
              ...reservationRequest,
              writeRequestChecksum,
              ...context(input.appSessionId),
              agentName: 'Codex',
              notebookSessionId: input.appSessionId,
              producerRunId: input.producerRunId,
              sourceKind: 'localPath',
              sourceFileObservation,
              contentType: 'image/png',
              resourceReservationId: reservation.id,
              resourceSizeBytes: fileDigest.sizeBytes,
              resourceChecksum: fileDigest.checksum
            })
          }
        )
        return finalizeVersion(input.appSessionId, input.artifactRunId, version)
      }
      const claimSessionId = 'claim-fixture'
      const sourceValues = { A: [8, 12], B: [1, 3], C: [2, 4] } as const
      const testData = Object.fromEntries(
        await Promise.all(
          Object.entries(sourceValues).map(async ([letter, values]) => {
            const artifactRunId = `claim-data-${letter.toLowerCase()}`
            const version = await artifacts.writeAppGeneratedVersion({
              projectId,
              appSessionId: claimSessionId,
              artifactStorageSessionId: claimSessionId,
              artifactRunId,
              ...context(claimSessionId),
              agentName: 'Codex',
              filename: `${letter}.json`,
              content: JSON.stringify({ claim, values }),
              contentType: 'application/json'
            })
            return [
              letter,
              {
                values: [...values],
                version: await finalizeVersion(claimSessionId, artifactRunId, version)
              }
            ]
          })
        )
      ) as Record<'A' | 'B' | 'C', { values: number[]; version: ArtifactVersionFile }>
      const outline = {
        claim,
        width_mm: 50.8,
        ncol: 2,
        row_heights_mm: [25.4, 25.4],
        panels: [
          {
            letter: 'A',
            role: 'schematic',
            message: 'Design',
            chart_family: 'diagram',
            row: 0,
            col: 0,
            colspan: 2,
            ask: 'design'
          },
          {
            letter: 'B',
            role: 'primary',
            message: 'Primary response increases',
            chart_family: 'bars',
            data_vid: testData.B.version.versionId,
            row: 1,
            col: 0,
            colspan: 1,
            ask: 'effect'
          },
          {
            letter: 'C',
            role: 'supporting',
            message: 'Independent replication agrees',
            chart_family: 'points',
            data_vid: testData.C.version.versionId,
            row: 1,
            col: 1,
            colspan: 1,
            ask: 'replication'
          }
        ]
      }
      type PanelLetter = 'A' | 'B' | 'C'
      const panelVersions: Record<PanelLetter, string> = { A: '', B: '', C: '' }
      const workerRuns: Array<{
        letter: PanelLetter
        round: number
        runId: string
        versionId: string
        inputs: string[]
      }> = []
      const publishPanel = async (letter: PanelLetter, round: number): Promise<void> => {
        const sessionId = `panel-worker-${letter}-r${round}`
        const filename = `panel_${letter}.png`
        const dimensions = letter === 'A' ? [200, 100] : [95, 100]
        const colors: Record<PanelLetter, string> = {
          A: '#eb4646',
          B: round === 1 ? '#46b45a' : '#46a050',
          C: '#4664dc'
        }
        const inputs = [
          testData[letter].version.versionId,
          ...(round > 1 ? [panelVersions[letter]] : [])
        ]
        const result = await execute({
          sessionId,
          helperModules: ['figure-style'],
          artifactVersionInputs: inputs,
          code: [
            'import json',
            'import os',
            'import matplotlib.pyplot as plt',
            'from PIL import Image',
            'apply_figure_style()',
            `claim = ${JSON.stringify(claim)}`,
            `values = ${JSON.stringify(testData[letter].values)}`,
            `fig, ax = plt.subplots(figsize=(${dimensions[0] / 100}, ${dimensions[1] / 100}), dpi=100)`,
            `ax.set_facecolor(${JSON.stringify(colors[letter])})`,
            `fig.patch.set_facecolor(${JSON.stringify(colors[letter])})`,
            'ax.plot(range(len(values)), values, color="white", linewidth=1.5)',
            'ax.set_title(claim, fontsize=5)',
            'ax.set_axis_off()',
            `output_path = os.path.abspath(${JSON.stringify(filename)})`,
            'fig.savefig(output_path, dpi=100, facecolor=fig.get_facecolor())',
            'plt.close(fig)',
            'with Image.open(output_path) as rendered:',
            `    rendered.resize((${dimensions[0]}, ${dimensions[1]})).save(output_path)`,
            `print(json.dumps({"letter": ${JSON.stringify(letter)}, "path": output_path, "size": ${JSON.stringify(dimensions)}, "claim": claim}))`
          ].join('\n')
        })
        const output = JSON.parse(result.text.stdout.trim()) as {
          letter: PanelLetter
          path: string
          size: number[]
          claim: string
        }
        expect(output).toMatchObject({
          letter,
          size: dimensions,
          claim
        })
        expect(await sharp(output.path).metadata()).toMatchObject({
          format: 'png',
          width: dimensions[0],
          height: dimensions[1]
        })
        const version = await publishNotebookFile({
          appSessionId: sessionId,
          producerRunId: result.runId,
          sourcePath: output.path,
          filename,
          artifactRunId: `artifact-panel-${letter.toLowerCase()}-r${round}`
        })
        panelVersions[letter] = version.versionId
        workerRuns.push({
          letter,
          round,
          runId: result.runId,
          versionId: version.versionId,
          inputs
        })
      }
      await Promise.all((['A', 'B', 'C'] as PanelLetter[]).map((letter) => publishPanel(letter, 1)))
      const initialPanelIds = (['A', 'B', 'C'] as PanelLetter[]).map(
        (letter) => panelVersions[letter]
      )
      const compose = async (
        round: number,
        outputName: string
      ): Promise<{
        round: number
        result: Awaited<ReturnType<NotebookRuntimeService['execute']>>
        panelIds: string[]
        outputPath: string
        version: ArtifactVersionFile
      }> => {
        const panelIds = (['A', 'B', 'C'] as PanelLetter[]).map((letter) => panelVersions[letter])
        const paths = Object.fromEntries(
          await Promise.all(
            (['A', 'B', 'C'] as PanelLetter[]).map(async (letter) => {
              const resolved = await artifacts.resolveVersionContent({
                projectId,
                versionId: panelVersions[letter]
              })
              return [letter, resolved.path]
            })
          )
        )
        const producer = [
          'import json',
          'import os',
          `outline = ${JSON.stringify(outline)}`,
          `paths = ${JSON.stringify(paths)}`,
          'review = {"outline_revisions": [], "violations": [{"severity":"MAJOR","panel_letter":"B","rule_ref":"§2","location":"B title","finding":"Cryptic","fix":"Use a claim"}]}',
          'regen = sorted(apply_outline_revisions(outline, review["outline_revisions"]) | set(group_fixes_by_panel(review)))',
          `output_path = os.path.abspath(${JSON.stringify(outputName)})`,
          'path, size = compose_figure(outline, paths, output_path, dpi=100, gutter_mm=2.54)',
          'print(json.dumps({"path": path, "size": size, "regen": regen, "crops": compose_crops(outline, dpi=100, gutter_mm=2.54)}))'
        ].join('\n')
        const result = await execute({
          sessionId: 'composer-session',
          helperModules: ['figure-composer'],
          artifactVersionInputs: panelIds,
          code: producer
        })
        const output = JSON.parse(result.text.stdout.trim()) as { path: string }
        const version = await publishNotebookFile({
          appSessionId: 'composer-session',
          producerRunId: result.runId,
          sourcePath: output.path,
          filename: outputName,
          artifactRunId: `artifact-composite-r${round}`
        })
        return { round, result, panelIds, outputPath: output.path, version }
      }
      const initialCompose = await compose(1, 'figure-initial.png')
      const review = JSON.parse(initialCompose.result.text.stdout.trim()) as {
        regen: PanelLetter[]
      }
      expect(review.regen).toEqual(['B'])
      const initialA = panelVersions.A
      const priorB = panelVersions.B
      const initialC = panelVersions.C
      await publishPanel('B', 2)
      const finalCompose = await compose(2, 'figure.png')
      const result = finalCompose.result
      expect(JSON.parse(result.text.stdout.trim())).toEqual({
        path: finalCompose.outputPath,
        size: [200, 210],
        regen: ['B'],
        crops: { A: [0, 0, 200, 104], B: [0, 106, 99, 210], C: [101, 106, 200, 210] }
      })
      expect(workerRuns.map(({ letter, round }) => `panel-${letter}-r${round}`).sort()).toEqual([
        'panel-A-r1',
        'panel-B-r1',
        'panel-B-r2',
        'panel-C-r1'
      ])
      expect(panelVersions.A).toBe(initialA)
      expect(panelVersions.B).not.toBe(priorB)
      expect(panelVersions.C).toBe(initialC)
      expect(initialPanelIds).toEqual([initialA, priorB, initialC])
      expect(finalCompose.panelIds).toEqual([initialA, panelVersions.B, initialC])
      expect(panelVersions.A).toBe(initialA)
      expect(panelVersions.C).toBe(initialC)
      expect(workerRuns.at(-1)?.inputs).toEqual([testData.B.version.versionId, priorB])
      expect(result.inputFiles?.map(({ inputFileVersionId }) => inputFileVersionId)).toEqual(
        finalCompose.panelIds
      )
      expect(await sharp(finalCompose.outputPath).metadata()).toMatchObject({
        format: 'png',
        width: 200,
        height: 210
      })
      const { data: pixels, info } = await sharp(finalCompose.outputPath)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const pixel = (x: number, y: number): number[] => {
        const start = (y * info.width + x) * info.channels
        return [...pixels.subarray(start, start + 3)]
      }
      expect(pixel(150, 50)).toEqual([235, 70, 70])
      expect(pixel(50, 160)).toEqual([70, 160, 80])
      expect(pixel(150, 160)).toEqual([70, 100, 220])

      expect(finalCompose.version).toMatchObject({
        versionId: expect.any(String),
        producerRunId: result.runId,
        name: 'figure.png'
      })
      for (const worker of workerRuns) {
        const [persistedWorker] = await repository.readSessionRuns(
          projectId,
          `panel-worker-${worker.letter}-r${worker.round}`
        )
        expect(persistedWorker).toMatchObject({
          runId: worker.runId,
          inputFiles: worker.inputs.map((inputFileVersionId) =>
            expect.objectContaining({ inputFileVersionId, sourceKind: 'artifact-version' })
          ),
          helperModules: [
            expect.objectContaining({
              helperId: 'figure-style',
              skillIdentity: 'figure-style',
              packageOrigin: 'builtin',
              registeredGeneration: registeredStyle!.generation,
              sourceDigest: registeredStyle!.digest.slice('sha256:'.length),
              source: registeredStyle!.source
            })
          ]
        })
        const artifactRow = await client.artifactVersion.findUniqueOrThrow({
          where: { id: worker.versionId }
        })
        expect(artifactRow).toMatchObject({ state: 'finalized', producerRunId: worker.runId })
      }
      const persisted = await repository.readSessionRuns(projectId, 'composer-session')
      expect(persisted).toHaveLength(2)
      expect(persisted[0]).toMatchObject({
        runId: initialCompose.result.runId,
        inputFiles: initialCompose.panelIds.map((inputFileVersionId) =>
          expect.objectContaining({ inputFileVersionId, sourceKind: 'artifact-version' })
        ),
        helperModules: [
          expect.objectContaining({
            helperId: 'figure-composer',
            registeredGeneration: registeredComposer!.generation,
            sourceDigest: registeredComposer!.digest.slice('sha256:'.length),
            source: registeredComposer!.source
          })
        ]
      })
      expect(persisted[1]).toMatchObject({
        runId: finalCompose.version.producerRunId,
        inputFiles: finalCompose.panelIds.map((inputFileVersionId) =>
          expect.objectContaining({ inputFileVersionId, sourceKind: 'artifact-version' })
        ),
        helperModules: [
          expect.objectContaining({
            helperId: 'figure-composer',
            skillIdentity: 'figure-composer',
            packageOrigin: 'builtin',
            registeredGeneration: registeredComposer!.generation,
            sourceDigest: registeredComposer!.digest.slice('sha256:'.length),
            source: registeredComposer!.source
          })
        ]
      })
      const finalExecution = await artifacts.getVersionExecution({
        projectId,
        appSessionId: 'composer-session',
        artifactId: finalCompose.version.artifactId,
        versionId: finalCompose.version.versionId
      })
      expect(finalExecution.execution).toMatchObject({
        producerRunId: result.runId,
        inputFiles: [...initialPanelIds, panelVersions.B].map((inputFileVersionId) =>
          expect.objectContaining({ inputFileVersionId, sourceKind: 'artifact-version' })
        ),
        helperEvidenceStatus: { state: 'complete' },
        helperModules: [
          expect.objectContaining({
            helperId: 'figure-composer',
            skillIdentity: 'figure-composer',
            packageOrigin: 'builtin',
            registeredGeneration: registeredComposer!.generation,
            sourceDigest: registeredComposer!.digest.slice('sha256:'.length),
            sourceAvailable: true
          })
        ]
      })

      const reconstruction = new ArtifactCodeReconstructionService({
        provenance: artifacts,
        runner: {
          captureTarget: async () => ({
            frameworkId: 'codex',
            providerId: 'acceptance-test',
            model: { kind: 'required', id: 'production-replay' },
            reasoningEffort: 'medium'
          }),
          run: async () => {
            throw new Error(
              'Complete helper provenance must not fall back to model reconstruction.'
            )
          }
        }
      })
      const reconstructed = await reconstruction.generate({
        projectId,
        appSessionId: 'composer-session',
        artifactId: finalCompose.version.artifactId,
        versionId: finalCompose.version.versionId
      })
      expect(reconstructed).toMatchObject({
        state: 'cached',
        value: { language: 'python' }
      })
      if (reconstructed.state !== 'cached') throw new Error('Artifact Code was not reconstructed.')
      expect(reconstructed.value.code).toContain('Supporting helper source: figure-composer')
      expect(reconstructed.value.code).toContain(`Producer cell: ${result.runId}`)
      const replayInputPaths = await Promise.all(
        finalCompose.panelIds.map(async (versionId) =>
          artifacts.resolveVersionContent({ projectId, versionId })
        )
      )
      for (const input of replayInputPaths) {
        expect(reconstructed.value.code).toContain(JSON.stringify(input.path))
      }

      const replayRoot = await mkdtemp(join(resolve('.'), '.figure-composer-replay-'))
      cleanups.push(() => rm(replayRoot, { recursive: true, force: true }))
      execFileSync(python3 as string, ['-c', reconstructed.value.code], {
        cwd: replayRoot,
        env: { ...process.env, MPLBACKEND: 'Agg' },
        timeout: 30_000
      })
      const replayPath = join(replayRoot, 'figure.png')
      const [originalImage, replayedImage] = await Promise.all(
        [finalCompose.outputPath, replayPath].map((path) =>
          sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true })
        )
      )
      expect(replayedImage.info).toMatchObject({
        width: originalImage.info.width,
        height: originalImage.info.height,
        channels: originalImage.info.channels
      })
      expect(createHash('sha256').update(replayedImage.data).digest('hex')).toBe(
        createHash('sha256').update(originalImage.data).digest('hex')
      )
    } finally {
      await settleCleanups(cleanups)
    }
  }, 60_000)
})

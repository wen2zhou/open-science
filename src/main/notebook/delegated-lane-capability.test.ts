import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchLocalRpc } from '../local-rpc-transport'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'

let storageRoot: string | undefined

const request = (
  connection: { endpoint: string; socketPath?: string; token: string },
  method: string,
  params: Record<string, unknown>
): Promise<Response> =>
  fetchLocalRpc(
    connection,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ method, params })
    },
    'Delegated Notebook capability test'
  )

afterEach(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('delegated Notebook lane capability', () => {
  it('binds sibling tokens to isolated Frame lanes and actual Run provenance', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'delegated-notebook-'))
    const invocationCounts = new WeakMap<object, number>()
    const service = new NotebookRuntimeService({
      configRoot: storageRoot,
      dataRoot: storageRoot,
      projectName: 'project-1',
      repository: new NotebookRunRepository(storageRoot),
      executorFactory: () => {
        const executor = {
          async execute(input: { cwd: string }) {
            const count = (invocationCounts.get(executor) ?? 0) + 1
            invocationCounts.set(executor, count)
            return {
              status: 'completed' as const,
              stdout: `${count}\n`,
              stderr: '',
              traceback: '',
              cwdAfter: input.cwd,
              outputs: [],
              workingFiles: []
            }
          },
          shutdown: vi.fn(async () => ({ reaped: true }))
        }
        return executor
      }
    })
    const server = new NotebookLocalRpcServer(service)
    const childOne = await server.issueDelegatedNotebookConnection({
      projectId: 'project-1',
      sessionId: 'session-1',
      rootFrameId: 'root-frame-session-1',
      agentFrameId: 'frame-one',
      attemptId: 'attempt-one',
      messageBranchId: 'branch-one',
      runtimeSegmentId: 'runtime-one',
      promptMessageId: 'message-one',
      workspaceCwd: '/workspace/one',
      isAttemptWritable: () => true
    })
    const childTwo = await server.issueDelegatedNotebookConnection({
      projectId: 'project-1',
      sessionId: 'session-1',
      rootFrameId: 'root-frame-session-1',
      agentFrameId: 'frame-two',
      attemptId: 'attempt-two',
      messageBranchId: 'branch-two',
      runtimeSegmentId: 'runtime-two',
      promptMessageId: 'message-two',
      workspaceCwd: '/workspace/two',
      isAttemptWritable: () => true
    })
    expect(childOne.token).not.toBe(childTwo.token)

    try {
      const [one, two] = await Promise.all([
        request(childOne, 'execute', {
          sessionId: 'forged',
          projectName: 'forged',
          workspaceCwd: '/forged',
          code: 'producer = "one"'
        }),
        request(childTwo, 'execute', {
          sessionId: 'forged',
          projectName: 'forged',
          workspaceCwd: '/forged',
          code: 'producer = "two"'
        })
      ])
      expect(one.status).toBe(200)
      expect(two.status).toBe(200)
      const [onePayload, twoPayload] = (await Promise.all([one.json(), two.json()])) as Array<{
        result: { text: { stdout: string }; dataRoot: string }
      }>
      expect(onePayload).toMatchObject({ result: { text: { stdout: '1\n' } } })
      expect(twoPayload).toMatchObject({ result: { text: { stdout: '1\n' } } })
      expect(onePayload.result.dataRoot).toBe(
        join(storageRoot, 'notebooks', 'project-1', 'session-1', 'frames', 'frame-one', 'data')
      )
      expect(twoPayload.result.dataRoot).toBe(
        join(storageRoot, 'notebooks', 'project-1', 'session-1', 'frames', 'frame-two', 'data')
      )

      const runs = await new NotebookRunRepository(storageRoot).readSessionRuns(
        'project-1',
        'session-1'
      )
      expect(runs).toHaveLength(2)
      expect(
        runs.map(({ script, agentFrameId, runtimeSegmentId }) => ({
          script,
          agentFrameId,
          runtimeSegmentId
        }))
      ).toEqual(
        expect.arrayContaining([
          {
            script: 'producer = "one"',
            agentFrameId: 'frame-one',
            runtimeSegmentId: 'runtime-one'
          },
          {
            script: 'producer = "two"',
            agentFrameId: 'frame-two',
            runtimeSegmentId: 'runtime-two'
          }
        ])
      )
    } finally {
      await childOne.revoke()
      await childTwo.revoke()
      await server.close()
    }
  })

  it('fences stopped and superseded Attempts without revoking a sibling lane', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'delegated-notebook-fence-'))
    const service = new NotebookRuntimeService({
      configRoot: storageRoot,
      dataRoot: storageRoot,
      projectName: 'project-1',
      repository: new NotebookRunRepository(storageRoot),
      executorFactory: () => ({
        execute: async (input) => ({
          status: 'completed',
          stdout: 'ok\n',
          stderr: '',
          traceback: '',
          cwdAfter: input.cwd,
          outputs: [],
          workingFiles: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    const server = new NotebookLocalRpcServer(service)
    let firstWritable = true
    const first = await server.issueDelegatedNotebookConnection({
      projectId: 'project-1',
      sessionId: 'session-1',
      rootFrameId: 'root-frame-session-1',
      agentFrameId: 'frame-one',
      attemptId: 'attempt-one',
      messageBranchId: 'branch-one',
      runtimeSegmentId: 'runtime-one',
      promptMessageId: 'message-one',
      workspaceCwd: '/workspace/one',
      isAttemptWritable: () => firstWritable
    })
    const sibling = await server.issueDelegatedNotebookConnection({
      projectId: 'project-1',
      sessionId: 'session-1',
      rootFrameId: 'root-frame-session-1',
      agentFrameId: 'frame-two',
      attemptId: 'attempt-two',
      messageBranchId: 'branch-two',
      runtimeSegmentId: 'runtime-two',
      promptMessageId: 'message-two',
      workspaceCwd: '/workspace/two',
      isAttemptWritable: () => true
    })

    try {
      firstWritable = false
      const stopped = await request(first, 'execute', {
        sessionId: 'session-1',
        workspaceCwd: '/workspace/one',
        code: 'late = True'
      })
      expect(stopped.status).toBe(403)

      await first.revoke()
      const superseded = await request(first, 'execute', {
        sessionId: 'session-1',
        workspaceCwd: '/workspace/one',
        code: 'later = True'
      })
      expect(superseded.status).toBe(401)

      const restarted = await server.issueDelegatedNotebookConnection({
        projectId: 'project-1',
        sessionId: 'session-1',
        rootFrameId: 'root-frame-session-1',
        agentFrameId: 'frame-one',
        attemptId: 'attempt-one-restarted',
        messageBranchId: 'branch-one',
        runtimeSegmentId: 'runtime-one-restarted',
        promptMessageId: 'message-one-restarted',
        workspaceCwd: '/workspace/one',
        isAttemptWritable: () => true
      })
      const resumed = await request(restarted, 'execute', {
        sessionId: 'session-1',
        workspaceCwd: '/workspace/one',
        code: 'resumed = True'
      })
      expect(resumed.status).toBe(200)
      await expect(resumed.json()).resolves.toMatchObject({ result: { text: { stdout: 'ok\n' } } })
      await restarted.revoke()

      const unaffected = await request(sibling, 'execute', {
        sessionId: 'session-1',
        workspaceCwd: '/workspace/two',
        code: 'still_running = True'
      })
      expect(unaffected.status).toBe(200)
      const runs = await new NotebookRunRepository(storageRoot).readSessionRuns(
        'project-1',
        'session-1'
      )
      expect(runs.map((run) => [run.script, run.runtimeSegmentId])).toEqual(
        expect.arrayContaining([
          ['resumed = True', 'runtime-one-restarted'],
          ['still_running = True', 'runtime-two']
        ])
      )
    } finally {
      await sibling.revoke()
      await server.close()
    }
  })
})

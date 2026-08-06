import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { createProject } from './certification/helpers'
import { test } from './fixtures/electron-app'

const ROOT_PROMPT = 'Coordinate the release-gate delegates.'
const CHILD_COUNT = 24

const seedDelegatedWork = async (page: Page, projectId: string): Promise<void> => {
  await page.evaluate(
    async ({ childCount, projectId, rootPrompt }) => {
      const bridge = globalThis as unknown as {
        api: {
          sessions: {
            saveManifest: (request: {
              lastProjectId: string
              lastSessionId: string
            }) => Promise<void>
            saveSession: (session: Record<string, unknown>) => Promise<void>
          }
        }
      }
      const now = Date.now()
      const sessionId = 'subagent-release-gate-session'
      const rootFrameId = 'release-root'
      const rootBranchId = 'release-root-branch'
      const rootMessageId = 'release-root-message'
      const rootMessage = {
        id: rootMessageId,
        role: 'user',
        content: rootPrompt,
        status: 'complete',
        eventIds: [],
        agentFrameId: rootFrameId,
        introducedOnBranchId: rootBranchId,
        revisionRootMessageId: rootMessageId,
        createdAt: now,
        updatedAt: now
      }
      const graph = {
        schemaVersion: 1,
        rootFrameId,
        activeFrameId: rootFrameId,
        frames: [
          {
            id: rootFrameId,
            originBindingState: 'root',
            kind: 'root',
            status: 'completed',
            activeBranchId: rootBranchId,
            createdAt: now
          }
        ] as Array<Record<string, unknown>>,
        branches: [
          {
            id: rootBranchId,
            agentFrameId: rootFrameId,
            headMessageId: rootMessageId,
            createdAt: now,
            updatedAt: now
          }
        ] as Array<Record<string, unknown>>,
        messages: [rootMessage] as Array<Record<string, unknown>>,
        activities: [],
        activityGroups: [],
        runtimeSegments: [] as Array<Record<string, unknown>>
      }
      const statuses = ['running', 'completed', 'cancelled', 'error'] as const
      const records = Array.from({ length: childCount }, (_, index) => {
        const suffix = String(index + 1).padStart(2, '0')
        const frameId = `release-child-${suffix}`
        const branchId = `release-branch-${suffix}`
        const messageId = `release-message-${suffix}`
        const runtimeSegmentId = `release-runtime-${suffix}`
        const attemptId = `release-attempt-${suffix}`
        const status = statuses[index % statuses.length]
        const createdAt = now + index
        graph.frames.push({
          id: frameId,
          parentFrameId: rootFrameId,
          originMessageId: rootMessageId,
          originBindingState: 'validated',
          kind: 'delegate',
          delegateName: `Release Child ${suffix}`,
          ...(index === 1 ? { agentName: 'Literature Specialist' } : {}),
          status,
          activeBranchId: branchId,
          createdAt
        })
        graph.branches.push({
          id: branchId,
          agentFrameId: frameId,
          headMessageId: messageId,
          createdAt,
          updatedAt: createdAt
        })
        graph.messages.push({
          id: messageId,
          role: 'agent',
          content: `Durable transcript for Release Child ${suffix}`,
          status: 'complete',
          eventIds: [],
          agentFrameId: frameId,
          introducedOnBranchId: branchId,
          revisionRootMessageId: messageId,
          runtimeSegmentId,
          createdAt,
          updatedAt: createdAt
        })
        graph.runtimeSegments.push({
          id: runtimeSegmentId,
          agentFrameId: frameId,
          frameworkId: 'opencode',
          startedAt: createdAt,
          ...(status === 'running' ? {} : { completedAt: createdAt + 1 })
        })
        return {
          agentFrameId: frameId,
          attempts: [
            {
              id: attemptId,
              status,
              resolvedAgent:
                index === 1
                  ? {
                      kind: 'specialist',
                      profileId: 'literature',
                      revision: 1,
                      displayName: 'Literature Specialist'
                    }
                  : { kind: 'main' },
              runtimeSegmentIds: [runtimeSegmentId],
              startedAt: createdAt,
              ...(status === 'cancelled'
                ? { cancellationReason: 'Stopped by the Main Agent' }
                : {}),
              ...(status === 'error'
                ? { error: { code: 'fixture_failure', message: 'Deterministic child failure' } }
                : {})
            }
          ],
          pendingMessages: []
        }
      })
      const session = {
        id: sessionId,
        projectId,
        title: rootPrompt,
        cwd: '/tmp/subagent-release-gate',
        status: 'idle',
        agentFrameworkId: 'opencode',
        messages: [rootMessage],
        conversationGraph: graph,
        runtimeContext: {
          version: 1,
          revision: childCount,
          delegatedWork: { records }
        },
        createdAt: now,
        updatedAt: now + childCount
      }
      await bridge.api.sessions.saveSession(session)
      await bridge.api.sessions.saveManifest({
        lastProjectId: projectId,
        lastSessionId: sessionId
      })
    },
    { childCount: CHILD_COUNT, projectId, rootPrompt: ROOT_PROMPT }
  )
}

test('ships one durable, scalable, keyboard-operable Subagent release surface', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Subagent release gate')
  await seedDelegatedWork(page, projectId)

  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: ROOT_PROMPT })
    .click()

  const summary = page.getByRole('region', { name: 'Subagent summary' })
  await expect(summary).toHaveCount(1)
  const childRows = summary.getByRole('button')
  await expect(childRows).toHaveCount(CHILD_COUNT)
  await expect(childRows.first()).toHaveAccessibleName('Release Child 01, running')
  await expect(childRows.nth(1)).toHaveAccessibleName('Release Child 02, completed')
  await expect(childRows.nth(2)).toHaveAccessibleName('Release Child 03, cancelled')
  await expect(childRows.nth(3)).toHaveAccessibleName('Release Child 04, error')
  await expect(page.getByRole('button', { name: '6 subagents running' })).toHaveCount(1)

  await childRows.nth(19).focus()
  await page.keyboard.press('Enter')
  const preview = page.getByRole('region', { name: 'Subagents' })
  await expect(preview).toHaveCount(1)
  const selector = preview.getByRole('combobox', { name: 'Subagent Frame' })
  await expect(selector).toHaveValue('release-child-20')
  await expect(preview.getByText('Durable transcript for Release Child 20')).toBeVisible()
  await selector.selectOption('release-child-02')
  await expect(preview.getByText('Literature Specialist')).toBeVisible()
  await expect(preview.getByText('Durable transcript for Release Child 02')).toBeVisible()

  await preview.getByRole('button', { name: 'Close Subagents preview' }).click()
  await expect(childRows.nth(19)).toBeFocused()

  await page.setViewportSize({ width: 390, height: 844 })
  const mobilePreview = page.getByRole('region', { name: 'Subagents' })
  const reopenedOnResize = await mobilePreview
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false)
  if (!reopenedOnResize) {
    await page.getByRole('button', { name: '6 subagents running' }).click()
  }
  await expect(mobilePreview).toHaveCount(1)
  await page.getByRole('combobox', { name: 'Subagent Frame' }).selectOption('release-child-05')
  await expect(page.getByRole('combobox', { name: 'Subagent Frame' })).toHaveValue(
    'release-child-05'
  )
  await expect(page.getByText('Durable transcript for Release Child 05')).toBeVisible()

  await expect
    .poll(() =>
      page.evaluate(async (projectId) => {
        const bridge = globalThis as unknown as {
          api: {
            preview: {
              load: (request: { projectId: string }) => Promise<{
                subagents?: { selectedAgentFrameId?: string }
              } | null>
            }
          }
        }
        return (await bridge.api.preview.load({ projectId }))?.subagents?.selectedAgentFrameId
      }, projectId)
    )
    .toBe('release-child-05')

  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: ROOT_PROMPT })
    .click()
  await expect(
    page.getByRole('region', { name: 'Subagent summary' }).getByRole('button')
  ).toHaveCount(CHILD_COUNT)
  await page.getByRole('button', { name: '6 subagents running' }).click()
  await expect(page.getByRole('combobox', { name: 'Subagent Frame' })).toHaveValue(
    'release-child-05'
  )
})

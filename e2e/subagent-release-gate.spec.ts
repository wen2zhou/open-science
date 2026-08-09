import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { createProject, sendPrompt } from './certification/helpers'
import { test } from './fixtures/electron-app'

const ROOT_PROMPT = 'Coordinate the release-gate delegates.'
const CHILD_COUNT = 24
const TERMINAL_PROMPT = 'Run the production delegation terminal journey.'
const BOUNDED_COLLECT_PROMPT = 'Run the production bounded collect journey.'
const PERMISSION_PROMPT = 'Run the production delegated permission journey.'
const STOP_PROMPT = 'Run the production delegation Stop journey.'
const UNAVAILABLE_PROMPT = 'Verify unsupported delegation admission.'
const INHERITED_SPECIALIST_PROMPT = 'Run the production inherited Specialist delegation journey.'
const TERMINAL_CHILD = 'Complete the certified delegated terminal fixture.'
const PERMISSION_CHILD = 'Request the delegated fixture permission.'
const STOP_CHILD = 'Wait until the Main Agent stops delegated fixture A.'
const STOP_CHILD_TWO = 'Wait until the Main Agent stops delegated fixture B.'

const expectDurableChildStatus = async (
  page: Page,
  name: string,
  status: 'running' | 'completed' | 'cancelled' | 'error'
): Promise<void> => {
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ childName }) => {
          const loaded = await window.api.sessions.loadAll()
          for (const session of loaded.sessions) {
            const frame = session.conversationGraph?.frames.find(
              (candidate) => candidate.delegateName === childName
            )
            const record = session.runtimeContext?.delegatedWork?.records.find(
              (candidate) => candidate.agentFrameId === frame?.id
            )
            const current = record?.attempts.at(-1)
            if (current) return current.status
          }
          return undefined
        },
        { childName: name }
      )
    )
    .toBe(status)
}

const expectRenderedChildStatus = async (
  page: Page,
  name: string,
  status: 'running' | 'completed' | 'cancelled' | 'error',
  awaitingPermission = false
): Promise<void> => {
  const bar = page.getByTestId('subagents-bar')
  const trigger = bar.locator(':scope > button')
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
  await expect(
    bar
      .getByRole('button', {
        name: `${name}, ${status}${awaitingPermission ? ', waiting for permission' : ''}`
      })
      .first()
  ).toBeVisible()
}

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

test('projects real production-composed delegation, permission, and Stop lifecycle', async ({
  app
}) => {
  test.setTimeout(180_000)
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Production delegation release gate')

  await sendPrompt(
    page,
    TERMINAL_PROMPT,
    'Production delegation reached a terminal result.',
    120_000
  )
  await expect(page.getByRole('button', { name: TERMINAL_CHILD })).toBeVisible()
  await expectDurableChildStatus(page, TERMINAL_CHILD, 'completed')

  await sendPrompt(
    page,
    BOUNDED_COLLECT_PROMPT,
    'Production bounded collect journey completed.',
    120_000
  )
  await expectRenderedChildStatus(page, TERMINAL_CHILD, 'completed')

  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await composer.fill(PERMISSION_PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  const permissionCard = page.getByTestId('permission-card')
  await expect(permissionCard).toContainText('Read delegated evidence', {
    timeout: 120_000
  })
  await expect(page.getByRole('button', { name: PERMISSION_CHILD })).toBeVisible()
  await expectDurableChildStatus(page, PERMISSION_CHILD, 'running')
  await expectRenderedChildStatus(page, PERMISSION_CHILD, 'running', true)
  await page.getByRole('button', { name: /^Allow/ }).click()
  await expect(page.getByText('Production delegated permission journey completed.')).toBeVisible({
    timeout: 120_000
  })
  await expect(page.getByRole('button', { name: PERMISSION_CHILD })).toBeVisible()
  await expectDurableChildStatus(page, PERMISSION_CHILD, 'completed')
  await expectRenderedChildStatus(page, PERMISSION_CHILD, 'completed')

  await composer.fill(STOP_PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Production delegation is running.')).toBeVisible({
    timeout: 120_000
  })
  await expect(page.getByRole('button', { name: STOP_CHILD })).toBeVisible()
  await expect(page.getByRole('button', { name: STOP_CHILD_TWO })).toBeVisible()
  await expectDurableChildStatus(page, STOP_CHILD, 'running')
  await expectDurableChildStatus(page, STOP_CHILD_TWO, 'running')
  await expectRenderedChildStatus(page, STOP_CHILD, 'running')
  await expectRenderedChildStatus(page, STOP_CHILD_TWO, 'running')
  await page.getByRole('button', { name: 'Cancel run' }).click()
  await expect(page.getByRole('button', { name: STOP_CHILD })).toBeVisible({
    timeout: 120_000
  })
  await expectDurableChildStatus(page, STOP_CHILD, 'cancelled')
  await expectRenderedChildStatus(page, STOP_CHILD, 'cancelled')
  await expect(page.getByRole('button', { name: STOP_CHILD_TWO })).toBeVisible({
    timeout: 120_000
  })
  await expectDurableChildStatus(page, STOP_CHILD_TWO, 'cancelled')
  await expectRenderedChildStatus(page, STOP_CHILD_TWO, 'cancelled')
})

test('rejects an unsupported Specialist configuration before child admission', async ({ app }) => {
  test.setTimeout(120_000)
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Unsupported delegation release gate')
  await sendPrompt(
    page,
    UNAVAILABLE_PROMPT,
    'Subagents are unavailable for this session configuration.',
    120_000
  )
  const unavailableNotice = page
    .getByRole('status')
    .filter({ hasText: 'Subagents unavailable for this configuration' })
  await expect(unavailableNotice).toBeVisible()
  await expect(unavailableNotice.getByRole('button', { name: 'Open Settings' })).toBeVisible()
  const admittedChildren = await page.evaluate(async () => {
    const loaded = await window.api.sessions.loadAll()
    const session = loaded.sessions[0]
    return {
      records: session?.runtimeContext?.delegatedWork?.records.length ?? 0,
      frames:
        session?.conversationGraph?.frames.filter((frame) => frame.kind === 'delegate').length ?? 0
    }
  })
  expect(admittedChildren).toEqual({ records: 0, frames: 0 })
})

test('inherits a real root Specialist when profile is omitted and preserves its label after restart', async ({
  app
}) => {
  test.setTimeout(180_000)
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Inherited Specialist release gate')
  const specialist = await page.evaluate(async () =>
    window.api.specialist.create({
      name: 'RELEASE_SPECIALIST',
      displayName: 'Release Specialist',
      description: 'Production-composed S4 identity fixture.',
      systemPrompt: 'Preserve the release Specialist identity.'
    })
  )

  await page.getByRole('button', { name: /Agent controls:/ }).click()
  await page.getByTestId('specialist-submenu-trigger').hover()
  await page.getByTestId(`specialist-option-${specialist.id}`).click()
  await sendPrompt(
    page,
    INHERITED_SPECIALIST_PROMPT,
    'Production inherited Specialist delegation completed.',
    120_000
  )
  await expectDurableChildStatus(page, TERMINAL_CHILD, 'completed')
  const inheritedChildTrigger = page.getByRole('button', { name: TERMINAL_CHILD })
  await inheritedChildTrigger.click()
  const inheritedPreview = page.getByRole('region', { name: 'Subagents' })
  await expect(inheritedPreview).toContainText('Release Specialist')
  await inheritedPreview.getByRole('button', { name: 'Close Subagents preview' }).click()
  await expect(inheritedChildTrigger).toBeFocused()

  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: INHERITED_SPECIALIST_PROMPT })
    .click()
  await page.getByRole('button', { name: TERMINAL_CHILD }).click()
  await expect(page.getByRole('region', { name: 'Subagents' })).toContainText('Release Specialist')
})

test('ships one durable, scalable, keyboard-operable persisted Subagent surface', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Subagent release gate')
  await seedDelegatedWork(page, projectId)

  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: ROOT_PROMPT })
    .click()

  const summaryTrigger = page.getByRole('button', { name: '24 subagents, 6 running' })
  await summaryTrigger.click()
  const childRows = page.getByRole('button', { name: /^Release Child \d{2},/ })
  await expect(childRows).toHaveCount(CHILD_COUNT)
  await expect(childRows.first()).toHaveAccessibleName('Release Child 01, running')
  await expect(childRows.nth(1)).toHaveAccessibleName('Release Child 02, completed')
  await expect(childRows.nth(2)).toHaveAccessibleName('Release Child 03, cancelled')
  await expect(childRows.nth(3)).toHaveAccessibleName('Release Child 04, error')
  await expect(summaryTrigger).toHaveCount(1)

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

  await page.setViewportSize({ width: 390, height: 844 })
  const mobilePreview = page.getByRole('region', { name: 'Subagents' })
  const reopenedOnResize = await mobilePreview
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false)
  if (!reopenedOnResize) {
    await summaryTrigger.click()
    await page.getByRole('button', { name: 'Release Child 05, running' }).click()
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
  await page.getByRole('button', { name: '24 subagents, 6 running' }).click()
  await expect(page.getByRole('button', { name: /^Release Child \d{2},/ })).toHaveCount(CHILD_COUNT)
  await page.getByRole('button', { name: 'Release Child 05, running' }).click()
  await expect(page.getByRole('combobox', { name: 'Subagent Frame' })).toHaveValue(
    'release-child-05'
  )
})

import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Durable Plan project'
const USER_MESSAGE = 'Create the deterministic durable Plan.'
const RETRY_USER_MESSAGE = 'Create the deterministic durable Plan with one interruption.'
const PLAN_TASK = 'Verify durable Plan approval and continuation'
const REVISED_PLAN_TASK = 'Verify the revised durable Plan'
const GENERATION_ENDED = 'Durable Plan generation attempt ended.'
const STEP_COMPLETED = 'Durable Plan step completed after approval.'
const WAITING_SESSION_NAME = `Session status: Waiting for plan approval ${USER_MESSAGE}`

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

const sendPlanFirst = async (page: Page, message = USER_MESSAGE): Promise<void> => {
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(message)
  await page.getByRole('button', { name: 'More send options' }).click()
  await page.getByTestId('menu-plan-first').click()
}

test('approves a Plan after more than five minutes and continues its turn', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  await sendPlanFirst(page)

  const conversation = page.getByRole('region', { name: 'Conversation' })
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(conversation.getByText(GENERATION_ENDED, { exact: true })).toBeVisible()

  const approvalTray = page.locator('article').filter({ hasText: PLAN_TASK })
  await expect(approvalTray.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  await expect(approvalTray.getByRole('button', { name: 'Dismiss', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toHaveCount(0)
  await expect(conversation.getByText(STEP_COMPLETED, { exact: true })).toHaveCount(0)
  await expect(
    page
      .getByRole('navigation', { name: 'Sessions' })
      .getByRole('button', { name: WAITING_SESSION_NAME, exact: true })
  ).toContainText('Waiting for plan approval')

  await app.advanceMainClockBy(301_000)
  await expect(approvalTray.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  await expect(conversation.getByText(STEP_COMPLETED, { exact: true })).toHaveCount(0)
  await approvalTray.getByRole('button', { name: 'Approve', exact: true }).click()

  await expect(conversation.locator('p').filter({ hasText: STEP_COMPLETED })).toContainText(
    STEP_COMPLETED
  )
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeVisible()
})

test('replaces a Plan from feedback in the same turn and executes only after approval', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)
  await sendPlanFirst(page)

  const originalTray = page.locator('article').filter({ hasText: PLAN_TASK })
  await expect(originalTray.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  await originalTray.getByRole('textbox', { name: 'Respond to Plan' }).fill('Split by cohort.')
  await originalTray.getByRole('button', { name: 'Send', exact: true }).click()

  const revisedTray = page.locator('article').filter({ hasText: REVISED_PLAN_TASK })
  await expect(revisedTray.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  await expect(page.getByText('Split by cohort.', { exact: true })).toHaveCount(1)
  await expect(page.getByText(STEP_COMPLETED, { exact: true })).toHaveCount(0)

  await revisedTray.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.locator('p').filter({ hasText: STEP_COMPLETED })).toContainText(STEP_COMPLETED)
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeVisible()
})

test('restores the original pending Plan when replacement generation fails', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)
  await sendPlanFirst(page)

  let tray = page.locator('article').filter({ hasText: PLAN_TASK })
  await expect(tray.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  await tray.getByRole('textbox', { name: 'Respond to Plan' }).fill('fail replacement')
  await tray.getByRole('button', { name: 'Send', exact: true }).click()

  await expect(page.getByText(/Deterministic replacement failure/u)).toBeVisible()
  tray = page.locator('article').filter({ hasText: PLAN_TASK })
  await expect(tray.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  await expect(page.getByText('fail replacement', { exact: true })).toHaveCount(1)
  await expect(page.getByText(STEP_COMPLETED, { exact: true })).toHaveCount(0)
})

test('restores and dismisses a long-waiting Plan without starting a continuation', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)
  await sendPlanFirst(page)

  let tray = page.locator('article').filter({ hasText: PLAN_TASK })
  await expect(tray.getByRole('button', { name: 'Dismiss', exact: true })).toBeEnabled()

  await app.advanceMainClockBy(301_000)
  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: new RegExp(USER_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .click()
  tray = page.locator('article').filter({ hasText: PLAN_TASK })
  await expect(tray.getByRole('button', { name: 'Dismiss', exact: true })).toBeEnabled()
  await tray.getByRole('button', { name: 'Dismiss', exact: true }).click()

  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0)
  await expect(page.getByText(STEP_COMPLETED, { exact: true })).toHaveCount(0)
  await expect(
    page.getByRole('navigation', { name: 'Sessions' }).getByRole('button', {
      name: new RegExp(
        `^Session status: Idle ${USER_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
      )
    })
  ).toBeVisible()
})

test('keeps approval after an interrupted continuation and completes on Retry', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)
  await sendPlanFirst(page, RETRY_USER_MESSAGE)

  const tray = page.locator('article').filter({ hasText: PLAN_TASK })
  await expect(tray.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  await tray.getByRole('button', { name: 'Approve', exact: true }).click()

  await expect(tray.getByText('Needs attention', { exact: true })).toBeVisible()
  await expect(tray.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
  await expect(page.getByText(STEP_COMPLETED, { exact: true })).toHaveCount(0)
  await tray.getByRole('button', { name: 'Retry', exact: true }).click()

  await expect(page.locator('p').filter({ hasText: STEP_COMPLETED })).toContainText(STEP_COMPLETED)
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeVisible()
})

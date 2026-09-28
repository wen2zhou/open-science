import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { openProjectSession } from './certification/helpers'

// Keep profiler attribution separate from timing runs. Renderer frame markers remain enabled.
test.use({ windowMode: 'hidden' })
test.skip(process.env.OPEN_SCIENCE_INTERACTION_PROFILE !== '1', 'Opt-in performance capture')
const cpuProfile = process.env.OPEN_SCIENCE_PERF_CPU_PROFILE === '1'
const fixtureTime = Date.UTC(2026, 8, 23, 0, 0, 0)
const draft = 'Synthetic draft only; no request is sent.'

for (const sessionCount of [20, 100, 500]) {
  test(`profiles workspace interaction with ${sessionCount} sessions`, async ({
    app
  }, testInfo) => {
    test.setTimeout(240_000)
    const page = await app.completeOnboarding()
    await app.showMainWindowInactive()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const cwd = await app.createTestDirectory('interaction-profile')
    const sessions = Array.from({ length: sessionCount }, (_, index) => ({
      id: `interaction-${index}`,
      title: `Interaction session ${index}`,
      status: 'idle' as const,
      createdAt: fixtureTime + index * 1000,
      updatedAt: fixtureTime + index * 1000,
      messages: [
        {
          id: `interaction-message-${index}`,
          role: 'user' as const,
          content: `Synthetic research question ${index}.`,
          status: 'complete' as const,
          eventIds: [],
          createdAt: fixtureTime + index * 1000,
          updatedAt: fixtureTime + index * 1000
        }
      ]
    }))
    const fixtureSha256 = createHash('sha256').update(JSON.stringify(sessions)).digest('hex')
    await page.evaluate(
      async ({ cwd, sessions }) => {
        const project = await window.api.projects.create({
          name: 'Interaction profile',
          description: ''
        })
        for (const session of sessions)
          await window.api.sessions.saveSession({ ...session, cwd, projectId: project.id })
        const stored = (await window.api.sessions.loadAll()).sessions.filter(
          (s) => s.projectId === project.id
        )
        if (
          stored.length !== sessions.length ||
          sessions.some(
            (expected) => !stored.some((s) => s.id === expected.id && s.title === expected.title)
          )
        ) {
          throw new Error('Seeded fixture does not match expected session IDs/titles.')
        }
      },
      { cwd, sessions }
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await app.showMainWindowInactive()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await app.setMainWindowSize(1280, 900)
    await app.setMainWindowZoomFactor(1)
    const cdp = await page.context().newCDPSession(page)
    if (cpuProfile) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.start')
    }
    const summary: Record<string, unknown> = {
      sessionCount,
      fixtureSha256,
      fixtureTime,
      cpuProfile,
      // UUIDs and temp paths vary by isolated profile; the logical fixture is byte-identical.
      fixtureIdentity:
        'SHA256 of ordered session IDs, titles, timestamps and messages; generated project UUID and cwd excluded',
      windowPresentation: await page.evaluate(() => ({
        documentFocused: document.hasFocus(),
        visibility: document.visibilityState,
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio
      })),
      phases: [],
      completed: false
    }
    await page.evaluate(() => {
      type Probe = {
        phase: string
        longTasks: { phase: string; duration: number }[]
        inputFrames: number[]
        switchFrames: number[]
        observer: PerformanceObserver
      }
      const probe: Probe = {
        phase: 'open',
        longTasks: [],
        inputFrames: [],
        switchFrames: [],
        observer: null as unknown as PerformanceObserver
      }
      probe.observer = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries())
          probe.longTasks.push({ phase: probe.phase, duration: entry.duration })
      })
      probe.observer.observe({ type: 'longtask' })
      document.addEventListener(
        'input',
        (event) => {
          if (
            probe.phase !== 'typing' ||
            !(event.target instanceof HTMLElement) ||
            event.target.getAttribute('aria-label') !== 'Ask anything'
          )
            return
          const started = performance.now()
          requestAnimationFrame(() => probe.inputFrames.push(performance.now() - started))
        },
        true
      )
      document.addEventListener(
        'click',
        (event) => {
          if (probe.phase !== 'switch') return
          if (!(event.target instanceof Element)) return
          const button = event.target.closest('button[data-slot="session-open-button"]')
          const index = button?.textContent?.match(/Interaction session (\d+)/u)?.[1]
          if (!index) return
          const started = performance.now()
          const expected = `Synthetic research question ${index}.`
          const check = (): void => {
            const conversation = document.querySelector('[aria-label="Conversation"]')
            if (conversation?.textContent?.includes(expected)) {
              probe.switchFrames.push(performance.now() - started)
            } else if (performance.now() - started < 10000) requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        },
        true
      )
      Object.assign(window, { __interactionProfile: probe })
    })
    const setPhase = async (phase: string): Promise<void> =>
      page.evaluate((phase) => {
        const probe = (
          window as unknown as {
            __interactionProfile: {
              phase: string
              inputFrames: number[]
              switchFrames: number[]
              observer: PerformanceObserver
              longTasks: { phase: string; duration: number }[]
            }
          }
        ).__interactionProfile
        for (const entry of probe.observer.takeRecords())
          probe.longTasks.push({ phase: probe.phase, duration: entry.duration })
        if (phase === 'typing') probe.inputFrames = []
        if (phase === 'switch') probe.switchFrames = []
        probe.phase = phase
      }, phase)
    try {
      const openedAt = performance.now()
      await openProjectSession(
        page,
        'Interaction profile',
        `Interaction session ${sessionCount - 1}`
      )
      summary.openMs = performance.now() - openedAt
      await setPhase('switch')
      const switchMs: number[] = []
      for (let index = sessionCount - 2; index >= sessionCount - 7; index--) {
        const startedAt = performance.now()
        await page
          .getByRole('navigation', { name: 'Sessions' })
          .locator('button[data-slot="session-open-button"]')
          .filter({ hasText: new RegExp(`Interaction session ${index}$`) })
          .click()
        await expect(
          page.getByText(`Synthetic research question ${index}.`, { exact: true })
        ).toBeVisible()
        switchMs.push(performance.now() - startedAt)
        await page.waitForFunction(
          (count) =>
            (window as unknown as { __interactionProfile: { switchFrames: number[] } })
              .__interactionProfile.switchFrames.length === count,
          switchMs.length,
          { timeout: 10_000, polling: 'raf' }
        )
      }
      summary.switchMs = switchMs
      const input = page.getByRole('textbox', { name: 'Ask anything' })
      await input.fill('')
      await setPhase('typing')
      const typedAt = performance.now()
      await input.pressSequentially(draft)
      summary.typingWallMs = performance.now() - typedAt
      await expect(input).toHaveText(draft)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      const counts = await page.evaluate(() => {
        const probe = (
          window as unknown as {
            __interactionProfile: { inputFrames: number[]; switchFrames: number[] }
          }
        ).__interactionProfile
        return { input: probe.inputFrames.length, switch: probe.switchFrames.length }
      })
      expect(counts).toEqual({ input: draft.length, switch: 6 })
      summary.completed = true
    } finally {
      const renderer = await page.evaluate(() => {
        const probe = (
          window as unknown as {
            __interactionProfile: {
              phase: string
              longTasks: { phase: string; duration: number }[]
              inputFrames: number[]
              switchFrames: number[]
              observer: PerformanceObserver
            }
          }
        ).__interactionProfile
        for (const entry of probe.observer.takeRecords())
          probe.longTasks.push({ phase: probe.phase, duration: entry.duration })
        probe.observer.disconnect()
        return {
          longTasks: probe.longTasks,
          inputToFrameMs: probe.inputFrames,
          clickToContentFrameMs: probe.switchFrames,
          sessionButtons: document.querySelectorAll('button[data-slot="session-open-button"]')
            .length,
          domElements: document.getElementsByTagName('*').length
        }
      })
      Object.assign(summary, renderer, {
        measurement:
          'Wall times include automation. Input-to-frame is renderer input capture to next RAF (paint opportunity, not OS input latency). Click-to-content-frame checks matching conversation text at RAF. No CPU profiler unless explicitly requested.'
      })
      const summaryPath = testInfo.outputPath('interaction-summary.json')
      await writeFile(summaryPath, JSON.stringify(summary, null, 2))
      await testInfo.attach('interaction-summary', {
        path: summaryPath,
        contentType: 'application/json'
      })
      if (cpuProfile) {
        const { profile } = await cdp.send('Profiler.stop')
        const path = testInfo.outputPath('renderer.cpuprofile')
        await writeFile(path, JSON.stringify(profile))
        await testInfo.attach('renderer-cpu', { path, contentType: 'application/json' })
      }
      await cdp.detach()
    }
  })
}

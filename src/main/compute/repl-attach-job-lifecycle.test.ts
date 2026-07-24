import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Issue 04 (design.md §6): the agent-facing repl kernel must expose per-job cancel()/cleanup() on the
// attach_job handle, wired to the cancel_job / cleanup_job computeCall ops. This guards the JS REPL API
// surface so a refactor of repl_loop.js cannot silently drop the lifecycle operations.
describe('agent repl — attach_job().cancel()/.cleanup() (design.md §6)', () => {
  const replLoop = readFileSync(
    join(__dirname, '../../../resources/notebook/repl_loop.js'),
    'utf-8'
  )

  it('exposes cancel() on the attach_job handle wired to the cancel_job op', () => {
    expect(replLoop).toMatch(/async cancel\s*\(\s*\)/)
    expect(replLoop).toMatch(/op:\s*['"]cancel_job['"]/)
  })

  it('exposes cleanup() on the attach_job handle wired to the cleanup_job op', () => {
    expect(replLoop).toMatch(/async cleanup\s*\(\s*\)/)
    expect(replLoop).toMatch(/op:\s*['"]cleanup_job['"]/)
  })
})

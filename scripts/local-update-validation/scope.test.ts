import { expect, it } from 'vitest'
import { SCENARIOS, startUpdateServer } from './server.mjs'
import { main } from './index.mjs'

it('keeps the local update runner within its upgrade and failure scenarios', () => {
  expect(SCENARIOS).toEqual([
    'upgrade',
    'boundary',
    'handoff-failure',
    'same-version',
    'lower-version',
    'download-cancel',
    'network-failure',
    'checksum-failure',
    'corrupt-artifact',
    'active-task',
    'shutdown-failure'
  ])
})

it('rejects manual-install/cache scenarios and staging commands before preparing any resources', async () => {
  await expect(startUpdateServer({ scenario: 'manual-local' })).rejects.toThrow('Unknown scenario')
  await expect(startUpdateServer({ scenario: 'cache-delete-reveal' })).rejects.toThrow(
    'Unknown scenario'
  )
  await expect(main(['stage'])).rejects.toThrow('Unknown command: stage')
  await expect(main(['observe-finder'])).rejects.toThrow('Unknown command: observe-finder')
})

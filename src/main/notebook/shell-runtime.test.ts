import { describe, expect, it } from 'vitest'

import {
  captureShellRuntimeBinding,
  defaultShellRuntimeBinding,
  shellRuntimeDialect,
  shellRuntimeSandboxTarget
} from './shell-runtime'

describe('shell runtime binding', () => {
  it.each([
    ['win32', { kind: 'powershell', version: '5.1' }],
    ['linux', { kind: 'native-posix', shell: '/bin/sh' }],
    ['darwin', { kind: 'native-posix', shell: '/bin/sh' }]
  ] as const)('keeps the existing %s default', (platform, expected) => {
    expect(defaultShellRuntimeBinding(platform)).toEqual(expected)
  })

  it('captures an immutable WSL binding and derives every execution facet from it', () => {
    const selected = {
      kind: 'wsl2-bash' as const,
      profileId: 'profile-1',
      distro: 'Ubuntu-22.04',
      user: 'researcher'
    }
    const binding = captureShellRuntimeBinding(selected)

    selected.user = 'changed-after-capture'

    expect(binding).toEqual({
      kind: 'wsl2-bash',
      profileId: 'profile-1',
      distro: 'Ubuntu-22.04',
      user: 'researcher'
    })
    expect(Object.isFrozen(binding)).toBe(true)
    expect(shellRuntimeDialect(binding)).toBe('posix')
    expect(shellRuntimeSandboxTarget(binding)).toEqual({
      kind: 'wsl2',
      profileId: 'profile-1',
      distro: 'Ubuntu-22.04',
      user: 'researcher'
    })
  })
})

import { z } from 'zod'

import type { ShellRuntimeBinding } from '../../shared/notebook'
import type { NotebookSandboxTarget } from './process-sandbox'

export type ShellRuntimeDialect = 'powershell' | 'posix'

export const shellRuntimeBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('powershell'), version: z.literal('5.1') }).strict(),
  z.object({ kind: z.literal('native-posix'), shell: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('wsl2-bash'),
      profileId: z.string().min(1),
      distro: z.string().min(1),
      user: z.string().min(1)
    })
    .strict()
])

export const captureShellRuntimeBinding = (binding: ShellRuntimeBinding): ShellRuntimeBinding => {
  switch (binding.kind) {
    case 'powershell':
      return Object.freeze({ kind: 'powershell', version: binding.version })
    case 'native-posix':
      return Object.freeze({ kind: 'native-posix', shell: binding.shell })
    case 'wsl2-bash':
      return Object.freeze({
        kind: 'wsl2-bash',
        profileId: binding.profileId,
        distro: binding.distro,
        user: binding.user
      })
  }
}

export const defaultShellRuntimeBinding = (
  platform: NodeJS.Platform = process.platform
): ShellRuntimeBinding =>
  platform === 'win32'
    ? Object.freeze({ kind: 'powershell', version: '5.1' })
    : Object.freeze({ kind: 'native-posix', shell: '/bin/sh' })

export const shellRuntimeDialect = (binding: ShellRuntimeBinding): ShellRuntimeDialect =>
  binding.kind === 'powershell' ? 'powershell' : 'posix'

export const shellRuntimeSandboxTarget = (binding: ShellRuntimeBinding): NotebookSandboxTarget =>
  binding.kind === 'wsl2-bash'
    ? Object.freeze({
        kind: 'wsl2',
        profileId: binding.profileId,
        distro: binding.distro,
        user: binding.user
      })
    : Object.freeze({ kind: 'native' })

export const shellRuntimePlatform = (
  binding: ShellRuntimeBinding,
  hostPlatform: NodeJS.Platform = process.platform
): NodeJS.Platform => {
  switch (binding.kind) {
    case 'powershell':
      return 'win32'
    case 'native-posix':
      return hostPlatform
    case 'wsl2-bash':
      return 'linux'
  }
}

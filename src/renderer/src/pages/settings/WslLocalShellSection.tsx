import { CheckCircle2, CircleMinus, CircleX, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { WslReadiness, WslSetupSnapshot } from '../../../../shared/wsl-setup'
import { SettingsField, SettingsSection } from './SettingsLayout'

const statusCopy = (snapshot: WslSetupSnapshot, t: (key: string) => string): string => {
  switch (snapshot.state) {
    case 'checking':
      return t('Checking WSL2 readiness…')
    case 'not-installed':
      return t('WSL2 is not installed. Install it in Windows, then check again.')
    case 'restart-required':
      return t('Windows must restart before WSL2 setup can continue.')
    case 'distro-required':
      return t('Install or select a WSL2 distribution to continue.')
    case 'first-launch-required':
      return t('Open the distribution once and finish creating its Linux user.')
    case 'dependency-required':
      return t('The selected distribution needs the missing Linux dependencies shown below.')
    case 'ready':
      return t('This profile is ready for sandboxed WSL2 Bash.')
    case 'failed':
      return t('This profile is not ready. Use the code below to identify the next action.')
  }
}

const recoveryCopy = (
  errorCode: string | undefined,
  t: (key: string) => string
): string | undefined => {
  switch (errorCode) {
    case 'wsl1_unsupported':
      return t('Convert the distribution to WSL2 in Windows, then check again.')
    case 'wsl_root_user':
    case 'wsl_user_mismatch':
    case 'wsl_user_not_found':
      return t('Choose an exact non-root Linux user, then save and check again.')
    case 'wsl_workspace_path_unsupported':
    case 'wsl_workspace_unreachable':
    case 'wsl_workspace_not_local':
    case 'wsl_workspace_not_ntfs':
    case 'wsl_workspace_volume_unavailable':
      return t('Move the Open Science data folder to a local NTFS drive, then check again.')
    default:
      return undefined
  }
}

export const WslLocalShellSection = (): React.JSX.Element => {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<WslSetupSnapshot>({
    state: 'checking',
    distros: [],
    operationReference: '--------'
  })
  const [distro, setDistro] = useState('')
  const [user, setUser] = useState('')
  const [busy, setBusy] = useState(true)
  const checks: ReadonlyArray<[keyof WslReadiness, string]> = [
    ['wsl2', t('WSL2 distribution')],
    ['bash', t('Bash')],
    ['bwrap', t('bubblewrap')],
    ['namespaces', t('Linux namespaces')],
    ['localWorkspace', t('Local Windows workspace')]
  ]

  const apply = useCallback((next: WslSetupSnapshot): void => {
    setSnapshot(next)
    setDistro(next.selection?.distro ?? next.distros.find((item) => item.version === 2)?.name ?? '')
    setUser(next.selection?.user ?? '')
  }, [])

  const probe = useCallback(
    async (isActive: () => boolean = () => true): Promise<void> => {
      if (isActive()) {
        setBusy(true)
        setSnapshot((current) => ({ ...current, state: 'checking' }))
      }
      try {
        const next = await window.api.settings.probeWslSetup()
        if (isActive()) apply(next)
      } catch {
        if (isActive()) {
          setSnapshot({
            state: 'failed',
            distros: [],
            errorCode: 'wsl_probe_failed',
            operationReference: '--------'
          })
        }
      } finally {
        if (isActive()) setBusy(false)
      }
    },
    [apply]
  )

  useEffect(() => {
    let active = true
    queueMicrotask(() => void probe(() => active))
    return () => {
      active = false
    }
  }, [probe])

  const saveAndCheck = async (): Promise<void> => {
    setBusy(true)
    try {
      apply(await window.api.settings.selectWslProfile({ distro, user }))
    } catch {
      setSnapshot((current) => ({ ...current, state: 'failed', errorCode: 'wsl_probe_failed' }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      separated
      title={t('Local Shell')}
      description={t(
        'Choose the exact WSL2 distribution and non-root Linux user Open Science should verify. Selection alone never enables WSL2 Bash.'
      )}
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void probe()}
          disabled={busy}
        >
          <RefreshCw className={busy ? 'animate-spin' : ''} aria-hidden="true" />
          {t('Check again')}
        </Button>
      }
    >
      <div className="rounded-lg border border-border bg-card p-4" data-testid="wsl-local-shell">
        {snapshot.state === 'failed' && !busy ? (
          <div className="flex justify-center">
            <ErrorNotice
              icon={CircleX}
              tone="red"
              title={statusCopy(snapshot, t)}
              description={recoveryCopy(snapshot.errorCode, t)}
              errorCode={
                snapshot.errorCode
                  ? `${snapshot.errorCode} · ${snapshot.operationReference}`
                  : undefined
              }
              primaryButton={{ label: t('Check again'), onClick: () => void probe() }}
            />
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm font-medium">
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : snapshot.state === 'ready' ? (
              <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
            ) : (
              <CircleX className="size-4 text-destructive" aria-hidden="true" />
            )}
            <span role="status">{statusCopy(snapshot, t)}</span>
          </div>
        )}

        {snapshot.distros.length > 0 ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <SettingsField label={t('WSL2 distribution')}>
              <Select value={distro} onValueChange={setDistro} disabled={busy}>
                <SelectTrigger aria-label={t('WSL2 distribution')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {snapshot.distros.map((item) => (
                    <SelectItem key={item.name} value={item.name} disabled={item.version !== 2}>
                      {item.name} {item.version === 1 ? t('(WSL1 — unsupported)') : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsField>
            <SettingsField label={t('Linux user')}>
              <Input
                value={user}
                onChange={(event) => setUser(event.target.value)}
                placeholder={t('Exact non-root user')}
                disabled={busy}
              />
            </SettingsField>
            <div className="sm:col-span-2">
              <Button
                type="button"
                onClick={() => void saveAndCheck()}
                disabled={busy || !distro.trim() || !user.trim()}
              >
                {t('Save and check')}
              </Button>
            </div>
          </div>
        ) : null}

        {snapshot.readiness ? (
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2" aria-label={t('Readiness checks')}>
            {checks.map(([key, label]) => (
              <li key={key} className="flex items-center gap-2">
                {snapshot.readiness?.[key] === true ? (
                  <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
                ) : snapshot.readiness?.[key] === false ? (
                  <CircleX className="size-4 text-destructive" aria-hidden="true" />
                ) : (
                  <CircleMinus className="size-4 text-muted-foreground" aria-hidden="true" />
                )}
                {label}
                {snapshot.readiness?.[key] === undefined ? (
                  <span className="text-xs text-muted-foreground">{t('Not checked')}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {!busy && snapshot.state !== 'failed' && snapshot.errorCode ? (
          <p className="mt-4 font-mono text-xs text-muted-foreground">
            {snapshot.errorCode} · {snapshot.operationReference}
          </p>
        ) : null}
      </div>
    </SettingsSection>
  )
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import {
  assertDesktopRuntimeWrite,
  getDesktopRuntimeEpoch,
  useDesktopRuntimeRecoveryStore
} from '@/stores/desktop-runtime-recovery-store'
import type { ExecuteNotebookShellCommandRequest } from '../../../../shared/notebook'

type Props = {
  request: Omit<ExecuteNotebookShellCommandRequest, 'command' | 'timeoutMs'>
  disabled: boolean
  active: boolean
  onSubmitted?: () => void
  onChanged: () => Promise<unknown>
}

// Human Shell commands use the same managed execution, durable history and teardown as agent runs.
export function NotebookShellTerminal({
  request,
  disabled,
  active,
  onSubmitted,
  onChanged
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const phase = useDesktopRuntimeRecoveryStore((state) => state.phase)
  const [command, setCommand] = useState('')
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string>()
  const busy = running || active
  const submit = async (): Promise<void> => {
    if (!command.trim() || busy || disabled || phase !== 'connected') return
    const epoch = getDesktopRuntimeEpoch()
    const submitted = command
    setRunning(true)
    setError(undefined)
    try {
      assertDesktopRuntimeWrite(epoch)
      setCommand('')
      onSubmitted?.()
      await window.api.notebook.executeShell({ ...request, command: submitted, timeoutMs: 600_000 })
      if (getDesktopRuntimeEpoch() === epoch) await onChanged()
    } catch (cause) {
      if (getDesktopRuntimeEpoch() === epoch) {
        setCommand(submitted)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (getDesktopRuntimeEpoch() === epoch) setRunning(false)
    }
  }
  const stop = async (): Promise<void> => {
    if (stopping || phase !== 'connected') return
    const epoch = getDesktopRuntimeEpoch()
    setStopping(true)
    setError(undefined)
    try {
      assertDesktopRuntimeWrite(epoch)
      await window.api.notebook.shutdown(request)
      if (getDesktopRuntimeEpoch() === epoch) await onChanged()
    } catch (cause) {
      if (getDesktopRuntimeEpoch() === epoch)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (getDesktopRuntimeEpoch() === epoch) setStopping(false)
    }
  }
  return (
    <div
      className="shrink-0 space-y-2 border-t border-border-100 p-3"
      data-testid="notebook-shell-terminal"
    >
      {error ? <ErrorNotice inline description={error} /> : null}
      <textarea
        aria-label={t('Run command')}
        placeholder={t('Run command')}
        value={command}
        disabled={disabled || busy || phase !== 'connected'}
        onChange={(event) => setCommand(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
        }}
        className="w-full resize-y rounded border border-border-100 bg-bg-000 p-2 font-mono text-xs text-text-000"
      />
      <div className="flex justify-end gap-2">
        {busy ? (
          <button
            type="button"
            disabled={stopping || phase !== 'connected'}
            onClick={() => void stop()}
            className="rounded border border-border-200 px-3 py-1 text-xs"
          >
            {t('Stop Notebook')}
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || !command.trim() || phase !== 'connected'}
            onClick={() => void submit()}
            className="rounded border border-border-200 px-3 py-1 text-xs"
          >
            {t('Run command')}
          </button>
        )}
      </div>
    </div>
  )
}

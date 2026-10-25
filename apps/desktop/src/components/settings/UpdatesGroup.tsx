import { useEffect, useState } from 'react'
import type { Settings, UpdateStatus } from '@shared/types'
import { checkedAgo, updateLine, updatePercent } from '@shared/updates'
import { useSettings } from '../../stores/settings'
import { useUpdates } from '../../stores/updates'
import { Button } from '../../ui/Button'
import { Download, ExternalLink, RefreshCw } from '../../ui/icons'
import { Toggle } from '../../ui/Toggle'
import { SettingRow, SettingsGroup } from './Section'

/** "Tester build 291", or what this build is when it has no number. */
export function buildName(status: UpdateStatus | null): string {
  return status && status.build > 0 ? `Tester build ${status.build}` : 'This build'
}

/** A minute clock, so "checked 5 minutes ago" stays true while the page is open. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** What the updater says, and the buttons that go with it: in Settings > General and in About. */
export function UpdateActions({ status, compact }: { status: UpdateStatus; compact?: boolean }) {
  const { check, install, cancel, openPage } = useUpdates.getState()
  const busy = status.state === 'checking' || status.state === 'downloading' || status.state === 'installing'
  return (
    <div className="settings-actions">
      {status.state === 'ready' && !status.waiting && (
        <Button variant="primary" icon={<Download size={13} />} onClick={() => void install()}>
          Restart to update
        </Button>
      )}
      {status.state === 'ready' && status.waiting && (
        <Button variant="ghost" onClick={() => void cancel()}>
          Don’t wait
        </Button>
      )}
      {status.state === 'manual' && (
        <Button icon={<ExternalLink size={13} />} onClick={() => void openPage()}>
          Release page
        </Button>
      )}
      {status.state !== 'off' && !(compact && status.state === 'ready') && (
        <Button icon={<RefreshCw size={13} />} busy={status.state === 'checking'} disabled={busy} onClick={() => void check()}>
          Check now
        </Button>
      )}
    </div>
  )
}

/** Whether there is a download's bar or a new build's notes to show. */
export const hasUpdateDetail = (status: UpdateStatus): boolean => updatePercent(status) !== null || ('next' in status && status.next.notes.length > 0)

/** The download's bar and the new build's notes, under the status line. */
export function UpdateDetail({ status }: { status: UpdateStatus }) {
  const percent = updatePercent(status)
  const next = 'next' in status ? status.next : null
  return (
    <div className="update-detail">
      {percent !== null && (
        <div className="install-server-bar" role="progressbar" aria-label={`Downloading build ${next?.build}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      {next && next.notes.length > 0 && (
        <div className="update-notes">
          <div className="update-notes-title">What is new in build {next.build}</div>
          <ul>
            {next.notes.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Settings > General > Updates (ADR 0127). */
export function UpdatesGroup({ settings }: { settings: Settings }) {
  const save = useSettings((state) => state.save)
  const status = useUpdates((state) => state.status)
  const now = useMinute()
  if (!status) return null
  const off = status.state === 'off'
  const checked = status.checkedAt !== null && !off ? ` Looked ${checkedAgo(status.checkedAt, now)}.` : ''
  return (
    <SettingsGroup title="Updates">
      <SettingRow
        id="general.autoUpdate"
        htmlFor="auto-update"
        label="Look for updates by itself"
        help="When eNCode starts and every four hours, it looks on GitHub for a newer tester build and downloads it in the background. It checks the download’s fingerprint, and installs it only when you restart for it, never while an agent works."
      >
        <Toggle id="auto-update" checked={settings.autoUpdate} disabled={off} onChange={(autoUpdate) => void save({ autoUpdate })} />
      </SettingRow>
      <SettingRow
        id="general.update"
        label={buildName(status)}
        help={
          <span className="update-line" data-state={status.state}>
            {updateLine(status)}
            {checked}
          </span>
        }
        below={hasUpdateDetail(status) ? <UpdateDetail status={status} /> : undefined}
      >
        <UpdateActions status={status} />
      </SettingRow>
    </SettingsGroup>
  )
}

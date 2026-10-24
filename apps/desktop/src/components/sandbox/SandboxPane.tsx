import { useEffect, useState } from 'react'
import { api } from '../../api'
import { actionFor, canFix, fixConfirm, headline, limitLines, switchRows, workingLine, type SwitchKey } from '../../panels/sandbox'
import { shortPath } from '../../panels/permissions'
import { useSandbox } from '../../stores/sandbox'
import { useUi } from '../../stores/ui'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { RefreshCw, ShieldAlert, ShieldCheck, Wrench } from '../../ui/icons'
import { Toggle } from '../../ui/Toggle'

/**
 * Settings > Sandbox: the operating-system sandbox around the commands the agent runs. It says what is confined and
 * what is not on this computer, and holds the switches that are the person's alone. Every change is saved at once into
 * their own settings file and the screen shows the sandbox as it stands afterwards; there is no Save for this tab.
 */
export default function SandboxPane() {
  const report = useSandbox((state) => state.report)
  const error = useSandbox((state) => state.error)
  const loading = useSandbox((state) => state.loading)
  const refresh = useSandbox((state) => state.refresh)
  const act = useSandbox((state) => state.act)
  const notify = useUi((state) => state.notify)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    const stop = api.sandbox.onChanged(() => void refresh())
    return () => {
      window.removeEventListener('focus', onFocus)
      stop()
    }
  }, [refresh])

  if (!report) {
    return (
      <div className="settings-sandbox">
        <div className="info-note">
          {error ? `eNCode could not read the sandbox: ${error}` : 'Open a folder to see how its commands are confined. The sandbox applies to every command the agent runs, in any folder.'}
        </div>
        {error && (
          <div>
            <Button size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        )}
      </div>
    )
  }

  const top = headline(report)
  const working = workingLine(report)
  const run = async (kind: string, action: Parameters<typeof act>[0]) => {
    setBusy(kind)
    try {
      const outcome = await act(action)
      if (!outcome) notify('error', 'eNCode could not do that. Try again.')
      else if (!outcome.ok) notify('error', outcome.reason)
      else if (outcome.note) notify('info', outcome.note)
    } finally {
      setBusy(null)
    }
  }
  const limits = limitLines(report)
  const unmark = async (folders?: string[]) => {
    const one = folders?.length === 1 ? folders[0] : undefined
    const confirmed = await useUi.getState().askConfirm({
      title: one ? 'Take the marks off this folder?' : `Take the marks off ${report.marked.length} folders?`,
      body: `${one ? shortPath(one, 64) : 'They'} get${one ? 's' : ''} the permissions back that ${one ? 'it' : 'they'} had before the sandbox. A command running there now can no longer change files. This can take a while for a large folder.`,
      confirmLabel: 'Remove marks',
    })
    if (confirmed) await run(one ? `unmark:${one}` : 'unmark', { type: 'unmark', ...(folders ? { folders } : {}) })
  }
  const fix = async (folder: string) => {
    if (await useUi.getState().askConfirm(fixConfirm(shortPath(folder, 64)))) await run(`fix:${folder}`, { type: 'fix', folder })
  }

  return (
    <div className="settings-sandbox">
      <section className={cx('sandbox-state', `is-${top.tone}`)} aria-label="Sandbox state" aria-live="polite">
        <span className="sandbox-state-icon" aria-hidden="true">
          {top.tone === 'success' ? <ShieldCheck size={18} /> : <ShieldAlert size={18} />}
        </span>
        <div className="sandbox-state-text">
          <div className="sandbox-state-title">{top.title}</div>
          <div className="sandbox-state-detail">{top.detail}</div>
          {working && <div className="sandbox-state-working">{working}…</div>}
        </div>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} busy={loading || busy === 'recheck'} onClick={() => void run('recheck', { type: 'recheck' })}>
          Check again
        </Button>
      </section>

      {canFix(report) && (
        <section aria-label="Folders the sandbox cannot use">
          <div className="settings-card sandbox-blocked">
            {report.blocked.map((folder) => (
              <div key={folder} className="settings-row">
                <div className="settings-row-text">
                  <code className="sandbox-mark-path" title={folder}>
                    {shortPath(folder, 72)}
                  </code>
                  {busy === `fix:${folder}` && <div className="settings-row-help">Say yes to Windows’ prompt to go on. Marking a large folder can take a minute after that.</div>}
                </div>
                <div className="settings-row-control">
                  <Button size="sm" variant="primary" icon={<Wrench size={13} />} busy={busy === `fix:${folder}`} disabled={busy !== null} onClick={() => void fix(folder)}>
                    Fix this folder
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {limits.length > 0 && (
        <section className="perm-problems" aria-label="What the sandbox does not cover here">
          <div className="perm-problems-title">Not covered on this computer</div>
          <ul>
            {limits.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      {report.tightened.length > 0 && (
        <section className="info-note" aria-label="What this folder asks for">
          {report.tightened.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </section>
      )}

      {report.problems.length > 0 && (
        <section className="perm-problems" aria-label="Problems in the settings">
          <div className="perm-problems-title">Settings eNCode could not use</div>
          <ul>
            {report.problems.map((problem, index) => (
              <li key={`${index}-${problem}`}>{problem}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="settings-card sandbox-switches">
        {switchRows(report).map((row) => {
          const id = `sandbox-${row.key}`
          return (
            <div key={row.key} className="settings-row">
              <div className="settings-row-text">
                <label className="settings-row-label" htmlFor={id}>
                  {row.label}
                </label>
                <div className="settings-row-help">{row.help}</div>
                {row.locked && <div className="settings-row-help is-note">{row.locked}</div>}
              </div>
              <div className="settings-row-control">
                <Toggle
                  id={id}
                  checked={row.checked}
                  disabled={busy !== null || Boolean(row.locked)}
                  onChange={(checked) => void run(row.key, actionFor(row.key as SwitchKey, checked))}
                />
              </div>
            </div>
          )
        })}
      </div>

      {report.marked.length > 0 && (
        <section aria-label="Folders marked for the sandbox">
          <div className="section-title">Folders marked for the sandbox</div>
          <div className="settings-card sandbox-marks">
            {report.marked.map((folder) => (
              <div key={folder} className="settings-row">
                <div className="settings-row-text">
                  <code className="sandbox-mark-path" title={folder}>
                    {shortPath(folder, 72)}
                  </code>
                </div>
                <div className="settings-row-control">
                  <Button size="sm" variant="ghost" busy={busy === `unmark:${folder}`} disabled={busy !== null} onClick={() => void unmark([folder])}>
                    Remove marks
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="perm-add-help sandbox-marks-foot">
            <span>
              Windows marks these folders so that confined commands can change them and nothing else. Taking the marks off puts their permissions back as they were; one the agent works in again is marked again.
            </span>
            {report.marked.length > 1 && (
              <Button size="sm" variant="ghost" busy={busy === 'unmark'} disabled={busy !== null} onClick={() => void unmark()}>
                Remove all marks
              </Button>
            )}
          </div>
        </section>
      )}

      <div className="perm-add-help">
        Saved in <code title={report.file}>{shortPath(report.file, 56)}</code>. A project’s own settings can make the sandbox stricter, never looser. Folders besides
        the project’s that commands may write (<code>sandbox.allowWrite</code>), and paths to keep read-only (<code>sandbox.denyWrite</code>) or hidden
        (<code>sandbox.denyRead</code>), are set in that file too.
      </div>
    </div>
  )
}

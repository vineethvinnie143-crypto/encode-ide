import { useEffect, useMemo, useState } from 'react'
import type { AboutInfo } from '@shared/types'
import { aboutText, shortCommit } from '@shared/about'
import { api } from '../../api'
import { GROUPS } from '../../commands/commands'
import { commandRegistry, helpActions } from '../../commands/app'
import { useUi } from '../../stores/ui'
import { Button, IconButton } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Copy } from '../../ui/icons'
import { Kbd } from '../../ui/Kbd'
import { LogoMark, Wordmark } from '../../ui/Logo'

interface ShortcutRow {
  title: string
  keys: string[]
}

/** Every command that has a shortcut, by menu. */
function shortcutRows(): { group: string; rows: ShortcutRow[] }[] {
  return GROUPS.map((group) => {
    const rows: ShortcutRow[] = commandRegistry
      .all()
      .filter((command) => command.group === group && !command.hidden && (command.keys?.length || command.hint))
      .map((command) => ({ title: commandRegistry.titleOf(command.id), keys: command.keys ?? [command.hint as string] }))
    if (group === 'Session') rows.push({ title: 'Go to session 1 to 9', keys: ['Alt+1 … Alt+9'] })
    return { group, rows }
  }).filter((entry) => entry.rows.length)
}

/** Ctrl+/ : every shortcut, searchable by name or key. */
export function ShortcutsDialog() {
  const open = useUi((state) => state.shortcutsOpen)
  const close = () => useUi.getState().setShortcutsOpen(false)
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const groups = useMemo(() => (open ? shortcutRows() : []), [open])
  const needle = query.trim().toLowerCase()
  const shown = groups
    .map((entry) => ({
      group: entry.group,
      rows: entry.rows.filter((row) => !needle || row.title.toLowerCase().includes(needle) || row.keys.some((key) => key.toLowerCase().includes(needle))),
    }))
    .filter((entry) => entry.rows.length)

  return (
    <Dialog open={open} onClose={close} title="Keyboard shortcuts" width={560} className="shortcuts-dialog">
      <input
        className="text-input shortcuts-filter"
        data-autofocus
        type="search"
        placeholder="Search by name or key"
        aria-label="Search shortcuts"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="shortcuts-list">
        {shown.map((entry) => (
          <section key={entry.group}>
            <h3 className="shortcuts-group">{entry.group}</h3>
            {entry.rows.map((row) => (
              <div key={row.title} className="shortcuts-row">
                <span>{row.title}</span>
                <span className="shortcuts-keys">
                  {row.keys.slice(0, 2).map((key, index) => (
                    <span key={key} className="shortcuts-alt">
                      {index > 0 && <span className="shortcuts-or">or</span>}
                      <Kbd keys={key} />
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
        {!shown.length && <div className="shortcuts-empty">No shortcut matches “{query}”.</div>}
      </div>
    </Dialog>
  )
}

export function AboutDialog() {
  const open = useUi((state) => state.aboutOpen)
  const [info, setInfo] = useState<AboutInfo | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!open) return
    void api.app
      .about()
      .then(setInfo)
      .catch(() => undefined)
  }, [open])
  const close = () => useUi.getState().setAboutOpen(false)
  const notify = useUi.getState().notify

  const copy = () => {
    if (!info) return
    void navigator.clipboard.writeText(aboutText(info)).then(() => notify('success', 'Build information copied.'))
  }
  const saveDiagnostics = async () => {
    setSaving(true)
    await helpActions.saveDiagnostics()
    setSaving(false)
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="About eNCode"
      width={440}
      className="about-dialog"
      footer={
        <>
          <Button busy={saving} disabled={!info} onClick={() => void saveDiagnostics()}>
            Save diagnostics…
          </Button>
          <Button variant="primary" data-autofocus onClick={close}>
            Close
          </Button>
        </>
      }
    >
      <div className="about-body">
        <LogoMark size={64} title="eNCode" />
        <Wordmark className="about-name" />
        <div className="about-version">
          Version {info?.version ?? '…'}
          {info?.channel === 'tester' ? ' · Tester build' : ''}
        </div>
        {info && (
          <dl className="about-facts">
            <div>
              <dt>Build</dt>
              <dd>
                <span className="about-build">
                  <span className="about-mono">{info.commit ? `${shortCommit(info.commit)}${info.dirty ? ' + changes' : ''}` : 'no commit recorded'}</span>
                  {info.builtAt && <span>{new Date(info.builtAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>}
                </span>
                <IconButton label="Copy build information" size="sm" onClick={copy}>
                  <Copy size={13} />
                </IconButton>
              </dd>
            </div>
            <div>
              <dt>System</dt>
              <dd>
                {info.os} · {info.arch}
              </dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>
                Electron {info.electron} · Chromium {info.chrome.split('.')[0]}
              </dd>
            </div>
          </dl>
        )}
        <p>An AI-first desktop IDE with an autonomous coding agent. Bring your own model and keep your files.</p>
        <p className="about-note">
          Model calls go straight from this app to your provider, and nothing else leaves your computer. If something goes wrong, save diagnostics and send
          the file: it has no keys, no code and no conversations.
        </p>
      </div>
    </Dialog>
  )
}

/** Asks before something that cannot be undone, such as deleting a session. */
export function ConfirmDialog() {
  const confirm = useUi((state) => state.confirm)
  const resolve = (ok: boolean) => useUi.getState().resolveConfirm(ok)
  return (
    <Dialog
      open={confirm !== null}
      onClose={() => resolve(false)}
      title={confirm?.title ?? ''}
      width={440}
      footer={
        <>
          <Button data-autofocus={confirm?.danger ? true : undefined} onClick={() => resolve(false)}>
            Cancel
          </Button>
          <Button
            variant={confirm?.danger ? 'danger' : 'primary'}
            data-autofocus={confirm?.danger ? undefined : true}
            onClick={() => resolve(true)}
          >
            {confirm?.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <p className="confirm-body">{confirm?.body}</p>
    </Dialog>
  )
}

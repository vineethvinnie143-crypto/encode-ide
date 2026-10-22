import { useEffect, useState } from 'react'
import type { AboutInfo } from '@shared/types'
import { aboutText, shortCommit } from '@shared/about'
import { api } from '../../api'
import { helpActions } from '../../commands/app'
import { useUi } from '../../stores/ui'
import { Button, IconButton } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Copy } from '../../ui/icons'
import { LogoMark, Wordmark } from '../../ui/Logo'

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

import { useEffect, useState } from 'react'
import type { ServerInstallPlan } from '@shared/types'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { installName, installPercent, installTarget, sizeLabel } from '../../panels/code'
import { useCode } from '../../stores/code'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Spinner } from '../../ui/Spinner'

type Plan = ServerInstallPlan | { unavailable: string }

/**
 * Installing a language server with one click (ADR 0083): what eNCode will download and run, read before saying yes,
 * then its progress. Closing the dialog leaves the install running; a toast says how it ended.
 */
export function InstallServerDialog() {
  const id = useCode((state) => state.installFor)
  // The report, not the target: a selector that builds an object each time renders without end.
  const report = useCode((state) => state.report)
  const target = installTarget(report, id)
  const server = target?.item ?? null
  const [plan, setPlan] = useState<Plan | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)

  useEffect(() => {
    setPlan(null)
    setFailed(null)
    setAsked(false)
    if (!id) return
    let live = true
    void api.code
      .installPlan(id)
      .then((answer) => live && setPlan(answer))
      .catch((error: unknown) => live && setPlan({ unavailable: errorText(error) }))
    return () => {
      live = false
    }
  }, [id])

  const close = () => useCode.getState().closeInstall()
  const running = Boolean(server?.installing) || (asked && !failed)
  const install = async () => {
    if (!id) return
    setAsked(true)
    setFailed(null)
    const result = await useCode.getState().install(id)
    if (useCode.getState().installFor !== id) return
    if (result.ok) close()
    else setFailed(result.reason)
  }

  const title = plan && 'what' in plan ? plan.what : id ? installName(report, id) : 'Language server'
  const library = target?.kind === 'library'
  const percent = server ? installPercent(server) : null
  const progress = server?.installing

  return (
    <Dialog
      open={id !== null}
      onClose={close}
      title={`Install ${title}`}
      width={500}
      className="install-server-dialog"
      footer={
        running ? (
          <>
            <Button onClick={() => id && void api.code.cancelInstall(id)}>Stop</Button>
            <Button variant="primary" data-autofocus onClick={close}>
              Keep going in the background
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            {plan && 'steps' in plan && (
              <Button variant="primary" data-autofocus onClick={() => void install()}>
                {failed ? 'Try again' : 'Install'}
              </Button>
            )}
          </>
        )
      }
    >
      {!plan ? (
        <div className="install-server-loading">
          <Spinner size={14} />
          <span>Reading what it needs…</span>
        </div>
      ) : 'unavailable' in plan ? (
        <p className="install-server-unavailable">{plan.unavailable}</p>
      ) : (
        <div className="install-server-body">
          <p className="install-server-lead">
            {library
              ? `${target.server.label}'s server reads them: hovers show each one's parameters, what it gives back and its notes, completion lists them, and calls with the wrong arguments are marked. The agent sees the same.`
              : 'The editor marks errors as you type, completes code and goes to definitions with it, and the agent hears what its edits broke. It runs only in folders you trust.'}
          </p>
          <ol className="install-server-steps">
            {plan.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <dl className="install-server-facts">
            <div>
              <dt>Version</dt>
              <dd className="is-mono">{plan.version}</dd>
            </div>
            {plan.bytes !== undefined && plan.bytes > 0 && (
              <div>
                <dt>Download</dt>
                <dd>about {sizeLabel(plan.bytes)}</dd>
              </div>
            )}
            <div>
              <dt>Kept in</dt>
              <dd className="is-mono" title={plan.dir}>
                {plan.dir}
              </dd>
            </div>
          </dl>
          {running && (
            <div className="install-server-progress" role="status" aria-live="polite">
              <div
                className={percent === null ? 'install-server-bar is-unknown' : 'install-server-bar'}
                role="progressbar"
                aria-label={`Installing ${title}`}
                aria-valuemin={0}
                aria-valuemax={100}
                {...(percent === null ? {} : { 'aria-valuenow': percent })}
              >
                <span style={percent === null ? undefined : { width: `${percent}%` }} />
              </div>
              <span className="install-server-progress-text">
                {progress && progress.total > 0
                  ? `${sizeLabel(progress.done)} of ${sizeLabel(progress.total)}`
                  : progress && progress.done > 0
                    ? `${sizeLabel(progress.done)} so far`
                    : 'Starting…'}
              </span>
            </div>
          )}
          {failed && (
            <p className="install-server-failed" role="alert">
              {failed}
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}

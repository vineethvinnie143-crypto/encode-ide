import { useEffect, useState } from 'react'
import type { ServerInstallPlan } from '@shared/types'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { sizeLabel } from '../../panels/code'
import { useDebug } from '../../stores/debug'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Spinner } from '../../ui/Spinner'

type Plan = ServerInstallPlan | { unavailable: string }
type Progress = { done: number; total: number } | null

const POLL_MS = 400

/**
 * Installing the debugger a run needs (debugpy for Python, Delve for Go: ADR 0144), the way a language server is
 * installed (ADR 0083): why the run needs it and what eNCode will download and run, read before saying yes, then its
 * progress. Once it is in place, the run the person asked for starts.
 */
export function InstallDebuggerDialog() {
  const asked = useDebug((state) => state.installFor)
  const id = asked?.id ?? null
  const [plan, setPlan] = useState<Plan | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress>(null)

  useEffect(() => {
    setPlan(null)
    setFailed(null)
    setRunning(false)
    setProgress(null)
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

  // Progress is asked for while the install runs: debuggers are in no report of the language servers.
  useEffect(() => {
    if (!id || !running) return
    const timer = window.setInterval(() => {
      void api.debug
        .installState(id)
        .then((state) => setProgress(state && 'done' in state ? state : null))
        .catch(() => undefined)
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [id, running])

  const close = (installed = false) => useDebug.getState().closeInstall(installed)
  const install = async () => {
    if (!id) return
    setRunning(true)
    setFailed(null)
    const result = await api.code.install(id).catch((error: unknown) => ({ ok: false as const, reason: errorText(error) }))
    if (useDebug.getState().installFor?.id !== id) return
    setRunning(false)
    if (result.ok) close(true)
    else setFailed(result.reason)
  }

  const title = plan && 'what' in plan ? plan.what : 'the debugger'
  const percent = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null

  return (
    <Dialog
      open={id !== null}
      onClose={() => close()}
      title={`Install ${title}`}
      width={500}
      className="install-server-dialog"
      footer={
        running ? (
          <>
            <Button onClick={() => id && void api.code.cancelInstall(id)}>Stop</Button>
            <Button variant="primary" data-autofocus onClick={() => close()}>
              Keep going in the background
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => close()}>Cancel</Button>
            {plan && 'steps' in plan && (
              <Button variant="primary" data-autofocus onClick={() => void install()}>
                {failed ? 'Try again' : 'Install and debug'}
              </Button>
            )}
          </>
        )
      }
    >
      {asked && <p className="install-server-lead">{asked.reason}</p>}
      {!plan ? (
        <div className="install-server-loading">
          <Spinner size={14} />
          <span>Reading what it needs…</span>
        </div>
      ) : 'unavailable' in plan ? (
        <p className="install-server-unavailable">{plan.unavailable}</p>
      ) : (
        <div className="install-server-body">
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
                {progress && progress.total > 0 ? `${sizeLabel(progress.done)} of ${sizeLabel(progress.total)}` : progress && progress.done > 0 ? `${sizeLabel(progress.done)} so far` : 'Starting…'}
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

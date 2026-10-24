import { useId } from 'react'
import { useRemote } from '../../stores/remote'
import { Button } from '../../ui/Button'
import { Details } from '../../ui/Details'
import { Dialog } from '../../ui/Dialog'
import { AlertTriangle, Download, ShieldCheck } from '../../ui/icons'
import { Spinner } from '../../ui/Spinner'

/** What the connection is doing, in words, while the dialog waits on it. */
function stepText(status: string | undefined, machine: string): string {
  if (status === 'uploading') return `Sending eNCode to ${machine}. This happens once for each version.`
  if (status === 'starting') return `Starting eNCode on ${machine}…`
  return `Connecting to ${machine}…`
}

/**
 * Open a folder on another machine (ADR 0111): the machine as SSH knows it and a folder there. eNCode signs in with
 * the person's SSH key; the agent then works on that machine, and its model calls come back through this PC, so the
 * API keys never go there. A machine without Node.js gets eNCode's own copy only when the person says yes here.
 */
export function RemoteDialog() {
  const dialog = useRemote((state) => state.dialog)
  const hosts = useRemote((state) => state.hosts)
  const state = useRemote((state) => state.state)
  const listId = useId()
  const remote = useRemote.getState()
  const busy = dialog !== null && dialog.phase !== 'edit'
  // Why the last try did not open, in words main wrote for the person (ipc.ts, remote:open).
  const problem = dialog?.failure
  const machine = dialog?.host.trim() || 'the machine'
  const canConnect = Boolean(dialog && !busy && dialog.host.trim() && dialog.folder.trim())

  return (
    <Dialog
      open={dialog !== null}
      onClose={() => remote.hide()}
      title="Open a folder on another machine"
      description="eNCode connects over SSH with your SSH key. The agent works on that machine; your API keys stay on this PC."
      width={500}
      backdropCloses={!busy}
      footer={
        <>
          <Button onClick={() => remote.hide()}>{busy ? 'Close' : 'Cancel'}</Button>
          <Button variant="primary" disabled={!canConnect} onClick={() => void remote.connect()}>
            Connect
          </Button>
        </>
      }
    >
      {dialog && (
        <form
          className="form-stack remote-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (canConnect) void remote.connect()
          }}
        >
          <label className="form-field">
            <span className="form-label">Machine</span>
            <input
              className="text-input"
              data-autofocus
              list={listId}
              value={dialog.host}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              placeholder="user@host, or a name from ~/.ssh/config"
              aria-label="Machine"
              onChange={(event) => remote.edit({ host: event.target.value })}
            />
            <datalist id={listId}>
              {hosts.map((host) => (
                <option key={host} value={host} />
              ))}
            </datalist>
          </label>
          <label className="form-field">
            <span className="form-label">Folder on that machine</span>
            <input
              className="text-input mono"
              value={dialog.folder}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              placeholder="~/project or /srv/app"
              aria-label="Folder on that machine"
              onChange={(event) => remote.edit({ folder: event.target.value })}
            />
          </label>
          {/* Enter submits from either field. */}
          <button type="submit" hidden />

          {busy && (
            <div className="remote-step" role="status">
              <Spinner size={14} />
              <span>{dialog.phase === 'installing' ? `Installing Node.js on ${machine}. The download is about 30 MB.` : stepText(state?.status, machine)}</span>
            </div>
          )}

          {!busy && problem && (
            <div className="problem-card" role="alert">
              <div className="problem-head">
                <span className="problem-icon">
                  <AlertTriangle size={14} />
                </span>
                <span className="problem-text">{problem.message}</span>
              </div>
              {problem.install && (
                <div className="remote-install">
                  <p className="form-help">
                    <ShieldCheck size={13} className="remote-install-icon" /> eNCode can put the official Node.js {problem.install.version} in
                    ~/.encode-server on {machine}, checked against a checksum built into eNCode. Nothing else on the machine changes, and nothing
                    needs administrator rights.
                  </p>
                  <Button size="sm" variant="primary" icon={<Download size={13} />} onClick={() => void remote.install()}>
                    Install Node.js there
                  </Button>
                </div>
              )}
              {problem.detail && (
                <div className="problem-foot">
                  <Details text={problem.detail} />
                </div>
              )}
            </div>
          )}
        </form>
      )}
    </Dialog>
  )
}

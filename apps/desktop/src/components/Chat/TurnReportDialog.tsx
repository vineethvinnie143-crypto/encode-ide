import { useState } from 'react'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { useUi } from '../../stores/ui'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Toggle } from '../../ui/Toggle'

/** The request's first line, short enough for one row. */
function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || '(no text)'
}

function savedNote(file: string, redacted: number): string {
  const taken = redacted ? ` ${redacted === 1 ? 'One thing that looked like a key was' : `${redacted} things that looked like keys were`} taken out.` : ''
  return `Saved the report to ${file}.${taken} Send it with a word on what you expected.`
}

/**
 * Report a problem with a request (ADR 0092): the request as the agent worked it, each step and what the tools
 * answered, with the files it read as they were before, saved to a file the person sends. Replayed with
 * `pnpm turn-report`, it shows the same steps again and can be kept as a benchmark task.
 */
export default function TurnReportDialog() {
  const target = useUi((state) => state.turnReportFor)
  const [description, setDescription] = useState('')
  const [scramble, setScramble] = useState(true)
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  const close = () => {
    useUi.getState().setTurnReportFor(null)
    setDescription('')
    setScramble(true)
    setRefused(null)
  }

  const save = async () => {
    if (!target) return
    setSaving(true)
    setRefused(null)
    try {
      const answer = await api.app.saveTurnReport({ sessionId: target.sessionId, turn: target.turn, description, scramble })
      if ('saved' in answer) {
        close()
        useUi.getState().notify('success', savedNote(answer.saved, answer.redacted))
      } else if ('refused' in answer) setRefused(answer.refused)
    } catch (error) {
      setRefused(`The report could not be saved: ${errorText(error)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title="Report a problem with this request"
      width={520}
      className="turn-report-dialog"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            Save report…
          </Button>
        </>
      }
    >
      <div className="report-body">
        <p className="install-server-lead">
          The report holds this request as eNCode worked it: each step, what the tools answered (shortened), and the files it read as they were before. Paths start at
          the project folder, and anything that looks like a key is taken out. It saves to a file you send; nothing is sent by itself.
        </p>
        <dl className="install-server-facts">
          <div>
            <dt>Request</dt>
            <dd title={target?.text ?? ''}>{target ? firstLine(target.text) : ''}</dd>
          </div>
        </dl>
        <label className="report-label" htmlFor="turn-report-description">
          What went wrong?
        </label>
        <textarea
          id="turn-report-description"
          className="approval-note report-description"
          rows={4}
          maxLength={4000}
          value={description}
          placeholder="What you asked for, what you expected, and what eNCode did instead"
          onChange={(event) => setDescription(event.currentTarget.value)}
          data-autofocus
        />
        <div className="report-scramble">
          <div>
            <label htmlFor="turn-report-scramble">Replace the words</label>
            <p>
              Keywords, file extensions and punctuation stay, so the steps still replay and the shape of the work travels; your code and your request do not. Turn it
              off for a project you would share as it is: then the request can also be tried again with a model.
            </p>
          </div>
          <Toggle id="turn-report-scramble" checked={scramble} onChange={setScramble} />
        </div>
        {refused && (
          <p className="report-refused" role="alert">
            {refused}
          </p>
        )}
      </div>
    </Dialog>
  )
}

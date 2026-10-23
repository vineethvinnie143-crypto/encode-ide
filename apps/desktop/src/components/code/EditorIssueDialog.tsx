import { useEffect, useState } from 'react'
import { api } from '../../api'
import { activeEditor } from '../../editor/active'
import { currentDoc } from '../../editor/docs'
import { checkRecording, issueDraft, mustScramble, type IssueCheck } from '../../editor/report'
import { errorText } from '../../ipc-error'
import { useUi } from '../../stores/ui'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Spinner } from '../../ui/Spinner'
import { Toggle } from '../../ui/Toggle'

const baseName = (path: string) => path.slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1)

/** The editor's options as plain values, for the report: how it was set up when the issue happened. */
function editorOptions(): Record<string, string | number | boolean> {
  const view = activeEditor()
  const out: Record<string, string | number | boolean> = {}
  if (!view) return out
  for (const [name, value] of Object.entries(view.options)) {
    if (name === 'ariaLabel') continue
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') out[name] = value
  }
  out.mac = view.mac
  out.devicePixelRatio = Math.round(window.devicePixelRatio * 100) / 100
  return out
}

function recordedText(check: IssueCheck): string {
  const { steps, minutes, trimmed } = check.recording
  const span = minutes < 1 ? 'under a minute' : minutes < 90 ? `${Math.round(minutes)} min` : `${Math.round(minutes / 6) / 10} h`
  return `${steps.toLocaleString()} ${steps === 1 ? 'step' : 'steps'} over ${span}${trimmed ? ', the newest ones' : ''}`
}

function foundText(check: IssueCheck): string {
  const { problems } = check
  if (!problems.length) return 'No problem found'
  return `${problems.length === 1 ? 'One problem' : `${problems.length} problems`}: ${problems[0].problem} (step ${problems[0].step})`
}

/**
 * Report editor issue (ADR 0088): what was recorded of the file since it opened, replayed here with the editor's
 * checks, saved with what the person says to a file they send. The file's words are replaced unless they keep them.
 */
export function EditorIssueDialog() {
  const path = useUi((state) => state.editorIssueFor)
  const [check, setCheck] = useState<IssueCheck | string | null>(null)
  const [description, setDescription] = useState('')
  const [scramble, setScramble] = useState(true)
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  useEffect(() => {
    setCheck(null)
    setRefused(null)
    setSaving(false)
    if (!path) return
    // Shown first, then replayed: a long record takes a moment.
    const timer = window.setTimeout(() => {
      try {
        setCheck(checkRecording(path, currentDoc(path)))
      } catch (error) {
        setCheck(`The record of this file could not be replayed: ${errorText(error)}`)
      }
    }, 30)
    return () => window.clearTimeout(timer)
  }, [path])

  const close = () => {
    useUi.getState().setEditorIssueFor(null)
    setDescription('')
    setScramble(true)
  }
  const forced = path ? mustScramble(path) : false
  const ready = check !== null && typeof check !== 'string'

  const save = async () => {
    if (!path || !ready) return
    setSaving(true)
    setRefused(null)
    try {
      const draft = issueDraft({ path, description, scramble: scramble || forced, editor: editorOptions(), check })
      const answer = await api.app.saveEditorIssue(draft)
      if ('saved' in answer) {
        close()
        useUi.getState().notify('success', `Saved the editor report to ${answer.saved}. Send it with a word on what you were doing.`)
      } else if ('refused' in answer) setRefused(answer.refused)
    } catch (error) {
      setRefused(`The report could not be saved: ${errorText(error)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={path !== null}
      onClose={close}
      title="Report an editor issue"
      width={520}
      className="editor-issue-dialog"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" busy={saving} disabled={!ready} onClick={() => void save()}>
            Save report…
          </Button>
        </>
      }
    >
      <div className="editor-issue-body">
        <p className="install-server-lead">
          eNCode keeps a record of what happened in this file since it was opened: each edit and where the cursor went, nothing else. The report saves it to a file
          you send, so the issue can be replayed step by step and kept as a test. Nothing is sent by itself.
        </p>
        <dl className="install-server-facts">
          <div>
            <dt>File</dt>
            <dd className="is-mono" title={path ?? ''}>
              {path ? baseName(path) : ''}
            </dd>
          </div>
          <div>
            <dt>Recorded</dt>
            <dd>{check === null ? '…' : typeof check === 'string' ? 'Nothing to report' : recordedText(check)}</dd>
          </div>
          <div>
            <dt>Replayed</dt>
            <dd className={ready && check.problems.length ? 'editor-issue-found' : undefined} title={ready ? foundText(check) : undefined}>
              {check === null ? (
                <span className="editor-issue-checking">
                  <Spinner size={12} />
                  Checking it here…
                </span>
              ) : typeof check === 'string' ? (
                '—'
              ) : (
                foundText(check)
              )}
            </dd>
          </div>
        </dl>
        {typeof check === 'string' && <p className="editor-issue-note">{check}</p>}
        <label className="editor-issue-label" htmlFor="editor-issue-description">
          What went wrong?
        </label>
        <textarea
          id="editor-issue-description"
          className="approval-note editor-issue-description"
          rows={4}
          maxLength={4000}
          value={description}
          placeholder="What you did, what you expected, and what the editor did instead"
          onChange={(event) => setDescription(event.currentTarget.value)}
          data-autofocus
        />
        <div className="editor-issue-scramble">
          <div>
            <label htmlFor="editor-issue-scramble">Replace the words of the file</label>
            <p>
              {forced
                ? 'This file holds secrets by its name, so its words are always replaced.'
                : 'Keywords, spaces and punctuation stay, so the shape of the code travels and its content does not. Turn it off only for a file you would share as it is.'}
            </p>
          </div>
          <Toggle id="editor-issue-scramble" checked={scramble || forced} disabled={forced} onChange={setScramble} />
        </div>
        {refused && (
          <p className="editor-issue-refused" role="alert">
            {refused}
          </p>
        )}
      </div>
    </Dialog>
  )
}

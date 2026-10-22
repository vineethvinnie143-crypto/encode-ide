import type { RewindFile, RewindPlan } from '@shared/types'
import { CHOICE_TEXT, NOT_RECORDED_NOTE, actionLabel, changes, choicesFor, conflicts, leftAlone, requestPreview, summaryOf } from '../../panels/rewind'
import { useChat } from '../../stores/chat'
import { useRewind } from '../../stores/rewind'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Dialog } from '../../ui/Dialog'
import { AlertTriangle, Undo2 } from '../../ui/icons'
import { Skeleton } from '../../ui/Skeleton'

function FileRow({ file }: { file: RewindFile }) {
  return (
    <li className={cx('rewind-file', `is-${file.action}`, file.conflict && 'is-conflict')}>
      <span className="rewind-file-path" title={file.path}>
        {file.path}
      </span>
      <span className="rewind-file-action">
        {file.conflict && <span className="rewind-file-flag">Changed since</span>}
        {actionLabel(file)}
      </span>
    </li>
  )
}

/** The files a plan would touch, then the ones it cannot, each with what happens to it. */
function FileList({ plan }: { plan: RewindPlan }) {
  const rows = [...changes(plan), ...leftAlone(plan)]
  if (!rows.length) return null
  return (
    <ul className="rewind-files" aria-label="Files">
      {rows.map((file) => (
        <FileRow key={file.path} file={file} />
      ))}
    </ul>
  )
}

/** Rewind: put the files the agent changed back to before one of your requests, and the conversation with them if you like. */
export default function RewindDialog() {
  const target = useRewind((state) => state.target)
  const mode = useRewind((state) => state.mode)
  const loading = useRewind((state) => state.loading)
  const plan = useRewind((state) => state.plan)
  const redo = useRewind((state) => state.redo)
  const problem = useRewind((state) => state.problem)
  const refreshed = useRewind((state) => state.refreshed)
  const choice = useRewind((state) => state.choice)
  const overwrite = useRewind((state) => state.overwrite)
  const busy = useRewind((state) => state.busy)
  const close = useRewind((state) => state.close)
  const setChoice = useRewind((state) => state.setChoice)
  const setOverwrite = useRewind((state) => state.setOverwrite)
  const setMode = useRewind((state) => state.setMode)
  const apply = useRewind((state) => state.apply)
  const working = useChat((state) => state.running)

  if (!target) return null
  const undoing = mode === 'undo'
  const shown = undoing ? redo : plan
  const choices = choicesFor(plan)
  const listed = undoing || choice !== 'conversation'
  const clashing = listed ? conflicts(shown).length : 0
  const nothingToDo = undoing && !changes(redo).length
  const label = undoing ? 'Undo the rewind' : choice === 'conversation' ? 'Go back' : choice === 'code' ? 'Put the files back' : 'Rewind'

  return (
    <Dialog
      open
      onClose={close}
      title={undoing ? 'Undo the last rewind' : 'Rewind'}
      description={undoing ? 'Bring back the changes the last rewind took away.' : 'Go back to just before this request.'}
      width={580}
      className="rewind-dialog"
      footer={
        <>
          {working && <span className="rewind-working">eNCode is working. Stop it first.</span>}
          {!undoing && redo && (
            <Button variant="ghost" size="md" className="rewind-undo-link" icon={<Undo2 size={14} />} onClick={() => setMode('undo')} disabled={busy}>
              Undo the last rewind
            </Button>
          )}
          {undoing && target.turn && (
            <Button variant="ghost" size="md" className="rewind-undo-link" onClick={() => setMode('rewind')} disabled={busy}>
              Back
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" data-autofocus busy={busy} disabled={loading || working || nothingToDo || (!undoing && !choices.includes(choice))} onClick={() => void apply()}>
            {label}
          </Button>
        </>
      }
    >
      {!undoing && target.text && <blockquote className="rewind-request">{requestPreview(target.text)}</blockquote>}

      {loading ? (
        <div className="rewind-loading" aria-busy="true">
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : (
        <>
          {problem && !undoing && (
            <div className="rewind-problem" role="status">
              <AlertTriangle size={14} />
              <span>The files cannot be put back: {problem} You can still go back in the conversation.</span>
            </div>
          )}

          {!undoing && (
            <div className="rewind-choices" role="radiogroup" aria-label="What to put back">
              {choices.map((value) => (
                <label key={value} className={cx('rewind-choice', choice === value && 'is-on')}>
                  <input type="radio" name="rewind-choice" value={value} checked={choice === value} onChange={() => setChoice(value)} />
                  <span className="rewind-choice-text">
                    <span className="rewind-choice-title">{CHOICE_TEXT[value].title}</span>
                    <span className="rewind-choice-help">{CHOICE_TEXT[value].help}</span>
                  </span>
                </label>
              ))}
            </div>
          )}

          {listed && shown && (
            <div className="rewind-list">
              <div className="rewind-summary">{nothingToDo ? 'There is nothing left to bring back.' : summaryOf(shown)}</div>
              {refreshed && <div className="rewind-refreshed">The files changed while this was open. This is how they stand now.</div>}
              <FileList plan={shown} />
              {clashing > 0 && (
                <label className="rewind-overwrite">
                  <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />
                  <span>
                    Also overwrite {clashing === 1 ? 'the file' : `${clashing} files`} that changed since the agent wrote {clashing === 1 ? 'it' : 'them'}
                    <span className="rewind-overwrite-note">Your own edits to {clashing === 1 ? 'it' : 'them'} would be lost. Left unticked, {clashing === 1 ? 'it stays' : 'they stay'} as {clashing === 1 ? 'it is' : 'they are'}.</span>
                  </span>
                </label>
              )}
            </div>
          )}

          {listed && <p className="rewind-note">{NOT_RECORDED_NOTE}</p>}
        </>
      )}
    </Dialog>
  )
}

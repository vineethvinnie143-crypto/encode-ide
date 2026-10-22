import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { ReviewSnapshot } from '@shared/types'
import { api } from '../../api'
import { useReview } from '../../stores/review'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Sparkles } from '../../ui/icons'
import { Toggle } from '../../ui/Toggle'

/**
 * Commit, with a message the Small tasks model drafts from the changes as the dialog opens. The person reads and
 * edits it; nothing is committed until they press Commit. Pushing goes to the branch's upstream, or sets one.
 */
export default function CommitDialog({ open, onClose, snapshot }: { open: boolean; onClose: () => void; snapshot: ReviewSnapshot }) {
  const { staged, unstaged } = snapshot.counts ?? { staged: 0, unstaged: 0 }
  const branch = snapshot.repo.branch
  const [message, setMessage] = useState('')
  const [all, setAll] = useState(false)
  const [amend, setAmend] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useReview((state) => state.busy === 'commit')
  const messageId = useId()
  /** Bumped by typing and by each draft, so a draft that arrives after the person wrote does not replace their words. */
  const edits = useRef(0)

  const draft = async (everything: boolean) => {
    const mine = ++edits.current
    setDrafting(true)
    setError(null)
    try {
      const result = await api.review.draft({ all: everything })
      if (mine !== edits.current) return
      if (result.ok) setMessage(result.message)
      else setError(result.message)
    } catch (error) {
      if (mine === edits.current) setError((error as Error).message)
    } finally {
      if (mine === edits.current) setDrafting(false)
    }
  }

  // Opened with nothing staged, the commit takes every change; a message is drafted at once for what it will take.
  useEffect(() => {
    if (!open) return
    const everything = staged === 0
    setAll(everything)
    setAmend(false)
    setError(null)
    if (!message.trim()) void draft(everything)
    // Only on opening: the counts change as the person stages, and that must not redraft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const submit = async (push: boolean) => {
    if (!message.trim() || busy) return
    setError(null)
    const outcome = await useReview.getState().commitChanges({ message, all, amend, push })
    if (outcome.ok) {
      setMessage('')
      onClose()
    } else setError(outcome.message)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void submit(false)
    }
  }

  const takes = all ? staged + unstaged : staged
  const nothing = takes === 0 && !amend

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={amend ? 'Amend the last commit' : 'Commit changes'}
      description={branch ? `On branch ${branch}` : 'HEAD is not on a branch'}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!message.trim() || busy || nothing || !branch} title={branch ? undefined : 'Check out a branch to push'} onClick={() => void submit(true)}>
            Commit and push
          </Button>
          <Button variant="primary" busy={busy} disabled={!message.trim() || nothing} onClick={() => void submit(false)}>
            {amend ? 'Amend' : 'Commit'}
          </Button>
        </>
      }
    >
      <div className="commit-form">
        <div className="commit-label-row">
          <label className="commit-label" htmlFor={messageId}>
            Message
          </label>
          <Button size="sm" variant="ghost" icon={<Sparkles size={14} />} busy={drafting} onClick={() => void draft(all)}>
            {message.trim() ? 'Draft again' : 'Draft'}
          </Button>
        </div>
        <textarea
          id={messageId}
          className="commit-message"
          data-autofocus
          rows={7}
          value={message}
          placeholder={drafting ? 'Drafting a message from the changes…' : 'What this change does, in one line. Details after a blank line.'}
          spellCheck
          onChange={(event) => {
            edits.current++
            setDrafting(false)
            setMessage(event.target.value)
          }}
          onKeyDown={onKeyDown}
        />
        {error && (
          <div className="commit-error" role="alert">
            {error}
          </div>
        )}
        <div className="commit-options">
          {unstaged > 0 && (
            <label className="commit-option">
              <Toggle checked={all} onChange={setAll} label="Include changes that are not staged" />
              <span>
                Include changes that are not staged <span className="commit-count">({unstaged})</span>
              </span>
            </label>
          )}
          <label className="commit-option">
            <Toggle
              checked={amend}
              onChange={(on) => {
                setAmend(on)
                const last = useReview.getState().commits?.[0]?.subject
                if (on && !message.trim() && last) setMessage(last)
              }}
              label="Amend the last commit"
            />
            <span>Amend the last commit</span>
          </label>
        </div>
        <div className="commit-summary">
          {nothing ? 'Nothing is staged. Stage changes, or include the ones that are not staged.' : `${takes} ${takes === 1 ? 'file' : 'files'} in this commit. Ctrl+Enter commits.`}
        </div>
      </div>
    </Dialog>
  )
}

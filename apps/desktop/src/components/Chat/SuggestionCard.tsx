import { Fragment, useState } from 'react'
import type { ConversationEntry } from '@shared/types'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { getActiveSessionId } from '../../stores/active'
import { BookOpen, Check } from '../../ui/icons'
import { Button } from '../../ui/Button'

/** A line with its `code` spans drawn as code; the rest stays plain text. */
function Line({ text }: { text: string }) {
  const parts = text.split('`')
  // An odd count of backticks leaves the last one open: shown as written.
  if (parts.length % 2 === 0) return <>{text}</>
  return (
    <>
      {parts.map((part, index) => (index % 2 ? <code key={index}>{part}</code> : <Fragment key={index}>{part}</Fragment>))}
    </>
  )
}

/**
 * What a request taught, offered for the project's instructions file (ADR 0097): the lines, and Add or Dismiss. Nothing
 * is written before Add; once answered the card says so and keeps the lines, so the same ones are not offered again.
 */
export function SuggestionCard({ entry }: { entry: ConversationEntry }) {
  const suggestion = entry.suggestion!
  const [busy, setBusy] = useState<'add' | 'dismiss' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const answer = async (accept: boolean) => {
    setBusy(accept ? 'add' : 'dismiss')
    setError(null)
    try {
      const outcome = await api.agent.answerSuggestion(getActiveSessionId(), entry.id, accept)
      if (!outcome.ok) setError(outcome.error)
    } catch (thrown) {
      setError(errorText(thrown))
    } finally {
      setBusy(null)
    }
  }

  if (suggestion.state === 'dismissed') {
    return (
      <div className="msg msg-notice suggestion-closed">
        <BookOpen size={13} />
        <span>Not kept in {suggestion.file}.</span>
      </div>
    )
  }
  const saved = suggestion.state === 'saved'
  return (
    <div className="result-card suggestion-card" data-state={suggestion.state}>
      <div className="result-head">
        <span className="result-icon">{saved ? <Check size={16} /> : <BookOpen size={16} />}</span>
        <span className="suggestion-title">{saved ? `Added to ${suggestion.file}` : (entry.text ?? `Keep what this request taught in ${suggestion.file}?`)}</span>
        {!saved && (
          <span className="result-actions">
            <Button size="sm" variant="ghost" busy={busy === 'dismiss'} disabled={busy !== null} onClick={() => void answer(false)}>
              Dismiss
            </Button>
            <Button size="sm" variant="primary" busy={busy === 'add'} disabled={busy !== null} onClick={() => void answer(true)}>
              Add to {suggestion.file}
            </Button>
          </span>
        )}
      </div>
      <ul className="suggestion-lines">
        {suggestion.lines.map((line) => (
          <li key={line}>
            <Line text={line} />
          </li>
        ))}
      </ul>
      {error && (
        <div className="suggestion-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

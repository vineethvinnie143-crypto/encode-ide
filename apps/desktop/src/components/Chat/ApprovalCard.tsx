import { useEffect, useRef, useState } from 'react'
import { useChat } from '../../stores/chat'
import { modalOpen } from '../../commands/useKeymap'
import { Button, IconButton } from '../../ui/Button'
import { ChevronLeft, ChevronRight, ShieldAlert } from '../../ui/icons'
import { Kbd } from '../../ui/Kbd'
import DiffView from './DiffView'

/**
 * What the agent wants to do and why it asks, docked above the composer. Enter approves and
 * Esc denies while you are not typing; with several waiting, a stepper moves between them.
 * "Approve for this session" and a note on a refusal appear when the agent supports them.
 */
export default function ApprovalCard() {
  const approvals = useChat((state) => state.approvals)
  const answerApproval = useChat((state) => state.answerApproval)
  const [position, setPosition] = useState(0)
  const [explaining, setExplaining] = useState(false)
  const note = useRef<HTMLTextAreaElement>(null)

  const index = Math.min(position, Math.max(0, approvals.length - 1))
  const approval = approvals[index]
  const id = approval?.id
  // A core that supports session grants and notes sets `grantable` on every request.
  const richAnswers = approval?.grantable !== undefined

  useEffect(() => {
    setExplaining(false)
  }, [id])

  useEffect(() => {
    if (explaining) note.current?.focus()
  }, [explaining])

  useEffect(() => {
    if (!id) return
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || modalOpen()) return
      const target = event.target as HTMLElement
      if (event.key === 'Escape') {
        event.preventDefault()
        if (explaining) setExplaining(false)
        else void answerApproval(false, id)
        return
      }
      if (event.key !== 'Enter' || explaining) return
      // Buttons and fields handle Enter themselves; the composer does too when it holds a message.
      if (['BUTTON', 'A', 'SELECT', 'INPUT'].includes(target.tagName)) return
      if (target.tagName === 'TEXTAREA' && (target as HTMLTextAreaElement).value.trim()) return
      event.preventDefault()
      void answerApproval(true, id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, explaining, answerApproval])

  if (!approval) return null

  return (
    <div className="approval-card" role="group" aria-label="Approval needed">
      <div className="approval-top">
        <div className="approval-head">
          <ShieldAlert size={16} />
          <span>{approval.title}</span>
        </div>
        {approvals.length > 1 && (
          <div className="approval-step" aria-label={`Approval ${index + 1} of ${approvals.length}`}>
            <IconButton label="Previous approval" size="sm" disabled={index === 0} onClick={() => setPosition(index - 1)}>
              <ChevronLeft size={14} />
            </IconButton>
            <span>
              {index + 1} of {approvals.length}
            </span>
            <IconButton label="Next approval" size="sm" disabled={index === approvals.length - 1} onClick={() => setPosition(index + 1)}>
              <ChevronRight size={14} />
            </IconButton>
          </div>
        )}
      </div>
      {approval.reason && <div className="approval-reason">{approval.reason}</div>}
      <pre className="approval-detail">{approval.detail}</pre>
      {approval.preview && approval.preview.length > 0 && (
        <div className="approval-preview">
          <DiffView diff={approval.preview} />
        </div>
      )}

      {explaining ? (
        <div className="approval-explain">
          <textarea
            ref={note}
            className="approval-note"
            rows={2}
            placeholder="Tell the agent why, or what to do instead"
            aria-label="Why you are declining"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.ctrlKey) {
                event.preventDefault()
                void answerApproval({ approved: false, note: event.currentTarget.value.trim() || undefined }, id)
              }
            }}
          />
          <div className="approval-actions">
            <Button
              size="sm"
              onClick={() => void answerApproval({ approved: false, note: note.current?.value.trim() || undefined }, id)}
            >
              Deny with this note <Kbd keys="Ctrl+Enter" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setExplaining(false)}>
              Cancel <Kbd keys="Esc" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="approval-actions">
          <Button variant="primary" size="sm" onClick={() => void answerApproval(true, id)}>
            Approve <Kbd keys="Enter" />
          </Button>
          {approval.grantable && (
            <Button size="sm" onClick={() => void answerApproval({ approved: true, remember: 'session' }, id)}>
              Approve for this session
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => void answerApproval(false, id)}>
            Deny <Kbd keys="Esc" />
          </Button>
          {richAnswers && (
            <Button variant="ghost" size="sm" onClick={() => setExplaining(true)}>
              Deny and explain
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

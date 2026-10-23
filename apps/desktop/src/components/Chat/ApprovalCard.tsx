import { useEffect, useRef, useState } from 'react'
import type { RuleScope } from '@shared/types'
import { useChat } from '../../stores/chat'
import { usePermissions } from '../../stores/permissions'
import { useUi } from '../../stores/ui'
import { modalOpen } from '../../commands/useKeymap'
import { DEFAULT_ALWAYS_SCOPE, SCOPE_CHOICES, alwaysRulesText, ruleTiming, scopeNote, trustOffer } from '../../panels/permissions'
import { Button, IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { AlertTriangle, ChevronLeft, ChevronRight, ListTree, ShieldAlert, ShieldCheck } from '../../ui/icons'
import { Kbd } from '../../ui/Kbd'
import DiffView from './DiffView'
import { reviewLine } from './review-text'

/**
 * What the agent wants to do and why it asks, docked above the composer. Enter approves and
 * Esc denies while you are not typing; with several waiting, a stepper moves between them.
 * "Approve for this session" and a note on a refusal appear when the agent supports them.
 * "Always allow" shows the exact rules it would save and which settings file they go to, then
 * saves them with the approval; it appears only where a rule can stand for the call.
 * Under Auto review it says who left the question to the person, and any invisible or look-alike
 * characters in what the call adds are listed above the buttons.
 */
/** The buttons' words, for a request that is not about touching something. */
const WORDS: Record<string, { approve: string; session: string; deny: string; explain: string; withNote: string }> = {
  EnterPlanMode: { approve: 'Plan first', session: 'Plan first whenever it asks', deny: 'Go ahead without a plan', explain: 'Say how to go ahead', withNote: 'Go ahead with this note' },
}
const DEFAULT_WORDS = { approve: 'Approve', session: 'Approve for this session', deny: 'Deny', explain: 'Deny and explain', withNote: 'Deny with this note' }

export default function ApprovalCard() {
  const approvals = useChat((state) => state.approvals)
  const answerApproval = useChat((state) => state.answerApproval)
  const [position, setPosition] = useState(0)
  const [explaining, setExplaining] = useState(false)
  const [remembering, setRemembering] = useState(false)
  const [scope, setScope] = useState<RuleScope>(DEFAULT_ALWAYS_SCOPE)
  // Whether the person ticked "trust this folder too"; null until they have, so the offer's own default stands.
  const [trustToo, setTrustToo] = useState<boolean | null>(null)
  const folder = usePermissions((state) => state.report)
  const note = useRef<HTMLTextAreaElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)

  const index = Math.min(position, Math.max(0, approvals.length - 1))
  const approval = approvals[index]
  const id = approval?.id
  // A core that supports session grants and notes sets `grantable` on every request.
  const richAnswers = approval?.grantable !== undefined

  useEffect(() => {
    setExplaining(false)
    setRemembering(false)
    setScope(DEFAULT_ALWAYS_SCOPE)
    setTrustToo(null)
  }, [id])

  useEffect(() => {
    if (explaining) note.current?.focus()
  }, [explaining])

  // The button that opened the choices is gone; Enter must not fall through to a one-time approval.
  useEffect(() => {
    if (remembering) confirm.current?.focus()
  }, [remembering])

  useEffect(() => {
    if (!id) return
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || modalOpen()) return
      const target = event.target as HTMLElement
      if (event.key === 'Escape') {
        // An Esc that closed something first (the message box's picker, the Settings page) is not an answer.
        if (event.defaultPrevented) return
        event.preventDefault()
        if (explaining) setExplaining(false)
        else if (remembering) setRemembering(false)
        else void answerApproval(false, id)
        return
      }
      if (event.key !== 'Enter' || explaining || remembering) return
      // Buttons and fields handle Enter themselves; the composer does too when it holds a message.
      if (['BUTTON', 'A', 'SELECT', 'INPUT'].includes(target.tagName)) return
      if (target.tagName === 'TEXTAREA' && (target as HTMLTextAreaElement).value.trim()) return
      event.preventDefault()
      void answerApproval(true, id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, explaining, remembering, answerApproval])

  if (!approval) return null

  const words = WORDS[approval.tool] ?? DEFAULT_WORDS
  const offer = trustOffer(folder, scope)
  const trusting = offer?.kind === 'offer' && (trustToo ?? offer.checked)
  const timing = trusting ? 'now' : ruleTiming(folder, scope)

  /** The folder is trusted before the rule is saved, so the rule finds it approved and starts to apply with the call. */
  const alwaysAllow = async () => {
    if (trusting) {
      const outcome = await usePermissions.getState().act({ type: 'trust' })
      if (!outcome || !outcome.ok) {
        useUi.getState().notify('error', outcome && !outcome.ok ? outcome.reason : 'eNCode could not trust this folder.')
        return
      }
    }
    void answerApproval({ approved: true, remember: 'always', scope }, approval.id)
    // The rule is written a moment after the answer; the Permissions screen and the banner read it again then.
    window.setTimeout(() => void usePermissions.getState().refresh(), 700)
  }

  return (
    <div className="approval-card" role="group" aria-label="Approval needed">
      <div className="approval-top">
        <div className="approval-head">
          {approval.tool === 'EnterPlanMode' ? <ListTree size={16} /> : <ShieldAlert size={16} />}
          <span>{approval.title}</span>
          {approval.background && (
            <em className="approval-tag" title="A subagent working in the background asks. It waits for you; nothing else does.">
              Background
            </em>
          )}
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
      {approval.review && (
        <div className="approval-review">
          <ShieldCheck size={14} />
          <span>{reviewLine(approval.review)}</span>
        </div>
      )}
      <pre className="approval-detail">{approval.detail}</pre>
      {approval.warnings && approval.warnings.length > 0 && (
        <div className="approval-warnings" role="note">
          <AlertTriangle size={14} />
          <div>
            Invisible or look-alike characters in this action
            <ul>
              {approval.warnings.map((line, position) => (
                <li key={position}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
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
              {words.withNote} <Kbd keys="Ctrl+Enter" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setExplaining(false)}>
              Cancel <Kbd keys="Esc" />
            </Button>
          </div>
        </div>
      ) : remembering && approval.always ? (
        <div className="approval-always" role="group" aria-label="Always allow">
          <div className="approval-always-head">
            Always allow <b>{approval.always.label}</b>
          </div>
          <pre className="approval-always-rules" aria-label="The rules that will be saved">
            {alwaysRulesText(approval.always.rules)}
          </pre>
          <div className="approval-scopes" role="radiogroup" aria-label="Where to save it">
            {SCOPE_CHOICES.map((choice) => (
              <label key={choice.value} className={cx('approval-scope', scope === choice.value && 'is-on')}>
                <input type="radio" name="always-scope" value={choice.value} checked={scope === choice.value} onChange={() => setScope(choice.value)} />
                <span className="approval-scope-text">
                  <span className="approval-scope-label">{choice.label}</span>
                  <span className="approval-scope-where">{choice.where}</span>
                </span>
              </label>
            ))}
          </div>
          {offer?.kind === 'offer' && (
            <label className="approval-trust">
              <input type="checkbox" checked={trusting} onChange={(event) => setTrustToo(event.target.checked)} />
              <span>
                Trust this folder too, so the rule applies right away
                <span className="approval-trust-note">{offer.note}</span>
              </span>
            </label>
          )}
          <div className="approval-always-note">{offer?.kind === 'warn' ? `${scopeNote(scope, timing)} ${offer.note}` : scopeNote(scope, timing)}</div>
          <div className="approval-actions">
            <Button ref={confirm} variant="primary" size="sm" onClick={() => void alwaysAllow()}>
              Approve and always allow
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRemembering(false)}>
              Back <Kbd keys="Esc" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="approval-actions">
          <Button variant="primary" size="sm" onClick={() => void answerApproval(true, id)}>
            {words.approve} <Kbd keys="Enter" />
          </Button>
          {approval.grantable && (
            <Button size="sm" onClick={() => void answerApproval({ approved: true, remember: 'session' }, id)}>
              {words.session}
            </Button>
          )}
          {approval.always && (
            <Button size="sm" onClick={() => setRemembering(true)}>
              Always allow…
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => void answerApproval(false, id)}>
            {words.deny} <Kbd keys="Esc" />
          </Button>
          {richAnswers && (
            <Button variant="ghost" size="sm" onClick={() => setExplaining(true)}>
              {words.explain}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

import type { ConversationEntry, ProblemAction } from '@shared/types'
import { ACTION_LABELS } from '@shared/problems'
import { agentActions } from '../../commands/agent'
import { helpActions } from '../../commands/app'
import { useChat } from '../../stores/chat'
import { useUi } from '../../stores/ui'
import { AlertTriangle, Info, Pause, Play, RotateCw } from '../../ui/icons'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Details } from '../../ui/Details'

function act(action: ProblemAction): void {
  switch (action) {
    case 'retry':
      useChat.getState().retry()
      return
    case 'switch-model':
      agentActions.openMenu('model')
      return
    case 'settings':
      useUi.getState().openSettings('models')
      return
    case 'diagnostics':
      void helpActions.saveDiagnostics()
      return
  }
}

/**
 * A request that ended on a problem: what happened in a sentence, and what can be done about it. The buttons belong
 * to the problem the conversation ends on, while nothing runs; an older one, or one already tried again, keeps only
 * its details.
 */
export function ProblemCard({ entry }: { entry: ConversationEntry }) {
  const latest = useChat((state) => state.entries.at(-1)?.id === entry.id)
  const running = useChat((state) => state.running)
  const problem = entry.problem
  const live = Boolean(problem && !problem.resolved && latest && !running)
  return (
    <div className={cx('problem-card', !live && 'is-settled')} role={live ? 'alert' : undefined}>
      <div className="problem-head">
        <span className="problem-icon">
          <AlertTriangle size={14} />
        </span>
        <span className="problem-text">{entry.text}</span>
      </div>
      {(live || entry.details) && (
        <div className="problem-foot">
          {live &&
            problem!.actions.map((action, index) => (
              <Button
                key={action}
                size="sm"
                variant={index === 0 ? 'primary' : 'default'}
                icon={action === 'retry' ? <RotateCw size={13} /> : undefined}
                onClick={() => act(action)}
              >
                {ACTION_LABELS[action]}
              </Button>
            ))}
          {entry.details && <Details text={entry.details} />}
        </div>
      )}
    </div>
  )
}

/** A line the session adds between steps (a model switched, a wait), with what it knew folded under it. */
export function NoticeLine({ entry }: { entry: ConversationEntry }) {
  return (
    <div className="msg msg-notice">
      <Info size={13} />
      <div className="notice-body">
        <span>{entry.text}</span>
        {entry.details && <Details text={entry.details} />}
      </div>
    </div>
  )
}

/** What Continue sends after the step limit: the agent reads it as the go-ahead to carry on (ADR 0124). */
export const CONTINUE_MESSAGE = 'Continue.'

/**
 * The request stopped at the step limit, under what the agent wrote then (ADR 0124). While it ends the conversation
 * and nothing runs, Continue lets the agent go on with the whole limit again, and the limit is a click away.
 */
export function StepLimitLine({ entry }: { entry: ConversationEntry }) {
  const latest = useChat((state) => state.entries.at(-1)?.id === entry.id)
  const running = useChat((state) => state.running)
  const live = latest && !running
  return (
    <div className="msg msg-notice is-step-limit">
      <Pause size={13} />
      <div className="notice-body">
        <span>{entry.text}</span>
        {live && (
          <div className="notice-actions">
            <Button size="sm" variant="primary" icon={<Play size={12} />} onClick={() => useChat.getState().send(CONTINUE_MESSAGE, [], { keepDraft: true })}>
              Continue
            </Button>
            <Button size="sm" variant="ghost" onClick={() => useUi.getState().openSettings('agent', 'agent.limits')}>
              Change the limit
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

import { CheckCircle2, Pause, Pencil, Play, Target, Trash2 } from 'lucide-react'
import type { SessionGoal } from '@shared/types'
import { api } from '../../api'
import { useChat } from '../../stores/chat'
import { useSessions } from '../../stores/sessions'
import { useUi } from '../../stores/ui'

const STATUS_LABEL: Record<SessionGoal['status'], string> = {
  active: 'Ongoing goal',
  paused: 'Paused goal',
  complete: 'Goal complete',
  blocked: 'Goal blocked',
}

export default function GoalCard() {
  const goal = useChat((state) => state.goal)
  const activeId = useSessions((state) => state.activeId)
  const askText = useUi((state) => state.askText)

  if (!goal) return null

  const update = (next: SessionGoal | null) => {
    if (!activeId) return
    void api.agent.setGoal(activeId, next)
  }

  return (
    <div className={`goal-card goal-${goal.status}`}>
      <span className="goal-icon">
        <Target size={14} />
      </span>
      <div className="goal-body">
        <div className="goal-status">
          {STATUS_LABEL[goal.status]} · round {goal.rounds}
        </div>
        <div className="goal-text">{goal.text}</div>
      </div>
      <div className="goal-actions">
        {goal.status === 'active' ? (
          <button title="Pause goal" onClick={() => update({ ...goal, status: 'paused' })}>
            <Pause size={13} />
          </button>
        ) : (
          <button title="Resume goal" onClick={() => update({ ...goal, status: 'active' })}>
            <Play size={13} />
          </button>
        )}
        <button
          title="Edit goal"
          onClick={async () => {
            const text = await askText('Edit goal', 'Goal', goal.text)
            if (text && text !== goal.text) update({ ...goal, text })
          }}
        >
          <Pencil size={13} />
        </button>
        <button title="Mark complete" onClick={() => update({ ...goal, status: 'complete' })}>
          <CheckCircle2 size={13} />
        </button>
        <button title="Delete goal" onClick={() => update(null)}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

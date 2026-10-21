import { Play, ScrollText, X } from 'lucide-react'
import { api } from '../../api'
import { useChat } from '../../stores/chat'
import { useSessions } from '../../stores/sessions'
import { useSettings } from '../../stores/settings'

export default function PlanCard() {
  const plan = useChat((state) => state.plan)
  const activeId = useSessions((state) => state.activeId)
  const save = useSettings((state) => state.save)

  if (!plan) return null

  const dismiss = () => {
    void api.agent.setPlan(activeId, null)
  }

  const approve = async () => {
    await save({ agentMode: 'code' })
    void api.agent.setPlan(activeId, null)
    useChat.getState().send(`Execute the approved plan:\n\n${plan.plan}`)
  }

  return (
    <div className="plan-card">
      <div className="plan-head">
        <ScrollText size={13} />
        <span>Proposed plan</span>
      </div>
      <pre className="plan-body">{plan.plan}</pre>
      <div className="plan-actions">
        <button className="btn primary sm" onClick={() => void approve()}>
          <Play size={12} /> Approve and execute
        </button>
        <button className="btn ghost sm" onClick={dismiss}>
          <X size={12} /> Dismiss
        </button>
      </div>
    </div>
  )
}

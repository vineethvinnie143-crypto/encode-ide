import { useEffect, useState } from 'react'
import { Clock, Play, Plus, Trash2, X } from 'lucide-react'
import type { Schedule } from '@shared/types'
import { api } from '../api'
import { useSessions } from '../stores/sessions'
import { useUi } from '../stores/ui'

export default function AutomationModal() {
  const setAutomationOpen = useUi((state) => state.setAutomationOpen)
  const notify = useUi((state) => state.notify)
  const activeId = useSessions((state) => state.activeId)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [prompt, setPrompt] = useState('')
  const [minutes, setMinutes] = useState(5)
  const [repeat, setRepeat] = useState(false)

  const refresh = async () => {
    try {
      setSchedules(await api.schedules.list())
    } catch {
      setSchedules([])
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => window.clearInterval(timer)
  }, [])

  const create = async () => {
    if (!prompt.trim() || !activeId) return
    try {
      await api.schedules.create({
        prompt: prompt.trim(),
        sessionId: activeId,
        afterSeconds: minutes * 60,
        everySeconds: repeat ? Math.max(60, minutes * 60) : undefined,
      })
      setPrompt('')
      await refresh()
      notify('success', 'Scheduled task created')
    } catch (error) {
      notify('error', (error as Error).message)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => setAutomationOpen(false)}>
      <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div className="settings-title">
            <Clock size={14} /> Automation tasks
          </div>
          <button className="icon-btn" onClick={() => setAutomationOpen(false)} title="Close">
            <X size={16} />
          </button>
        </header>

        <div className="settings-body">
          <div className="settings-agent">
            <div className="info-note">
              Scheduled prompts fire into the active session. One-shot tasks are removed after they run.
            </div>
            <div className="form-row">
              <label>Prompt</label>
              <input
                className="text-input"
                value={prompt}
                placeholder="e.g. Re-run the test suite and report failures"
                onChange={(event) => setPrompt(event.target.value)}
              />
            </div>
            <div className="form-row inline">
              <label>Delay / interval (minutes)</label>
              <input
                className="text-input narrow"
                type="number"
                min={1}
                max={1440}
                value={minutes}
                onChange={(event) => setMinutes(Math.max(1, Number(event.target.value) || 1))}
              />
            </div>
            <label className="checkbox-row">
              <input type="checkbox" checked={repeat} onChange={(event) => setRepeat(event.target.checked)} />
              Repeat on this interval
            </label>
            <button className="btn primary sm" onClick={() => void create()} disabled={!prompt.trim() || !activeId}>
              <Plus size={12} /> Schedule task
            </button>

            <div className="section-title">Scheduled</div>
            {schedules.map((schedule) => (
              <div className="plugin-row" key={schedule.id}>
                <span className="plugin-name">{schedule.prompt}</span>
                <span className="plugin-meta">
                  {schedule.enabled ? 'next' : 'paused'} {new Date(schedule.nextAt).toLocaleTimeString()}
                  {schedule.everySeconds ? ` · every ${Math.round(schedule.everySeconds / 60)}m` : ' · once'}
                  {schedule.lastError ? ` · error: ${schedule.lastError}` : ''}
                  {schedule.attempts ? ` · attempt ${schedule.attempts}` : ''}
                </span>
                <button
                  className="icon-btn tiny"
                  title={schedule.enabled ? 'Pause' : 'Resume'}
                  onClick={() => void api.schedules.toggle(schedule.id, !schedule.enabled).then(refresh)}
                >
                  <Play size={11} />
                </button>
                <button
                  className="icon-btn tiny"
                  title="Delete"
                  onClick={() => void api.schedules.remove(schedule.id).then(refresh)}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            {!schedules.length && <div className="rail-empty">No scheduled tasks.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

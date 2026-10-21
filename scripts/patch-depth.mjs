/** Jobs live output, schedule retries/reporting, goal fork + configurable rounds. */
import fs from 'node:fs'

const edits = [
  // --- Schedules: retries + last error/result ---
  ['shared/types.ts', '  enabled: boolean\n  createdAt: number\n  lastFiredAt?: number\n}',
    '  enabled: boolean\n  createdAt: number\n  lastFiredAt?: number\n  attempts: number\n  lastResult?: string\n  lastError?: string\n}'],
  ['electron/services/schedules.ts', '  constructor(private readonly fire: (schedule: Schedule) => void) {',
    '  constructor(private readonly fire: (schedule: Schedule) => Promise<void>) {'],
  ['electron/services/schedules.ts', "      enabled: true,\n      createdAt: Date.now(),\n    }",
    "      enabled: true,\n      createdAt: Date.now(),\n      attempts: 0,\n    }"],
  ['electron/services/schedules.ts', "      schedule.lastFiredAt = now\n      try {\n        this.fire(schedule)\n      } catch (error) {\n        console.error('[schedules] fire failed', error)\n      }",
    `      schedule.lastFiredAt = now
      void this.fire(schedule)
        .then(() => {
          schedule.attempts = 0
          schedule.lastResult = 'ok'
          schedule.lastError = undefined
          this.persist()
        })
        .catch((error: Error) => {
          schedule.attempts = (schedule.attempts ?? 0) + 1
          schedule.lastError = error.message
          if (schedule.attempts >= 3) schedule.enabled = false
          this.persist()
        })`],
  // --- Goals: configurable rounds + fork copies goal/todos ---
  ['shared/types.ts', '  maxSteps: number\n  recentWorkspaces: string[]',
    '  maxSteps: number\n  maxGoalRounds: number\n  recentWorkspaces: string[]'],
  ['electron/services/settings.ts', '    maxSteps: 30,',
    '    maxSteps: 30,\n    maxGoalRounds: 8,'],
  ['electron/services/settings.ts', '      maxSteps: this.data.maxSteps,',
    '      maxSteps: this.data.maxSteps,\n      maxGoalRounds: this.data.maxGoalRounds,'],
  ['electron/services/settings.ts', '      maxSteps: clamp(input.maxSteps, 1, 100, base.maxSteps),',
    '      maxSteps: clamp(input.maxSteps, 1, 100, base.maxSteps),\n      maxGoalRounds: clamp(input.maxGoalRounds, 1, 100, base.maxGoalRounds),'],
  ['electron/services/settings.ts', "    if (patch.maxSteps !== undefined) next.maxSteps = clamp(patch.maxSteps, 1, 100, 30)",
    "    if (patch.maxSteps !== undefined) next.maxSteps = clamp(patch.maxSteps, 1, 100, 30)\n    if (patch.maxGoalRounds !== undefined) next.maxGoalRounds = clamp(patch.maxGoalRounds, 1, 100, 8)"],
  ['electron/agent/manager.ts', '    if (goal.rounds >= MAX_GOAL_ROUNDS) {',
    '    const cap = this.deps.settings.raw().maxGoalRounds ?? MAX_GOAL_ROUNDS\n    if (goal.rounds >= cap) {'],
  ['electron/agent/manager.ts', '    this.meta.set(id, created)\n    this.stored.set(id, { ...created, messages: snapshot.messages, entries: snapshot.entries })',
    `    this.meta.set(id, created)
    this.stored.set(id, {
      ...created,
      messages: snapshot.messages,
      entries: snapshot.entries,
      goal: this.goals.get(sessionId) ? { ...this.goals.get(sessionId)!, rounds: 0 } : null,
      todos: [...(this.todosBySession.get(sessionId) ?? [])],
    })
    const goal = this.goals.get(sessionId)
    if (goal) this.goals.set(id, { ...goal, rounds: 0, updatedAt: Date.now() })
    const todos = this.todosBySession.get(sessionId)
    if (todos) this.todosBySession.set(id, todos.map((todo) => ({ ...todo })))`],
  // --- Automation modal: surface retries/errors ---
  ['src/components/AutomationModal.tsx', "                  {schedule.everySeconds ? ` · every ${Math.round(schedule.everySeconds / 60)}m` : ' · once'}",
    "                  {schedule.everySeconds ? ` · every ${Math.round(schedule.everySeconds / 60)}m` : ' · once'}\n                  {schedule.lastError ? ` · error: ${schedule.lastError}` : ''}\n                  {schedule.attempts ? ` · attempt ${schedule.attempts}` : ''}"],
  // --- Jobs: live output preview in the popover ---
  ['src/components/SessionHeader.tsx', '                  {job.status === \'running\' && (',
    '                  {job.output ? <span className="job-preview">{job.output.slice(-160)}</span> : null}\n                  {job.status === \'running\' && ('],
  ['src/styles.css', '/* Policy menu',
    '.job-preview { display: block; width: 100%; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }\n\n/* Policy menu'],
]

let changed = 0
for (const [file, from, to] of edits) {
  const text = fs.readFileSync(file, 'utf8')
  if (!text.includes(from)) {
    console.log(`MISS ${file}: ${from.slice(0, 60).replace(/\n/g, '\\n')}`)
    continue
  }
  fs.writeFileSync(file, text.replace(from, to), 'utf8')
  changed += 1
}
console.log(`applied ${changed}/${edits.length}`)

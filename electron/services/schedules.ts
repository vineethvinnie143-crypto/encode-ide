import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { Schedule } from '../../shared/types'

/** One-shot or repeating prompts that fire into a session. */
export class ScheduleService {
  private schedules: Schedule[] = []
  private readonly file: string
  private readonly timer: NodeJS.Timeout

  constructor(private readonly fire: (schedule: Schedule) => Promise<void>) {
    this.file = path.join(app.getPath('userData'), 'eNCode-schedules.json')
    this.load()
    this.timer = setInterval(() => this.tick(), 1000)
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { schedules?: Schedule[] }
      this.schedules = (raw.schedules ?? []).filter((schedule) => schedule?.id && schedule.prompt)
    } catch {
      this.schedules = []
    }
  }

  private persist(): void {
    try {
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, schedules: this.schedules }, null, 0), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (error) {
      console.error('[schedules] failed to persist', error)
    }
  }

  list(): Schedule[] {
    return [...this.schedules].sort((a, b) => a.nextAt - b.nextAt)
  }

  create(input: { prompt: string; sessionId: string; afterSeconds?: number; everySeconds?: number }): Schedule {
    const delay = Math.max(5, input.afterSeconds ?? input.everySeconds ?? 60)
    const schedule: Schedule = {
      id: randomUUID(),
      prompt: input.prompt.trim(),
      sessionId: input.sessionId,
      everySeconds: input.everySeconds && input.everySeconds >= 60 ? Math.round(input.everySeconds) : undefined,
      nextAt: Date.now() + delay * 1000,
      enabled: true,
      createdAt: Date.now(),
      attempts: 0,
    }
    this.schedules.push(schedule)
    this.persist()
    return schedule
  }

  remove(id: string): void {
    this.schedules = this.schedules.filter((schedule) => schedule.id !== id)
    this.persist()
  }

  toggle(id: string, enabled: boolean): void {
    const schedule = this.schedules.find((item) => item.id === id)
    if (!schedule) return
    schedule.enabled = enabled
    schedule.nextAt = Date.now() + (schedule.everySeconds ?? 60) * 1000
    this.persist()
  }

  dispose(): void {
    clearInterval(this.timer)
    this.persist()
  }

  private tick(): void {
    const now = Date.now()
    let changed = false
    for (const schedule of [...this.schedules]) {
      if (!schedule.enabled || schedule.nextAt > now) continue
      schedule.lastFiredAt = now
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
        })
      if (schedule.everySeconds) {
        schedule.nextAt = now + schedule.everySeconds * 1000
      } else {
        this.schedules = this.schedules.filter((item) => item.id !== schedule.id)
      }
      changed = true
    }
    if (changed) this.persist()
  }
}

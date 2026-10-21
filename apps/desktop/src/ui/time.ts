const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A short age for list rows: now, 5m, 3h, Tue, Oct 3, Oct 3, 2025. */
export function shortAge(time: number, now: number = Date.now()): string {
  const age = Math.max(0, now - time)
  if (age < MINUTE) return 'now'
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`
  if (age < DAY) return `${Math.floor(age / HOUR)}h`
  const date = new Date(time)
  if (age < 7 * DAY) return date.toLocaleDateString('en-US', { weekday: 'short' })
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** True when `time` falls on the same local calendar day as `now`. */
export function isToday(time: number, now: number = Date.now()): boolean {
  return new Date(time).toDateString() === new Date(now).toDateString()
}

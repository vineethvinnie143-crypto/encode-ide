export const SECOND = 1_000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** The UTC calendar day, `YYYY-MM-DD`. Daily quotas reset at UTC midnight, as OpenRouter's do. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function nextUtcMidnight(ms: number): number {
  return (Math.floor(ms / DAY) + 1) * DAY
}

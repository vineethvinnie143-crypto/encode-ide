/**
 * The arithmetic that tells a change from noise (the cost and accuracy plan's Q4). A model does not do a task the same
 * way twice, so one run per task says little: a task that passes four times in five fails one run in five, and with
 * fourteen tasks one such run moves the pass rate by seven points. These are small, exact tests, with no outside
 * library and no randomness, so a comparison says the same thing every time it is made.
 */

/** Two-sided 95% points of Student's t for 1 to 30 degrees of freedom; past 30, the normal one. */
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042]

export function t95(degrees: number): number {
  return degrees >= 1 && degrees <= T95.length ? T95[degrees - 1]! : 1.96
}

/** A mean and its 95% interval, over `n` paired values. */
export interface Interval {
  mean: number
  low: number
  high: number
  n: number
}

/** The mean of paired differences and its 95% interval (Student's t); undefined for fewer than two. */
export function meanInterval(values: readonly number[]): Interval | undefined {
  const n = values.length
  if (n < 2) return undefined
  const mean = values.reduce((sum, value) => sum + value, 0) / n
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
  const half = t95(n - 1) * Math.sqrt(variance / n)
  return { mean, low: mean - half, high: mean + half, n }
}

/**
 * The 95% interval of a ratio from paired ratios, on their logarithms: the geometric mean, which a task that got ten
 * times dearer does not swamp the way an arithmetic mean would. Ratios that are not positive are left out.
 */
export function ratioInterval(ratios: readonly number[]): Interval | undefined {
  const logs = ratios.filter((ratio) => ratio > 0 && Number.isFinite(ratio)).map(Math.log)
  const interval = meanInterval(logs)
  return interval && { mean: Math.exp(interval.mean), low: Math.exp(interval.low), high: Math.exp(interval.high), n: interval.n }
}

const logFactorials: number[] = [0]
function logFactorial(n: number): number {
  for (let k = logFactorials.length; k <= n; k++) logFactorials[k] = logFactorials[k - 1]! + Math.log(k)
  return logFactorials[n]!
}

const logChoose = (n: number, k: number): number => logFactorial(n) - logFactorial(k) - logFactorial(n - k)

/**
 * Fisher's exact test, one-sided: the chance that a task passing `before` of `beforeRuns` times and `after` of
 * `afterRuns` times would pass that few times after, or fewer, if nothing had changed. Small means a real drop: five of
 * five to one of five is 0.024, five of five to two of five is 0.083.
 */
export function dropChance(before: number, beforeRuns: number, after: number, afterRuns: number): number {
  const passes = before + after
  const runs = beforeRuns + afterRuns
  const least = Math.max(0, passes - beforeRuns)
  let chance = 0
  for (let k = least; k <= after; k++) chance += Math.exp(logChoose(afterRuns, k) + logChoose(beforeRuns, passes - k) - logChoose(runs, passes))
  return Math.min(1, chance)
}

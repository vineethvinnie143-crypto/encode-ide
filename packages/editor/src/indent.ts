import type { Text } from '@encode/text'

export interface IndentStyle {
  /** What one level of indentation inserts: spaces or a tab. */
  indentUnit: string
  tabSize: number
}

/** Lines looked at; the indentation of a file shows within its first few hundred. */
const SAMPLE_LINES = 600
const STEPS = [2, 3, 4, 8]

/**
 * Works out how a file is indented from its lines: tabs when most indented
 * lines start with one, else the step between one indented line and the
 * next that occurs most often. `fallback` stands when the text says nothing
 * (no indented lines).
 */
export function detectIndent(source: string | Text, fallback: IndentStyle = { indentUnit: '  ', tabSize: 4 }): IndentStyle {
  const lines = typeof source === 'string' ? source.split('\n', SAMPLE_LINES) : source.lineTexts(1, Math.min(source.lineCount, SAMPLE_LINES))
  let tabs = 0
  let spaces = 0
  const steps = new Map<number, number>()
  let previous = 0
  for (const line of lines) {
    if (!line.trim()) continue
    if (line[0] === '\t') {
      tabs++
      previous = 0
      continue
    }
    let width = 0
    while (width < line.length && line[width] === ' ') width++
    if (width > 0) spaces++
    // A single leading space is alignment, not a level.
    if (width !== previous && width !== 1 && previous !== 1) {
      const step = Math.abs(width - previous)
      if (STEPS.includes(step)) steps.set(step, (steps.get(step) ?? 0) + 1)
    }
    previous = width
  }
  if (tabs > spaces) return { indentUnit: '\t', tabSize: fallback.tabSize }
  let best = 0
  let bestCount = 0
  for (const step of STEPS) {
    const count = steps.get(step) ?? 0
    if (count > bestCount) {
      best = step
      bestCount = count
    }
  }
  return best ? { indentUnit: ' '.repeat(best), tabSize: fallback.tabSize } : fallback
}

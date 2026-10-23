/**
 * How well what was typed finds a word of code, for a list of suggestions: the letters typed, in order, with the
 * first at the start of the word or of one of its parts (`gEBI` finds `getElementById`, `str` finds `toString`, `ring`
 * does not). Higher is better. Runs of letters, the starts of parts and the same letter case count most; skipping
 * letters costs a little.
 */

export interface FuzzyMatch {
  score: number
  /** The indexes in the word of the letters that matched, ascending. */
  matches: number[]
}

/** Longer patterns and words are matched on their first this many characters. */
const MAX_PATTERN = 64
const MAX_WORD = 256

const SEPARATORS = new Set(['_', '-', '.', ' ', '/', '\\', '$', ':', '#', '@', '(', '<', '[', "'", '"'])

/** Where the parts of a word start: its first character, after a separator, and an upper-case letter after a lower-case one or a digit. */
function partStarts(word: string, length: number): Uint8Array {
  const starts = new Uint8Array(length)
  for (let index = 0; index < length; index++) {
    if (index === 0) {
      starts[index] = 1
      continue
    }
    const char = word[index]
    const before = word[index - 1]
    if (SEPARATORS.has(before) && !SEPARATORS.has(char)) starts[index] = 1
    else if (isUpper(char) && (isLower(before) || isDigit(before))) starts[index] = 1
    else if (isDigit(char) && !isDigit(before)) starts[index] = 1
  }
  return starts
}

const isUpper = (char: string): boolean => char !== char.toLowerCase() && char === char.toUpperCase()
const isLower = (char: string): boolean => char !== char.toUpperCase() && char === char.toLowerCase()
const isDigit = (char: string): boolean => char >= '0' && char <= '9'

/** Null when the pattern's letters are not all in the word in order, or its first letter starts no part of it. */
export function fuzzyMatch(pattern: string, word: string): FuzzyMatch | null {
  const n = Math.min(pattern.length, MAX_PATTERN)
  if (n === 0) return { score: 0, matches: [] }
  const m = Math.min(word.length, MAX_WORD)
  if (n > m) return null
  const lowerPattern = pattern.slice(0, n).toLowerCase()
  const lowerWord = word.slice(0, m).toLowerCase()
  // Quick rejection: every letter must be there in order.
  let seek = 0
  for (let index = 0; index < n; index++) {
    seek = lowerWord.indexOf(lowerPattern[index], seek)
    if (seek < 0) return null
    seek++
  }
  const starts = partStarts(word, m)
  const NONE = -1e9
  // score[i * m + j]: the best score with pattern[i] at word[j]; from[i * m + j]: where pattern[i - 1] was then.
  const score = new Float64Array(n * m).fill(NONE)
  const from = new Int32Array(n * m).fill(-1)
  const gain = (i: number, j: number, run: boolean): number => {
    let value = 1
    if (starts[j]) value += j === 0 ? 10 : 7
    if (run) value += 8
    if (pattern[i] === word[j]) value += 1
    // An upper-case letter typed asks for one: it rarely means a lower-case one.
    else if (isUpper(pattern[i])) value -= 3
    return value
  }
  for (let j = 0; j < m; j++) {
    if (lowerWord[j] !== lowerPattern[0] || !starts[j]) continue
    // A match further into the word counts a little less.
    score[j] = gain(0, j, false) - Math.min(j, 20) * 0.05
  }
  for (let i = 1; i < n; i++) {
    // The best placement of pattern[i - 1] at least two letters back, for a jump.
    let bestJump = NONE
    let bestJumpAt = -1
    for (let j = i; j < m; j++) {
      const back = (i - 1) * m + (j - 2)
      if (j >= 2 && score[back] > bestJump) {
        bestJump = score[back]
        bestJumpAt = j - 2
      }
      if (lowerWord[j] !== lowerPattern[i]) continue
      const run = score[(i - 1) * m + (j - 1)]
      const viaRun = run > NONE ? run + gain(i, j, true) : NONE
      const viaJump = bestJump > NONE ? bestJump + gain(i, j, false) - (starts[j] ? 0.5 : 2) : NONE
      if (viaRun === NONE && viaJump === NONE) continue
      if (viaRun >= viaJump) {
        score[i * m + j] = viaRun
        from[i * m + j] = j - 1
      } else {
        score[i * m + j] = viaJump
        from[i * m + j] = bestJumpAt
      }
    }
  }
  let best = NONE
  let at = -1
  for (let j = n - 1; j < m; j++) {
    if (score[(n - 1) * m + j] > best) {
      best = score[(n - 1) * m + j]
      at = j
    }
  }
  if (at < 0) return null
  const matches = new Array<number>(n)
  for (let i = n - 1; i >= 0; i--) {
    matches[i] = at
    at = from[i * m + at]
  }
  // A word that is just what was typed wins over a longer one.
  if (n === m) best += 3
  return { score: best, matches }
}

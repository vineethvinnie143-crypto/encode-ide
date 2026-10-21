import type { DiffHunk, DiffLine } from '../../shared/types'

/**
 * Hand-written line diff (Myers) with unified hunk formatting, replacing the
 * `diff` package. Common prefixes/suffixes are trimmed first, and pathological
 * inputs fall back to a replace-all hunk instead of blowing up memory/time.
 */

type Op = { type: 'eq' | 'del' | 'add'; text: string }

const CONTEXT = 3
const MAX_EDIT_DISTANCE = 2500
const MAX_MIDDLE_LINES = 8000

function myers(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (!n && !m) return []
  if (!n) return b.map((text) => ({ type: 'add' as const, text }))
  if (!m) return a.map((text) => ({ type: 'del' as const, text }))

  const max = n + m
  const limit = Math.min(max, MAX_EDIT_DISTANCE)
  const v = new Map<number, number>()
  const trace: Array<Map<number, number>> = []
  v.set(1, 0)

  for (let d = 0; d <= limit; d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      const down = v.get(k + 1) ?? 0
      const right = v.get(k - 1) ?? 0
      let x: number
      if (k === -d || (k !== d && right < down)) x = down
      else x = right + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v.set(k, x)
      if (x >= n && y >= m) return backtrack(trace, a, b, d)
    }
  }

  // Too many edits: treat the middle as a full replacement.
  return [...a.map((text) => ({ type: 'del' as const, text })), ...b.map((text) => ({ type: 'add' as const, text }))]
}

function backtrack(trace: Array<Map<number, number>>, a: string[], b: string[], depth: number): Op[] {
  const ops: Op[] = []
  let x = a.length
  let y = b.length

  for (let d = depth; d >= 0; d--) {
    const v = trace[d]
    const k = x - y
    const down = v.get(k + 1) ?? 0
    const right = v.get(k - 1) ?? 0
    const previousK = k === -d || (k !== d && right < down) ? k + 1 : k - 1
    const previousX = v.get(previousK) ?? 0
    const previousY = previousX - previousK

    while (x > previousX && y > previousY) {
      x--
      y--
      ops.push({ type: 'eq', text: a[x] })
    }
    if (d === 0) break
    if (x === previousX) {
      y--
      ops.push({ type: 'add', text: b[y] })
    } else {
      x--
      ops.push({ type: 'del', text: a[x] })
    }
  }

  return ops.reverse()
}

export function buildDiff(_fileName: string, before: string, after: string): DiffHunk[] {
  if (before === after) return []

  const a = before.split('\n')
  const b = after.split('\n')

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++

  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }

  const middleA = a.slice(prefix, a.length - suffix)
  const middleB = b.slice(prefix, b.length - suffix)

  let middleOps: Op[]
  if (middleA.length * middleB.length > MAX_MIDDLE_LINES * MAX_MIDDLE_LINES) {
    middleOps = [
      ...middleA.map((text) => ({ type: 'del' as const, text })),
      ...middleB.map((text) => ({ type: 'add' as const, text })),
    ]
  } else {
    middleOps = myers(middleA, middleB)
  }

  const ops: Op[] = [
    ...a.slice(0, prefix).map((text) => ({ type: 'eq' as const, text })),
    ...middleOps,
    ...a.slice(a.length - suffix).map((text) => ({ type: 'eq' as const, text })),
  ]

  // Number both sides.
  const lines: DiffLine[] = []
  let oldNo = 1
  let newNo = 1
  for (const op of ops) {
    if (op.type === 'eq') {
      lines.push({ type: 'ctx', text: op.text, oldNo: oldNo++, newNo: newNo++ })
    } else if (op.type === 'del') {
      lines.push({ type: 'del', text: op.text, oldNo: oldNo++ })
    } else {
      lines.push({ type: 'add', text: op.text, newNo: newNo++ })
    }
  }

  const changed = lines.map((line, index) => (line.type === 'ctx' ? -1 : index)).filter((index) => index >= 0)
  if (!changed.length) return []

  // Group nearby changes into hunks.
  const groups: Array<[number, number]> = []
  let start = Math.max(0, changed[0] - CONTEXT)
  let end = Math.min(lines.length - 1, changed[0] + CONTEXT)

  for (let index = 1; index < changed.length; index++) {
    const change = changed[index]
    if (change - end <= CONTEXT * 2) {
      end = Math.min(lines.length - 1, change + CONTEXT)
    } else {
      groups.push([start, end])
      start = Math.max(0, change - CONTEXT)
      end = Math.min(lines.length - 1, change + CONTEXT)
    }
  }
  groups.push([start, end])

  return groups.map(([groupStart, groupEnd]) => {
    let oldConsumed = 0
    let newConsumed = 0
    for (let index = 0; index < groupStart; index++) {
      if (lines[index].type !== 'add') oldConsumed++
      if (lines[index].type !== 'del') newConsumed++
    }

    const slice = lines.slice(groupStart, groupEnd + 1)
    const oldLines = slice.filter((line) => line.type !== 'add').length
    const newLines = slice.filter((line) => line.type !== 'del').length

    return {
      oldStart: oldConsumed + 1,
      oldLines,
      newStart: newConsumed + 1,
      newLines,
      lines: slice,
    }
  })
}

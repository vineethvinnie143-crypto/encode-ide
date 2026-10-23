/**
 * Edit traces made from a file's history: each version reached from the one before by the edits a person would
 * make (select what changed, cut or delete it, type or paste what replaces it, a change from a language server or
 * the agent now and then, a pause before the next place), with undo and redo along the way. Every version is an
 * `expect`, so a replay that drifts from the real file is caught where it drifts.
 *
 * Used by scripts/edit-traces.mjs to write the regression traces in packages/editor/test/traces.
 */
import { diffLines } from '@encode/diff'
import { languageForPath } from './languages'
import { expectOf, TraceReplayer, type EditorTrace, type TraceStep } from './trace'
import { Text } from '@encode/text'

/** A tiny seeded generator (xorshift), so a trace is made the same way every time. */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

/** Where each line starts in `text` followed by one more line break, and one past the end. */
function lineStarts(lines: readonly string[]): number[] {
  const starts = [0]
  for (const line of lines) starts.push(starts[starts.length - 1] + line.length + 1)
  return starts
}

const isLowSurrogate = (text: string, index: number) => {
  const code = text.charCodeAt(index)
  return code >= 0xdc00 && code <= 0xdfff
}

/** The edits that turn `a` into `b`: one per changed block of lines, narrowed to the characters that differ. */
export function editsBetween(a: string, b: string): { from: number; to: number; insert: string }[] {
  const linesA = a.split('\n')
  const linesB = b.split('\n')
  const startsA = lineStarts(linesA)
  const startsB = lineStarts(linesB)
  // Each text with one more line break at its end, so every block of lines is its lines with their breaks.
  const paddedA = `${a}\n`
  const paddedB = `${b}\n`
  const edits: { from: number; to: number; insert: string }[] = []
  for (const block of diffLines(linesA, linesB).blocks) {
    let fromA = startsA[block.fromA]
    let toA = startsA[block.toA]
    let fromB = startsB[block.fromB]
    let toB = startsB[block.toB]
    // Lines added or taken away after the last line: the same edit made before the extra line break, not after it.
    if ((fromA === toA || fromB === toB) && toA > a.length) {
      fromA--
      toA--
      fromB--
      toB--
    }
    // Narrow to what differs: the common end first (taking the extra line break with it), then the common start.
    while (toA > fromA && toB > fromB && paddedA[toA - 1] === paddedB[toB - 1]) {
      toA--
      toB--
    }
    while (fromA < toA && fromB < toB && paddedA[fromA] === paddedB[fromB]) {
      fromA++
      fromB++
    }
    // Never split a surrogate pair.
    while (fromA > 0 && fromB > 0 && (isLowSurrogate(paddedA, fromA) || isLowSurrogate(paddedB, fromB))) {
      fromA--
      fromB--
    }
    while ((toA < a.length && isLowSurrogate(paddedA, toA)) || (toB < b.length && isLowSurrogate(paddedB, toB))) {
      toA++
      toB++
    }
    if (toA === fromA && toB === fromB) continue
    edits.push({ from: fromA, to: toA, insert: paddedB.slice(fromB, toB) })
  }
  return edits
}

/** Splits text the way it is typed: a word, its spaces, a line at most, in pieces of at most `size`. */
function typedPieces(text: string, size: number): string[] {
  const pieces: string[] = []
  for (const token of text.match(/[^\S\n]*[^\s]{1,24}|\n[^\S\n]*|[^\S\n]+/gu) ?? [text]) {
    const last = pieces[pieces.length - 1]
    if (last !== undefined && last.length + token.length <= size && !last.endsWith('\n')) pieces[pieces.length - 1] = last + token
    else pieces.push(token)
  }
  return pieces
}

export interface HistoryTraceOptions {
  seed?: number
  /** A trace for a file with Windows line endings. */
  lineSeparator?: '\n' | '\r\n'
}

/** A trace that edits `versions[0]` into each later version in turn. */
export function traceFromHistory(name: string, path: string, versions: readonly string[], options: HistoryTraceOptions = {}): EditorTrace {
  const random = seeded(options.seed ?? versions.length * 7919 + name.length)
  const header: Omit<EditorTrace, 'steps'> = {
    version: 1,
    name,
    doc: versions[0],
    language: languageForPath(path).id,
    tabSize: 4,
    indentUnit: '  ',
    lineSeparator: options.lineSeparator ?? '\n',
  }
  const steps: TraceStep[] = []
  const replayer = new TraceReplayer(header, { check: false })
  let t = 0
  const step = (action: TraceStep) => {
    steps.push(action)
    replayer.step(action)
  }
  for (let index = 1; index < versions.length; index++) {
    const next = versions[index]
    let delta = 0
    for (const edit of editsBetween(replayer.state.doc.toString(), next)) {
      const from = edit.from + delta
      const to = edit.to + delta
      delta += edit.insert.length - (edit.to - edit.from)
      t += 600 + Math.floor(random() * 2400)
      const roll = random()
      if (roll < 0.15) {
        // A language server's or the agent's edit, made from elsewhere.
        step({ changes: [[from, to, edit.insert]], origin: 'external', t })
        continue
      }
      step({ select: [[to, from]], t })
      if (to > from) {
        t += 80 + Math.floor(random() * 200)
        step(random() < 0.4 ? { cut: true, t } : { command: 'deleteCharBackward', t })
      }
      if (!edit.insert) continue
      if (edit.insert.length > 300 && random() < 0.6) {
        t += 300
        step({ paste: edit.insert, t })
        continue
      }
      for (const piece of typedPieces(edit.insert, 12 + Math.floor(random() * 30))) {
        t += 30 + Math.floor(random() * 150)
        step({ insert: piece, t })
      }
    }
    t += 500
    step({ expect: expectOf(Text.of(next)), t })
    // Now and then, take a few steps back and forward again, as people do to look at what they changed.
    if (index % 3 === 0 && replayer.state.history.done.length) {
      const back = 1 + Math.floor(random() * 3)
      for (let undo = 0; undo < back; undo++) step({ command: 'undo', t: (t += 400) })
      step({ expect: expectOf(replayer.state.doc), t: (t += 10) })
      for (let redo = 0; redo < back; redo++) step({ command: 'redo', t: (t += 400) })
      step({ expect: expectOf(Text.of(next)), t: (t += 10) })
    }
  }
  return { ...header, steps }
}

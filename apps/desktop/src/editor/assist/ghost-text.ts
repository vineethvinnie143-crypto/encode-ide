import type { EditorState, Transaction } from '@encode/editor'
import { LONG_LINE } from '@encode/editor-view'
import type { Text } from '@encode/text'
import { INLINE_PREFIX_CHARS, INLINE_SNIPPET_CHARS, INLINE_SNIPPETS, INLINE_SUFFIX_CHARS, headToLine, tailFromLine, type InlineState } from '@shared/inline'
import { isWordText } from './completion'

/** Typing waits this long before a suggestion is asked for, so a fast typist sends one question, not one per key. */
export const GHOST_MS = 300

/** A suggestion drawn at `pos` as if it were typed there. */
export interface Ghost {
  pos: number
  text: string
}

// ------------------------------------------------------------------ what is asked

/** The text around `pos` a suggestion is asked with, cut to what the main process takes, and whether it may run over lines. */
export function contextAt(state: EditorState, pos: number): { prefix: string; suffix: string; multiline: boolean } {
  const doc = state.doc
  // A little more than is sent, so the cut can go back to the start of a line.
  const prefix = tailFromLine(doc.sliceString(Math.max(0, pos - INLINE_PREFIX_CHARS - 1_000), pos), INLINE_PREFIX_CHARS)
  const suffix = headToLine(doc.sliceString(pos, Math.min(doc.length, pos + INLINE_SUFFIX_CHARS + 1_000)), INLINE_SUFFIX_CHARS)
  const line = doc.lineAt(pos)
  return { prefix, suffix, multiline: !line.text.slice(pos - line.from).trim() }
}

/**
 * Whether a suggestion fits where the cursor is: one cursor and nothing selected, in a file that can be typed in, on a
 * line short enough to draw, and not in the middle of a word (the rest of a word is what the list of suggestions does).
 */
export function suggestibleAt(state: EditorState): boolean {
  if (state.config.readOnly) return false
  const { ranges, main } = state.selection
  if (ranges.length !== 1 || !main.empty) return false
  const line = state.doc.lineAt(main.head)
  if (line.to - line.from > LONG_LINE) return false
  const next = Array.from(line.text.slice(main.head - line.from, main.head - line.from + 2))[0]
  return !next || !isWordText(state, next)
}

const WORD = /[\p{L}\p{N}_$]{2,}/gu
/** The lines before the cursor a part of another file is compared with. */
const NEAR_LINES = 20
/** The parts of other files compared: this many lines, starting every `STEP` lines. */
const WINDOW_LINES = 30
const STEP_LINES = 10
/** At most this many lines of another file are looked at, and this many files. */
const SCANNED_LINES = 3_000
const SCANNED_FILES = 12
/** How alike a part must be (shared words over all words) to go with the question. */
const ALIKE = 0.12

function wordsOf(text: string): Set<string> {
  const words = new Set<string>()
  for (const match of text.matchAll(WORD)) words.add(match[0])
  return words
}

function likeness(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let both = 0
  for (const word of a) if (b.has(word)) both++
  return both / (a.size + b.size - both)
}

interface Part {
  text: string
  words: Set<string>
}

/** The parts of each document, worked out once per version of it. */
const partsCache = new WeakMap<Text, Part[]>()

function partsOf(doc: Text): Part[] {
  const known = partsCache.get(doc)
  if (known) return known
  const lines = Math.min(doc.lineCount, SCANNED_LINES)
  const parts: Part[] = []
  for (let first = 1; first <= lines; first += STEP_LINES) {
    const last = Math.min(lines, first + WINDOW_LINES - 1)
    const text = doc.sliceString(doc.line(first).from, doc.line(last).to)
    parts.push({ text, words: wordsOf(text) })
    if (last === lines) break
  }
  partsCache.set(doc, parts)
  return parts
}

/**
 * The parts of other open files most like the code just before the cursor: the best part of each file, the most alike
 * first, at most a few of them. They show the model the names and the style the file's neighbours use.
 */
export function pickSnippets(prefix: string, others: readonly { path: string; doc: Text }[]): { path: string; text: string }[] {
  const near = wordsOf(prefix.split('\n').slice(-NEAR_LINES).join('\n'))
  if (!near.size) return []
  const best: { path: string; text: string; score: number }[] = []
  for (const { path, doc } of others.slice(0, SCANNED_FILES)) {
    let top: { text: string; score: number } | null = null
    for (const part of partsOf(doc)) {
      const score = likeness(near, part.words)
      if (score >= ALIKE && (!top || score > top.score)) top = { text: part.text, score }
    }
    if (top) best.push({ path, text: headToLine(top.text, INLINE_SNIPPET_CHARS) || top.text.slice(0, INLINE_SNIPPET_CHARS), score: top.score })
  }
  return best
    .sort((a, b) => b.score - a.score)
    .slice(0, INLINE_SNIPPETS)
    .map(({ path, text }) => ({ path, text }))
}

// ------------------------------------------------------------------ what is shown

/**
 * The ghost after a transaction: typing what it starts with, or taking a part of it, leaves the rest at the cursor;
 * anything else ends it, as does a cursor moved off it.
 */
export function followGhost(ghost: Ghost, tr: Transaction): Ghost | null {
  const { ranges, main } = tr.state.selection
  if (ranges.length !== 1 || !main.empty) return null
  if (!tr.docChanged) return main.head === ghost.pos ? ghost : null
  if (tr.origin !== 'input.type' && tr.origin !== 'input.ghost') return null
  const changes = tr.changes.changes
  if (changes.length !== 1) return null
  const [change] = changes
  if (change.from !== ghost.pos || change.to !== ghost.pos || !change.insert || !ghost.text.startsWith(change.insert)) return null
  const pos = ghost.pos + change.insert.length
  const text = ghost.text.slice(change.insert.length)
  return text && main.head === pos ? { pos, text } : null
}

/**
 * The part of a suggestion Ctrl+Right takes: a line break and the next line's indentation, or the spaces and the word
 * or the run of other characters that come first.
 */
export function nextWord(text: string): string {
  const match = /^(?:\n[ \t]*|[ \t]*(?:[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+)|[ \t]+)/u.exec(text)
  return match ? match[0] : Array.from(text)[0] ?? ''
}

/** Answers kept for the places they were asked for, so going back to one (an undo, Esc and typing again) asks nothing. */
export class GhostCache {
  private readonly entries = new Map<string, string>()

  constructor(private readonly size = 32) {}

  static key(path: string, prefix: string, suffix: string): string {
    return `${path}\u0000${prefix.slice(-600)}\u0000${suffix.slice(0, 120)}`
  }

  get(key: string): string | undefined {
    const text = this.entries.get(key)
    if (text === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, text)
    return text
  }

  set(key: string, text: string): void {
    this.entries.delete(key)
    this.entries.set(key, text)
    while (this.entries.size > this.size) this.entries.delete(this.entries.keys().next().value!)
  }

  clear(): void {
    this.entries.clear()
  }
}

/** How the suggestions stand, for the editor's status line. */
export type GhostStatus =
  | { kind: 'idle' }
  | { kind: 'asking' }
  /** The model cannot answer for now: `message` says why, `until` when trying again may help. */
  | { kind: 'paused'; message: string; until?: number }
  /** Only a change of settings helps (a key refused, no model): nothing is asked until one. */
  | { kind: 'stopped'; message: string }

/** The status line's button for the suggestions: none while they are off, else how they stand and why, in words. */
export function ghostFooter(status: GhostStatus, state: InlineState | null): { text: string; title: string; tone: 'idle' | 'busy' | 'warning' | 'danger' } | null {
  if (!state?.on) return null
  switch (status.kind) {
    case 'asking':
      return { text: '', title: 'Asking the model for a suggestion…', tone: 'busy' }
    case 'paused':
      return { text: 'Paused', title: `Suggestions as you type are paused. ${status.message}`, tone: 'warning' }
    case 'stopped':
      return { text: 'Stopped', title: `Suggestions as you type stopped. ${status.message} They start again once the settings change.`, tone: 'danger' }
    default:
      return { text: '', title: `Suggestions as you type are on. ${state.reason} Alt+\\ asks at once. Click for the settings.`, tone: 'idle' }
  }
}

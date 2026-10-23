import { DecorationSet, type LineSpec, type MarkSpec } from '@encode/editor-view'
import type { Text } from '@encode/text'
import type { CodeDiagnostic, FileMarks } from '@shared/types'
import { create } from '../store'

export interface ProblemCount {
  errors: number
  warnings: number
  /** Notes and hints. */
  others: number
}

interface ProblemsStore {
  /** By path in the open folder; a file without problems has no entry. */
  counts: Record<string, ProblemCount>
}

/** How many problems each file has, for the editor's footer: only counts, so typing never renders the app for it. */
export const useProblems = create<ProblemsStore>(() => ({ counts: {} }))

/** The problems the language servers found, by path in the open folder, as last said. */
const marks = new Map<string, readonly CodeDiagnostic[]>()
const listeners = new Set<(path: string) => void>()

const SEVERITY_ORDER: Record<CodeDiagnostic['severity'], number> = { error: 0, warning: 1, info: 2, hint: 3 }

function countOf(items: readonly CodeDiagnostic[]): ProblemCount {
  const count = { errors: 0, warnings: 0, others: 0 }
  for (const item of items) {
    if (item.severity === 'error') count.errors++
    else if (item.severity === 'warning') count.warnings++
    else count.others++
  }
  return count
}

/** What a server says of a file now; an empty list takes the file's marks away. */
export function setMarks({ path, diagnostics }: FileMarks): void {
  const before = marks.get(path)
  if (!diagnostics.length && !before) return
  if (diagnostics.length) marks.set(path, diagnostics)
  else marks.delete(path)
  const counts = { ...useProblems.getState().counts }
  if (diagnostics.length) counts[path] = countOf(diagnostics)
  else delete counts[path]
  useProblems.setState({ counts })
  for (const listener of [...listeners]) listener(path)
}

/** The folder closed or changed: its marks go with it. */
export function clearMarks(): void {
  const paths = [...marks.keys()]
  marks.clear()
  useProblems.setState({ counts: {} })
  for (const path of paths) for (const listener of [...listeners]) listener(path)
}

export function marksOf(path: string): readonly CodeDiagnostic[] {
  return marks.get(path) ?? []
}

/** Calls back with the path whose marks changed. Returns the way to stop. */
export function onMarksChanged(listener: (path: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A line and a UTF-16 column, zero-based, as a position in the document; past the end of a line is its end. */
export function positionOf(doc: Text, line: number, character: number): number {
  if (line >= doc.lineCount) return doc.length
  const at = doc.line(Math.max(0, line) + 1)
  return Math.min(at.to, at.from + Math.max(0, character))
}

/** The range a mark covers: at least one character where the line has one, so an empty range can still be seen. */
export function rangeOf(doc: Text, item: CodeDiagnostic): { from: number; to: number } {
  let from = positionOf(doc, item.line, item.character)
  let to = Math.max(from, positionOf(doc, item.endLine, item.endCharacter))
  if (from === to) {
    const line = doc.lineAt(from)
    if (to < line.to) to++
    else if (from > line.from) from--
  }
  return { from, to }
}

/** The marks as the editor draws them: a wavy line under each problem, and the line number in the colour of the worst. */
export function decorationsOf(doc: Text, items: readonly CodeDiagnostic[]): DecorationSet {
  const spans: MarkSpec[] = []
  const worst = new Map<number, CodeDiagnostic['severity']>()
  // Errors drawn last, so they show over a warning on the same text.
  const sorted = [...items].sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity])
  for (const item of sorted) {
    const { from, to } = rangeOf(doc, item)
    // A hint is a suggestion, not a problem: it gets no line under it.
    if (item.severity !== 'hint') spans.push({ from, to, className: `enc-squiggle-${item.severity}` })
    const number = doc.lineAt(from).number
    const known = worst.get(number)
    if (!known || SEVERITY_ORDER[item.severity] < SEVERITY_ORDER[known]) worst.set(number, item.severity)
  }
  const gutter: LineSpec[] = []
  for (const [line, severity] of worst) if (severity === 'error' || severity === 'warning') gutter.push({ line, className: `enc-gutter-${severity}` })
  return DecorationSet.of(doc, { marks: spans.sort((a, b) => a.from - b.from), gutter })
}

/** The problems over a position, worst first. */
export function marksAt(doc: Text, items: readonly CodeDiagnostic[], pos: number): CodeDiagnostic[] {
  return items
    .filter((item) => {
      const { from, to } = rangeOf(doc, item)
      return pos >= from && pos <= to
    })
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

/** The problems that start on a line (1-based), worst first: what the gutter's mark stands for. */
export function marksOnLine(doc: Text, items: readonly CodeDiagnostic[], line: number): CodeDiagnostic[] {
  return items.filter((item) => doc.lineAt(rangeOf(doc, item).from).number === line).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

/** "TS2304" or "eslint(no-unused-vars)": who said it, for the end of the message. */
export function sourceOf(item: CodeDiagnostic): string {
  if (item.source && item.code) return `${item.source}(${item.code})`
  return item.source ?? item.code ?? ''
}

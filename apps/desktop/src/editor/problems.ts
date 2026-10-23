import type { CodeDiagnostic } from '@shared/types'
import { sourceOf } from './marks'

/** A place as the servers count: zero-based line, UTF-16 column. */
interface At {
  line: number
  character: number
}

const compare = (a: At, b: At): number => a.line - b.line || a.character - b.character

/** A file's problems in the order they come in the text; at one place, the worst first. */
export function inTextOrder(items: readonly CodeDiagnostic[]): CodeDiagnostic[] {
  const rank: Record<CodeDiagnostic['severity'], number> = { error: 0, warning: 1, info: 2, hint: 3 }
  return [...items].sort((a, b) => compare(a, b) || rank[a.severity] - rank[b.severity])
}

/**
 * The problem F8 (`direction` 1) or Shift+F8 (-1) goes to from a place: the next one in this file after it, then the
 * first of the next file with problems, wrapping round. Hints are suggestions, not problems, and are passed over.
 * `files` are in path order; `from` null starts before the first file.
 */
export function problemFrom(
  files: readonly (readonly [string, readonly CodeDiagnostic[]])[],
  from: ({ path: string } & At) | null,
  direction: 1 | -1,
): { path: string; item: CodeDiagnostic } | null {
  const lists = files.map(([path, items]) => [path, inTextOrder(items.filter((item) => item.severity !== 'hint'))] as const).filter(([, items]) => items.length)
  if (!lists.length) return null
  const index = from ? lists.findIndex(([path]) => path === from.path) : -1
  if (from && index >= 0) {
    const [path, items] = lists[index]
    const found = direction === 1 ? items.find((item) => compare(item, from) > 0) : [...items].reverse().find((item) => compare(item, from) < 0)
    if (found) return { path, item: found }
  }
  // The file after (or before) this one, by path, also when this one has no problems.
  let next: number
  if (index >= 0) next = (index + direction + lists.length) % lists.length
  else if (from) {
    const after = lists.findIndex(([path]) => path > from.path)
    next = direction === 1 ? (after === -1 ? 0 : after) : (after === -1 ? lists.length - 1 : (after - 1 + lists.length) % lists.length)
  } else next = direction === 1 ? 0 : lists.length - 1
  const [path, items] = lists[next]
  return { path, item: direction === 1 ? items[0] : items[items.length - 1] }
}

export type Severity = 'errors' | 'warnings' | 'others'

const severityOf = (item: CodeDiagnostic): Severity => (item.severity === 'error' ? 'errors' : item.severity === 'warning' ? 'warnings' : 'others')

/** The problems of the folder's files to list: the severities shown, and the words typed in the filter. */
export function filterProblems(
  files: readonly (readonly [string, readonly CodeDiagnostic[]])[],
  shown: Record<Severity, boolean>,
  filter: string,
): { path: string; items: CodeDiagnostic[] }[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = (path: string, item: CodeDiagnostic) => {
    if (!words.length) return true
    const text = `${item.message} ${sourceOf(item)} ${path}`.toLowerCase()
    return words.every((word) => text.includes(word))
  }
  return files
    .map(([path, items]) => ({ path, items: inTextOrder(items).filter((item) => shown[severityOf(item)] && matches(path, item)) }))
    .filter((file) => file.items.length)
}

/**
 * What Go to file is asked for, read from what is typed: a file by name (with ":12" for a line in it), "@" a symbol of
 * the file shown, "#" a symbol of the folder, ":" a line. Pure, so the rules are unit tested.
 */
import type { EditorSymbolMatch } from '@shared/types'
import { matchScore, normalize } from './model'

export interface LineAsk {
  /** One-based, as people count lines. */
  line: number
  column?: number
}

export type QuickOpenMode =
  | { kind: 'file'; text: string; at?: LineAsk }
  | { kind: 'symbol'; text: string }
  | { kind: 'folderSymbol'; text: string }
  /** `at` is missing while what follows the ":" is no line number. */
  | { kind: 'line'; text: string; at?: LineAsk }

/** "12", "12:5" or "12,5", spaces allowed around the parts; undefined for anything else. */
export function parseLine(text: string): LineAsk | undefined {
  const match = /^\s*(\d{1,9})(?:\s*[:,]\s*(\d{1,9}))?\s*$/.exec(text)
  if (!match) return undefined
  const line = Number(match[1])
  if (line < 1) return undefined
  const column = match[2] === undefined ? undefined : Number(match[2])
  return column && column >= 1 ? { line, column } : { line }
}

export function quickOpenMode(query: string): QuickOpenMode {
  const lead = query.trimStart()
  if (lead.startsWith('@')) return { kind: 'symbol', text: lead.slice(1).trim() }
  if (lead.startsWith('#')) return { kind: 'folderSymbol', text: lead.slice(1).trim() }
  if (lead.startsWith(':')) {
    const at = parseLine(lead.slice(1))
    return at ? { kind: 'line', text: lead.slice(1).trim(), at } : { kind: 'line', text: lead.slice(1).trim() }
  }
  // "app.ts:12": the file, then that line in it.
  const withLine = /^(.*?[^\s:]):(\d{1,9})(?::(\d{1,9}))?\s*$/.exec(lead)
  if (withLine) {
    const at = parseLine(withLine[3] ? `${withLine[2]}:${withLine[3]}` : withLine[2])
    if (at) return { kind: 'file', text: withLine[1].trim(), at }
  }
  return { kind: 'file', text: lead.trim() }
}

/** The most folder symbols the list shows. */
export const MAX_FOLDER_SYMBOLS = 200

/**
 * The folder's symbols a server found, best first: the names the query spells, then those it finds with what they are
 * in. A symbol the server found that the query does not spell is kept, after the rest: servers match in their own ways.
 */
export function rankFolderSymbols(matches: readonly EditorSymbolMatch[], query: string): EditorSymbolMatch[] {
  const q = normalize(query)
  const scored = matches.map((match, index) => {
    if (!q) return { match, score: 0, index }
    // A name the query spells comes before one found only with what it is in ("shape area").
    const own = matchScore(q, match.name)
    const whole = match.container ? matchScore(q, `${match.container} ${match.name}`) : -1
    return { match, score: own >= 0 ? own + 1000 : whole, index }
  })
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_FOLDER_SYMBOLS)
    .map((entry) => entry.match)
}

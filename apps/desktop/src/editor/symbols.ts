/**
 * A file's symbols as the editor shows them: the chain the breadcrumbs show for the cursor, the outline sorted and
 * filtered, the flat list Go to symbol searches, and how each kind is drawn. Pure functions over the tree the
 * language servers give (EditorSymbol), so the rules are unit tested.
 */
import type { EditorSymbol } from '@shared/types'
import { matchScore, normalize } from '../palette/model'

export interface Spot {
  line: number
  character: number
}

const before = (a: Spot, b: Spot): number => a.line - b.line || a.character - b.character

/** Whether a symbol's range holds a position, its two ends included. */
export function symbolHolds(symbol: EditorSymbol, at: Spot): boolean {
  return before(symbol.range.start, at) <= 0 && before(at, symbol.range.end) <= 0
}

/** The symbols that hold a position, outermost first: what the breadcrumbs show after the file. */
export function symbolPath(symbols: readonly EditorSymbol[], at: Spot): EditorSymbol[] {
  const path: EditorSymbol[] = []
  let level: readonly EditorSymbol[] | undefined = symbols
  while (level?.length) {
    // The last of the ones that hold it: of two that touch, the one that starts at the position.
    let found: EditorSymbol | undefined
    for (const symbol of level) if (symbolHolds(symbol, at)) found = symbol
    if (!found) break
    path.push(found)
    level = found.children
  }
  return path
}

/** A symbol of the flat list Go to symbol searches: with the names of the symbols it is in, and how deep it is. */
export interface FlatSymbol {
  symbol: EditorSymbol
  /** "Shape.area": the symbols it is in, outermost first. Empty at the top. */
  container: string
  depth: number
}

/** Every symbol of the tree in the order of the text. */
export function flattenSymbols(symbols: readonly EditorSymbol[]): FlatSymbol[] {
  const out: FlatSymbol[] = []
  const walk = (items: readonly EditorSymbol[], names: string[]) => {
    for (const symbol of items) {
      out.push({ symbol, container: names.join('.'), depth: names.length })
      if (symbol.children) walk(symbol.children, [...names, symbol.name])
    }
  }
  walk(symbols, [])
  return out
}

/**
 * The symbols a query finds, best first; the order of the text when the query is empty or two match as well. A
 * query of two parts ("shape area") finds a symbol by its name and the symbol it is in.
 */
export function findSymbols(symbols: readonly EditorSymbol[], query: string): FlatSymbol[] {
  const flat = flattenSymbols(symbols)
  const q = normalize(query)
  if (!q) return flat
  const scored: { item: FlatSymbol; score: number; index: number }[] = []
  flat.forEach((item, index) => {
    // A name the query spells comes before one found only with what it is in.
    const own = matchScore(q, item.symbol.name)
    const whole = item.container ? matchScore(q, `${item.container} ${item.symbol.name}`) : -1
    const score = own >= 0 ? own + 1000 : whole
    if (score >= 0) scored.push({ item, score, index })
  })
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.item)
}

/** A part of the breadcrumbs. A folder and the file list what is beside them; a symbol, the symbols beside it. */
export type Segment =
  | { kind: 'folder'; label: string; path: string; parent: string }
  | { kind: 'file'; label: string; path: string; parent: string }
  | { kind: 'symbol'; symbol: EditorSymbol; siblings: readonly EditorSymbol[] }
  /** After the last part: what it holds (the file's symbols when the cursor is in none). */
  | { kind: 'children'; children: readonly EditorSymbol[] }

/** The parts for a file and the symbols the cursor is in. */
export function segmentsOf(path: string, symbols: readonly EditorSymbol[] | null, chain: readonly EditorSymbol[]): Segment[] {
  const parts = path.split('/')
  const out: Segment[] = parts.slice(0, -1).map((label, index) => ({ kind: 'folder', label, path: parts.slice(0, index + 1).join('/'), parent: parts.slice(0, index).join('/') }))
  out.push({ kind: 'file', label: parts[parts.length - 1], path, parent: parts.slice(0, -1).join('/') })
  chain.forEach((symbol, index) => out.push({ kind: 'symbol', symbol, siblings: index === 0 ? (symbols ?? []) : (chain[index - 1].children ?? []) }))
  const inner = chain.length ? chain[chain.length - 1].children : symbols
  if (inner?.length) out.push({ kind: 'children', children: inner })
  return out
}

export type OutlineSort = 'position' | 'name' | 'kind'

/** The order each kind comes in when the outline is sorted by kind: the types first, then what they hold. */
const KIND_ORDER = ['module', 'namespace', 'package', 'file', 'class', 'struct', 'interface', 'enum', 'type parameter', 'constructor', 'method', 'function', 'property', 'field', 'enum member', 'event', 'operator', 'constant', 'variable']

/** The outline in the order asked for, at every level; the server's order (the text's) is the position order. */
export function sortOutline(symbols: readonly EditorSymbol[], by: OutlineSort): EditorSymbol[] {
  const sorted = by === 'position' ? [...symbols].sort((a, b) => before(a.range.start, b.range.start)) : [...symbols]
  if (by === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || before(a.range.start, b.range.start))
  if (by === 'kind') {
    const rank = (kind: string) => {
      const at = KIND_ORDER.indexOf(kind)
      return at < 0 ? KIND_ORDER.length : at
    }
    sorted.sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
  }
  return sorted.map((symbol) => (symbol.children ? { ...symbol, children: sortOutline(symbol.children, by) } : symbol))
}

/** The outline cut to what a filter finds: a symbol stays when its name matches, or one under it does. */
export function filterOutline(symbols: readonly EditorSymbol[], query: string): EditorSymbol[] {
  const q = normalize(query)
  if (!q) return [...symbols]
  const out: EditorSymbol[] = []
  for (const symbol of symbols) {
    const children = symbol.children ? filterOutline(symbol.children, q) : []
    if (matchScore(q, symbol.name) < 0 && !children.length) continue
    const { children: _all, ...own } = symbol
    out.push(children.length ? { ...own, children } : own)
  }
  return out
}

/** A stable key for a symbol in its tree: the names and starts of it and the symbols it is in. */
export function symbolKey(path: readonly EditorSymbol[]): string {
  return path.map((symbol) => `${symbol.name}@${symbol.range.start.line}:${symbol.range.start.character}`).join('/')
}

export type SymbolTone = 'function' | 'type' | 'interface' | 'enum' | 'value' | 'constant' | 'module' | 'other'

/** How a kind is drawn: a letter on a tinted tile, the tint by what the kind is. */
export function symbolGlyph(kind: string): { letter: string; tone: SymbolTone } {
  switch (kind) {
    case 'function':
    case 'method':
    case 'constructor':
    case 'operator':
      return { letter: kind === 'method' ? 'm' : kind === 'constructor' ? 'c' : kind === 'operator' ? 'o' : 'f', tone: 'function' }
    case 'class':
    case 'struct':
      return { letter: kind === 'struct' ? 'S' : 'C', tone: 'type' }
    case 'interface':
    case 'type parameter':
      return { letter: kind === 'interface' ? 'I' : 'T', tone: 'interface' }
    case 'enum':
    case 'enum member':
      return { letter: kind === 'enum' ? 'E' : 'e', tone: 'enum' }
    case 'variable':
    case 'property':
    case 'field':
    case 'key':
    case 'event':
      return { letter: kind === 'property' ? 'p' : kind === 'field' ? 'f' : kind === 'key' ? 'k' : kind === 'event' ? 'e' : 'v', tone: 'value' }
    case 'constant':
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
      return { letter: 'K', tone: 'constant' }
    case 'module':
    case 'namespace':
    case 'package':
    case 'file':
      return { letter: kind === 'namespace' ? 'N' : 'M', tone: 'module' }
    default:
      return { letter: '·', tone: 'other' }
  }
}

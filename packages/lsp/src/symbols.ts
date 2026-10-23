/**
 * A document's symbols as the editor shows them: a tree, whatever shape the server answered in. A server that knows
 * the nesting sends a tree (DocumentSymbol); an older one sends a flat list (SymbolInformation), which is nested here
 * by range: a symbol goes under the last one before it whose range holds it.
 */
import { SYMBOL_KINDS, type DocumentSymbol, type Position, type Range } from './protocol'

/** A symbol of a document as the editor shows it (the outline, the breadcrumbs): its whole range, its name's, and what it holds. */
export interface EditorSymbol {
  name: string
  kind: string
  detail?: string
  range: Range
  /** The range of its name: where going to the symbol puts the cursor. */
  selection: Range
  children?: EditorSymbol[]
}

const before = (a: Position, b: Position): number => a.line - b.line || a.character - b.character

/** Whether `outer` holds `inner`, the same range included. */
export function holds(outer: Range, inner: Range): boolean {
  return before(outer.start, inner.start) <= 0 && before(inner.end, outer.end) <= 0
}

/** A server's tree, its kinds as names. */
export function fromDocumentSymbols(items: readonly DocumentSymbol[]): EditorSymbol[] {
  return items.map((item) => ({
    name: item.name,
    kind: SYMBOL_KINDS[item.kind] ?? 'symbol',
    ...(item.detail ? { detail: item.detail } : {}),
    range: item.range,
    // A name outside its symbol's range is a server's slip: the symbol's start stands in for it.
    selection: holds(item.range, item.selectionRange) ? item.selectionRange : { start: item.range.start, end: item.range.start },
    ...(item.children?.length ? { children: fromDocumentSymbols(item.children) } : {}),
  }))
}

/** A flat list nested by range, in the order of the text. Symbols that hold one another the same way stay in the order given. */
export function nestSymbols(items: readonly EditorSymbol[]): EditorSymbol[] {
  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => before(a.item.range.start, b.item.range.start) || before(b.item.range.end, a.item.range.end) || a.index - b.index)
  const roots: EditorSymbol[] = []
  const stack: EditorSymbol[] = []
  for (const { item } of sorted) {
    const node: EditorSymbol = { name: item.name, kind: item.kind, ...(item.detail ? { detail: item.detail } : {}), range: item.range, selection: item.selection }
    while (stack.length && !holds(stack[stack.length - 1].range, node.range)) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) (parent.children ??= []).push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}


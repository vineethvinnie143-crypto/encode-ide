/**
 * The call hierarchy as the peek shows it: the functions a server named, opened a level at a time, walked into the
 * rows on screen. Pure, so the rules are unit tested.
 */
import type { EditorCallFunction, EditorLocation } from '@shared/types'

export type CallDirection = 'incoming' | 'outgoing'

/** A function of the tree: one asked about at the top, then who calls it (or what it calls), as far as it was opened. */
export interface CallNode {
  key: string
  fn: EditorCallFunction
  /** Where the calls are: in the caller's file for callers, in the calling function's file for calls. None at the top. */
  sites: EditorLocation[]
}

/** What a function's level holds, once asked. */
export type CallChildren = { state: 'loading' } | { state: 'ready'; nodes: CallNode[] } | { state: 'failed'; reason: string }

export type CallRow =
  | { kind: 'node'; node: CallNode; depth: number; parent: string | null; open: boolean; known: CallChildren | undefined }
  | { kind: 'note'; key: string; depth: number; text: string; loading?: boolean }

/** The rows on screen: the functions in the order of the tree, under each open one what its question gave. */
export function callRows(roots: readonly CallNode[], open: ReadonlySet<string>, children: ReadonlyMap<string, CallChildren>, direction: CallDirection): CallRow[] {
  const rows: CallRow[] = []
  const walk = (nodes: readonly CallNode[], depth: number, parent: string | null) => {
    for (const node of nodes) {
      const known = children.get(node.key)
      const isOpen = open.has(node.key)
      rows.push({ kind: 'node', node, depth, parent, open: isOpen, known })
      if (!isOpen || !known) continue
      if (known.state === 'loading') rows.push({ kind: 'note', key: `${node.key}:loading`, depth: depth + 1, text: 'Asking the language server…', loading: true })
      else if (known.state === 'failed') rows.push({ kind: 'note', key: `${node.key}:failed`, depth: depth + 1, text: known.reason })
      else if (!known.nodes.length) rows.push({ kind: 'note', key: `${node.key}:none`, depth: depth + 1, text: direction === 'incoming' ? 'No callers found.' : 'No calls found.' })
      else walk(known.nodes, depth + 1, node.key)
    }
  }
  walk(roots, 0, null)
  return rows
}

/** Where a function's row takes the person: the first of its calls, or the function itself at the top. */
export const placeOfNode = (node: CallNode): EditorLocation => node.sites[0] ?? node.fn.at

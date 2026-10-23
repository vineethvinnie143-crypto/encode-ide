import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { EditorView } from '@encode/editor-view'
import type { EditorCallFunction, EditorLocation } from '@shared/types'
import { askServers } from '../../editor/assist/ask'
import { callRows, placeOfNode, type CallChildren, type CallDirection, type CallNode, type CallRow } from '../../editor/calls'
import { withOpenText } from '../../editor/assist/navigation'
import { cx } from '../../ui/cx'
import { ChevronDown, ChevronRight, Loader2, X } from '../../ui/icons'
import { PeekPreview, usePeekZone } from './Peek'
import { SymbolIcon } from './SymbolIcon'

/** A call hierarchy a server prepared for the symbol on `line` (1-based) of `path`, shown under that line. */
export interface CallsData {
  path: string
  /** The server's list of the functions it named, which later questions about them go by. */
  list: number
  items: EditorCallFunction[]
  line: number
}

const fileName = (location: EditorLocation): string => (location.path ?? location.file).split(/[\\/]/).pop() ?? location.file

/**
 * Who calls a function, or what it calls, between the lines of the editor under it: a tree opened a level at a time
 * (each level asks the server), the file of the call selected on the left. Arrows move through the tree, Right and Left
 * open and close a level, Enter goes to the call, Esc closes the peek and hands the keys back to the editor.
 */
export function CallsPeek({ view, calls, onOpen, onClose }: { view: EditorView; calls: CallsData; onOpen(location: EditorLocation): void; onClose(): void }) {
  const listRef = useRef<HTMLDivElement>(null)
  const zone = usePeekZone(view, 'calls', calls.line, calls, () => listRef.current?.focus())
  const [direction, setDirection] = useState<CallDirection>('incoming')
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [children, setChildren] = useState<ReadonlyMap<string, CallChildren>>(new Map())
  const roots = useMemo<CallNode[]>(() => calls.items.map((fn, index) => ({ key: String(index), fn, sites: [] })), [calls.items])
  const [selected, setSelected] = useState(roots[0]?.key ?? '')
  /** Grows with each switch between callers and calls, and with each hierarchy: an answer for an older one is dropped. */
  const generation = useRef(0)

  const expand = (node: CallNode, known = children) => {
    setOpen((now) => (now.has(node.key) ? now : new Set([...now, node.key])))
    if (known.has(node.key)) return
    const mine = generation.current
    setChildren((now) => new Map(now).set(node.key, { state: 'loading' }))
    void askServers({ kind: 'calls', path: calls.path, list: calls.list, id: node.fn.id, direction }).then((answer) => {
      if (mine !== generation.current) return
      const next: CallChildren =
        answer === null
          ? { state: 'failed', reason: 'The language server gave no answer. Open the call hierarchy again.' }
          : 'reason' in answer
            ? { state: 'failed', reason: answer.reason }
            : { state: 'ready', nodes: answer.calls.map((call, index) => ({ key: `${node.key}/${index}`, fn: call.item, sites: withOpenText(call.sites) })) }
      setChildren((now) => new Map(now).set(node.key, next))
    })
  }

  // A new hierarchy, or the other way round: the tree starts again with the first function opened.
  useEffect(() => {
    generation.current++
    const fresh = new Map<string, CallChildren>()
    setChildren(fresh)
    setOpen(new Set())
    setSelected(roots[0]?.key ?? '')
    if (roots[0]) expand(roots[0], fresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots, direction])

  const rows = useMemo(() => callRows(roots, open, children, direction), [roots, open, children, direction])
  const nodeRows = useMemo(() => rows.filter((row): row is Extract<CallRow, { kind: 'node' }> => row.kind === 'node'), [rows])
  const current = nodeRows.find((row) => row.node.key === selected) ?? nodeRows[0]
  const location = current ? placeOfNode(current.node) : undefined
  const also = useMemo(() => current?.node.sites.slice(1) ?? [], [current])

  useLayoutEffect(() => {
    listRef.current?.querySelector('.calls-row.is-selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const collapse = (key: string) => setOpen((now) => new Set([...now].filter((item) => item !== key)))

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (!current) return
    const at = nodeRows.indexOf(current)
    const handled = () => {
      event.preventDefault()
      event.stopPropagation()
    }
    const known = current.known
    if (event.key === 'ArrowDown') return (handled(), setSelected(nodeRows[Math.min(nodeRows.length - 1, at + 1)].node.key))
    if (event.key === 'ArrowUp') return (handled(), setSelected(nodeRows[Math.max(0, at - 1)].node.key))
    if (event.key === 'Home') return (handled(), setSelected(nodeRows[0].node.key))
    if (event.key === 'End') return (handled(), setSelected(nodeRows[nodeRows.length - 1].node.key))
    if (event.key === 'Enter' && location) return (handled(), onOpen(location))
    if (event.key === 'ArrowRight') {
      handled()
      if (!current.open) expand(current.node)
      else if (known?.state === 'ready' && known.nodes[0]) setSelected(known.nodes[0].key)
      return
    }
    if (event.key === 'ArrowLeft') {
      handled()
      if (current.open) collapse(current.node.key)
      else if (current.parent !== null) setSelected(current.parent)
    }
  }

  const root = calls.items[0]
  const title = direction === 'incoming' ? `Callers of ${root?.name ?? 'this function'}` : `Calls from ${root?.name ?? 'this function'}`

  return createPortal(
    <div
      className="peek calls-peek"
      // Esc in the preview closes the peek too; the keys of the tree stay in it.
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="peek-head">
        <span className="peek-title">{title}</span>
        <span className="calls-switch" role="group" aria-label="Show">
          {(['incoming', 'outgoing'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={cx('calls-switch-item', direction === value && 'is-on')}
              aria-pressed={direction === value}
              onClick={() => {
                if (value !== direction) setDirection(value)
                listRef.current?.focus()
              }}
            >
              {value === 'incoming' ? 'Callers' : 'Calls'}
            </button>
          ))}
        </span>
        <button type="button" className="peek-close" aria-label="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="peek-body">
        <PeekPreview location={location} also={also} />
        <div ref={listRef} className="peek-list calls-list" role="tree" aria-label={title} tabIndex={0} onKeyDown={onKeyDown}>
          {rows.map((row) => {
            if (row.kind === 'note') {
              return (
                <div key={row.key} className={cx('calls-note', row.loading && 'is-loading')} style={{ paddingLeft: 30 + row.depth * 14 }}>
                  {row.loading ? <Loader2 size={12} className="spin" aria-hidden="true" /> : null}
                  <span>{row.text}</span>
                </div>
              )
            }
            const { node } = row
            const empty = row.known?.state === 'ready' && !row.known.nodes.length
            const count = node.sites.length
            return (
              <div
                key={node.key}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={empty ? undefined : row.open}
                aria-selected={node.key === current?.node.key}
                className={cx('calls-row', node.key === current?.node.key && 'is-selected')}
                style={{ paddingLeft: 6 + row.depth * 14 }}
                title={`${node.fn.name}, ${node.fn.at.path ?? node.fn.at.file}:${node.fn.at.line + 1}`}
                onClick={() => setSelected(node.key)}
                onDoubleClick={() => onOpen(placeOfNode(node))}
              >
                <span
                  className="outline-twisty"
                  onClick={(event) => {
                    event.stopPropagation()
                    setSelected(node.key)
                    if (row.open) collapse(node.key)
                    else expand(node)
                  }}
                >
                  {empty ? null : row.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <SymbolIcon kind={node.fn.kind} />
                <span className="calls-name">{node.fn.name}</span>
                {node.fn.detail && node.fn.detail !== node.fn.name ? <span className="calls-detail">{node.fn.detail}</span> : null}
                <span className="calls-file">{fileName(node.fn.at)}</span>
                {count > 1 ? (
                  <span className="peek-file-count" title={`${count} calls`}>
                    {count}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    zone,
  )
}

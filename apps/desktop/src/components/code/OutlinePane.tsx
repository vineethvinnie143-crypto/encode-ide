import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { EditorSymbol } from '@shared/types'
import { goToPlace } from '../../editor/assist/navigation'
import { useOutline } from '../../editor/assist/outline'
import { filterOutline, sortOutline, symbolKey, symbolPath, type OutlineSort } from '../../editor/symbols'
import { OUTLINE_MAX, OUTLINE_MIN, useEditorLayout } from '../../stores/editor-layout'
import { cx } from '../../ui/cx'
import { ArrowDownUp, ChevronDown, ChevronRight, ChevronsDownUp, Crosshair, ListTree, Search, X } from '../../ui/icons'
import { Menu } from '../../ui/Menu'
import { SymbolIcon } from './SymbolIcon'

const SORTS: { value: OutlineSort; label: string }[] = [
  { value: 'position', label: 'By position' },
  { value: 'name', label: 'By name' },
  { value: 'kind', label: 'By kind' },
]

interface Row {
  key: string
  symbol: EditorSymbol
  depth: number
  parent: string | null
  open: boolean
  hasChildren: boolean
}

/** The rows on screen: the tree walked in order, a closed symbol's children left out (a filter shows everything it finds). */
function rowsOf(symbols: readonly EditorSymbol[], closed: ReadonlySet<string>, filtering: boolean): Row[] {
  const rows: Row[] = []
  const walk = (items: readonly EditorSymbol[], chain: EditorSymbol[], parent: string | null) => {
    for (const symbol of items) {
      const path = [...chain, symbol]
      const key = symbolKey(path)
      const hasChildren = Boolean(symbol.children?.length)
      const open = hasChildren && (filtering || !closed.has(key))
      rows.push({ key, symbol, depth: chain.length, parent, open, hasChildren })
      if (open) walk(symbol.children!, path, key)
    }
  }
  walk(symbols, [], null)
  return rows
}

/** Every key of a tree that has children: what Collapse all closes. */
function parentKeys(symbols: readonly EditorSymbol[]): string[] {
  const keys: string[] = []
  const walk = (items: readonly EditorSymbol[], chain: EditorSymbol[]) => {
    for (const symbol of items) {
      if (!symbol.children?.length) continue
      const path = [...chain, symbol]
      keys.push(symbolKey(path))
      walk(symbol.children, path)
    }
  }
  walk(symbols, [])
  return keys
}

/** Beside the text: the file's symbols as a tree, the one the cursor is in marked. A click goes to one. */
export function OutlinePane({ path }: { path: string }) {
  const symbols = useOutline((state) => (state.path === path ? state.symbols : null))
  const status = useOutline((state) => (state.path === path ? state.status : 'loading'))
  const at = useOutline((state) => state.at)
  const sort = useEditorLayout((state) => state.outlineSort)
  const follow = useEditorLayout((state) => state.outlineFollow)
  const width = useEditorLayout((state) => state.outlineWidth)
  const [filter, setFilter] = useState('')
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const [focused, setFocused] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const sorted = useMemo(() => (symbols ? sortOutline(symbols, sort) : []), [symbols, sort])
  const shown = useMemo(() => filterOutline(sorted, filter), [sorted, filter])
  const filtering = filter.trim().length > 0
  const rows = useMemo(() => rowsOf(shown, closed, filtering), [shown, closed, filtering])
  const current = useMemo(() => (symbols ? symbolPath(symbols, at) : []), [symbols, at])
  const currentKey = current.length ? symbolKey(current) : null

  // Another file: its own tree, opened.
  useEffect(() => {
    setClosed(new Set())
    setFilter('')
    setFocused(null)
  }, [path])

  // Following the cursor: the symbols it is in are opened, and its own row is brought into sight.
  useEffect(() => {
    if (!follow || !current.length) return
    const ancestors = current.slice(0, -1).map((_, index) => symbolKey(current.slice(0, index + 1)))
    setClosed((now) => (ancestors.some((key) => now.has(key)) ? new Set([...now].filter((key) => !ancestors.includes(key))) : now))
  }, [follow, currentKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!follow || !currentKey) return
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(currentKey)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [follow, currentKey, rows])

  const toggle = (key: string, open?: boolean) =>
    setClosed((now) => {
      const next = new Set(now)
      if (open ?? next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const go = (symbol: EditorSymbol) => goToPlace({ path, range: symbol.selection })

  const focusRow = (key: string | undefined) => {
    if (!key) return
    setFocused(key)
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.key === (document.activeElement as HTMLElement | null)?.dataset.key)
    if (index < 0) return
    const row = rows[index]
    const handled = () => event.preventDefault()
    if (event.key === 'ArrowDown') (handled(), focusRow(rows[Math.min(rows.length - 1, index + 1)]?.key))
    else if (event.key === 'ArrowUp') (handled(), focusRow(rows[Math.max(0, index - 1)]?.key))
    else if (event.key === 'Home') (handled(), focusRow(rows[0]?.key))
    else if (event.key === 'End') (handled(), focusRow(rows[rows.length - 1]?.key))
    else if (event.key === 'ArrowRight') {
      handled()
      if (row.hasChildren && !row.open) toggle(row.key, true)
      else if (row.open) focusRow(rows[index + 1]?.key)
    } else if (event.key === 'ArrowLeft') {
      handled()
      if (row.open && !filtering) toggle(row.key, false)
      else if (row.parent) focusRow(row.parent)
    } else if (event.key === 'Enter') (handled(), go(row.symbol))
  }

  // The left edge widens or narrows the outline; a double click puts it back.
  const onResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => {
      const value = Math.min(OUTLINE_MAX, Math.max(OUTLINE_MIN, startWidth + startX - next.clientX))
      useEditorLayout.getState().set({ outlineWidth: value })
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  const tabStop = rows.some((row) => row.key === focused) ? focused : (currentKey && rows.some((row) => row.key === currentKey) ? currentKey : rows[0]?.key)

  return (
    <aside className="outline-pane" style={{ width }} aria-label="Outline">
      <div
        className="outline-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Outline width"
        aria-valuemin={OUTLINE_MIN}
        aria-valuemax={OUTLINE_MAX}
        aria-valuenow={width}
        onPointerDown={onResize}
        onDoubleClick={() => useEditorLayout.getState().set({ outlineWidth: 248 })}
      />
      <div className="outline-head">
        <span className="outline-title">Outline</span>
        <span className="outline-tools">
          <button
            type="button"
            className={cx('outline-tool', follow && 'is-on')}
            aria-pressed={follow}
            title={follow ? 'Stop following the cursor' : 'Follow the cursor'}
            aria-label="Follow the cursor"
            onClick={() => useEditorLayout.getState().set({ outlineFollow: !follow })}
          >
            <Crosshair size={14} />
          </button>
          <Menu
            label="Sort the outline"
            align="end"
            trigger={(props) => (
              <button type="button" className="outline-tool" title="Sort" aria-label="Sort" {...props}>
                <ArrowDownUp size={14} />
              </button>
            )}
            entries={SORTS.map((item) => ({ id: `sort-${item.value}`, label: item.label, checked: sort === item.value, onSelect: () => useEditorLayout.getState().set({ outlineSort: item.value }) }))}
          />
          <button type="button" className="outline-tool" title="Collapse all" aria-label="Collapse all" onClick={() => setClosed(new Set(parentKeys(sorted)))}>
            <ChevronsDownUp size={14} />
          </button>
          <button type="button" className="outline-tool" title="Hide the outline" aria-label="Hide the outline" onClick={() => useEditorLayout.getState().set({ outline: false })}>
            <X size={14} />
          </button>
        </span>
      </div>
      <label className="outline-filter">
        <Search size={13} aria-hidden="true" />
        <input value={filter} placeholder="Filter symbols" aria-label="Filter symbols" spellCheck={false} onChange={(event) => setFilter(event.target.value)} />
      </label>
      {status === 'loading' && !symbols ? (
        <div className="outline-empty">Reading the outline…</div>
      ) : status === 'none' ? (
        <div className="outline-empty">
          <ListTree size={18} />
          <span>No language server gives this file an outline. Settings → Language servers shows which ones run.</span>
        </div>
      ) : !sorted.length ? (
        <div className="outline-empty">This file has no symbols.</div>
      ) : !rows.length ? (
        <div className="outline-empty">No symbols match.</div>
      ) : (
        <div ref={listRef} className="outline-tree" role="tree" aria-label="Symbols" onKeyDown={onKeyDown}>
          {rows.map((row) => (
            <div
              key={row.key}
              data-key={row.key}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={row.hasChildren ? row.open : undefined}
              aria-selected={row.key === currentKey}
              tabIndex={row.key === tabStop ? 0 : -1}
              className={cx('outline-row', row.key === currentKey && 'is-current')}
              style={{ paddingLeft: 6 + row.depth * 14 }}
              title={row.symbol.detail ? `${row.symbol.name} ${row.symbol.detail}` : row.symbol.name}
              onFocus={() => setFocused(row.key)}
              onClick={() => go(row.symbol)}
            >
              <span
                className={cx('outline-twisty', !row.hasChildren && 'is-leaf')}
                onClick={(event) => {
                  if (!row.hasChildren) return
                  event.stopPropagation()
                  toggle(row.key)
                }}
              >
                {row.hasChildren ? row.open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
              </span>
              <SymbolIcon kind={row.symbol.kind} />
              <span className="outline-name">{row.symbol.name}</span>
              {row.symbol.detail && <span className="outline-detail">{row.symbol.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}

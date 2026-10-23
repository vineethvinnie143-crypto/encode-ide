import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { EditorSymbol, FileEntry } from '@shared/types'
import { api } from '../../api'
import { activeEditor } from '../../editor/active'
import { goToPlace } from '../../editor/assist/navigation'
import { useOutline } from '../../editor/assist/outline'
import { segmentsOf, symbolPath, type Segment } from '../../editor/symbols'
import { useEditor } from '../../stores/editor'
import { useBreadcrumbsAsk } from '../../stores/editor-layout'
import { usePanels } from '../../stores/panels'
import { useWorkspace } from '../../stores/workspace'
import { cx } from '../../ui/cx'
import { ChevronRight, File, Folder } from '../../ui/icons'
import { MenuPanel, type MenuEntry } from '../../ui/Menu'
import { SymbolIcon } from './SymbolIcon'

/** A folder's list is long only in folders nobody browses this way; past this many the rest are left out. */
const MAX_ENTRIES = 300

/** A folder's entries, folders first, as the file list has them or read now. */
function useFolder(dir: string | null): FileEntry[] | 'loading' | 'failed' | null {
  const cached = useWorkspace((state) => (dir === null ? undefined : state.children[dir]))
  const [read, setRead] = useState<{ dir: string; entries: FileEntry[] | 'failed' } | null>(null)
  useEffect(() => {
    if (dir === null || cached) return
    let live = true
    api.workspace.list(dir).then(
      (entries) => live && setRead({ dir, entries }),
      () => live && setRead({ dir, entries: 'failed' }),
    )
    return () => {
      live = false
    }
  }, [dir, cached])
  if (dir === null) return null
  const entries = cached ?? (read?.dir === dir ? read.entries : 'loading')
  if (typeof entries === 'string') return entries
  return [...entries].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
}

interface Open {
  index: number
  /** A folder opened from inside the list: its entries are shown in place of the part's. */
  inside: string | null
  keyboard: boolean
}

/** Above the text: the file's folders, the file, and the symbols the cursor is in, each with a list of what is beside it. */
export function Breadcrumbs({ path }: { path: string }) {
  const symbols = useOutline((state) => (state.path === path ? state.symbols : null))
  const at = useOutline((state) => state.at)
  const chain = useMemo(() => (symbols ? symbolPath(symbols, at) : []), [symbols, at])
  const segments = useMemo(() => segmentsOf(path, symbols, chain), [path, symbols, chain])
  const [open, setOpen] = useState<Open | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])

  // The innermost part in sight: a long path scrolls, the end of it stays.
  useLayoutEffect(() => {
    const list = listRef.current
    if (list) list.scrollLeft = list.scrollWidth
  }, [segments])

  // Another file: a list that was open belongs to the one before.
  useEffect(() => setOpen(null), [path])

  const asked = useBreadcrumbsAsk((state) => state.asked)
  useEffect(() => {
    if (asked === useBreadcrumbsAsk.getState().handled) return
    useBreadcrumbsAsk.setState({ handled: asked })
    setOpen({ index: segments.length - 1, inside: null, keyboard: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked])

  const close = (refocus: boolean) => {
    setOpen(null)
    if (refocus) activeEditor()?.focus()
  }

  const segment = open ? segments[open.index] : undefined
  const folderOf = (item: Segment | undefined, inside: string | null): string | null => {
    if (inside !== null) return inside
    return item && (item.kind === 'folder' || item.kind === 'file') ? item.parent : null
  }
  const folder = useFolder(open ? folderOf(segment, open.inside) : null)

  const entries = useMemo<MenuEntry[]>(() => {
    if (!open || !segment) return []
    if (segment.kind === 'symbol' || segment.kind === 'children') {
      const list = segment.kind === 'symbol' ? segment.siblings : segment.children
      return list.slice(0, MAX_ENTRIES).map((symbol, index) => ({
        id: `symbol-${index}`,
        label: symbol.name,
        icon: <SymbolIcon kind={symbol.kind} />,
        ...(symbol.detail ? { trailing: symbol.detail.length > 40 ? `${symbol.detail.slice(0, 39)}…` : symbol.detail } : {}),
        ...(segment.kind === 'symbol' ? { checked: symbol === segment.symbol } : {}),
        onSelect: () => goToPlace({ path, range: symbol.selection }),
      }))
    }
    if (folder === 'loading') return [{ id: 'loading', label: 'Reading the folder…', disabled: true, onSelect: () => undefined }]
    if (folder === 'failed' || folder === null) return [{ id: 'failed', label: 'The folder could not be read.', disabled: true, onSelect: () => undefined }]
    const current = open.inside === null ? segment.path : null
    const shown: MenuEntry[] = folder.slice(0, MAX_ENTRIES).map((entry) => ({
      id: `entry-${entry.path}`,
      label: entry.name,
      icon: entry.isDir ? <Folder size={14} /> : <File size={14} />,
      ...(entry.isDir ? { trailing: '›' } : {}),
      checked: entry.path === current,
      onSelect: () => {
        if (entry.isDir) {
          // Into the folder, in the same list.
          setOpen({ index: open.index, inside: entry.path, keyboard: true })
          return
        }
        usePanels.getState().open('editor')
        void useEditor.getState().openFile(entry.path)
      },
    }))
    if (folder.length > MAX_ENTRIES) shown.push({ id: 'more', label: `${folder.length - MAX_ENTRIES} more, not listed`, disabled: true, onSelect: () => undefined })
    if (!shown.length) shown.push({ id: 'empty', label: 'This folder is empty.', disabled: true, onSelect: () => undefined })
    return shown
  }, [open, segment, folder, path])

  const anchor = open ? buttons.current[open.index]?.getBoundingClientRect() : undefined

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumbs">
      <ol ref={listRef} className="bc-list">
        {segments.map((item, index) => {
          const isOpen = open?.index === index
          const label = item.kind === 'symbol' ? item.symbol.name : item.kind === 'children' ? null : item.label
          return (
            <li key={item.kind === 'symbol' ? `s-${index}-${item.symbol.name}` : `${item.kind}-${index}`} className={cx('bc-part', `is-${item.kind}`)}>
              {index > 0 && item.kind !== 'children' && <ChevronRight size={12} className="bc-sep" aria-hidden="true" />}
              <button
                ref={(node) => {
                  buttons.current[index] = node
                }}
                type="button"
                className={cx('bc-item', isOpen && 'is-open')}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-label={item.kind === 'children' ? 'What it holds' : undefined}
                title={item.kind === 'folder' || item.kind === 'file' ? item.path : item.kind === 'symbol' ? `${item.symbol.kind} ${item.symbol.name}` : 'What it holds'}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setOpen(isOpen ? null : { index, inside: null, keyboard: false })}
              >
                {item.kind === 'folder' ? null : item.kind === 'file' ? <File size={13} className="bc-file-icon" /> : item.kind === 'symbol' ? <SymbolIcon kind={item.symbol.kind} /> : <ChevronRight size={12} />}
                {label !== null && <span className="bc-label">{label}</span>}
              </button>
            </li>
          )
        })}
      </ol>
      {open && anchor && (
        <MenuPanel
          key={`${open.index}:${open.inside ?? ''}`}
          entries={entries}
          anchor={{ left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height }}
          label={segment?.kind === 'symbol' || segment?.kind === 'children' ? 'Symbols' : 'Files'}
          start={open.keyboard ? 'checked' : 'none'}
          className="bc-menu"
          ignore={listRef}
          onClose={close}
          onHorizontal={(direction) => {
            const next = open.index + direction
            if (next >= 0 && next < segments.length) setOpen({ index: next, inside: null, keyboard: true })
          }}
        />
      )}
    </nav>
  )
}

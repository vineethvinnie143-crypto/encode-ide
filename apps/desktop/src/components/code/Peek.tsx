import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { EditorState, languageForPath } from '@encode/editor'
import { DecorationSet, EditorView } from '@encode/editor-view'
import type { EditorLocation } from '@shared/types'
import { api } from '../../api'
import { docState } from '../../editor/docs'
import { sharedHighlighting } from '../../editor/highlighting'
import { positionOf } from '../../editor/marks'
import { useEditorLayout } from '../../stores/editor-layout'
import { cx } from '../../ui/cx'
import { ChevronDown, ChevronRight, X } from '../../ui/icons'

/** The height of the peek between the lines. */
export const PEEK_HEIGHT = 300

/**
 * A zone between the lines of `view` under `line` (1-based), for a peek named `name`: brought into sight once placed,
 * then `focus` runs. It is placed again whenever `data` changes, and taken away with the peek.
 */
export function usePeekZone(view: EditorView, name: string, line: number, data: unknown, focus: () => void): HTMLDivElement {
  const zone = useMemo(() => {
    const element = document.createElement('div')
    element.className = 'enc-zone peek-zone'
    return element
  }, [])
  useLayoutEffect(() => {
    view.setZones(name, [{ after: line, height: PEEK_HEIGHT, dom: zone, fixed: true }])
    const doc = view.state.doc
    // The peek in sight: the line it is under near the top when it would run off the bottom.
    requestAnimationFrame(() => {
      const box = zone.getBoundingClientRect()
      const scroller = view.scroller.getBoundingClientRect()
      if (box.bottom > scroller.bottom) view.scroller.scrollTop += box.bottom - scroller.bottom + 8
      else if (box.top < scroller.top) view.scrollToPos(doc.line(Math.min(line, doc.lineCount)).from, false)
      focus()
    })
    return () => view.setZones(name, [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, zone, name, line, data])
  return zone
}

/** What a peek shows: the places a server named for the symbol on `line` (1-based), under that line. */
export interface PeekData {
  title: string
  locations: EditorLocation[]
  line: number
}

interface Group {
  key: string
  /** The path in the folder, or the whole path of a file outside it. */
  label: string
  inFolder: boolean
  items: { location: EditorLocation; index: number }[]
}

function groupsOf(locations: readonly EditorLocation[], current: string | null): Group[] {
  const groups = new Map<string, Group>()
  locations.forEach((location, index) => {
    const key = location.path ?? location.file
    let group = groups.get(key)
    if (!group) {
      group = { key, label: key, inFolder: location.path !== null, items: [] }
      groups.set(key, group)
    }
    group.items.push({ location, index })
  })
  const list = [...groups.values()]
  for (const group of list) group.items.sort((a, b) => a.location.line - b.location.line || a.location.character - b.location.character)
  // The file being edited first, then the rest as the server listed them.
  return list.sort((a, b) => Number(b.key === current) - Number(a.key === current))
}

/** A line of a place with the part the server named set apart; the indentation is left out. */
function PreviewLine({ location }: { location: EditorLocation }) {
  const text = location.preview ?? ''
  const lead = text.length - text.trimStart().length
  const shown = text.slice(lead)
  const from = location.character - lead
  const to = location.endLine === location.line ? location.endCharacter - lead : shown.length
  if (!shown) return <span className="peek-line-text is-empty">{location.preview === undefined ? '' : '(empty line)'}</span>
  if (from < 0 || from >= shown.length || to <= from) return <span className="peek-line-text">{shown}</span>
  return (
    <span className="peek-line-text">
      {shown.slice(0, from)}
      <b>{shown.slice(from, Math.min(to, shown.length))}</b>
      {shown.slice(Math.min(to, shown.length))}
    </span>
  )
}

/** The file a place is in, read-only, scrolled to it with the place marked, and the other places of `also` in that file. */
export function PeekPreview({ location, also }: { location: EditorLocation | undefined; also?: readonly EditorLocation[] }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [missing, setMissing] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // A glimpse of a file: no folding, pinned lines or map, its brackets coloured as the editor's are.
    const view = new EditorView({
      state: EditorState.create({ readOnly: true }),
      parent: host,
      ariaLabel: 'Preview',
      highlightActiveLine: false,
      folding: false,
      bracketColors: useEditorLayout.getState().bracketColors,
      highlighting: sharedHighlighting(),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  const path = location?.path ?? null
  const [text, setText] = useState<{ path: string; text: string } | null>(null)
  useEffect(() => {
    if (!location) return
    if (path === null) {
      setMissing(`Outside the open folder: ${location.file}`)
      return
    }
    // An open file is shown as the editor has it, unsaved changes included.
    const open = docState(path)
    if (open) {
      setMissing(null)
      setText({ path, text: open.doc.toString() })
      return
    }
    let live = true
    api.workspace.read(path).then(
      (file) => {
        if (!live) return
        if (file.binary) setMissing(`${path} is not a text file.`)
        else {
          setMissing(null)
          setText({ path, text: file.content.replace(/\r\n?/g, '\n') })
        }
      },
      () => live && setMissing(`${path} could not be read.`),
    )
    return () => {
      live = false
    }
  }, [path, location])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view || !text || !location || location.path !== text.path) return
    if (view.state.doc.toString() !== text.text || view.state.config.language !== languageForPath(text.path)) {
      view.setState(EditorState.create({ doc: text.text, language: languageForPath(text.path), readOnly: true }))
    }
    const doc = view.state.doc
    const rangeOf = (place: EditorLocation) => {
      const start = positionOf(doc, place.line, place.character)
      return { from: start, to: Math.max(start, positionOf(doc, place.endLine, place.endCharacter)) }
    }
    const { from } = rangeOf(location)
    const marks = [location, ...(also ?? []).filter((place) => place.path === text.path)]
      .map(rangeOf)
      .filter((range) => range.to > range.from)
      .sort((a, b) => a.from - b.from)
      .map((range) => ({ ...range, className: 'enc-mark-peek' }))
    view.setSource('peek', DecorationSet.of(doc, { marks, lines: [{ line: doc.lineAt(from).number, className: 'enc-line-peek' }] }))
    view.select(from)
    view.scrollToPos(from, true)
  }, [text, location, also])

  return (
    <div className="peek-preview">
      <div ref={hostRef} className="peek-preview-editor" hidden={missing !== null} />
      {missing !== null ? <div className="peek-preview-missing">{missing}</div> : null}
    </div>
  )
}

/**
 * The places a server named, between the lines of the editor under the symbol they are about: the file of the one
 * selected on the left, the list grouped by file on the right. Arrows move through the list, Enter opens a place,
 * Esc closes the peek and hands the keys back to the editor.
 */
export function Peek({ view, peek, current, onOpen, onClose }: { view: EditorView; peek: PeekData; current: string | null; onOpen(location: EditorLocation): void; onClose(): void }) {
  const listRef = useRef<HTMLDivElement>(null)
  const zone = usePeekZone(view, 'peek', peek.line, peek, () => listRef.current?.focus())
  const groups = useMemo(() => groupsOf(peek.locations, current), [peek.locations, current])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const order = useMemo(() => groups.flatMap((group) => (collapsed.has(group.key) ? [] : group.items.map((item) => item.index))), [groups, collapsed])
  const [selected, setSelected] = useState(() => groups[0]?.items[0]?.index ?? 0)

  useLayoutEffect(() => {
    listRef.current?.querySelector('.peek-row.is-selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const count = peek.locations.length
  const fileCount = groups.length
  const location = peek.locations[selected]

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const at = order.indexOf(selected)
    const group = groups.find((item) => item.items.some((entry) => entry.index === selected))
    const handled = () => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (event.key === 'Escape') return (handled(), onClose())
    if (event.key === 'ArrowDown' && order.length) return (handled(), setSelected(order[Math.min(order.length - 1, at + 1)]))
    if (event.key === 'ArrowUp' && order.length) return (handled(), setSelected(order[Math.max(0, at - 1)]))
    if (event.key === 'Enter' && location) return (handled(), onOpen(location))
    if (event.key === 'ArrowLeft' && group && !collapsed.has(group.key)) return (handled(), setCollapsed(new Set([...collapsed, group.key])))
    if (event.key === 'ArrowRight' && group && collapsed.has(group.key)) return (handled(), setCollapsed(new Set([...collapsed].filter((key) => key !== group.key))))
  }

  return createPortal(
    <div
      className="peek"
      // Esc in the preview closes the peek too; the keys of the list stay in it.
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="peek-head">
        <span className="peek-title">{peek.title}</span>
        <span className="peek-count">
          {count === 1 ? '1 place' : `${count} places`}
          {fileCount > 1 ? ` in ${fileCount} files` : ''}
        </span>
        <button type="button" className="peek-close" aria-label="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="peek-body">
        <PeekPreview location={location} />
        <div ref={listRef} className="peek-list" role="tree" aria-label={peek.title} tabIndex={0} onKeyDown={onKeyDown}>
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.key)
            const name = group.label.split(/[\\/]/).pop() ?? group.label
            const folder = group.label.slice(0, group.label.length - name.length).replace(/[\\/]$/, '')
            return (
              <div key={group.key} role="group" className={cx('peek-group', !group.inFolder && 'is-outside')}>
                <button
                  type="button"
                  className="peek-file"
                  aria-expanded={!isCollapsed}
                  tabIndex={-1}
                  onClick={() => setCollapsed(isCollapsed ? new Set([...collapsed].filter((key) => key !== group.key)) : new Set([...collapsed, group.key]))}
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <span className="peek-file-name">{name}</span>
                  {folder ? <span className="peek-file-folder">{folder}</span> : null}
                  <span className="peek-file-count">{group.items.length}</span>
                </button>
                {isCollapsed
                  ? null
                  : group.items.map(({ location: item, index }) => (
                      <div
                        key={index}
                        role="treeitem"
                        aria-selected={index === selected}
                        className={cx('peek-row', index === selected && 'is-selected')}
                        onClick={() => setSelected(index)}
                        onDoubleClick={() => onOpen(item)}
                      >
                        <span className="peek-row-line">{item.line + 1}</span>
                        <PreviewLine location={item} />
                      </div>
                    ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    zone,
  )
}

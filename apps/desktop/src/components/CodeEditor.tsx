import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { EditorState } from '@encode/editor'
import { EditorView } from '@encode/editor-view'
import '@encode/editor-view/style.css'
import type { CodeDiagnostic } from '@shared/types'
import { attach, docState, indentLabel, recordState, saveScroll, scrollOf } from '../editor/docs'
import { decorationsOf, marksAt, marksOf, marksOnLine, onMarksChanged, rangeOf, sourceOf } from '../editor/marks'
import { useEditor, type Tab } from '../stores/editor'
import { useUi } from '../stores/ui'
import { cx } from '../ui/cx'
import { AlertTriangle, Info, XCircle } from '../ui/icons'
import { ContextMenu, type MenuEntry } from '../ui/Menu'
import { place } from '../ui/place'

/** What the view shows when no file is open. */
const NOTHING = EditorState.create({})

function reportInfo(state: EditorState): void {
  useEditor.getState().setInfo({ indent: indentLabel(state), eol: state.config.lineSeparator === '\r\n' ? 'CRLF' : 'LF' })
}

function reportCursor(state: EditorState): void {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  useEditor.getState().setCursor(line.number, head - line.from + 1)
}

/** "12" or "12:5" to a position in the document; null for anything else. */
function parseLocation(text: string, state: EditorState): number | null {
  const match = /^(\d+)(?:\s*[:,]\s*(\d+))?$/.exec(text.trim())
  if (!match) return null
  const { doc } = state
  const line = doc.line(Math.max(1, Math.min(doc.lineCount, Number(match[1]))))
  const column = match[2] ? Math.max(1, Number(match[2])) : 1
  return line.from + Math.min(column - 1, line.to - line.from)
}

/** How long the pointer rests on a mark before its message shows. */
const HOVER_MS = 350

/** The problems under the pointer, and the spot on screen they belong to. */
interface Hover {
  items: CodeDiagnostic[]
  anchor: { left: number; top: number; width: number; height: number }
}

const SEVERITY_ICON = { error: XCircle, warning: AlertTriangle, info: Info, hint: Info } as const

/** The messages of the marks under the pointer, beside the text they are about. */
function MarkCard({ hover, onEnter, onLeave }: { hover: Hover; onEnter(): void; onLeave(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    setSpot(place(hover.anchor, { width: box.offsetWidth, height: box.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, { side: 'top', align: 'start', gap: 4 }))
  }, [hover])
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="mark-card"
      style={spot ? { left: spot.left, top: spot.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      {hover.items.map((item, index) => {
        const Icon = SEVERITY_ICON[item.severity]
        const source = sourceOf(item)
        return (
          <div key={index} className={cx('mark-card-item', `is-${item.severity}`)}>
            <Icon size={13} className="mark-card-icon" aria-hidden="true" />
            <div className="mark-card-text">
              <span className="mark-card-message">{item.message}</span>
              {source && <span className="mark-card-source">{source}</span>}
            </div>
          </div>
        )
      })}
    </div>,
    document.body,
  )
}

/**
 * eNCode's editor, on its own engine (@encode/editor-view): one view, which
 * shows the active tab's document. The documents live in `editor/docs`, with
 * their undo history and what is on disk; the view only reports back what the
 * rest of the app shows (unsaved mark, cursor position).
 */
export default function CodeEditor({ tab }: { tab: Tab | null }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const pathRef = useRef<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  const overCard = useRef(false)
  const path = tab?.path ?? null
  const revealLine = useEditor((state) => state.revealLine)

  /** The language servers' marks of the file shown, drawn again whenever they change. */
  const showMarks = (view: EditorView, shown: string | null) => {
    const items = shown ? marksOf(shown) : []
    view.setSource('marks', items.length ? decorationsOf(view.state.doc, items) : null)
  }

  useEffect(
    () =>
      onMarksChanged((changed) => {
        const view = viewRef.current
        if (view && changed === pathRef.current) showMarks(view, changed)
      }),
    [],
  )

  useEffect(
    () => () => {
      if (pathRef.current) attach(pathRef.current, null)
      viewRef.current?.destroy()
      viewRef.current = null
      pathRef.current = null
    },
    [],
  )

  // Show the active document in the view; it is made when the first one is opened, in a container that has a size.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const previous = pathRef.current
    if (previous) attach(previous, null)
    const state = path ? docState(path) : undefined
    pathRef.current = state ? path : null
    let view = viewRef.current
    setHover(null)
    if (!state) {
      view?.setState(NOTHING)
      if (view) showMarks(view, null)
      return
    }
    if (view) {
      view.setState(state, scrollOf(path!) ?? undefined)
    } else {
      view = new EditorView({ state, parent: host, ariaLabel: 'Code editor' })
      const created = view
      viewRef.current = created
      const scroll = scrollOf(path!)
      if (scroll) created.setState(state, scroll)
      created.on('transaction', (tr) => {
        const current = pathRef.current
        if (!current) return
        useEditor.getState().setDirty(current, recordState(current, tr.state))
        if (tr.docChanged || tr.selectionChanged) reportCursor(tr.state)
      })
      created.on('viewport', () => {
        // Hidden, the scroll position reads as zero.
        const current = pathRef.current
        if (current && created.root.clientHeight > 0) saveScroll(current, created.saveScroll())
      })
      created.on('contextmenu', ({ x, y }) => setMenu({ x, y }))
      created.on('request', (name) => {
        if (name === 'gotoLine') void goToLine(created)
      })
      // Typing or scrolling moves the text from under a message.
      created.on('transaction', (tr) => {
        if (tr.docChanged) setHover(null)
      })
      created.on('viewport', () => {
        if (!overCard.current) setHover(null)
      })
    }
    attach(path!, view)
    showMarks(view, path)
    reportCursor(state)
    reportInfo(state)
  }, [path])

  // A search result or Go to file asked for a line.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !pathRef.current || revealLine === null) return
    const { doc } = view.state
    const line = doc.line(Math.max(1, Math.min(revealLine, doc.lineCount)))
    view.select(line.from, line.to)
    view.scrollToPos(line.from, true)
    view.focus()
    useEditor.getState().consumeRevealLine()
  }, [revealLine, path])

  /** The marks under the pointer: on the text, the ones over it; on the gutter, the ones of the line. */
  const hoverAt = (clientX: number, clientY: number, target: EventTarget | null): Hover | null => {
    const view = viewRef.current
    const shown = pathRef.current
    if (!view || !shown) return null
    const items = marksOf(shown)
    if (!items.length) return null
    const doc = view.state.doc
    if (target instanceof Element && target.closest('.enc-gutter')) {
      const line = view.lineAtClientY(clientY)
      const found = marksOnLine(doc, items, line)
      if (!found.length) return null
      const at = view.coordsAtPos(doc.line(line).from)
      return { items: found, anchor: { left: clientX, top: at.top, width: 1, height: at.bottom - at.top } }
    }
    const pos = view.posAtCoords(clientX, clientY)
    const found = marksAt(doc, items, pos).filter((item) => {
      // posAtCoords takes the nearest place on the line: the pointer must be over the mark's own text.
      const { from, to } = rangeOf(doc, item)
      const start = view.coordsAtPos(from)
      const end = view.coordsAtPos(to)
      return start.top !== end.top || (clientX >= start.left - 2 && clientX <= end.left + 2 && clientY >= start.top && clientY <= start.bottom)
    })
    if (!found.length) return null
    const { from } = rangeOf(doc, found[0])
    const at = view.coordsAtPos(Math.max(from, doc.lineAt(pos).from))
    return { items: found, anchor: { left: Math.min(clientX, at.left + 400), top: at.top, width: 1, height: at.bottom - at.top } }
  }

  const onPointerMove = (event: ReactPointerEvent) => {
    window.clearTimeout(hoverTimer.current)
    const { clientX, clientY, target, buttons } = event
    if (buttons) return
    hoverTimer.current = window.setTimeout(() => {
      const next = hoverAt(clientX, clientY, target)
      setHover((current) => (next ? next : overCard.current ? current : null))
    }, HOVER_MS)
  }

  const onPointerLeave = () => {
    window.clearTimeout(hoverTimer.current)
    // Over to the card is still on the mark: leave it up for the person to read or select.
    hoverTimer.current = window.setTimeout(() => {
      if (!overCard.current) setHover(null)
    }, 120)
  }

  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  async function goToLine(view: EditorView): Promise<void> {
    const answer = await useUi.getState().askText('Go to line', `1 to ${view.state.doc.lineCount}, or line:column`)
    if (answer === null || viewRef.current !== view) return
    const pos = parseLocation(answer, view.state)
    if (pos === null) {
      useUi.getState().notify('error', `"${answer}" is not a line number.`)
    } else {
      view.select(pos)
      view.scrollToPos(pos, true)
    }
    view.focus()
  }

  const entries = (): MenuEntry[] => {
    const view = viewRef.current
    const state = view?.state
    const selected = Boolean(state && !state.selection.main.empty)
    const editable = Boolean(state && !state.config.readOnly)
    const native = (command: 'cut' | 'copy' | 'paste') => () => {
      view?.focus()
      document.execCommand(command)
    }
    const run = (name: string) => () => {
      view?.focus()
      view?.runCommand(name)
    }
    return [
      { id: 'cut', label: 'Cut', shortcut: 'Ctrl+X', disabled: !selected || !editable, onSelect: native('cut') },
      { id: 'copy', label: 'Copy', shortcut: 'Ctrl+C', onSelect: native('copy') },
      { id: 'paste', label: 'Paste', shortcut: 'Ctrl+V', disabled: !editable, onSelect: native('paste') },
      { kind: 'separator', id: 'clipboard' },
      { id: 'select-all', label: 'Select all', shortcut: 'Ctrl+A', onSelect: run('selectAll') },
      { kind: 'separator', id: 'selection' },
      { id: 'find', label: 'Find', shortcut: 'Ctrl+F', onSelect: run('openFind') },
      { id: 'replace', label: 'Replace', shortcut: 'Ctrl+H', disabled: !editable, onSelect: run('openReplace') },
      { id: 'goto', label: 'Go to line…', shortcut: 'Ctrl+G', onSelect: run('gotoLine') },
      { kind: 'separator', id: 'edit' },
      { id: 'comment', label: 'Toggle line comment', shortcut: 'Ctrl+/', disabled: !editable, onSelect: run('toggleLineComment') },
    ]
  }

  return (
    <>
      <div
        className="code-editor"
        ref={hostRef}
        hidden={path === null}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onPointerDown={() => {
          window.clearTimeout(hoverTimer.current)
          setHover(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && hover) setHover(null)
        }}
      />
      {hover && (
        <MarkCard
          hover={hover}
          onEnter={() => {
            overCard.current = true
            window.clearTimeout(hoverTimer.current)
          }}
          onLeave={() => {
            overCard.current = false
            setHover(null)
          }}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={entries()}
          label="Editor"
          onClose={(refocus) => {
            setMenu(null)
            // Escape or a choice hands focus back; a click elsewhere has put it where the user wanted.
            if (refocus) viewRef.current?.focus()
          }}
        />
      )}
    </>
  )
}

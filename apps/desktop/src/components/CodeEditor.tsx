import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@encode/editor'
import { EditorView } from '@encode/editor-view'
import '@encode/editor-view/style.css'
import { attach, docState, indentLabel, recordState, saveScroll, scrollOf } from '../editor/docs'
import { useEditor, type Tab } from '../stores/editor'
import { useUi } from '../stores/ui'
import { ContextMenu, type MenuEntry } from '../ui/Menu'

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
  const path = tab?.path ?? null
  const revealLine = useEditor((state) => state.revealLine)

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
    if (!state) {
      view?.setState(NOTHING)
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
    }
    attach(path!, view)
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
      <div className="code-editor" ref={hostRef} hidden={path === null} />
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

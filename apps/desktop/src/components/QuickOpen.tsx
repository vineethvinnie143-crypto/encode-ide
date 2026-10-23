import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CodeRange, EditorSymbolMatch } from '@shared/types'
import { File, Hash, ListTree, Loader2, Search } from '../ui/icons'
import { api } from '../api'
import { askServers, fileText, findSymbols, focusEditor, goToPlace, isShowing, keepView, putBackView, showRange, useOutline, type KeptView } from '../editor/surface'
import { SymbolIcon } from '../editor/surface-view'
import { quickOpenMode, rankFolderSymbols, type LineAsk } from '../palette/quick-open'
import { useEditor } from '../stores/editor'
import { usePanels } from '../stores/panels'
import { useUi } from '../stores/ui'

function fuzzyScore(query: string, target: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const direct = t.indexOf(q)
  if (direct !== -1) return 1000 - direct - (t.length - q.length) * 0.1

  let score = 0
  let qi = 0
  let streak = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi++
      streak++
      score += 1 + streak
      if (i > 0 && /[/\\_.-]/.test(t[i - 1])) score += 3
    } else {
      streak = 0
    }
  }
  return qi === q.length ? score : -1
}

/** How long typing rests before the folder's servers are asked for symbols. */
const FOLDER_ASK_MS = 150
/** The most of a file's symbols the list shows. */
const MAX_FILE_SYMBOLS = 300

/** A row of the list, whatever the list holds. */
interface Item {
  key: string
  icon: ReactNode
  name: string
  detail?: string
  trailing?: string
  /** What Enter does. */
  run(): void
  /** What moving onto it shows in the editor before Enter (a symbol of the file, a line). */
  preview?(): void
}

/** Whether the editor on screen shows `path`, as the active tab. */
const shows = (path: string | null): path is string => path !== null && useEditor.getState().activePath === path && isShowing(path)

/** A point of a file as the servers count, from a line and column as people count them. */
const pointAt = (at: LineAsk): CodeRange => {
  const point = { line: at.line - 1, character: Math.max(0, (at.column ?? 1) - 1) }
  return { start: point, end: point }
}

/** Where a line ask lands in the file the editor shows, its numbers kept inside the file. */
function lineRange(path: string, at: LineAsk): CodeRange {
  const text = shows(path) ? fileText(path) : null
  if (!text) return pointAt(at)
  const line = Math.min(at.line, text.lines)
  const point = { line: line - 1, character: Math.min(Math.max(0, (at.column ?? 1) - 1), text.line(line).length) }
  return { start: point, end: point }
}

/**
 * Go to file (Ctrl+P), and through it a symbol of the file shown (@, Ctrl+Shift+O), a symbol of the folder (#,
 * Ctrl+Alt+T) or a line (:). Moving through a file's symbols or onto a line shows it in the editor; Esc puts the
 * cursor back where it was.
 */
export default function QuickOpen() {
  const setOpen = useUi((state) => state.setQuickOpenOpen)
  const openFile = useEditor((state) => state.openFile)
  const activePath = useEditor((state) => state.activePath)

  const [query, setQuery] = useState(() => useUi.getState().quickOpenQuery)
  const mode = useMemo(() => quickOpenMode(query), [query])
  const [files, setFiles] = useState<string[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The cursor and scroll before a preview moved them, put back when the person closes without choosing.
  const origin = useRef<KeptView | null>(null)
  const chosen = useRef(false)

  // The file shown in the editor is what @ and : act on; with the editor not on screen there is none.
  const shownPath = shows(activePath) ? activePath : null
  const outlineSymbols = useOutline((state) => (state.path === shownPath ? state.symbols : null))
  const outlineStatus = useOutline((state) => (state.path === shownPath ? state.status : 'idle'))

  // The folder's file list, read the first time a file is looked for.
  const wantsFiles = mode.kind === 'file'
  useEffect(() => {
    if (!wantsFiles || files !== null) return
    let cancelled = false
    api.workspace
      .listAllFiles()
      .then((result) => {
        if (cancelled) return
        setFiles(result.files)
        setTruncated(result.truncated)
      })
      .catch(() => {
        if (!cancelled) setFiles([])
      })
    return () => {
      cancelled = true
    }
  }, [wantsFiles, files])

  useEffect(() => {
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      // Opened with "@" or "#": the cursor after it, ready for the name.
      input.setSelectionRange(input.value.length, input.value.length)
    })
  }, [])

  // The folder's symbols, asked for once typing rests; an older answer is dropped.
  const [folder, setFolder] = useState<{ query: string; matches: EditorSymbolMatch[] | null } | null>(null)
  const folderText = mode.kind === 'folderSymbol' ? mode.text : null
  useEffect(() => {
    if (!folderText) return
    let live = true
    const timer = window.setTimeout(() => {
      void askServers({ kind: 'workspaceSymbols', path: shownPath ?? '', query: folderText }).then((matches) => {
        if (live) setFolder({ query: folderText, matches })
      })
    }, FOLDER_ASK_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [folderText, shownPath])

  /** The editor shows a range of its file, selected, without taking the keys from the list. */
  const previewRange = (path: string, range: CodeRange) => {
    if (!shows(path)) return
    origin.current ??= keepView(path)
    showRange(path, range)
  }

  /** What a preview moved goes back. */
  const restore = () => {
    const kept = origin.current
    origin.current = null
    if (kept && shows(kept.path)) putBackView(kept)
  }

  // Closed without a choice: the cursor goes back to where it was, with the keys.
  useEffect(
    () => () => {
      if (chosen.current || !origin.current) return
      const path = origin.current.path
      restore()
      if (shows(path)) focusEditor(path)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const close = () => setOpen(false)

  /** Goes somewhere: a preview is put back first, so Back returns to where the person was. */
  const choose = (go: () => void) => {
    restore()
    chosen.current = true
    close()
    go()
  }

  const { items, message, loading } = useMemo((): { items: Item[]; message: string | null; loading: boolean } => {
    if (mode.kind === 'file') {
      if (files === null) return { items: [], message: null, loading: true }
      const ranked = files
        .map((path) => ({ path, score: fuzzyScore(mode.text, path) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 100)
      const at = mode.at
      return {
        items: ranked.map(({ path }) => ({
          key: path,
          icon: <File size={13} className="qo-icon" />,
          name: path.split('/').pop() ?? path,
          detail: path,
          ...(at ? { trailing: `:${at.line}${at.column ? `:${at.column}` : ''}` } : {}),
          run: () =>
            choose(() => {
              usePanels.getState().open('editor')
              if (at) goToPlace({ path, range: pointAt(at) })
              else void openFile(path)
            }),
        })),
        message: ranked.length ? null : `No files matched${truncated ? '. The file index was truncated.' : '.'}`,
        loading: false,
      }
    }
    if (mode.kind === 'symbol') {
      if (!shownPath) return { items: [], message: 'Open a file in the editor to go to its symbols.', loading: false }
      if (!outlineSymbols) {
        if (outlineStatus === 'none') return { items: [], message: 'No language server gives the symbols of this file.', loading: false }
        return { items: [], message: null, loading: true }
      }
      const found = findSymbols(outlineSymbols, mode.text).slice(0, MAX_FILE_SYMBOLS)
      return {
        items: found.map(({ symbol, container }) => ({
          key: `${container}/${symbol.name}@${symbol.selection.start.line}:${symbol.selection.start.character}`,
          icon: <SymbolIcon kind={symbol.kind} />,
          name: symbol.name,
          ...(container ? { detail: container } : {}),
          trailing: `:${symbol.selection.start.line + 1}`,
          preview: () => previewRange(shownPath, symbol.selection),
          run: () => choose(() => goToPlace({ path: shownPath, range: symbol.selection })),
        })),
        message: found.length ? null : mode.text ? 'No symbols match.' : 'This file has no symbols.',
        loading: false,
      }
    }
    if (mode.kind === 'folderSymbol') {
      if (!mode.text) return { items: [], message: 'Type the name of a function, class or other symbol in the folder.', loading: false }
      const answer = folder?.query === mode.text ? folder : null
      if (!answer) return { items: [], message: null, loading: true }
      if (answer.matches === null) return { items: [], message: 'No language server is running to search the folder. Open one of its files so its server starts.', loading: false }
      const ranked = rankFolderSymbols(answer.matches, mode.text)
      return {
        items: ranked.map((match, at) => ({
          key: `${match.path}:${match.range.start.line}:${match.range.start.character}:${at}`,
          icon: <SymbolIcon kind={match.kind} />,
          name: match.name,
          detail: match.container ? `${match.container} · ${match.path}` : match.path,
          trailing: `:${match.range.start.line + 1}`,
          run: () =>
            choose(() => {
              usePanels.getState().open('editor')
              goToPlace({ path: match.path, range: match.range })
            }),
        })),
        message: ranked.length ? null : 'No symbols in the folder match.',
        loading: false,
      }
    }
    // A line of the file shown.
    if (!shownPath) return { items: [], message: 'Open a file in the editor to go to a line.', loading: false }
    const lines = (shows(shownPath) ? fileText(shownPath)?.lines : 0) ?? 0
    if (!mode.at) return { items: [], message: `Type a line number from 1 to ${lines}, or line:column.`, loading: false }
    const range = lineRange(shownPath, mode.at)
    return {
      items: [
        {
          key: 'line',
          icon: <Hash size={13} className="qo-icon" />,
          name: `Go to line ${range.start.line + 1}${mode.at.column ? `, column ${range.start.character + 1}` : ''}`,
          ...(mode.at.line > lines ? { detail: `The file has ${lines} lines.` } : {}),
          preview: () => previewRange(shownPath, range),
          run: () => choose(() => goToPlace({ path: shownPath, range })),
        },
      ],
      message: null,
      loading: false,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, files, truncated, shownPath, outlineSymbols, outlineStatus, folder])

  useEffect(() => {
    setIndex(0)
  }, [query])

  const active = items.length ? items[Math.min(index, items.length - 1)] : undefined

  // Moving onto a symbol or a line shows it; a file or a folder symbol puts back what a preview moved.
  useEffect(() => {
    if (active?.preview) active.preview()
    else restore()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.key, mode.kind])

  useLayoutEffect(() => {
    listRef.current?.querySelector('.quickopen-item.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = (by: number) => {
      event.preventDefault()
      setIndex((value) => Math.max(0, Math.min(items.length - 1, value + by)))
    }
    if (event.key === 'ArrowDown') step(1)
    else if (event.key === 'ArrowUp') step(-1)
    else if (event.key === 'PageDown') step(10)
    else if (event.key === 'PageUp') step(-10)
    else if (event.key === 'Enter') {
      event.preventDefault()
      active?.run()
    } else if (event.key === 'Escape') close()
  }

  const ModeIcon = mode.kind === 'symbol' || mode.kind === 'folderSymbol' ? ListTree : mode.kind === 'line' ? Hash : Search
  const label = mode.kind === 'symbol' ? 'Go to symbol in file' : mode.kind === 'folderSymbol' ? 'Go to symbol in folder' : mode.kind === 'line' ? 'Go to line' : 'Go to file'

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="quickopen" role="dialog" aria-label={label} onMouseDown={(event) => event.stopPropagation()}>
        <div className="quickopen-input-wrap">
          <ModeIcon size={15} />
          <input
            ref={inputRef}
            className="quickopen-input"
            value={query}
            placeholder="Go to a file, or type @ for symbols, # for the folder's symbols, : for a line"
            aria-label={label}
            aria-controls="quickopen-list"
            aria-activedescendant={active ? `qo-${index}` : undefined}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {loading && <Loader2 size={14} className="spin" />}
        </div>

        <div ref={listRef} id="quickopen-list" className="quickopen-list" role="listbox" aria-label="Results">
          {items.map((item, itemIndex) => (
            <button
              key={item.key}
              id={`qo-${itemIndex}`}
              role="option"
              aria-selected={itemIndex === index}
              tabIndex={-1}
              className={`quickopen-item ${itemIndex === index ? 'is-active' : ''}`}
              onMouseEnter={() => setIndex(itemIndex)}
              onClick={() => item.run()}
            >
              {item.icon}
              <span className="qo-name">{item.name}</span>
              {item.detail ? <span className="qo-dir">{item.detail}</span> : null}
              {item.trailing ? <span className="qo-trailing">{item.trailing}</span> : null}
            </button>
          ))}
          {message && <div className="quickopen-empty">{message}</div>}
        </div>

        <div className="quickopen-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
          <span className="qo-modes">
            <span>
              <kbd>@</kbd> symbols
            </span>
            <span>
              <kbd>#</kbd> in folder
            </span>
            <span>
              <kbd>:</kbd> line
            </span>
          </span>
          {truncated && mode.kind === 'file' && <span className="muted">index truncated</span>}
        </div>
      </div>
    </div>
  )
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { EditorState } from '@encode/editor'
import { DecorationSet, EditorView, type KeyBinding, type ViewCommand } from '@encode/editor-view'
import '@encode/editor-view/style.css'
import type { CodeDiagnostic, EditorLocation } from '@shared/types'
import { api } from '../api'
import { modalOpen } from '../commands/useKeymap'
import { setActiveEditor } from '../editor/active'
import { askServers, forgetTriggers, lspAt } from '../editor/assist/ask'
import { wordEnd, wordStart } from '../editor/assist/completion'
import { EditorAssist } from '../editor/assist/controller'
import { EditorFolding } from '../editor/assist/folding'
import { EditorInlays } from '../editor/assist/inlays'
import { EditorSemanticColours } from '../editor/assist/semantic'
import { markupHtml } from '../editor/assist/markup'
import { goBack, goForward, goToLocation, withOpenText, type Place } from '../editor/assist/navigation'
import { EditorOutline } from '../editor/assist/outline'
import { EditorRefactor } from '../editor/assist/refactor'
import { attach, docState, foldsOf, indentLabel, recordState, saveFolds, saveScroll, scrollOf } from '../editor/docs'
import { sharedHighlighting } from '../editor/highlighting'
import { tooLargeForServers } from '../editor/language'
import { allMarks, decorationsOf, marksAt, marksOf, marksOnLine, onMarksChanged, positionOf, rangeOf, sourceOf } from '../editor/marks'
import { problemFrom } from '../editor/problems'
import { noAnswerReason } from '../panels/code'
import { useCode } from '../stores/code'
import { useEditorLayout } from '../stores/editor-layout'
import { useEditor, type Tab } from '../stores/editor'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import { cx } from '../ui/cx'
import { AlertTriangle, Info, Lightbulb, XCircle } from '../ui/icons'
import { Kbd } from '../ui/Kbd'
import { ContextMenu, type MenuEntry } from '../ui/Menu'
import { place } from '../ui/place'
import { SignatureCard, SuggestWidget } from './code/Assist'
import { CallsPeek, type CallsData } from './code/CallsPeek'
import { Peek, type PeekData } from './code/Peek'
import { ActionMenu, ChangePreview, LightbulbButton, RenameBox } from './code/Refactor'

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

/** The file's symbols are asked for only while something shows them: the breadcrumbs, the outline, Go to symbol. */
const outlineWanted = (): boolean => {
  const layout = useEditorLayout.getState()
  return layout.breadcrumbs || layout.outline || useUi.getState().quickOpenOpen
}

/** What the editor's text shows, as the View menu set it. */
const viewOptions = () => {
  const { folding, stickyScroll, bracketColors, minimap } = useEditorLayout.getState()
  return { folding, stickyScroll, bracketColors, minimap }
}

/** The blocks folded in the file a view shows, kept to fold them again when the file is shown next. */
function keepFolds(view: EditorView, shown: string): void {
  saveFolds(shown, view.state.doc, view.folding.folded)
}

/** The keys to the editor after a jump, unless a dialog opened meanwhile (Go to file, the palette): it keeps them. */
function takeKeys(view: EditorView): void {
  if (!modalOpen()) view.focus()
}

/** How long the pointer rests on a mark before its message shows. */
const HOVER_MS = 350

/** What the language servers add to the editor, on its own keys; the palette's Go menu runs the same commands. */
const BINDINGS: readonly KeyBinding[] = [
  { key: 'Ctrl-Space', command: 'triggerSuggest' },
  { key: 'Ctrl-Shift-Space', command: 'triggerParameterHints' },
  { key: 'F12', command: 'goToDefinition' },
  { key: 'Alt-F12', command: 'peekDefinition' },
  { key: 'Shift-F12', command: 'goToReferences' },
  { key: 'Mod-F12', command: 'goToImplementation' },
  { key: 'Alt-ArrowLeft', mac: 'Ctrl--', command: 'navigateBack' },
  { key: 'Alt-ArrowRight', mac: 'Ctrl-Shift--', command: 'navigateForward' },
  { key: 'F2', command: 'renameSymbol' },
  { key: 'Mod-.', command: 'quickFix' },
  { key: 'Ctrl-Shift-r', command: 'refactor' },
  { key: 'Shift-Alt-o', command: 'organizeImports' },
  { key: 'Shift-Alt-f', command: 'formatDocument' },
  { key: 'Shift-Alt-h', command: 'callHierarchy' },
  { key: 'F8', command: 'nextProblem' },
  { key: 'Shift-F8', command: 'previousProblem' },
  // Before the editor's own Esc: an open peek closes first.
  { key: 'Escape', command: 'closePeek' },
]

type LocationKind = 'definition' | 'typeDefinition' | 'implementation' | 'references'

const FEATURE: Record<LocationKind, { title: string; feature: string; none: string }> = {
  definition: { title: 'Definitions', feature: 'go to definition', none: 'No definition found for' },
  typeDefinition: { title: 'Type definitions', feature: 'go to type definition', none: 'No type definition found for' },
  implementation: { title: 'Implementations', feature: 'go to implementation', none: 'No implementation found for' },
  references: { title: 'References', feature: 'find references', none: 'No references found for' },
}

/** The problems and the server's words under the pointer, and the spot on screen they belong to. */
interface Hover {
  items: CodeDiagnostic[]
  /** What the server says of the symbol, as markdown. */
  markdown?: string
  anchor: { left: number; top: number; width: number; height: number }
}

const SEVERITY_ICON = { error: XCircle, warning: AlertTriangle, info: Info, hint: Info } as const

/** The messages of the marks under the pointer and what the server says of the symbol there, beside the text. */
function HoverCard({ hover, language, onEnter, onLeave, onQuickFix }: { hover: Hover; language: string; onEnter(): void; onLeave(): void; onQuickFix?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null)
  const docs = useMemo(() => (hover.markdown ? markupHtml({ kind: 'markdown', value: hover.markdown }, language) : ''), [hover.markdown, language])
  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    setSpot(place(hover.anchor, { width: box.offsetWidth, height: box.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, { side: 'top', align: 'start', gap: 4 }))
  }, [hover, docs])
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className={cx('mark-card', docs && 'has-docs')}
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
      {/* Built by markupHtml: everything escaped first, then the renderer's own tags only. */}
      {docs ? <div className="mark-card-docs markup" dangerouslySetInnerHTML={{ __html: docs }} /> : null}
      {hover.items.length > 0 && onQuickFix && (
        <div className="mark-card-actions">
          <button type="button" className="mark-card-action" onClick={onQuickFix}>
            <Lightbulb size={13} aria-hidden="true" />
            <span>Quick fix…</span>
            <Kbd keys="Ctrl+." plain className="mark-card-kbd" />
          </button>
        </div>
      )}
    </div>,
    document.body,
  )
}

/**
 * eNCode's editor, on its own engine (@encode/editor-view): one view, which
 * shows the active tab's document. The documents live in `editor/docs`, with
 * their undo history and what is on disk; the view only reports back what the
 * rest of the app shows (unsaved mark, cursor position). The language servers
 * add suggestions, parameter hints, hover and the ways to a symbol's places.
 */
export default function CodeEditor({ tab }: { tab: Tab | null }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const assistRef = useRef<EditorAssist | null>(null)
  const refactorRef = useRef<EditorRefactor | null>(null)
  const outlineRef = useRef<EditorOutline | null>(null)
  const foldingRef = useRef<EditorFolding | null>(null)
  const inlaysRef = useRef<EditorInlays | null>(null)
  const semanticRef = useRef<EditorSemanticColours | null>(null)
  /** The problem F8 went to, whose message shows once the editor is there. */
  const problemCard = useRef<{ path: string; line: number; character: number } | null>(null)
  const pathRef = useRef<string | null>(null)
  const [view, setView] = useState<EditorView | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const [peek, setPeek] = useState<(PeekData & { from: Place }) | null>(null)
  const [calls, setCalls] = useState<(CallsData & { from: Place }) | null>(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  const hoverAsk = useRef(0)
  const linkRange = useRef<{ from: number; to: number } | null>(null)
  const overCard = useRef(false)
  const path = tab?.path ?? null
  const language = tab?.language ?? 'plaintext'
  const revealLine = useEditor((state) => state.revealLine)
  const revealRange = useEditor((state) => state.revealRange)

  /** The language servers' marks of the file shown, drawn again whenever they change. */
  const showMarks = (target: EditorView, shown: string | null) => {
    const items = shown ? marksOf(shown) : []
    target.setSource('marks', items.length ? decorationsOf(target.state.doc, items) : null)
  }

  useEffect(
    () =>
      onMarksChanged((changed) => {
        const current = viewRef.current
        if (current && changed === pathRef.current) showMarks(current, changed)
      }),
    [],
  )

  // The breadcrumbs or the outline shown again, or Go to symbol opened: the symbols skipped meanwhile are asked for.
  useEffect(() => {
    const wake = () => outlineRef.current?.wake()
    const stops = [useEditorLayout.subscribe(wake), useUi.subscribe(wake)]
    return () => stops.forEach((stop) => stop())
  }, [])

  // Folding, sticky scroll, bracket colours or the minimap turned on or off; folding back on asks the server again.
  useEffect(
    () =>
      useEditorLayout.subscribe(() => {
        const current = viewRef.current
        if (!current) return
        const next = viewOptions()
        const was = current.options
        if (next.folding === was.folding && next.stickyScroll === was.stickyScroll && next.bracketColors === was.bracketColors && next.minimap === was.minimap) return
        const foldingOn = next.folding && !was.folding
        current.setOptions(next)
        if (foldingOn) foldingRef.current?.wake()
      }),
    [],
  )

  // Inlay hints or semantic colours turned on or off: asked for again, or taken away.
  useEffect(() => {
    let was = useEditorLayout.getState()
    return useEditorLayout.subscribe(() => {
      const next = useEditorLayout.getState()
      if (next.inlayHints !== was.inlayHints) inlaysRef.current?.wake()
      if (next.semanticHighlighting !== was.semanticHighlighting) semanticRef.current?.wake()
      was = next
    })
  }, [])

  // A server started or stopped: what typing asks of it may have changed.
  useEffect(
    () =>
      api.code.onChanged(() => {
        forgetTriggers()
        assistRef.current?.refreshTriggers()
      }),
    [],
  )

  useEffect(
    () => () => {
      if (pathRef.current) {
        if (viewRef.current) keepFolds(viewRef.current, pathRef.current)
        attach(pathRef.current, null)
      }
      foldingRef.current?.dispose()
      foldingRef.current = null
      inlaysRef.current?.dispose()
      inlaysRef.current = null
      semanticRef.current?.dispose()
      semanticRef.current = null
      assistRef.current?.dispose()
      assistRef.current = null
      refactorRef.current?.dispose()
      refactorRef.current = null
      outlineRef.current?.dispose()
      outlineRef.current = null
      setActiveEditor(null)
      viewRef.current?.destroy()
      viewRef.current = null
      pathRef.current = null
    },
    [],
  )

  /** Where the cursor is, as a place Back returns to. */
  const placeOf = (target: EditorView, shown: string): Place => {
    const at = lspAt(target.state.doc, target.state.selection.main.head)
    return { path: shown, range: { start: at, end: at } }
  }

  const notify = (text: string) => useUi.getState().notify('info', text)

  /** Asks the servers for the places of the symbol at `pos` (the cursor by default), and goes there or lists them. */
  async function locate(kind: LocationKind, mode: 'go' | 'peek', at?: number): Promise<void> {
    const target = viewRef.current
    const shown = pathRef.current
    if (!target || !shown) return
    const state = target.state
    const pos = at ?? state.selection.main.head
    const { line, character } = lspAt(state.doc, pos)
    const word = state.doc.sliceString(wordStart(state, pos), wordEnd(state, pos))
    const found = await askServers({ kind, path: shown, line, character })
    if (viewRef.current !== target || pathRef.current !== shown) return
    const feature = FEATURE[kind]
    if (found === null) {
      if (!useCode.getState().report) await useCode.getState().refresh()
      notify(noAnswerReason(useCode.getState().report, shown, feature.feature, tooLargeForServers(shown)))
      return
    }
    if (!found.length) {
      notify(word ? `${feature.none} ${word}.` : `${feature.none} the symbol here.`)
      return
    }
    const from = placeOf(target, shown)
    // Already at the definition: where it is used is what the person is after.
    if (kind === 'definition' && mode === 'go' && found.length === 1 && found[0].path === shown && found[0].line === line && found[0].character <= character && character <= found[0].endCharacter) {
      void locate('references', 'peek', pos)
      return
    }
    if (mode === 'go' && kind !== 'references' && found.length === 1) {
      goToLocation(found[0], from)
      return
    }
    setHover(null)
    setCalls(null)
    setPeek({ title: feature.title, locations: withOpenText(found), line: state.doc.lineAt(pos).number, from })
  }

  /** Shift+Alt+H: who calls the function at the cursor, and what it calls, between the lines under it. */
  async function showCalls(): Promise<void> {
    const target = viewRef.current
    const shown = pathRef.current
    if (!target || !shown) return
    const state = target.state
    const pos = state.selection.main.head
    const word = state.doc.sliceString(wordStart(state, pos), wordEnd(state, pos))
    const found = await askServers({ kind: 'callHierarchy', path: shown, ...lspAt(state.doc, pos) })
    if (viewRef.current !== target || pathRef.current !== shown) return
    if (found === null) {
      if (!useCode.getState().report) await useCode.getState().refresh()
      notify(noAnswerReason(useCode.getState().report, shown, 'the call hierarchy', tooLargeForServers(shown)))
      return
    }
    if (!found.items.length) {
      notify(word ? `${word} is not a function the language server can follow calls of.` : 'Put the cursor on a function to see its calls.')
      return
    }
    setHover(null)
    setPeek(null)
    setCalls({ path: shown, list: found.list, items: found.items, line: state.doc.lineAt(pos).number, from: placeOf(target, shown) })
  }

  const peekOpen = useRef(false)
  peekOpen.current = peek !== null || calls !== null
  const cardOpen = useRef(false)
  cardOpen.current = hover !== null

  const commands: Record<string, ViewCommand> = {
    // Escape closes what is over the text, the peek first; with nothing open it goes on to the editor's own uses.
    closePeek: () => {
      if (peekOpen.current) {
        setPeek(null)
        setCalls(null)
      } else if (cardOpen.current) setHover(null)
      else return false
      return true
    },
    triggerSuggest: () => (assistRef.current?.suggest(), true),
    triggerParameterHints: () => (assistRef.current?.parameterHints(), true),
    goToDefinition: () => (void locate('definition', 'go'), true),
    peekDefinition: () => (void locate('definition', 'peek'), true),
    goToReferences: () => (void locate('references', 'peek'), true),
    goToImplementation: () => (void locate('implementation', 'go'), true),
    goToTypeDefinition: () => (void locate('typeDefinition', 'go'), true),
    callHierarchy: () => (void showCalls(), true),
    navigateBack: (target) => {
      const shown = pathRef.current
      if (!goBack(shown ? placeOf(target, shown) : null)) notify('Nothing to go back to.')
      return true
    },
    navigateForward: (target) => {
      const shown = pathRef.current
      if (!goForward(shown ? placeOf(target, shown) : null)) notify('Nothing to go forward to.')
      return true
    },
    renameSymbol: () => (void refactorRef.current?.rename(), true),
    quickFix: () => (setHover(null), void refactorRef.current?.quickFix(), true),
    refactor: () => (void refactorRef.current?.refactor(), true),
    sourceAction: () => (void refactorRef.current?.sourceAction(), true),
    organizeImports: () => (void refactorRef.current?.organizeImports(), true),
    fixAll: () => (void refactorRef.current?.fixAll(), true),
    formatDocument: () => (void refactorRef.current?.formatDocument(), true),
    formatSelection: () => (void refactorRef.current?.formatSelection(), true),
    nextProblem: () => (goToProblem(1), true),
    previousProblem: () => (goToProblem(-1), true),
  }
  // The view keeps the commands it was made with; they reach the current ones through this.
  const commandsRef = useRef(commands)
  commandsRef.current = commands

  // Show the active document in the view; it is made when the first one is opened, in a container that has a size.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const previous = pathRef.current
    if (previous) {
      if (viewRef.current) keepFolds(viewRef.current, previous)
      attach(previous, null)
    }
    const state = path ? docState(path) : undefined
    pathRef.current = state ? path : null
    let current = viewRef.current
    setHover(null)
    setPeek(null)
    setCalls(null)
    if (!state) {
      current?.setState(NOTHING)
      if (current) showMarks(current, null)
      assistRef.current?.show(null)
      refactorRef.current?.show(null)
      outlineRef.current?.show(null)
      foldingRef.current?.show(null)
      inlaysRef.current?.show(null)
      semanticRef.current?.show(null)
      return
    }
    if (current) {
      current.setState(state, scrollOf(path!) ?? undefined)
    } else {
      const routed = Object.fromEntries(Object.keys(commandsRef.current).map((name) => [name, (target: EditorView) => commandsRef.current[name](target)]))
      current = new EditorView({ state, parent: host, ariaLabel: 'Code editor', bindings: BINDINGS, commands: routed, highlighting: sharedHighlighting(), ...viewOptions() })
      const created = current
      viewRef.current = created
      setView(created)
      setActiveEditor(created)
      assistRef.current = new EditorAssist(created, { formatOnType: () => useSettings.getState().settings?.formatOnType === true })
      refactorRef.current = new EditorRefactor(created)
      outlineRef.current = new EditorOutline(created, outlineWanted)
      foldingRef.current = new EditorFolding(created, () => useEditorLayout.getState().folding)
      inlaysRef.current = new EditorInlays(created, () => useEditorLayout.getState().inlayHints)
      semanticRef.current = new EditorSemanticColours(created, () => useEditorLayout.getState().semanticHighlighting)
      const scroll = scrollOf(path!)
      if (scroll) created.setState(state, scroll)
      created.on('transaction', (tr) => {
        const shown = pathRef.current
        if (!shown) return
        useEditor.getState().setDirty(shown, recordState(shown, tr.state))
        if (tr.docChanged || tr.selectionChanged) reportCursor(tr.state)
      })
      created.on('viewport', () => {
        // Hidden, the scroll position reads as zero.
        const shown = pathRef.current
        if (shown && created.root.clientHeight > 0) saveScroll(shown, created.saveScroll())
      })
      created.on('folds', () => {
        const shown = pathRef.current
        if (shown) keepFolds(created, shown)
      })
      created.on('contextmenu', ({ x, y }) => setMenu({ x, y }))
      created.on('request', (name) => {
        if (name === 'gotoLine') void goToLine(created)
      })
      // Ctrl+click (Cmd on macOS) goes to the definition of what was clicked.
      created.on('navigate', ({ pos }) => void locate('definition', 'go', pos))
      // Typing or scrolling moves the text from under a message.
      created.on('transaction', (tr) => {
        if (tr.docChanged) {
          setHover(null)
          clearLink(created)
        }
      })
      created.on('viewport', () => {
        if (!overCard.current) setHover(null)
      })
    }
    attach(path!, current)
    // What was folded when the file was last shown is folded again, before the scroll it was left at is applied.
    const folds = foldsOf(path!)
    if (folds.length) current.folding.restore(folds)
    assistRef.current?.show(path)
    refactorRef.current?.show(path)
    outlineRef.current?.show(path)
    foldingRef.current?.show(path)
    inlaysRef.current?.show(path)
    semanticRef.current?.show(path)
    showMarks(current, path)
    reportCursor(state)
    reportInfo(state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // A search result or Go to file asked for a line.
  useEffect(() => {
    const current = viewRef.current
    if (!current || !pathRef.current || revealLine === null) return
    const { doc } = current.state
    const line = doc.line(Math.max(1, Math.min(revealLine, doc.lineCount)))
    current.select(line.from, line.to)
    current.scrollToPos(line.from, true)
    takeKeys(current)
    useEditor.getState().consumeRevealLine()
  }, [revealLine, path])

  // Go to definition, Back and Forward asked for a place: the cursor goes to its start, with the symbol selected.
  useEffect(() => {
    const current = viewRef.current
    if (!current || !pathRef.current || revealRange === null) return
    const { doc } = current.state
    const from = positionOf(doc, revealRange.start.line, revealRange.start.character)
    const to = Math.max(from, positionOf(doc, revealRange.end.line, revealRange.end.character))
    current.select(to === from || doc.lineAt(from).number !== doc.lineAt(to).number ? from : to, from)
    current.scrollToPos(from, true)
    takeKeys(current)
    useEditor.getState().consumeRevealRange()
    const card = problemCard.current
    if (card && card.path === pathRef.current) {
      problemCard.current = null
      showProblemCard(current, card)
    }
  }, [revealRange, path])

  /** F8 and Shift+F8: the next or previous problem in the folder's files, with its message beside it. */
  function goToProblem(direction: 1 | -1): void {
    const target = viewRef.current
    const shown = pathRef.current
    const from = target && shown ? { path: shown, ...lspAt(target.state.doc, target.state.selection.main.head) } : null
    const found = problemFrom(allMarks(), from, direction)
    if (!found) {
      notify('No problems in the files the language servers checked.')
      return
    }
    const at = { line: found.item.line, character: found.item.character }
    problemCard.current = { path: found.path, ...at }
    setHover(null)
    void useEditor.getState().openAt(found.path, { start: at, end: at })
  }

  /** The message of the problem F8 went to, once the text has scrolled to it. */
  function showProblemCard(target: EditorView, card: { path: string; line: number; character: number }): void {
    target.flush()
    // The scroll lands before the next frame, and a scroll closes a card; it shows after it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (viewRef.current !== target || pathRef.current !== card.path) return
        const { doc } = target.state
        const pos = positionOf(doc, card.line, card.character)
        const items = marksAt(doc, marksOf(card.path), pos)
        if (!items.length) return
        const box = target.coordsAtPos(pos)
        setHover({ items, anchor: { left: box.left, top: box.top, width: 1, height: box.bottom - box.top } })
      }),
    )
  }

  /** The marks under the pointer: on the text, the ones over it; on the gutter, the ones of the line. */
  const marksUnder = (clientX: number, clientY: number, target: EventTarget | null): Hover | null => {
    const current = viewRef.current
    const shown = pathRef.current
    if (!current || !shown) return null
    const items = marksOf(shown)
    if (!items.length) return null
    const doc = current.state.doc
    if (target instanceof Element && target.closest('.enc-gutter')) {
      const line = current.lineAtClientY(clientY)
      const found = marksOnLine(doc, items, line)
      if (!found.length) return null
      const at = current.coordsAtPos(doc.line(line).from)
      return { items: found, anchor: { left: clientX, top: at.top, width: 1, height: at.bottom - at.top } }
    }
    const pos = current.posAtCoords(clientX, clientY)
    const found = marksAt(doc, items, pos).filter((item) => {
      // posAtCoords takes the nearest place on the line: the pointer must be over the mark's own text.
      const { from, to } = rangeOf(doc, item)
      const start = current.coordsAtPos(from)
      const end = current.coordsAtPos(to)
      return start.top !== end.top || (clientX >= start.left - 2 && clientX <= end.left + 2 && clientY >= start.top && clientY <= start.bottom)
    })
    if (!found.length) return null
    const { from } = rangeOf(doc, found[0])
    const at = current.coordsAtPos(Math.max(from, doc.lineAt(pos).from))
    return { items: found, anchor: { left: Math.min(clientX, at.left + 400), top: at.top, width: 1, height: at.bottom - at.top } }
  }

  /** The word under the pointer, or null when it is over space, past the end of a line or off the text. */
  const wordUnder = (clientX: number, clientY: number, target: EventTarget | null): { from: number; to: number } | null => {
    const current = viewRef.current
    if (!current || !(target instanceof Element) || !target.closest('.enc-content') || target.closest('.enc-zone')) return null
    const state = current.state
    const pos = current.posAtCoords(clientX, clientY)
    const box = current.coordsAtPos(pos)
    if (clientY < box.top || clientY > box.bottom) return null
    // The pointer is on the character before `pos` when it is left of the boundary.
    const at = clientX < box.left ? pos - 1 : pos
    const line = state.doc.lineAt(Math.max(0, pos))
    if (at < line.from || at >= line.to) return null
    const from = wordStart(state, at + 1)
    const to = wordEnd(state, at)
    return to > from ? { from, to } : null
  }

  const clearLink = (target: EditorView | null) => {
    if (!linkRange.current) return
    linkRange.current = null
    target?.setSource('link', null)
    target?.root.classList.remove('enc-linking')
  }

  /** With Ctrl (Cmd on macOS) held, the word under the pointer reads as a link to its definition. */
  const showLink = (word: { from: number; to: number } | null) => {
    const current = viewRef.current
    if (!current) return
    if (!word) return clearLink(current)
    if (linkRange.current?.from === word.from && linkRange.current.to === word.to) return
    linkRange.current = word
    current.setSource('link', DecorationSet.of(current.state.doc, { marks: [{ from: word.from, to: word.to, className: 'enc-mark-link' }] }))
    current.root.classList.add('enc-linking')
  }

  /** What the server says of the symbol under the pointer, added to the card when it comes. */
  const askHover = (word: { from: number; to: number }, marks: Hover | null) => {
    const current = viewRef.current
    const shown = pathRef.current
    if (!current || !shown) return
    const token = ++hoverAsk.current
    const doc = current.state.doc
    void askServers({ kind: 'hover', path: shown, ...lspAt(doc, word.from) }).then((answer) => {
      if (token !== hoverAsk.current || viewRef.current !== current || current.state.doc !== doc || !answer?.markdown.trim()) return
      const start = answer.range ? positionOf(doc, answer.range.start.line, answer.range.start.character) : word.from
      const at = current.coordsAtPos(Math.max(doc.lineAt(word.from).from, Math.min(start, word.from)))
      setHover({ items: marks?.items ?? [], markdown: answer.markdown, anchor: marks?.anchor ?? { left: at.left, top: at.top, width: 1, height: at.bottom - at.top } })
    })
  }

  const onPointerMove = (event: ReactPointerEvent) => {
    window.clearTimeout(hoverTimer.current)
    hoverAsk.current++
    const { clientX, clientY, target, buttons } = event
    if (buttons) return
    // The peek between the lines is not the text: it has its own pointer.
    if (target instanceof Element && target.closest('.enc-zone')) return clearLink(viewRef.current)
    const command = viewRef.current?.mac ? event.metaKey : event.ctrlKey
    showLink(command ? wordUnder(clientX, clientY, target) : null)
    hoverTimer.current = window.setTimeout(() => {
      const marks = marksUnder(clientX, clientY, target)
      setHover((current) => (marks ? marks : overCard.current ? current : null))
      const word = wordUnder(clientX, clientY, target)
      if (word) askHover(word, marks)
    }, HOVER_MS)
  }

  const onPointerLeave = () => {
    window.clearTimeout(hoverTimer.current)
    hoverAsk.current++
    clearLink(viewRef.current)
    // Over to the card is still on the mark: leave it up for the person to read or select.
    hoverTimer.current = window.setTimeout(() => {
      if (!overCard.current) setHover(null)
    }, 120)
  }

  // Letting go of Ctrl ends the link.
  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Control' || event.key === 'Meta') clearLink(viewRef.current)
    }
    const onBlur = () => clearLink(viewRef.current)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  async function goToLine(target: EditorView): Promise<void> {
    const answer = await useUi.getState().askText('Go to line', `1 to ${target.state.doc.lineCount}, or line:column`)
    if (answer === null || viewRef.current !== target) return
    const pos = parseLocation(answer, target.state)
    if (pos === null) {
      useUi.getState().notify('error', `"${answer}" is not a line number.`)
    } else {
      target.select(pos)
      target.scrollToPos(pos, true)
    }
    target.focus()
  }

  const entries = (): MenuEntry[] => {
    const current = viewRef.current
    const state = current?.state
    const selected = Boolean(state && !state.selection.main.empty)
    const editable = Boolean(state && !state.config.readOnly)
    const native = (command: 'cut' | 'copy' | 'paste') => () => {
      current?.focus()
      document.execCommand(command)
    }
    const run = (name: string) => () => {
      current?.focus()
      current?.runCommand(name)
    }
    return [
      { id: 'definition', label: 'Go to definition', shortcut: 'F12', onSelect: run('goToDefinition') },
      { id: 'peek', label: 'Peek definition', shortcut: 'Alt+F12', onSelect: run('peekDefinition') },
      { id: 'references', label: 'Go to references', shortcut: 'Shift+F12', onSelect: run('goToReferences') },
      { id: 'implementation', label: 'Go to implementation', shortcut: 'Ctrl+F12', onSelect: run('goToImplementation') },
      { id: 'calls', label: 'Show call hierarchy', shortcut: 'Shift+Alt+H', onSelect: run('callHierarchy') },
      { kind: 'separator', id: 'navigate' },
      { id: 'rename', label: 'Rename symbol', shortcut: 'F2', disabled: !editable, onSelect: run('renameSymbol') },
      { id: 'quick-fix', label: 'Quick fix…', shortcut: 'Ctrl+.', disabled: !editable, onSelect: run('quickFix') },
      { id: 'refactor', label: 'Refactor…', shortcut: 'Ctrl+Shift+R', disabled: !editable, onSelect: run('refactor') },
      { id: 'source-action', label: 'Source action…', disabled: !editable, onSelect: run('sourceAction') },
      { kind: 'separator', id: 'change' },
      { id: 'format', label: 'Format document', shortcut: 'Shift+Alt+F', disabled: !editable, onSelect: run('formatDocument') },
      { id: 'format-selection', label: selected ? 'Format selection' : 'Format line', disabled: !editable, onSelect: run('formatSelection') },
      { kind: 'separator', id: 'format' },
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

  const closePeek = () => {
    setPeek(null)
    setCalls(null)
    viewRef.current?.focus()
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
          hoverAsk.current++
          setHover(null)
        }}
      />
      {hover && (
        <HoverCard
          hover={hover}
          language={language}
          onEnter={() => {
            overCard.current = true
            window.clearTimeout(hoverTimer.current)
          }}
          onLeave={() => {
            overCard.current = false
            setHover(null)
          }}
          onQuickFix={
            viewRef.current?.state.config.readOnly
              ? undefined
              : () => {
                  const current = viewRef.current
                  const item = hover.items[0]
                  overCard.current = false
                  setHover(null)
                  if (!current || !item) return
                  // The fixes are for the problem the card shows: the cursor goes to it first.
                  const { from } = rangeOf(current.state.doc, item)
                  if (!marksAt(current.state.doc, [item], current.state.selection.main.head).length) current.select(from)
                  current.focus()
                  void refactorRef.current?.quickFix()
                }
          }
        />
      )}
      {view && assistRef.current && path ? (
        <>
          <SuggestWidget assist={assistRef.current} language={language} />
          <SignatureCard assist={assistRef.current} language={language} />
        </>
      ) : null}
      {view && refactorRef.current && path ? (
        <>
          <RenameBox refactor={refactorRef.current} />
          <ActionMenu refactor={refactorRef.current} />
          <LightbulbButton refactor={refactorRef.current} view={view} />
          <ChangePreview refactor={refactorRef.current} />
        </>
      ) : null}
      {view && peek ? (
        <Peek
          view={view}
          peek={peek}
          current={path}
          onClose={closePeek}
          onOpen={(location: EditorLocation) => {
            const from = peek.from
            setPeek(null)
            goToLocation(location, from)
          }}
        />
      ) : null}
      {view && calls ? (
        <CallsPeek
          view={view}
          calls={calls}
          onClose={closePeek}
          onOpen={(location: EditorLocation) => {
            const from = calls.from
            setCalls(null)
            goToLocation(location, from)
          }}
        />
      ) : null}
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

import { DecorationSet, type EditorView } from '@encode/editor-view'
import type { DebugBreakpoint } from '@shared/types'
import { breakpointClass, placeOf } from '../panels/debug'
import { useDebug } from '../stores/debug'
import { useUi } from '../stores/ui'
import type { MenuEntry } from '../ui/Menu'

/** A hit count the debugger reads: `5` (from the 5th hit on), `== 5`, `> 5`, `% 5` (every 5th) and the like. */
const HIT_COUNT = /^\s*(==|>=|<=|>|<|%)?\s*\d+\s*$/

/**
 * The open file's breakpoints in the editor's gutter, and the line the program is paused on (ADR 0143). A click left
 * of a line number sets a breakpoint or takes it away; an edit moves them with their lines. One per editor view.
 */
export class EditorBreakpoints {
  private path: string | null = null
  /** What is drawn, so a change of the store that is not of this file draws nothing. */
  private drawnMarks: string | null = null
  private drawnPlace: string | null = null
  private readonly stops: (() => void)[] = []

  constructor(private readonly view: EditorView) {
    this.stops.push(
      useDebug.subscribe(() => this.draw()),
      view.on('gutterClick', ({ line }) => {
        if (this.path && line >= 1 && line <= view.state.doc.lineCount) useDebug.getState().toggleBreakpoint(this.path, line)
      }),
      view.on('transaction', (tr) => {
        const path = this.path
        if (!path || !tr.docChanged || !useDebug.getState().state?.breakpoints[path]?.length) return
        const before = tr.startState.doc
        const after = tr.state.doc
        // A breakpoint goes with the start of its line: Enter at the start pushes it down with the text.
        useDebug.getState().moveBreakpoints(path, (line) => (line > before.lineCount ? line : after.lineAt(tr.changes.mapPos(before.line(line).from, 1)).number))
      }),
    )
  }

  /** The editor shows another file, or none; the view has its state already. */
  show(path: string | null): void {
    this.path = path
    this.drawnMarks = null
    this.drawnPlace = null
    this.draw()
  }

  dispose(): void {
    for (const stop of this.stops.splice(0)) stop()
  }

  private draw(): void {
    const path = this.path
    const { state, frame } = useDebug.getState()
    const doc = this.view.state.doc
    const list = path ? (state?.breakpoints[path] ?? []) : []
    const marks = list.map((item) => `${item.line}:${breakpointClass(item)}`).join(' ')
    if (marks !== this.drawnMarks) {
      this.drawnMarks = marks
      this.view.setSource('breakpoints', list.length ? DecorationSet.of(doc, { gutter: list.map((item) => ({ line: item.line, className: breakpointClass(item) })) }) : null)
    }
    const place = path ? placeOf(state, frame) : null
    const here = place && place.path === path && place.line >= 1 && place.line <= doc.lineCount ? place : null
    const key = here ? `${here.line}:${here.top}` : ''
    if (key !== this.drawnPlace) {
      this.drawnPlace = key
      this.view.setSource(
        'debug-frame',
        here
          ? DecorationSet.of(doc, {
              lines: [{ line: here.line, className: here.top ? 'enc-line-paused' : 'enc-line-frame' }],
              gutter: [{ line: here.line, className: here.top ? 'enc-frame-top' : 'enc-frame-other' }],
            })
          : null,
      )
    }
  }
}

/** What the editor's context menu offers in the breakpoint column, for `line` of `path`. */
export function breakpointMenu(path: string, line: number): MenuEntry[] {
  const debug = useDebug.getState()
  const existing = debug.state?.breakpoints[path]?.find((item) => item.line === line)
  const ask = useUi.getState().askText
  const notify = (text: string) => useUi.getState().notify('error', text)
  const hitCount = (value: string): boolean => {
    if (!value.trim() || HIT_COUNT.test(value)) return true
    notify('A hit count is a number, with == > >= < <= or % before it if you like: 5, == 5, % 3.')
    return false
  }
  type Extra = Pick<DebugBreakpoint, 'condition' | 'hitCondition' | 'logMessage'>
  const put = (extra: Extra) => (existing ? debug.editBreakpoint(path, existing.id, { ...extra, enabled: true }) : debug.addBreakpoint(path, line, extra))
  const condition = () => void ask('Stop only when this is true', 'count > 3', existing?.condition ?? '').then((value) => value !== null && put({ condition: value }))
  const hits = () => void ask('Stop on which hits', '5, == 5, > 5 or % 5', existing?.hitCondition ?? '').then((value) => value !== null && hitCount(value) && put({ hitCondition: value }))
  const log = () => void ask('Print this instead of stopping. Put an expression in {braces} for its value.', 'Total is {total}', existing?.logMessage ?? '').then((value) => value !== null && put({ logMessage: value }))
  if (!existing) {
    return [
      { id: 'bp-add', label: 'Add breakpoint', shortcut: 'F9', onSelect: () => debug.toggleBreakpoint(path, line) },
      { id: 'bp-condition', label: 'Add conditional breakpoint…', onSelect: condition },
      { id: 'bp-hits', label: 'Add breakpoint on a hit count…', onSelect: hits },
      { id: 'bp-log', label: 'Add log point…', onSelect: log },
    ]
  }
  return [
    { id: 'bp-remove', label: existing.logMessage ? 'Remove log point' : 'Remove breakpoint', shortcut: 'F9', onSelect: () => debug.editBreakpoint(path, existing.id, null) },
    { id: 'bp-toggle', label: existing.enabled ? 'Turn off' : 'Turn on', onSelect: () => debug.editBreakpoint(path, existing.id, { enabled: !existing.enabled }) },
    { kind: 'separator', id: 'bp-what' },
    { id: 'bp-condition', label: existing.condition ? 'Edit condition…' : 'Add a condition…', onSelect: condition },
    { id: 'bp-hits', label: existing.hitCondition ? 'Edit hit count…' : 'Add a hit count…', onSelect: hits },
    { id: 'bp-log', label: existing.logMessage ? 'Edit log message…' : 'Print instead of stopping…', onSelect: log },
  ]
}

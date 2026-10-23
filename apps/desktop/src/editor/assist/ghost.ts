import { EditorSelection, SelectionRange, type Transaction } from '@encode/editor'
import type { EditorView } from '@encode/editor-view'
import type { Text } from '@encode/text'
import type { InlineSuggestAnswer, InlineSuggestRequest } from '@shared/types'
import { api } from '../../api'
import { create } from '../../store'
import { currentDoc, openDocPaths } from '../docs'
import { useAssist } from './controller'
import { GHOST_MS, GhostCache, contextAt, followGhost, nextWord, pickSnippets, suggestibleAt, type Ghost, type GhostStatus } from './ghost-text'

export { GHOST_MS, type Ghost, type GhostStatus } from './ghost-text'

// ------------------------------------------------------------------ the controller

export const useGhost = create<{ status: GhostStatus }>(() => ({ status: { kind: 'idle' } }))

const setStatus = (status: GhostStatus): void => {
  const now = useGhost.getState().status
  if (now.kind !== status.kind || JSON.stringify(now) !== JSON.stringify(status)) useGhost.setState({ status })
}

/** What typing does that asks for a suggestion once it pauses. */
const ASKING = new Set(['input.type', 'input.newline', 'input.delete', 'input.complete', 'input.ghost'])

/**
 * Suggestions as you type (ADR 0087): once typing pauses, the model of the Inline suggestions role is asked what comes
 * at the cursor, and its answer is drawn there as ghost text. Tab takes it, Ctrl+Right takes its next word, Esc puts
 * it away, Alt+\ asks for one at once. Nothing is asked while the list of suggestions or a snippet is open, while an
 * input method composes, or while the editor does not have the focus. One per editor view.
 */
export class EditorGhost {
  private path: string | null = null
  private language = 'plaintext'
  private ghost: Ghost | null = null
  private timer: number | undefined
  private asking: { id: number; doc: Text; pos: number } | null = null
  private nextId = 0
  private pausedUntil = 0
  private stopped = false
  /** Esc put the suggestion away: none comes back until the text changes. */
  private dismissed = false
  private readonly cache = new GhostCache()
  private readonly stops: (() => void)[] = []

  constructor(
    private readonly view: EditorView,
    /** Whether the settings have suggestions on. */
    private readonly enabled: () => boolean,
  ) {
    this.stops.push(view.on('transaction', (tr) => this.onTransaction(tr)))
    this.stops.push(view.on('blur', () => this.hide()))
    const onKey = (event: KeyboardEvent) => this.onKey(event)
    view.root.addEventListener('keydown', onKey, true)
    this.stops.push(() => view.root.removeEventListener('keydown', onKey, true))
    // The list of suggestions opening puts the ghost away: the two would offer different text at one place.
    this.stops.push(
      useAssist.subscribe(() => {
        if (useAssist.getState().suggest) this.hide()
      }),
    )
  }

  /** The editor shows another file, or none. */
  show(path: string | null, language = 'plaintext'): void {
    this.hide()
    this.path = path
    this.language = language
    this.dismissed = false
  }

  /** The settings changed: a stop or a pause they caused may be over, and turned off, the ghost goes. */
  wake(): void {
    this.stopped = false
    this.pausedUntil = 0
    // Another model may answer now: what the last one said is not its answer.
    this.cache.clear()
    if (!this.enabled()) this.hide()
    setStatus({ kind: 'idle' })
  }

  dispose(): void {
    this.show(null)
    for (const stop of this.stops.splice(0)) stop()
  }

  /** The suggestion drawn now. */
  get current(): Ghost | null {
    return this.ghost
  }

  /** Alt+\: a suggestion here and now, whatever stopped one coming. */
  trigger(): void {
    this.dismissed = false
    this.stopped = false
    this.pausedUntil = 0
    window.clearTimeout(this.timer)
    void this.ask(true)
  }

  /** Tab: the whole suggestion goes in, as one step for Ctrl+Z. */
  accept(): boolean {
    const ghost = this.ghost
    if (!ghost) return false
    return this.take(ghost, ghost.text)
  }

  /** Ctrl+Right: its next word goes in, and the rest stays. */
  acceptWord(): boolean {
    const ghost = this.ghost
    if (!ghost) return false
    return this.take(ghost, nextWord(ghost.text))
  }

  /** Esc: the suggestion goes, and no other comes until the text changes. */
  dismiss(): boolean {
    if (!this.ghost) return false
    this.dismissed = true
    this.hide()
    return true
  }

  // ------------------------------------------------------------ the editor's events

  private onTransaction(tr: Transaction): void {
    if (!this.path) return
    if (this.ghost) {
      const kept = followGhost(this.ghost, tr)
      if (kept) {
        this.draw(kept)
        if (!tr.docChanged) return
      } else this.hide()
    }
    if (!tr.docChanged) {
      // The cursor moved: what was being asked is for another place.
      if (tr.selectionChanged) this.cancel()
      return
    }
    this.dismissed = false
    this.cancel()
    if (this.ghost || !ASKING.has(tr.origin ?? '')) return
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => void this.ask(false), GHOST_MS)
  }

  private onKey(event: KeyboardEvent): void {
    const ghost = this.ghost
    if (!ghost || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    if (useAssist.getState().suggest || this.view.snippet.active) return
    const handled = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    // Tab moving the focus (Ctrl+M) leaves Tab to that.
    if (event.key === 'Tab' && plain && !this.view.options.tabMovesFocus) {
      if (this.accept()) handled()
      return
    }
    // Ctrl+Right (Cmd+Right on macOS); Alt+Right stays Go forward.
    const word = this.view.mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    if (event.key === 'ArrowRight' && word && !event.altKey && !event.shiftKey) {
      if (this.acceptWord()) handled()
      return
    }
    if (event.key === 'Escape' && plain) {
      if (this.dismiss()) handled()
    }
  }

  // ------------------------------------------------------------ asking

  private canAsk(explicit: boolean): boolean {
    const view = this.view
    if (!this.path || !this.enabled()) return false
    if (!explicit && (this.stopped || this.dismissed || Date.now() < this.pausedUntil)) return false
    if (!view.hasFocus || view.input.composing || view.snippet.active || useAssist.getState().suggest) return false
    return suggestibleAt(view.state)
  }

  private async ask(explicit: boolean): Promise<void> {
    if (!this.canAsk(explicit)) {
      if (explicit && this.path && !this.enabled()) setStatus({ kind: 'stopped', message: 'Suggestions as you type are off (Settings, Editor).' })
      return
    }
    const path = this.path!
    const state = this.view.state
    const pos = state.selection.main.head
    const context = contextAt(state, pos)
    const key = GhostCache.key(path, context.prefix, context.suffix)
    const known = this.cache.get(key)
    // An answer of nothing is kept too, so typing back to a place asks nothing; Alt+\ asks again all the same.
    if (known !== undefined && (known || !explicit)) {
      if (known) this.draw({ pos, text: known })
      return
    }
    this.cancel()
    const id = ++this.nextId
    this.asking = { id, doc: state.doc, pos }
    const others = openDocPaths()
      .filter((other) => other !== path)
      .map((other) => ({ path: other, doc: currentDoc(other) }))
      .filter((other): other is { path: string; doc: Text } => other.doc !== undefined)
    const request: InlineSuggestRequest = { id, path, language: this.language, ...context, snippets: pickSnippets(context.prefix, others) }
    setStatus({ kind: 'asking' })
    let answer: InlineSuggestAnswer
    try {
      answer = await api.code.inline(request)
    } catch {
      answer = { kind: 'none' }
    }
    if (this.asking?.id !== id) return
    this.asking = null
    if (answer.kind === 'paused') {
      if (answer.stop) {
        this.stopped = true
        setStatus({ kind: 'stopped', message: answer.message })
      } else {
        this.pausedUntil = answer.until ?? Date.now() + 30_000
        setStatus({ kind: 'paused', message: answer.message, ...(answer.until ? { until: answer.until } : {}) })
      }
      return
    }
    setStatus({ kind: 'idle' })
    this.cache.set(key, answer.kind === 'text' ? answer.text : '')
    // Typed on or moved meanwhile: the answer is for a place that is gone.
    const now = this.view.state
    if (answer.kind !== 'text' || now.doc !== state.doc || now.selection.main.head !== pos || !this.canAsk(true)) return
    this.draw({ pos, text: answer.text })
    if (this.view.options.screenReader) this.view.announce(`Suggestion: ${answer.text.split('\n')[0].trim()}. Tab to accept.`)
  }

  /** What is being asked is no longer wanted. */
  private cancel(): void {
    window.clearTimeout(this.timer)
    const asking = this.asking
    if (!asking) return
    this.asking = null
    api.code.cancelInline(asking.id)
    setStatus({ kind: 'idle' })
  }

  // ------------------------------------------------------------ drawing and taking

  private draw(ghost: Ghost): void {
    this.ghost = ghost
    this.view.setGhostText(ghost)
    // Drawn only where the view can (not in a line too long to draw): what it shows is what Tab takes.
    if (!this.view.ghostText) this.ghost = null
  }

  private hide(): void {
    this.cancel()
    if (!this.ghost) return
    this.ghost = null
    this.view.setGhostText(null)
  }

  private take(ghost: Ghost, text: string): boolean {
    const view = this.view
    if (!text || view.state.config.readOnly) return false
    const end = ghost.pos + text.length
    view.dispatch({
      changes: { from: ghost.pos, insert: text },
      selection: EditorSelection.create([new SelectionRange(end, end)]),
      origin: 'input.ghost',
      scrollIntoView: true,
    })
    return true
  }
}

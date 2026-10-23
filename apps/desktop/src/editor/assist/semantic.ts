import type { EditorView } from '@encode/editor-view'
import { semanticTokensToView } from '../hints'
import { onMarksChanged } from '../marks'
import { askServers } from './ask'

/** How long semantic colours wait after typing stops before they are asked for again. */
const TYPED_MS = 300
/** Files past these sizes keep the lexer's colours alone: a server's tokens for them are slow to come and large. */
const MAX_CHARS = 2_000_000
const MAX_LINES = 50_000

/**
 * Asks the file's language server for its semantic tokens (what each name is: a type, a parameter, a deprecated
 * function) and has the view draw them over the lexer's colours. Asked when a file is shown, once typing pauses, and
 * when the server marks the file while it gave nothing yet (it was still loading the project). One per editor view.
 *
 * Asked only while semantic colours are on (`wanted`); turned off, they are taken away, and turned on, asked for again.
 */
export class EditorSemanticColours {
  private path: string | null = null
  private token = 0
  private timer: number | undefined
  /** The last answer had no tokens, or there was none: a server that marks the file later may have them. */
  private empty = false
  private readonly stops: (() => void)[] = []

  constructor(
    private readonly view: EditorView,
    private readonly wanted: () => boolean = () => true,
  ) {
    this.stops.push(
      view.on('transaction', (tr) => {
        if (tr.docChanged) this.schedule()
      }),
      onMarksChanged((path) => {
        if (path === this.path && this.empty) this.schedule()
      }),
    )
  }

  /** The editor shows another file, or none; the view has the new state already (and no tokens). */
  show(path: string | null): void {
    this.path = path
    this.token++
    this.empty = false
    window.clearTimeout(this.timer)
    if (path) void this.refresh()
  }

  /** Semantic colours were turned on or off. */
  wake(): void {
    if (!this.wanted()) {
      this.token++
      window.clearTimeout(this.timer)
      this.view.setSemanticTokens(null)
      return
    }
    if (this.path) void this.refresh()
  }

  /** Asks for the whole file's tokens, for the text as it is. */
  async refresh(): Promise<void> {
    const path = this.path
    window.clearTimeout(this.timer)
    if (!path || !this.wanted()) return
    const doc = this.view.state.doc
    if (doc.length > MAX_CHARS || doc.lineCount > MAX_LINES) {
      this.view.setSemanticTokens(null)
      return
    }
    const token = ++this.token
    const answer = await askServers({ kind: 'semanticTokens', path })
    if (token !== this.token || this.path !== path || !this.wanted()) return
    if (this.view.state.doc !== doc) return this.schedule()
    this.empty = !answer?.data.length
    this.view.setSemanticTokens(answer ? semanticTokensToView(answer) : null)
  }

  dispose(): void {
    this.token++
    window.clearTimeout(this.timer)
    for (const stop of this.stops.splice(0)) stop()
  }

  private schedule(): void {
    window.clearTimeout(this.timer)
    if (this.path && this.wanted()) this.timer = window.setTimeout(() => void this.refresh(), TYPED_MS)
  }
}

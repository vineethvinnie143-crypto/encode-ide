/**
 * The page the browser tests load: the view, the core it sits on and a small
 * harness to mount editors with. Bundled by run.mjs; nothing here ships.
 */
import { EditorSelection, EditorState, Highlighter, SelectionRange, T, compileSearch, connectHighlighting, findNext, languageForPath, searchMatches, type HighlightConnection } from '@encode/editor'
import { Text } from '@encode/text'
import { EditorView, type EditorViewConfig } from '../../src/index'
import '../../src/style.css'

export interface MountOptions {
  text?: string
  path?: string
  width?: number
  height?: number
  config?: Partial<EditorViewConfig>
  readOnly?: boolean
  focus?: boolean
  /** Tokenize on the page's highlighting worker, as the app does. */
  worker?: boolean
}

declare global {
  interface Window {
    view: EditorView
    enc: typeof api
    harness: {
      mount(options?: MountOptions): EditorView
      /** The page's highlighting worker, started on first use. */
      highlighting(): HighlightConnection
    }
  }
}

const api = { EditorSelection, EditorState, SelectionRange, T, Text, EditorView, Highlighter, compileSearch, findNext, searchMatches, languageForPath }
window.enc = api

let current: EditorView | null = null
let highlighting: HighlightConnection | null = null

window.harness = {
  highlighting() {
    if (!highlighting?.alive) highlighting = connectHighlighting(new Worker('worker.js'))
    return highlighting
  },
  mount(options = {}) {
    current?.destroy()
    const host = document.getElementById('host') as HTMLDivElement
    host.replaceChildren()
    host.style.width = `${options.width ?? 800}px`
    host.style.height = `${options.height ?? 400}px`
    const state = EditorState.create({
      doc: options.text ?? '',
      language: options.path ? languageForPath(options.path) : undefined,
      readOnly: options.readOnly,
    })
    const view = new EditorView({ state, parent: host, highlighting: options.worker ? window.harness.highlighting() : null, ...options.config })
    current = window.view = view
    if (options.focus !== false) view.focus()
    return view
  },
}

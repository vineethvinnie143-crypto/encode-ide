/**
 * The page the browser tests load: the view, the core it sits on and a small
 * harness to mount editors with. Bundled by run.mjs; nothing here ships.
 */
import { EditorSelection, EditorState, SelectionRange, languageForPath } from '@encode/editor'
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
}

declare global {
  interface Window {
    view: EditorView
    enc: typeof api
    harness: { mount(options?: MountOptions): EditorView }
  }
}

const api = { EditorSelection, EditorState, SelectionRange, Text, EditorView, languageForPath }
window.enc = api

let current: EditorView | null = null

window.harness = {
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
    const view = new EditorView({ state, parent: host, ...options.config })
    current = window.view = view
    if (options.focus !== false) view.focus()
    return view
  },
}

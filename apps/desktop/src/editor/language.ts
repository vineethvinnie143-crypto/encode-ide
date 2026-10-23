import type { EditorState } from '@encode/editor'
import { watchDocs } from './docs'

/** A pause in typing before the servers get the new text: each change they get, they check the file again. */
export const SEND_AFTER_MS = 250
/** The largest document the servers are given, in characters; they read no more of a file from the disk either. */
export const MAX_DOCUMENT_CHARS = 8 * 1024 * 1024

/** Where the documents go: the open folder's language servers, through the main process. */
export interface DocumentSink {
  open(path: string, text: string, dirty: boolean): void
  change(path: string, text: string, dirty: boolean): void
  close(path: string): void
}

export interface LanguageSyncOptions {
  sendAfterMs?: number
  setTimer?(run: () => void, ms: number): unknown
  clearTimer?(timer: unknown): void
}

/**
 * Keeps the language servers on the editor's text: a file it opens goes at once, typing goes after a short pause and
 * a save at once (the servers check a saved file again), and a closed file is taken back. A document too large for a
 * server is not given to it. Returns the way to stop.
 */
export function startLanguageSync(sink: DocumentSink, options: LanguageSyncOptions = {}): () => void {
  const wait = options.sendAfterMs ?? SEND_AFTER_MS
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms))
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  /** The paths the servers were given, and a change waiting to go for each. */
  const given = new Set<string>()
  const waiting = new Map<string, unknown>()

  const send = (path: string, state: EditorState, dirty: boolean, kind: 'open' | 'change'): void => {
    if (state.doc.length > MAX_DOCUMENT_CHARS) {
      if (given.delete(path)) sink.close(path)
      return
    }
    const text = state.serialize()
    if (kind === 'open' || !given.has(path)) sink.open(path, text, dirty)
    else sink.change(path, text, dirty)
    given.add(path)
  }

  const cancel = (path: string): void => {
    if (!waiting.has(path)) return
    clearTimer(waiting.get(path))
    waiting.delete(path)
  }

  watchDocs({
    opened(path, state, dirty) {
      cancel(path)
      send(path, state, dirty, 'open')
    },
    changed(path, state, dirty) {
      cancel(path)
      // Saved, or read again from the disk: the servers check it now.
      if (!dirty) return send(path, state, false, 'change')
      const timer = setTimer(() => {
        waiting.delete(path)
        send(path, state, true, 'change')
      }, wait)
      waiting.set(path, timer)
    },
    closed(path) {
      cancel(path)
      if (given.delete(path)) sink.close(path)
    },
  })

  return () => {
    watchDocs(null)
    for (const path of [...waiting.keys()]) cancel(path)
  }
}

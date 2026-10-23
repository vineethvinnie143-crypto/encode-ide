import type { EditorState } from '@encode/editor'
import { docState, watchDocs } from './docs'

/** A pause in typing before the servers get the new text: each change they get, they check the file again. */
export const SEND_AFTER_MS = 250
/** The largest document the servers are given, in characters; they read no more of a file from the disk either. */
export const MAX_DOCUMENT_CHARS = 8 * 1024 * 1024

/** Whether the document open at `path` is larger than the servers are given. */
export function tooLargeForServers(path: string): boolean {
  return (docState(path)?.doc.length ?? 0) > MAX_DOCUMENT_CHARS
}

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

/** Sends the change waiting for a path at once; set while a sync runs. */
let flushNow: ((path: string) => void) | null = null

/** Sends the change waiting for `path` now, so that a question asked next is answered for the text as it is. */
export function flushLanguageSync(path: string): void {
  flushNow?.(path)
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
  const pending = new Map<string, () => void>()

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
    pending.delete(path)
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
      const run = () => {
        waiting.delete(path)
        pending.delete(path)
        send(path, state, true, 'change')
      }
      waiting.set(path, setTimer(run, wait))
      pending.set(path, run)
    },
    closed(path) {
      cancel(path)
      if (given.delete(path)) sink.close(path)
    },
  })

  const flush = (path: string): void => {
    const run = pending.get(path)
    if (!run) return
    clearTimer(waiting.get(path))
    run()
  }
  flushNow = flush

  return () => {
    watchDocs(null)
    if (flushNow === flush) flushNow = null
    for (const path of [...waiting.keys()]) cancel(path)
  }
}

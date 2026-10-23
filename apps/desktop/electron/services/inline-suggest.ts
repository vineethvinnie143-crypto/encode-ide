/**
 * The main process's side of suggestions as you type (ADR 0087): what it takes of a request from the page, and one
 * request at a time per window, a newer one stopping the older.
 */
import { INLINE_NAME_CHARS, INLINE_PREFIX_CHARS, INLINE_SNIPPET_CHARS, INLINE_SNIPPETS, INLINE_SUFFIX_CHARS, headToLine, tailFromLine } from '../../shared/inline'
import type { InlineSuggestAnswer, InlineSuggestRequest } from '../../shared/types'

/** An editor language id: a short word ("typescriptreact", "lua", "c++"). */
const LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9_.+#-]{0,63}$/

/**
 * A request from the page, checked: a positive id, a path inside the open folder (`relative` says which, or null), a
 * language id, the texts cut to their limits, and at most a few snippets of files inside the folder. Null when it is
 * not one.
 */
export function readInlineRequest(value: unknown, relative: (path: string) => string | null): InlineSuggestRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const { id, path, language, prefix, suffix, multiline, snippets } = raw
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null
  if (typeof path !== 'string' || !path || path.length > INLINE_NAME_CHARS) return null
  const file = relative(path)
  if (!file) return null
  if (typeof language !== 'string' || !LANGUAGE.test(language)) return null
  if (typeof prefix !== 'string' || typeof suffix !== 'string' || typeof multiline !== 'boolean') return null
  const kept: InlineSuggestRequest['snippets'] = []
  if (Array.isArray(snippets)) {
    for (const snippet of snippets.slice(0, INLINE_SNIPPETS)) {
      if (typeof snippet !== 'object' || snippet === null) continue
      const { path: other, text } = snippet as Record<string, unknown>
      if (typeof other !== 'string' || !other || other.length > INLINE_NAME_CHARS || typeof text !== 'string') continue
      const otherFile = relative(other)
      if (!otherFile || otherFile === file) continue
      const cut = headToLine(text, INLINE_SNIPPET_CHARS)
      if (cut.trim()) kept.push({ path: otherFile, text: cut })
    }
  }
  return { id, path: file, language, prefix: tailFromLine(prefix, INLINE_PREFIX_CHARS), suffix: headToLine(suffix, INLINE_SUFFIX_CHARS), multiline, snippets: kept }
}

/** One suggestion running at a time: a newer request stops the one before it, and `cancel` stops one by its id. */
export class InlineRequests {
  private running: { id: number; controller: AbortController } | null = null

  async run(id: number, ask: (signal: AbortSignal) => Promise<InlineSuggestAnswer>): Promise<InlineSuggestAnswer> {
    this.running?.controller.abort(new Error('A newer suggestion was asked for.'))
    const entry = { id, controller: new AbortController() }
    this.running = entry
    try {
      return await ask(entry.controller.signal)
    } catch {
      return { kind: 'none' }
    } finally {
      if (this.running === entry) this.running = null
    }
  }

  cancel(id: number): void {
    if (this.running?.id === id) this.running.controller.abort(new Error('The editor no longer wants it.'))
  }
}

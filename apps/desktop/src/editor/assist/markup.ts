import { MAX_TOKENIZED_LINE, TOKEN_NAMES, languageByName, type Tokenizer } from '@encode/editor'
import type { CodeMarkup } from '@shared/types'
import { escapeHtml, renderMarkdown } from '../../markdown'

/** Code in a hover or a suggestion's details is short; a block longer than this is cut. */
const MAX_CODE_CHARS = 20_000

/** One line of code as spans of the editor's token classes (`tok-keyword`...), escaped. */
function highlightLine(tokenizer: Tokenizer, text: string, state: string): { html: string; state: string } {
  let result: { tokens: readonly number[]; state: string }
  try {
    result = tokenizer.line(text.length > MAX_TOKENIZED_LINE ? text.slice(0, MAX_TOKENIZED_LINE) : text, state)
  } catch {
    return { html: escapeHtml(text), state }
  }
  const { tokens } = result
  let html = ''
  for (let index = 0; index < tokens.length; index += 2) {
    const start = tokens[index]
    const end = index + 2 < tokens.length ? tokens[index + 2] : text.length
    const piece = escapeHtml(text.slice(start, end))
    const name = TOKEN_NAMES[tokens[index + 1]] ?? 'plain'
    html += name === 'plain' ? piece : `<span class="tok-${name}">${piece}</span>`
  }
  if (!tokens.length) html = escapeHtml(text)
  return { html, state: result.state }
}

/** A block of code, coloured as the editor colours its language (the fence's, else the file's). */
export function codeBlockHtml(code: string, language: string, fallback?: string): string {
  const text = code.length > MAX_CODE_CHARS ? `${code.slice(0, MAX_CODE_CHARS)}…` : code
  const entry = (language && languageByName(language)) || (fallback ? languageByName(fallback) : undefined)
  if (!entry) return `<pre class="markup-code"><code>${escapeHtml(text)}</code></pre>`
  let state = entry.tokenizer.start
  const lines = text.split('\n').map((line) => {
    const result = highlightLine(entry.tokenizer, line, state)
    state = result.state
    return result.html
  })
  return `<pre class="markup-code"><code>${lines.join('\n')}</code></pre>`
}

/**
 * What a server wrote for people, as HTML that is safe to put in the page: markdown through the app's renderer
 * (which escapes everything first and allows only its own tags), with code blocks coloured; plain text escaped.
 * `language` colours a fence without a language of its own, such as a signature of the file's language.
 */
export function markupHtml(markup: CodeMarkup | string, language?: string): string {
  const value = typeof markup === 'string' ? markup : markup.value
  const kind = typeof markup === 'string' ? 'plaintext' : markup.kind
  if (kind === 'plaintext') return `<p class="markup-plain">${escapeHtml(value)}</p>`
  return renderMarkdown(value, { codeBlock: (code, fence) => codeBlockHtml(code, fence, language) })
}

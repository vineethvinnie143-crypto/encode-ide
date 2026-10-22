import { T, type LineTokens, type Tokenizer } from '../language'
import { javascript } from './clike'
import { cssTokenizer } from './css'
import { Scanner, WHITESPACE } from './scan'

/** Copies an embedded tokenizer's tokens for `text.slice(from, from + part.length)` into the scanner. */
function embed(s: Scanner, from: number, tokens: readonly number[]): void {
  for (let index = 0; index < tokens.length; index += 2) s.mark(from + tokens[index], tokens[index + 1])
}

// ---------------------------------------------------------------- HTML and XML

const TAG_NAME = /[A-Za-z][\w:.-]*/y
const ATTRIBUTE = /[^\s"'>/=]+/y
const ENTITY = /&(?:#\d+|#[xX][\da-fA-F]+|[A-Za-z][\w]*);/y

/** Content kind of a `<script>` from its `type` attribute. */
function scriptKind(type: string): string {
  const value = type.toLowerCase()
  if (!value || /module|javascript|ecmascript|babel|jsx|typescript/.test(value)) return 'js'
  if (/json|importmap|speculationrules/.test(value)) return 'json'
  return 'text'
}

/**
 * HTML (also Svelte and Vue templates) and XML. State: "" in text, `c`
 * in a comment, `d` in CDATA, `t<name>[:kind]` inside a tag, `a<quote><tag
 * state>` in an attribute value that spans lines, `S<kind>|<state>` in
 * script content and `Y|<state>` in style content (embedded tokenizer state
 * after the bar).
 */
function markup(xml: boolean, json: Tokenizer): Tokenizer {
  const embedded = (kind: string): Tokenizer | null => (kind === 'js' ? javascript : kind === 'json' ? json : null)

  const line = (text: string, state: string): LineTokens => {
    const s = new Scanner(text)
    let mode = state
    while (!s.eol) {
      if (mode === 'c' || mode === 'd') {
        const close = mode === 'c' ? '-->' : ']]>'
        const end = text.indexOf(close, s.pos)
        s.mark(s.pos, mode === 'c' ? T.comment : T.string)
        s.pos = end < 0 ? text.length : end + close.length
        if (end >= 0) mode = ''
        continue
      }
      if (mode[0] === 'S' || mode[0] === 'Y') {
        const bar = mode.indexOf('|')
        const kind = mode.slice(1, bar)
        const inner = mode.slice(bar + 1)
        const closing = new RegExp(`</${mode[0] === 'S' ? 'script' : 'style'}`, 'i')
        const rest = text.slice(s.pos)
        const at = rest.search(closing)
        const part = at < 0 ? rest : rest.slice(0, at)
        const tokenizer = mode[0] === 'Y' ? cssTokenizer : embedded(kind)
        if (part) {
          if (tokenizer) {
            const result = tokenizer.line(part, inner)
            embed(s, s.pos, result.tokens)
            mode = `${mode[0]}${kind}|${result.state}`
          } else s.mark(s.pos, T.string)
        }
        s.pos += part.length
        if (at >= 0) mode = ''
        continue
      }
      if (mode[0] === 'a') {
        const quote = mode[1]
        const end = text.indexOf(quote, s.pos)
        s.mark(s.pos, T.string)
        s.pos = end < 0 ? text.length : end + 1
        if (end >= 0) mode = mode.slice(2)
        continue
      }
      if (mode[0] === 't') {
        mode = tag(s, mode)
        continue
      }
      // Text.
      const start = s.pos
      const char = s.peek()
      if (char === '<') {
        if (s.startsWith('<!--')) {
          s.take(4, T.comment)
          mode = 'c'
        } else if (s.startsWith('<![CDATA[')) {
          s.take(9, T.meta)
          mode = 'd'
        } else if (s.startsWith('<!') || s.startsWith('<?')) {
          const end = text.indexOf('>', s.pos)
          s.mark(start, T.meta)
          s.pos = end < 0 ? text.length : end + 1
        } else if (s.peek(1) === '/' && /[A-Za-z]/.test(s.peek(2))) {
          s.take(2, T.punct)
          s.token(TAG_NAME, T.tag)
          mode = 't/'
        } else if (/[A-Za-z]/.test(s.peek(1))) {
          s.take(1, T.punct)
          const name = s.match(TAG_NAME)!
          s.mark(start + 1, T.tag)
          mode = `t${xml ? '' : name.toLowerCase()}`
        } else s.take(1, T.plain)
        continue
      }
      if (char === '&') {
        if (!s.token(ENTITY, T.escape)) s.take(1, T.plain)
        continue
      }
      if (char === '{' && !xml) {
        // Template expressions: Svelte `{x}`, Vue and Angular `{{ x }}`.
        const double = s.peek(1) === '{'
        const close = text.indexOf(double ? '}}' : '}', s.pos + 1)
        if (close > 0) {
          s.take(double ? 2 : 1, T.punct)
          s.mark(s.pos, T.variable)
          s.pos = close
          s.take(double ? 2 : 1, T.punct)
          continue
        }
      }
      if (!s.token(xml ? /[^<&]+/y : /[^<&{]+/y, T.plain)) s.take(1, T.plain)
    }
    return { tokens: s.tokens(), state: mode }
  }

  /** One token inside a tag; returns the new mode. */
  const tag = (s: Scanner, mode: string): string => {
    const char = s.peek()
    const [name, kind] = mode.slice(1).split(':')
    if (char === ' ' || char === '\t') {
      s.token(WHITESPACE, T.plain)
      return mode
    }
    if (char === '/' && s.peek(1) === '>') {
      s.take(2, T.punct)
      return ''
    }
    if (char === '>') {
      s.take(1, T.punct)
      if (name === 'script') return `S${kind ?? 'js'}|${(embedded(kind ?? 'js') ?? javascript).start}`
      if (name === 'style') return `Y|${cssTokenizer.start}`
      return ''
    }
    if (char === '=') {
      s.take(1, T.operator)
      return mode
    }
    if (char === '"' || char === "'") {
      const start = s.pos
      const end = s.text.indexOf(char, s.pos + 1)
      s.mark(start, T.string)
      s.pos = end < 0 ? s.text.length : end + 1
      if (end < 0) return `a${char}${mode}`
      return name === 'script' && /\btype\s*=\s*$/i.test(s.text.slice(0, start))
        ? `tscript:${scriptKind(s.text.slice(start + 1, end))}`
        : mode
    }
    if (char === '{') {
      const end = s.text.indexOf('}', s.pos)
      s.take(1, T.punct)
      s.mark(s.pos, T.variable)
      s.pos = end < 0 ? s.text.length : end
      if (!s.eol) s.take(1, T.punct)
      return mode
    }
    const before = s.text[s.pos - 1]
    if (before === '=' || (before === ' ' && /=\s*$/.test(s.text.slice(0, s.pos)))) {
      s.token(/[^\s>]+/y, T.string)
      return mode
    }
    if (!s.token(ATTRIBUTE, T.attr)) s.take(1, T.plain)
    return mode
  }

  return { start: '', line }
}

export function htmlTokenizer(json: Tokenizer): Tokenizer {
  return markup(false, json)
}

export const xmlTokenizer = markup(true, { start: '', line: (text) => ({ tokens: text ? [0, T.plain] : [], state: '' }) })

// ---------------------------------------------------------------- Markdown

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)/
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/
const URL = /https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/y

function inline(s: Scanner, html: Tokenizer): void {
  const text = s.text
  while (!s.eol) {
    const start = s.pos
    const char = s.peek()
    if (char === '\\' && /[!-/:-@[-`{-~]/.test(s.peek(1))) {
      s.take(2, T.escape)
      continue
    }
    if (char === '`') {
      const run = s.match(/`+/y)!
      const close = text.indexOf(run, s.pos)
      if (close < 0) {
        s.mark(start, T.plain)
        continue
      }
      s.mark(start, T.code)
      s.pos = close + run.length
      continue
    }
    if ((char === '*' || char === '_') && s.peek(1) === char) {
      const marker = char + char
      const close = text.indexOf(marker, s.pos + 2)
      if (close > s.pos + 2) {
        s.mark(start, T.strong)
        s.pos = close + 2
        continue
      }
    }
    if ((char === '*' || char === '_') && s.peek(1) !== ' ' && s.peek(1) !== char && (char === '*' || !/\w/.test(text[s.pos - 1] ?? ''))) {
      const close = text.indexOf(char, s.pos + 1)
      if (close > s.pos + 1 && text[close - 1] !== ' ' && (char === '*' || !/\w/.test(text[close + 1] ?? ''))) {
        s.mark(start, T.emphasis)
        s.pos = close + 1
        continue
      }
    }
    if (char === '~' && s.peek(1) === '~') {
      const close = text.indexOf('~~', s.pos + 2)
      if (close > 0) {
        s.mark(start, T.deleted)
        s.pos = close + 2
        continue
      }
    }
    if (char === '[' || (char === '!' && s.peek(1) === '[')) {
      const open = char === '!' ? s.pos + 1 : s.pos
      const close = text.indexOf(']', open + 1)
      if (close > open) {
        const after = text[close + 1]
        s.take(open - s.pos + 1, T.punct)
        s.mark(s.pos, T.link)
        s.pos = close
        s.take(1, T.punct)
        if (after === '(' || after === '[') {
          const end = text.indexOf(after === '(' ? ')' : ']', close + 2)
          if (end > 0) {
            s.take(1, T.punct)
            s.mark(s.pos, T.string)
            s.pos = end
            s.take(1, T.punct)
          }
        }
        continue
      }
    }
    if (char === '<') {
      if (s.startsWith('<!--')) {
        const end = text.indexOf('-->', s.pos)
        s.mark(start, T.comment)
        s.pos = end < 0 ? text.length : end + 3
        continue
      }
      if (s.sees(/<https?:\/\/[^\s>]+>/y)) {
        s.token(/<https?:\/\/[^\s>]+>/y, T.link)
        continue
      }
      if (s.sees(/<\/?[A-Za-z][\w-]*(?:\s[^>]*)?\/?>/y)) {
        const tag = s.match(/<\/?[A-Za-z][\w-]*(?:\s[^>]*)?\/?>/y)!
        embed(s, start, html.line(tag, '').tokens)
        continue
      }
    }
    if (char === 'h' && !/\w/.test(text[s.pos - 1] ?? '') && s.token(URL, T.link)) continue
    if (!s.token(/[^\\`*_~[!<h]+/y, T.plain)) s.take(1, T.plain)
  }
}

/**
 * Markdown (CommonMark and GitHub's extensions) with highlighted fenced
 * code, YAML front matter and inline HTML. `resolve` finds a tokenizer for a
 * fence's language name. State: `S` at the start of the document, `Y|…`
 * in front matter, `F<fence>|<language>|<inner state>` in a fenced block,
 * `c` in an HTML comment, "" otherwise.
 */
export function markdownTokenizer(resolve: (name: string) => Tokenizer | null, yaml: Tokenizer, html: Tokenizer): Tokenizer {
  return {
    start: 'S',
    line(text, state) {
      const s = new Scanner(text)
      if (state[0] === 'F') {
        const [fence, language, inner] = state.slice(1).split('|')
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(text)
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
          s.rest(T.punct)
          return { tokens: s.tokens(), state: '' }
        }
        const tokenizer = resolve(language)
        if (!tokenizer) {
          s.rest(T.code)
          return { tokens: s.tokens(), state }
        }
        const result = tokenizer.line(text, inner)
        return { tokens: result.tokens, state: `F${fence}|${language}|${result.state}` }
      }
      if (state[0] === 'Y') {
        if (/^(?:---|\.\.\.)\s*$/.test(text)) {
          s.rest(T.punct)
          return { tokens: s.tokens(), state: '' }
        }
        const result = yaml.line(text, state.slice(2))
        return { tokens: result.tokens, state: `Y|${result.state}` }
      }
      if (state === 'c') {
        const end = text.indexOf('-->')
        s.mark(0, T.comment)
        if (end < 0) {
          s.pos = text.length
          return { tokens: s.tokens(), state: 'c' }
        }
        s.pos = end + 3
        inline(s, html)
        return { tokens: s.tokens(), state: '' }
      }
      if (state === 'S' && /^---\s*$/.test(text)) {
        s.rest(T.punct)
        return { tokens: s.tokens(), state: `Y|${yaml.start}` }
      }

      const fence = FENCE.exec(text)
      if (fence) {
        s.mark(0, T.punct)
        s.pos = fence[1].length + fence[2].length
        if (fence[3]) {
          s.token(WHITESPACE, T.punct)
          s.mark(s.pos, T.type)
          s.pos += fence[3].length
        }
        s.rest(T.meta)
        return { tokens: s.tokens(), state: `F${fence[2]}|${fence[3].toLowerCase()}|${resolve(fence[3].toLowerCase())?.start ?? ''}` }
      }
      if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(text) || /^ {0,3}=+[ \t]*$/.test(text)) {
        s.rest(T.heading)
        return { tokens: s.tokens(), state: '' }
      }
      if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(text)) {
        s.rest(T.punct)
        return { tokens: s.tokens(), state: '' }
      }
      if (/^ {0,3}\[[^\]]+\]:/.test(text)) {
        s.token(/ {0,3}\[[^\]]+\]:/y, T.link)
        s.rest(T.string)
        return { tokens: s.tokens(), state: '' }
      }
      if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(text)) {
        s.rest(T.punct)
        return { tokens: s.tokens(), state: '' }
      }
      s.token(/ {0,3}(?:>[ \t]?)+/y, T.punct)
      const list = LIST.exec(text.slice(s.pos))
      if (list) {
        s.token(WHITESPACE, T.plain)
        s.take(list[2].length, T.keyword)
        s.token(WHITESPACE, T.plain)
        s.token(/\[[ xX]\](?=\s)/y, T.keyword)
      }
      if (text.includes('<!--') && !text.includes('-->', text.lastIndexOf('<!--'))) {
        const at = text.lastIndexOf('<!--')
        const before = s.pos
        if (at >= before) {
          const head = new Scanner(text.slice(before, at))
          inline(head, html)
          embed(s, before, head.tokens())
          s.mark(at, T.comment)
          return { tokens: s.tokens(), state: 'c' }
        }
      }
      if (text.includes('|')) {
        // A table row: cells as inline text, pipes as punctuation.
        while (!s.eol) {
          if (s.peek() === '|') {
            s.take(1, T.punct)
            continue
          }
          const end = text.indexOf('|', s.pos)
          const cell = new Scanner(text.slice(s.pos, end < 0 ? text.length : end))
          inline(cell, html)
          embed(s, s.pos, cell.tokens())
          s.pos = end < 0 ? text.length : end
        }
        return { tokens: s.tokens(), state: '' }
      }
      inline(s, html)
      return { tokens: s.tokens(), state: '' }
    },
  }
}

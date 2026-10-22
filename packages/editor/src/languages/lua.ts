import { T, type Tokenizer } from '../language'
import { IDENTIFIER, Scanner, WHITESPACE, quotedBody, words } from './scan'

const KEYWORDS = words('and break do else elseif end for function goto if in local not or repeat return then until while')
const NUMBER = /0[xX][\da-fA-F]*(?:\.[\da-fA-F]*)?(?:[pP][+-]?\d+)?|(?:\d+(?:\.(?!\.)\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y
const LONG_OPEN = /\[(=*)\[/y
const OPERATOR = /\.\.\.?|[=~<>]=|<<|>>|\/\/|[-+*/%^#&|~<>=]|::/y

/** Skips a long bracket body; returns true when its closing bracket was on this line. */
function longBody(s: Scanner, level: number, kind: number): boolean {
  const close = `]${'='.repeat(level)}]`
  const end = s.text.indexOf(close, s.pos)
  s.mark(s.pos, kind)
  if (end < 0) {
    s.pos = s.text.length
    return false
  }
  s.pos = end + close.length
  return true
}

/**
 * Lua 5.4 with the additions of CfxLua (the FiveM runtime): backtick hash
 * strings and compound assignment. State: "" or an open long comment
 * (`c<level>`), long string (`s<level>`) or a quoted string continued with
 * a backslash (`q"` / `q'`).
 */
export const lua: Tokenizer = {
  start: '',
  line(text, state) {
    const s = new Scanner(text)
    let open = ''
    if (state) {
      if (state[0] === 'q') {
        if (quotedBody(s, state[1])) open = state
      } else if (!longBody(s, Number(state.slice(1)), state[0] === 'c' ? T.comment : T.string)) open = state
    }
    let dot = false
    while (!s.eol && !open) {
      const start = s.pos
      const char = s.peek()
      if (char === ' ' || char === '\t') {
        s.token(WHITESPACE, T.plain)
        continue
      }
      if (s.startsWith('--')) {
        s.pos += 2
        const long = s.match(LONG_OPEN)
        s.mark(start, T.comment)
        if (long === null) s.rest(T.comment)
        else if (!longBody(s, long.length - 2, T.comment)) open = `c${long.length - 2}`
        continue
      }
      const longString = s.sees(LONG_OPEN) ? s.match(LONG_OPEN) : null
      if (longString !== null) {
        s.mark(start, T.string)
        if (!longBody(s, longString.length - 2, T.string)) open = `s${longString.length - 2}`
        dot = false
        continue
      }
      if (char === '"' || char === "'") {
        s.take(1, T.string)
        if (quotedBody(s, char)) open = `q${char}`
        dot = false
        continue
      }
      if (char === '`') {
        s.take(1, T.string)
        const end = text.indexOf('`', s.pos)
        s.pos = end < 0 ? text.length : end + 1
        continue
      }
      if ((char >= '0' && char <= '9') || (char === '.' && /\d/.test(s.peek(1)))) {
        s.token(NUMBER, T.number)
        continue
      }
      if (s.startsWith('::') && s.sees(/::[\p{L}_][\p{L}\p{N}_]*::/uy)) {
        s.token(/::[\p{L}_][\p{L}\p{N}_]*::/uy, T.meta)
        continue
      }
      if (char === '<' && s.sees(/<(?:const|close)>/y)) {
        s.token(/<(?:const|close)>/y, T.keyword)
        continue
      }
      const word = s.match(IDENTIFIER)
      if (word !== null) {
        const next = s.nextNonSpace()
        // f(x), f"str", f{...} and f[[long]] are all calls.
        const call = next === '(' || next === '"' || next === "'" || next === '{' || (next === '[' && /\[=*\[/.test(text.slice(s.pos).trimStart()))
        let kind: number
        if (KEYWORDS.has(word) && !dot) kind = T.keyword
        else if (word === 'true' || word === 'false') kind = T.bool
        else if (word === 'nil') kind = T.constant
        else if (word === 'self') kind = T.constant
        else if (call) kind = T.function
        else if (dot) kind = T.property
        else if (/^[A-Z][A-Z0-9_]+$/.test(word)) kind = T.constant
        else kind = T.variable
        s.mark(start, kind)
        dot = false
        continue
      }
      if (s.startsWith('..')) {
        s.token(OPERATOR, T.operator)
        dot = false
        continue
      }
      dot = char === '.' || (char === ':' && s.peek(1) !== ':')
      if (dot || '()[]{},;'.includes(char)) s.take(1, T.punct)
      else if (!s.token(OPERATOR, T.operator)) s.take(1, T.plain)
    }
    return { tokens: s.tokens(), state: open }
  },
}

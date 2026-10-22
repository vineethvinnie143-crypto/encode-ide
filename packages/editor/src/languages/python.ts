import { T, type Tokenizer } from '../language'
import { ESCAPE, IDENTIFIER, Scanner, WHITESPACE, words } from './scan'

const KEYWORDS = words(
  'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
)
/** Keywords only at the start of a statement: `match x:` but not `match = re.match(...)`. */
const SOFT = words('match case type')
const BOOLEANS = words('True False')
const CONSTANTS = words('None Ellipsis NotImplemented __debug__ self cls')
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[jJ]?)/y
const STRING_START = /([rRbBuUfF]{0,2})("""|'''|"|')/y
const OPERATOR = /[-+*/%@&|^~<>=!:]+|->/y

/**
 * Reads a string body up to `quote`. Returns 'closed', 'open' (a triple
 * quote, or a backslash at the end of the line) or 'ended' (unterminated).
 */
function stringBody(s: Scanner, quote: string, raw: boolean, format: boolean): 'closed' | 'open' | 'ended' {
  const text = s.text
  while (!s.eol) {
    if (s.startsWith(quote)) {
      s.take(quote.length, T.string)
      return 'closed'
    }
    const char = text[s.pos]
    if (char === '\\') {
      if (s.pos === text.length - 1) {
        s.take(1, T.string)
        return 'open'
      }
      if (raw) s.take(2, T.string)
      else if (!s.token(ESCAPE, T.escape)) s.take(1, T.string)
      continue
    }
    if (format && char === '{') {
      if (s.peek(1) === '{') {
        s.take(2, T.escape)
        continue
      }
      // A replacement field: tokenize roughly as code up to its closing brace.
      s.take(1, T.punct)
      let depth = 1
      const start = s.pos
      while (!s.eol && depth > 0) {
        const inner = text[s.pos]
        if (inner === '{') depth++
        else if (inner === '}') depth--
        else if (inner === quote[0]) break
        if (depth > 0) s.pos++
      }
      s.mark(start, T.variable)
      if (s.peek() === '}') s.take(1, T.punct)
      continue
    }
    if (format && char === '}' && s.peek(1) === '}') {
      s.take(2, T.escape)
      continue
    }
    const run = s.pos
    while (!s.eol && !s.startsWith(quote) && text[s.pos] !== '\\' && !(format && (text[s.pos] === '{' || text[s.pos] === '}'))) s.pos++
    if (s.pos === run) s.pos++
    s.mark(run, T.string)
  }
  return quote.length === 3 ? 'open' : 'ended'
}

/** State: "" or an open string as flags and quote, such as `f"""` or `r'`. */
export const python: Tokenizer = {
  start: '',
  line(text, state) {
    const s = new Scanner(text)
    let open = ''
    if (state) {
      const quote = state.replace(/^[a-z]*/, '')
      const flags = state.slice(0, state.length - quote.length)
      if (stringBody(s, quote, flags.includes('r'), flags.includes('f')) === 'open') open = state
    }
    let previous = ''
    let dot = false
    while (!s.eol && !open) {
      const start = s.pos
      const char = s.peek()
      if (char === ' ' || char === '\t') {
        s.token(WHITESPACE, T.plain)
        continue
      }
      if (char === '#') {
        s.rest(T.comment)
        break
      }
      STRING_START.lastIndex = s.pos
      const quoteMatch = STRING_START.exec(text)
      if (quoteMatch && (quoteMatch[1] === '' || !/[\p{L}\p{N}_]/u.test(text[s.pos - 1] ?? ''))) {
        const flags = quoteMatch[1].toLowerCase()
        const quote = quoteMatch[2]
        s.take(quoteMatch[0].length, T.string)
        if (stringBody(s, quote, flags.includes('r'), flags.includes('f')) === 'open') open = flags.replace(/[bu]/g, '') + quote
        previous = 'value'
        dot = false
        continue
      }
      if ((char >= '0' && char <= '9') || (char === '.' && /\d/.test(s.peek(1)))) {
        s.token(NUMBER, T.number)
        previous = 'value'
        continue
      }
      if (char === '@' && s.atLineStart() && s.token(/@[\p{L}_][\p{L}\p{N}_.]*/uy, T.meta)) continue
      const word = s.match(IDENTIFIER)
      if (word !== null) {
        const next = s.nextNonSpace()
        let kind: number
        if (dot) kind = next === '(' ? T.function : T.property
        else if (previous === 'def') kind = T.function
        else if (previous === 'class') kind = T.type
        else if (KEYWORDS.has(word)) kind = T.keyword
        else if (SOFT.has(word) && text.slice(0, start).trim() === '' && /^[\p{L}\p{N}_("'[{-]/u.test(next) && next !== '=')
          kind = T.keyword
        else if (BOOLEANS.has(word)) kind = T.bool
        else if (CONSTANTS.has(word)) kind = T.constant
        else if (next === '(') kind = T.function
        else if (/^[A-Z][A-Z0-9_]+$/.test(word)) kind = T.constant
        else if (/^[A-Z]/.test(word)) kind = T.type
        else kind = T.variable
        s.mark(start, kind)
        previous = word === 'def' || word === 'class' ? word : 'value'
        dot = false
        continue
      }
      dot = char === '.'
      previous = ''
      if ('()[]{},;.'.includes(char)) s.take(1, T.punct)
      else if (!s.token(OPERATOR, T.operator)) s.take(1, T.plain)
    }
    return { tokens: s.tokens(), state: open }
  },
}

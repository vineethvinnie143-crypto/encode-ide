import { T, type Tokenizer } from '../language'
import { Scanner, WHITESPACE, quoted } from './scan'

/** `name:` at the start of a statement, the shape of a declaration (or a Sass/Less variable). */
const DECLARATION = /(?:--[\w-]+|\$[\w-]+|@[\w-]+|-?[A-Za-z_][\w-]*|#\{[^}]*\}[\w-]*)\s*:(?!:)/y
const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:%|[a-zA-Z]+)?/y
const IDENT = /-?[A-Za-z_][\w-]*/y
const VARIABLE = /--[\w-]+|\$[\w-]+|@[\w-]+/y

function isDeclaration(text: string, pos: number, depth: number): boolean {
  DECLARATION.lastIndex = pos
  if (!DECLARATION.test(text)) return false
  const name = text.slice(pos, DECLARATION.lastIndex)
  if (depth === 0 && !/^(?:\$|@|--)/.test(name)) return false
  // `a:hover {` is a selector, not a declaration.
  const rest = text.slice(DECLARATION.lastIndex).replace(/#\{[^}]*\}/g, '')
  const end = rest.search(/[;}]/)
  return !(end < 0 ? rest : rest.slice(0, end)).includes('{')
}

function interpolation(s: Scanner): void {
  s.take(2, T.punct)
  const end = s.text.indexOf('}', s.pos)
  s.mark(s.pos, T.variable)
  s.pos = end < 0 ? s.text.length : end
  if (!s.eol) s.take(1, T.punct)
}

function valueToken(s: Scanner): void {
  const char = s.peek()
  if (char === '"' || char === "'") {
    quoted(s, char)
    return
  }
  if ((char === 'u' || char === 'U') && s.sees(/url\(/iy)) {
    s.take(3, T.function)
    s.take(1, T.punct)
    if (s.peek() !== '"' && s.peek() !== "'") {
      const end = s.text.indexOf(')', s.pos)
      s.mark(s.pos, T.string)
      s.pos = end < 0 ? s.text.length : end
    }
    return
  }
  if (char === '#') {
    if (s.startsWith('#{')) interpolation(s)
    else if (!s.token(/#[\da-fA-F]{3,8}(?![\w-])/y, T.constant)) s.take(1, T.plain)
    return
  }
  if (char === '!') {
    if (!s.token(/!\s*[A-Za-z]+/y, T.keyword)) s.take(1, T.operator)
    return
  }
  if (/[\d.]/.test(char) || ((char === '-' || char === '+') && /[\d.]/.test(s.peek(1)))) {
    if (s.token(NUMBER, T.number)) return
  }
  if (s.token(VARIABLE, T.variable)) return
  const start = s.pos
  if (s.match(IDENT) !== null) {
    const next = s.peek()
    s.mark(start, next === '(' ? T.function : next === ':' ? T.property : T.value)
    return
  }
  if ('(),:'.includes(char)) s.take(1, T.punct)
  else if (!s.token(/[/*+\-=<>!%&|]+/y, T.operator)) s.take(1, T.plain)
}

function selectorToken(s: Scanner): void {
  const char = s.peek()
  const next = s.peek(1)
  if (char === '.' && /[\w-]/.test(next)) {
    s.take(1, T.type)
    s.token(/[\w-]+/y, T.type)
  } else if (char === '#' && next === '{') interpolation(s)
  else if (char === '#' && /[\w-]/.test(next)) {
    s.take(1, T.constant)
    s.token(/[\w-]+/y, T.constant)
  } else if (char === ':') {
    if (!s.token(/::?[\w-]+/y, T.keyword)) s.take(1, T.punct)
  } else if (char === '%' && /[\w-]/.test(next)) s.token(/%[\w-]+/y, T.type)
  else if (char === '&' || char === '>' || char === '+' || char === '~') s.take(1, T.operator)
  else if (char === '[') {
    s.take(1, T.punct)
    s.token(WHITESPACE, T.plain)
    s.token(/[\w-]+/y, T.attr)
    s.token(/[~|^$*]?=/y, T.operator)
    if (s.peek() === '"' || s.peek() === "'") quoted(s, s.peek())
    else s.token(/[^\]\s]+/y, T.string)
    s.token(/\s*[iIsS]?\s*/y, T.plain)
    if (s.peek() === ']') s.take(1, T.punct)
  } else if (char === '"' || char === "'") quoted(s, char)
  else if (/\d/.test(char) && s.token(NUMBER, T.number)) return
  else if (char === '*') s.take(1, T.tag)
  else if (char === ',' || char === '(' || char === ')') s.take(1, T.punct)
  else if (s.token(VARIABLE, T.variable)) return
  else if (!s.token(/[\w-]+/y, T.tag)) s.take(1, T.plain)
}

/**
 * CSS, Sass (SCSS syntax) and Less. Whether a statement is a selector or a
 * declaration is decided at its start: `name:` without a `{` before the next
 * `;` is a declaration. State: brace depth, then `v` inside a value that
 * continues on the next line and `c` inside a comment.
 */
function css(lineComments: boolean): Tokenizer {
  return {
    start: '0',
    line(text, state) {
      const s = new Scanner(text)
      const parsed = /^(\d+)(v?)(c?)$/.exec(state)
      let depth = parsed ? Number(parsed[1]) : 0
      let value = parsed?.[2] === 'v'
      let comment = parsed?.[3] === 'c'
      let statementStart = !value
      let declaration = false
      while (!s.eol) {
        if (comment) {
          const end = text.indexOf('*/', s.pos)
          s.mark(s.pos, T.comment)
          s.pos = end < 0 ? text.length : end + 2
          if (end >= 0) comment = false
          continue
        }
        const char = s.peek()
        if (char === ' ' || char === '\t') {
          s.token(WHITESPACE, T.plain)
          continue
        }
        if (char === '/' && s.peek(1) === '*') {
          s.take(2, T.comment)
          comment = true
          continue
        }
        if (lineComments && char === '/' && s.peek(1) === '/') {
          s.rest(T.comment)
          break
        }
        if (char === '}' || char === '{' || char === ';') {
          s.take(1, T.punct)
          if (char === '}') depth = Math.max(0, depth - 1)
          else if (char === '{') depth++
          value = false
          declaration = false
          statementStart = true
          continue
        }
        if (statementStart) {
          statementStart = false
          if (isDeclaration(text, s.pos, depth)) declaration = true
          else if (char === '@') {
            s.token(/@[\w-]+/y, T.keyword)
            value = true
            continue
          }
        }
        if (declaration && !value) {
          if (char === ':') {
            s.take(1, T.punct)
            value = true
          } else if (s.startsWith('#{')) interpolation(s)
          else if (!s.token(VARIABLE, T.variable) && !s.token(/[\w-]+/y, T.property)) s.take(1, T.plain)
          continue
        }
        if (value) valueToken(s)
        else selectorToken(s)
      }
      return { tokens: s.tokens(), state: `${depth}${value ? 'v' : ''}${comment ? 'c' : ''}` }
    },
  }
}

export const cssTokenizer = css(false)
/** SCSS and Less: CSS with `//` comments, variables and nesting. */
export const scssTokenizer = css(true)

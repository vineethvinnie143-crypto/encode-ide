/**
 * CSS, SCSS and Less read into rules, at-rules and declarations with their offsets, reading on after each problem (an
 * unclosed block, a missing colon or semicolon). Enough of the grammar for checks, completion, hovers and symbols;
 * not a full CSS parser (ADR 0085).
 */

export type Dialect = 'css' | 'scss' | 'less'

export type TokenKind = 'ident' | 'at' | 'hash' | 'number' | 'string' | 'url' | 'variable' | 'interpolation' | 'comment' | 'space' | 'delim' | 'bad-string'

export interface Token {
  kind: TokenKind
  start: number
  end: number
  text: string
}

export interface Span {
  start: number
  end: number
}

export interface Declaration {
  type: 'declaration'
  start: number
  end: number
  property: Span & { name: string }
  /** From after the colon to before the semicolon. */
  value: Span
  colon: number | null
  important: boolean
  /** `$x: ...` or `@x: ...`: a preprocessor variable, not a property. */
  variable: boolean
}

export interface Block {
  start: number
  /** Just past the `}`, or the end of the text when it is not closed. */
  end: number
  children: Node[]
}

export interface Rule {
  type: 'rule'
  start: number
  end: number
  selector: Span
  block: Block
}

export interface AtRule {
  type: 'at-rule'
  start: number
  end: number
  name: Span & { name: string }
  prelude: Span
  block: Block | null
}

export type Node = Declaration | Rule | AtRule

export interface Stylesheet {
  children: Node[]
  tokens: Token[]
  problems: { start: number; end: number; message: string }[]
}

const IDENT_START = /[A-Za-z_\u0080-￿-]/
const IDENT_CHAR = /[\w\u0080-￿-]/

export function tokenize(text: string, dialect: Dialect): Token[] {
  const tokens: Token[] = []
  const length = text.length
  let index = 0
  const push = (kind: TokenKind, start: number) => tokens.push({ kind, start, end: index, text: text.slice(start, index) })
  const ident = () => {
    while (index < length) {
      if (text[index] === '\\' && index + 1 < length) index += 2
      else if (IDENT_CHAR.test(text[index]!)) index++
      else break
    }
  }
  while (index < length) {
    const start = index
    const char = text[index]!
    const next = text[index + 1]
    if (/\s/.test(char)) {
      while (index < length && /\s/.test(text[index]!)) index++
      push('space', start)
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end < 0 ? length : end + 2
      push('comment', start)
    } else if (char === '/' && next === '/' && dialect !== 'css') {
      while (index < length && text[index] !== '\n' && text[index] !== '\r') index++
      push('comment', start)
    } else if (char === '"' || char === "'") {
      index++
      let closed = false
      while (index < length) {
        const at = text[index]!
        if (at === '\\') index += 2
        else if (at === char) {
          index++
          closed = true
          break
        } else if (at === '\n' || at === '\r') break
        else index++
      }
      push(closed ? 'string' : 'bad-string', start)
    } else if (char === '@' && next === '{' && dialect === 'less') {
      index = skipTo(text, index + 2, '}')
      push('interpolation', start)
    } else if (char === '#' && next === '{' && dialect !== 'css') {
      index = skipTo(text, index + 2, '}')
      push('interpolation', start)
    } else if (char === '@' && index + 1 < length && IDENT_START.test(next!)) {
      index++
      ident()
      push('at', start)
    } else if (char === '$' && dialect === 'scss' && next && IDENT_START.test(next)) {
      index++
      ident()
      push('variable', start)
    } else if (char === '#' && next && IDENT_CHAR.test(next)) {
      index++
      ident()
      push('hash', start)
    } else if (/\d/.test(char) || (char === '.' && next && /\d/.test(next)) || ((char === '+' || char === '-') && /^[+-](\d|\.\d)/.test(text.slice(index, index + 3)))) {
      index++
      while (index < length && /[\d.]/.test(text[index]!)) index++
      if (/[eE]/.test(text[index] ?? '') && /\d|[+-]\d/.test(text.slice(index + 1, index + 3))) {
        index += 2
        while (index < length && /\d/.test(text[index]!)) index++
      }
      if (text[index] === '%') index++
      else if (index < length && /[A-Za-z]/.test(text[index]!)) ident()
      push('number', start)
    } else if (IDENT_START.test(char) || (char === '\\' && index + 1 < length)) {
      ident()
      // url( with no quotes holds its address up to the bracket.
      if (text[index] === '(' && /^url$/i.test(text.slice(start, index)) && !/^\(\s*['"]/.test(text.slice(index, index + 40))) {
        index = skipTo(text, index + 1, ')')
        push('url', start)
      } else {
        push('ident', start)
      }
    } else {
      index++
      push('delim', start)
    }
  }
  return tokens
}

/** Past the next `close` (or the end), strings skipped. */
function skipTo(text: string, from: number, close: string): number {
  let index = from
  while (index < text.length && text[index] !== close) {
    if (text[index] === '\n' && close !== ')') return index
    index++
  }
  return Math.min(text.length, index + 1)
}

/** At-rules whose block holds declarations (descriptors), not rules. */
export const DESCRIPTOR_AT_RULES = new Set(['@font-face', '@page', '@property', '@counter-style', '@font-palette-values', '@viewport', '@font-feature-values', '@view-transition', '@position-try'])

export function parseStylesheet(text: string, dialect: Dialect): Stylesheet {
  const tokens = tokenize(text, dialect)
  const problems: Stylesheet['problems'] = []
  const significant = tokens.filter((token) => token.kind !== 'space' && token.kind !== 'comment')
  let at = 0
  const peek = () => significant[at]
  const problem = (start: number, end: number, message: string) => problems.push({ start, end: Math.max(end, start + 1), message })

  /** Statements until `}` or the end; `top` for the sheet itself. */
  const statements = (top: boolean, depth: number): Node[] => {
    const nodes: Node[] = []
    while (at < significant.length) {
      const token = peek()!
      if (token.text === '}' && token.kind === 'delim') {
        if (!top) return nodes
        problem(token.start, token.end, 'This } closes no block.')
        at++
        continue
      }
      if (token.text === ';' && token.kind === 'delim') {
        at++
        continue
      }
      if (depth > 64) {
        problem(token.start, token.end, 'This is nested too deeply to read.')
        at = significant.length
        return nodes
      }
      if (token.kind === 'at' && !(dialect === 'less' && isLessVariableDeclaration())) {
        nodes.push(atRule(depth))
        continue
      }
      // A rule when a { comes before a ; or }; a declaration otherwise.
      let look = at
      let parens = 0
      let opens = false
      while (look < significant.length) {
        const item = significant[look]!
        if (item.kind === 'delim') {
          if (item.text === '(' || item.text === '[') parens++
          else if (item.text === ')' || item.text === ']') parens = Math.max(0, parens - 1)
          else if (parens === 0 && (item.text === ';' || item.text === '}')) break
          else if (parens === 0 && item.text === '{') {
            opens = true
            break
          }
        }
        look++
      }
      if (opens) nodes.push(rule(depth))
      else {
        const declaration = parseDeclaration(look)
        if (top && !declaration.variable) problem(declaration.start, declaration.end, 'Expected a selector and a { block } here.')
        nodes.push(declaration)
      }
    }
    return nodes
  }

  const isLessVariableDeclaration = () => {
    const after = significant[at + 1]
    return after?.kind === 'delim' && after.text === ':'
  }

  const block = (depth: number): Block => {
    const open = significant[at++]!
    const children = statements(false, depth + 1)
    const close = peek()
    if (close && close.text === '}') {
      at++
      return { start: open.start, end: close.end, children }
    }
    problem(open.start, open.end, 'This { is not closed.')
    return { start: open.start, end: text.length, children }
  }

  const rule = (depth: number): Rule => {
    const first = peek()!
    let last = first
    while (at < significant.length && !(significant[at]!.kind === 'delim' && significant[at]!.text === '{')) last = significant[at++]!
    const selector = { start: first.start, end: last.text === '{' ? first.start : last.end }
    if (selector.end <= selector.start) problem(first.start, first.end, 'Expected a selector before this block.')
    const body = block(depth)
    return { type: 'rule', start: first.start, end: body.end, selector, block: body }
  }

  const atRule = (depth: number): AtRule => {
    const name = significant[at++]!
    const preludeStart = peek()?.start ?? name.end
    let preludeEnd = name.end
    let parens = 0
    while (at < significant.length) {
      const item = significant[at]!
      if (item.kind === 'delim') {
        if (item.text === '(' || item.text === '[') parens++
        else if (item.text === ')' || item.text === ']') parens = Math.max(0, parens - 1)
        else if (parens === 0 && (item.text === '{' || item.text === ';' || item.text === '}')) break
      }
      preludeEnd = item.end
      at++
    }
    const prelude = { start: preludeEnd > name.end ? preludeStart : name.end, end: preludeEnd }
    const ends = peek()
    if (ends?.text === '{') {
      const body = block(depth)
      return { type: 'at-rule', start: name.start, end: body.end, name: { start: name.start, end: name.end, name: name.text.toLowerCase() }, prelude, block: body }
    }
    if (ends?.text === ';') at++
    return { type: 'at-rule', start: name.start, end: ends?.text === ';' ? ends.end : preludeEnd, name: { start: name.start, end: name.end, name: name.text.toLowerCase() }, prelude, block: null }
  }

  /** A declaration from here to `stop` (the index of its ; or }, or the end). */
  const parseDeclaration = (stop: number): Declaration => {
    const first = significant[at]!
    const variable = first.kind === 'variable' || (dialect === 'less' && first.kind === 'at')
    let propertyEnd = first.end
    let colon: number | null = null
    let index = at + 1
    // The name: an identifier, with interpolations and `*` hacks and such read as part of it.
    while (index < stop && !(significant[index]!.kind === 'delim' && significant[index]!.text === ':') && significant[index]!.start === propertyEnd) propertyEnd = significant[index++]!.end
    if (index < stop && significant[index]!.text === ':') colon = significant[index++]!.start
    let valueStart = colon === null ? propertyEnd : colon + 1
    let valueEnd = valueStart
    let important = false
    let end = stop
    for (let item = index; item < stop; item++) {
      const token = significant[item]!
      // A name and a colon at the start of a new line: the line before has no semicolon.
      if (colon !== null && token.kind === 'ident' && significant[item + 1]?.text === ':' && /[\r\n]/.test(text.slice(significant[item - 1]!.end, token.start)) && !variable && item > index) {
        const after = significant[item + 2]
        if (after && after.start > significant[item + 1]!.end) {
          problem(significant[item - 1]!.end - 1, significant[item - 1]!.end, 'Expected a semicolon at the end of this line.')
          end = item
          break
        }
      }
      if (token.text === '!' && /^important$/i.test(significant[item + 1]?.text ?? '')) important = true
      valueEnd = token.end
    }
    if (valueStart > valueEnd) valueStart = valueEnd
    // Less calls a mixin as a statement of its own: `.mixin();`, `#ns.mixin();`.
    const mixinCall = dialect === 'less' && (first.text === '.' || first.kind === 'hash')
    if (colon === null && !mixinCall) problem(first.start, propertyEnd, `Expected a colon after ${text.slice(first.start, propertyEnd)}.`)
    else if (colon !== null && valueEnd === valueStart && end === stop && !variable) problem(colon, colon + 1, 'Expected a value after the colon.')
    at = end
    const close = significant[end]
    if (close?.text === ';') at++
    return {
      type: 'declaration',
      start: first.start,
      end: close?.text === ';' ? close.end : valueEnd,
      property: { start: first.start, end: propertyEnd, name: text.slice(first.start, propertyEnd) },
      value: { start: valueStart, end: valueEnd },
      colon,
      important,
      variable,
    }
  }

  const children = statements(true, 0)
  for (const token of tokens) {
    if (token.kind === 'bad-string') problem(token.start, token.end, 'This string is not closed.')
    if (token.kind === 'comment' && token.text.startsWith('/*') && !token.text.endsWith('*/')) problem(token.start, token.end, 'This comment is not closed.')
  }
  return { children, tokens, problems }
}

/** Every node, depth first, with the at-rule or rule each is in. */
export function* walk(nodes: readonly Node[], parents: (Rule | AtRule)[] = []): Generator<{ node: Node; parents: (Rule | AtRule)[] }> {
  for (const node of nodes) {
    yield { node, parents }
    if (node.type === 'rule') yield* walk(node.block.children, [...parents, node])
    else if (node.type === 'at-rule' && node.block) yield* walk(node.block.children, [...parents, node])
  }
}

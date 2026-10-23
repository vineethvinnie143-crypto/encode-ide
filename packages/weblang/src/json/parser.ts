/**
 * JSON and JSON with comments, read into a tree with offsets, with every problem found and reading going on after it:
 * a missing comma, a stray token or an unclosed string still leaves the rest of the document read (ADR 0085).
 */

export type NodeType = 'object' | 'array' | 'property' | 'string' | 'number' | 'boolean' | 'null'

export interface JsonNode {
  type: NodeType
  offset: number
  length: number
  parent?: JsonNode
  /** An object's properties, an array's items, or a property's key and (when there is one) its value. */
  children?: JsonNode[]
  value?: string | number | boolean | null
  /** A property's colon, when it has one. */
  colon?: number
}

export interface ParseProblem {
  offset: number
  length: number
  message: string
}

export interface ParseOptions {
  /** JSON with comments: comments and trailing commas are allowed. */
  comments: boolean
}

export interface JsonDocument {
  root: JsonNode | null
  problems: ParseProblem[]
  /** Comments, for folding and formatting. */
  comments: { offset: number; length: number; block: boolean }[]
}

type TokenKind = '{' | '}' | '[' | ']' | ':' | ',' | 'string' | 'number' | 'true' | 'false' | 'null' | 'word' | 'bad' | 'eof'

interface Token {
  kind: TokenKind
  offset: number
  length: number
  value?: string | number
}

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

/** The tokens of a JSON text, comments set aside. */
export function scan(text: string, problems: ParseProblem[], comments: JsonDocument['comments']): Token[] {
  const tokens: Token[] = []
  let index = 0
  const length = text.length
  while (index < length) {
    const char = text[index]!
    const code = text.charCodeAt(index)
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 0xfeff) {
      index++
      continue
    }
    const start = index
    if (char === '/' && text[index + 1] === '/') {
      while (index < length && text[index] !== '\n' && text[index] !== '\r') index++
      comments.push({ offset: start, length: index - start, block: false })
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end < 0 ? length : end + 2
      if (end < 0) problems.push({ offset: start, length: index - start, message: 'This comment is not closed.' })
      comments.push({ offset: start, length: index - start, block: true })
      continue
    }
    if ('{}[]:,'.includes(char)) {
      tokens.push({ kind: char as TokenKind, offset: start, length: 1 })
      index++
      continue
    }
    if (char === '"') {
      index++
      let value = ''
      let closed = false
      while (index < length) {
        const next = text[index]!
        if (next === '"') {
          index++
          closed = true
          break
        }
        if (next === '\n' || next === '\r') break
        if (next === '\\') {
          const escape = text[index + 1]
          if (escape === 'u') {
            const hex = text.slice(index + 2, index + 6)
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              value += String.fromCharCode(parseInt(hex, 16))
              index += 6
              continue
            }
            problems.push({ offset: index, length: 2, message: 'A \\u escape takes four hexadecimal digits.' })
            index += 2
            continue
          }
          if (escape !== undefined && ESCAPES[escape] !== undefined) {
            value += ESCAPES[escape]
            index += 2
            continue
          }
          problems.push({ offset: index, length: escape === undefined ? 1 : 2, message: 'This escape is not one JSON has.' })
          index += escape === undefined ? 1 : 2
          continue
        }
        if (text.charCodeAt(index) < 0x20) problems.push({ offset: index, length: 1, message: 'A control character must be escaped in a string.' })
        value += next
        index++
      }
      if (!closed) problems.push({ offset: start, length: index - start, message: 'This string is not closed.' })
      tokens.push({ kind: 'string', offset: start, length: index - start, value })
      continue
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index, index + 400))
      const loose = /^[-+0-9.eE]+/.exec(text.slice(index, index + 400))![0]
      if (match && match[0].length === loose.length) {
        tokens.push({ kind: 'number', offset: start, length: match[0].length, value: Number(match[0]) })
      } else {
        problems.push({ offset: start, length: loose.length, message: 'This is not a number JSON can read.' })
        tokens.push({ kind: 'number', offset: start, length: loose.length, value: Number.NaN })
      }
      index += loose.length
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      while (index < length && /[\w$]/.test(text[index]!)) index++
      const word = text.slice(start, index)
      const kind: TokenKind = word === 'true' || word === 'false' || word === 'null' ? word : 'word'
      tokens.push({ kind, offset: start, length: index - start, value: word })
      continue
    }
    // A character JSON has no use for: one token, so reading goes on.
    const point = text.codePointAt(index)!
    index += point > 0xffff ? 2 : 1
    tokens.push({ kind: 'bad', offset: start, length: index - start })
  }
  tokens.push({ kind: 'eof', offset: length, length: 0 })
  return tokens
}

const MAX_DEPTH = 512

export function parseJson(text: string, options: ParseOptions): JsonDocument {
  const problems: ParseProblem[] = []
  const comments: JsonDocument['comments'] = []
  const tokens = scan(text, problems, comments)
  if (!options.comments) for (const comment of comments) problems.push({ offset: comment.offset, length: comment.length, message: 'Comments are not allowed in JSON. Name the file .jsonc to keep them.' })
  let at = 0
  const peek = () => tokens[at]!
  const next = () => tokens[at++]!
  const problem = (token: Token, message: string) => {
    // One problem per place: a run of stray tokens says so once.
    const last = problems.at(-1)
    if (last && last.offset === token.offset) return
    problems.push({ offset: token.offset, length: Math.max(1, token.length), message })
  }

  const value = (parent: JsonNode | undefined, depth: number): JsonNode | null => {
    const token = peek()
    if (depth > MAX_DEPTH) {
      problem(token, 'This is nested too deeply to read.')
      return null
    }
    switch (token.kind) {
      case '{':
        return object(parent, depth)
      case '[':
        return array(parent, depth)
      case 'string':
        next()
        return { type: 'string', offset: token.offset, length: token.length, value: token.value as string, ...(parent ? { parent } : {}) }
      case 'number':
        next()
        return { type: 'number', offset: token.offset, length: token.length, value: token.value as number, ...(parent ? { parent } : {}) }
      case 'true':
      case 'false':
        next()
        return { type: 'boolean', offset: token.offset, length: token.length, value: token.kind === 'true', ...(parent ? { parent } : {}) }
      case 'null':
        next()
        return { type: 'null', offset: token.offset, length: token.length, value: null, ...(parent ? { parent } : {}) }
      default:
        return null
    }
  }

  /** Skips to a token that can go on: one of `stops`, or the end. */
  const recover = (stops: string) => {
    while (peek().kind !== 'eof' && !stops.includes(peek().kind)) next()
  }

  const object = (parent: JsonNode | undefined, depth: number): JsonNode => {
    const open = next()
    const node: JsonNode = { type: 'object', offset: open.offset, length: 0, children: [], ...(parent ? { parent } : {}) }
    let needComma = false
    let lastComma: Token | null = null
    for (;;) {
      const token = peek()
      if (token.kind === '}') {
        if (lastComma && !needComma && !options.comments && node.children!.length) problem(lastComma, 'A trailing comma is not allowed in JSON.')
        next()
        node.length = token.offset + 1 - node.offset
        return node
      }
      if (token.kind === 'eof') {
        problem({ ...token, offset: Math.max(0, token.offset - 1) }, 'Expected a } to close the object.')
        node.length = token.offset - node.offset
        return node
      }
      if (token.kind === ',') {
        if (!needComma) problem(token, 'Expected a property before this comma.')
        lastComma = next()
        needComma = false
        continue
      }
      if (needComma) problem(token, 'Expected a comma.')
      if (token.kind !== 'string') {
        problem(token, token.kind === 'word' ? 'A property name must be in double quotes.' : 'Expected a property name in double quotes.')
        if (token.kind === 'word') {
          // Read it as a name anyway, so its value is still checked.
        } else {
          next()
          recover(',}"')
          needComma = false
          continue
        }
      }
      next()
      const property: JsonNode = { type: 'property', offset: token.offset, length: token.length, parent: node, children: [] }
      property.children!.push({ type: 'string', offset: token.offset, length: token.length, value: String(token.value ?? ''), parent: property })
      node.children!.push(property)
      if (peek().kind === ':') {
        property.colon = next().offset
        const item = value(property, depth + 1)
        if (item) {
          property.children!.push(item)
          property.length = item.offset + item.length - property.offset
        } else {
          problem(peek(), 'Expected a value.')
          property.length = property.colon + 1 - property.offset
          if (!',}'.includes(peek().kind)) recover(',}')
        }
      } else {
        problem(peek(), 'Expected a colon.')
        if (!',}'.includes(peek().kind)) {
          const item = value(property, depth + 1)
          if (item) property.children!.push(item)
          else recover(',}')
        }
      }
      needComma = true
      lastComma = null
    }
  }

  const array = (parent: JsonNode | undefined, depth: number): JsonNode => {
    const open = next()
    const node: JsonNode = { type: 'array', offset: open.offset, length: 0, children: [], ...(parent ? { parent } : {}) }
    let needComma = false
    let lastComma: Token | null = null
    for (;;) {
      const token = peek()
      if (token.kind === ']') {
        if (lastComma && !needComma && !options.comments && node.children!.length) problem(lastComma, 'A trailing comma is not allowed in JSON.')
        next()
        node.length = token.offset + 1 - node.offset
        return node
      }
      if (token.kind === 'eof') {
        problem({ ...token, offset: Math.max(0, token.offset - 1) }, 'Expected a ] to close the array.')
        node.length = token.offset - node.offset
        return node
      }
      if (token.kind === ',') {
        if (!needComma) problem(token, 'Expected a value before this comma.')
        lastComma = next()
        needComma = false
        continue
      }
      if (needComma) problem(token, 'Expected a comma.')
      const item = value(node, depth + 1)
      if (item) {
        node.children!.push(item)
      } else {
        problem(token, token.kind === '}' ? 'Expected a ] to close the array.' : 'Expected a value.')
        next()
      }
      needComma = true
      lastComma = null
    }
  }

  let root: JsonNode | null = null
  if (peek().kind === 'eof') {
    if (!text.trim()) return { root: null, problems, comments }
  }
  root = value(undefined, 0)
  if (!root && peek().kind !== 'eof') problem(peek(), 'Expected a JSON value.')
  if (peek().kind !== 'eof') {
    problem(peek(), 'Only one value may be at the top of a JSON document.')
  }
  return { root, problems, comments }
}

/** The deepest node at an offset; `inclusive` counts the offset just past a node's end as inside it. */
export function nodeAt(root: JsonNode | null, offset: number, inclusive = false): JsonNode | null {
  if (!root) return null
  const inside = (node: JsonNode) => offset >= node.offset && (inclusive ? offset <= node.offset + node.length : offset < node.offset + node.length)
  if (!inside(root)) return null
  let node = root
  for (;;) {
    const child = node.children?.find(inside)
    if (!child) return node
    node = child
  }
}

/** The keys and indexes from the root down to a node. */
export function pathOf(node: JsonNode): (string | number)[] {
  const path: (string | number)[] = []
  let current: JsonNode | undefined = node
  while (current?.parent) {
    const parent: JsonNode = current.parent
    if (parent.type === 'property') {
      path.unshift(String(parent.children![0]!.value))
      current = parent.parent
      continue
    }
    if (parent.type === 'array') path.unshift(parent.children!.indexOf(current))
    current = parent
  }
  return path
}

/** A node as a plain value; a property gives its value's. */
export function valueOf(node: JsonNode | undefined): unknown {
  if (!node) return undefined
  switch (node.type) {
    case 'object': {
      const result: Record<string, unknown> = {}
      for (const property of node.children ?? []) result[String(property.children![0]!.value)] = valueOf(property.children![1])
      return result
    }
    case 'array':
      return (node.children ?? []).map((item) => valueOf(item))
    case 'property':
      return valueOf(node.children?.[1])
    default:
      return node.value
  }
}

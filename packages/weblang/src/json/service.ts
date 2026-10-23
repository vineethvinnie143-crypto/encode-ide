/**
 * JSON and JSON with comments: problems (reading, duplicate keys, the schema's), completion and hovers from the
 * schema, symbols, folding and formatting (ADR 0085).
 */
import { escapeMarkdown, ItemKind, Severity, SymbolKind, type CompletionItem, type Diagnostic, type Document, type DocumentSymbol, type FoldingRange, type FormatOptions, type Hover, type Position, type TextEdit } from '../text'
import { nodeAt, parseJson, pathOf, scan, valueOf, type JsonDocument, type JsonNode, type ParseProblem } from './parser'
import { describe, schemasAt, validate, type Schema } from './schema'
import { allowsComments, builtinSchema } from './schemas'

/** A document's schema from its own `$schema`, when the server can read it (a file in the folder). */
export type SchemaLoader = (documentUri: string, address: string) => Schema | null

const MAX_SYMBOLS = 5000

function fileName(uri: string): string {
  return decodeURIComponent(uri.split(/[\\/]/).pop() ?? uri)
}

export class JsonService {
  private readonly parsed = new Map<string, { version: number; text: string; result: JsonDocument; comments: boolean }>()

  constructor(private readonly loader?: SchemaLoader) {}

  private parse(doc: Document): { result: JsonDocument; comments: boolean } {
    const cached = this.parsed.get(doc.uri)
    if (cached && cached.version === doc.version && cached.text === doc.text) return cached
    const comments = allowsComments(fileName(doc.uri), doc.languageId)
    const result = parseJson(doc.text, { comments })
    const entry = { version: doc.version, text: doc.text, result, comments }
    this.parsed.set(doc.uri, entry)
    return entry
  }

  forget(uri: string): void {
    this.parsed.delete(uri)
  }

  /** The schema for a document: its own `$schema` first, then the one its name has. */
  schemaFor(doc: Document, root: JsonNode | null): Schema | null {
    const own = root?.type === 'object' ? root.children!.find((property) => property.children![0]!.value === '$schema') : undefined
    const address = own?.children?.[1]?.type === 'string' ? String(own.children[1].value) : undefined
    if (address) {
      const known = builtinSchema(fileName(doc.uri), address)
      if (known) return known
      const loaded = this.loader?.(doc.uri, address)
      if (loaded) return loaded
    }
    return builtinSchema(fileName(doc.uri))
  }

  diagnostics(doc: Document): Diagnostic[] {
    const { result } = this.parse(doc)
    const out: Diagnostic[] = result.problems.map((problem: ParseProblem) => ({
      range: doc.range(problem.offset, problem.offset + problem.length),
      severity: Severity.Error,
      message: problem.message,
      source: 'json',
    }))
    if (!result.root) return out
    const walk = (node: JsonNode) => {
      if (node.type === 'object') {
        const seen = new Map<string, JsonNode>()
        for (const property of node.children ?? []) {
          const key = property.children![0]!
          const name = String(key.value)
          if (seen.has(name)) out.push({ range: doc.range(key.offset, key.offset + key.length), severity: Severity.Warning, message: `The property ${JSON.stringify(name)} is already in this object; the last one wins.`, source: 'json' })
          seen.set(name, key)
        }
      }
      for (const child of node.children ?? []) walk(child)
    }
    walk(result.root)
    const schema = this.schemaFor(doc, result.root)
    if (schema) {
      for (const problem of validate(result.root, schema, schema)) {
        out.push({
          range: doc.range(problem.node.offset, problem.node.offset + problem.node.length),
          severity: problem.severity === 1 ? Severity.Error : Severity.Warning,
          message: problem.message,
          source: 'json',
          ...(problem.deprecated ? { tags: [2] } : {}),
        })
      }
    }
    return out
  }

  completion(doc: Document, position: Position): CompletionItem[] {
    const { result } = this.parse(doc)
    const schema = this.schemaFor(doc, result.root)
    const offset = doc.offsetAt(position)
    const text = doc.text
    let node = nodeAt(result.root, offset, true)
    // Just before a value or a key: the place is in what holds it.
    if (node && node.type !== 'object' && node.type !== 'array' && node.type !== 'property' && offset <= node.offset) node = node.parent ?? null
    if (node?.type === 'property' && offset <= node.offset) node = node.parent ?? null
    // Inside a string or a word being typed: it is what a suggestion replaces.
    let replace = { start: offset, end: offset }
    let place: { kind: 'key'; object: JsonNode; current?: string } | { kind: 'value'; path: (string | number)[] } | null = null

    if (node && (node.type === 'string' || node.type === 'number' || node.type === 'boolean' || node.type === 'null') && offset > node.offset && offset <= node.offset + node.length) {
      replace = { start: node.offset, end: node.offset + node.length }
      const parent = node.parent
      if (parent?.type === 'property' && parent.children![0] === node) place = { kind: 'key', object: parent.parent!, current: String(node.value) }
      else place = { kind: 'value', path: pathOf(node) }
    } else if (node?.type === 'property') {
      if (node.colon !== undefined && offset > node.colon) place = { kind: 'value', path: [...pathOf(node.parent!), String(node.children![0]!.value)] }
      else place = { kind: 'key', object: node.parent! }
    } else if (node?.type === 'object' && offset > node.offset && offset < node.offset + node.length + 1) {
      // After a colon whose value is not written yet, the place is that value.
      let back = offset
      while (back > node.offset && /\s/.test(text[back - 1]!)) back--
      const waiting = text[back - 1] === ':' ? node.children!.find((property) => property.colon === back - 1) : undefined
      place = waiting ? { kind: 'value', path: [...pathOf(node), String(waiting.children![0]!.value)] } : { kind: 'key', object: node }
    } else if (node?.type === 'array' && offset > node.offset) {
      const index = (node.children ?? []).filter((item) => item.offset + item.length <= offset).length
      place = { kind: 'value', path: [...pathOf(node), index] }
    } else if (!result.root || !text.trim()) {
      place = { kind: 'value', path: [] }
    }
    if (!place) return []
    // A word typed without its quotes yet: it is replaced too.
    if (replace.start === replace.end) {
      let start = offset
      while (start > 0 && /[\w$-]/.test(text[start - 1]!)) start--
      replace = { start, end: offset }
    }
    const range = doc.range(replace.start, replace.end)

    if (place.kind === 'key') {
      if (!schema) return []
      const existing = new Set((place.object.children ?? []).map((property) => String(property.children![0]!.value)))
      if (place.current !== undefined) existing.delete(place.current)
      const after = text.slice(replace.end).match(/^\s*:/) !== null
      const items: CompletionItem[] = []
      const seen = new Set<string>()
      for (const candidate of schemasAt(schema, pathOf(place.object))) {
        for (const [name, sub] of Object.entries(candidate.properties ?? {})) {
          if (existing.has(name) || seen.has(name)) continue
          seen.add(name)
          const subSchema = typeof sub === 'object' ? sub : {}
          const resolved = schemasAt(schema, [...pathOf(place.object), name])
          const types = resolved.flatMap((item) => (Array.isArray(item.type) ? item.type : item.type ? [item.type] : []))
          const docs = resolved.map(describe).find(Boolean)
          items.push({
            label: name,
            kind: ItemKind.Property,
            insertText: after ? JSON.stringify(name) : `${JSON.stringify(name).replace(/[$}\\]/g, '\\$&')}: ${valueSnippet(types[0], resolved)}`,
            insertTextFormat: 2,
            range,
            filterText: JSON.stringify(name),
            ...(docs ? { documentation: { kind: 'markdown' as const, value: docs } } : {}),
            ...(subSchema.deprecationMessage || subSchema.deprecated ? { tags: [1] } : {}),
          })
        }
      }
      return items
    }

    const values: CompletionItem[] = []
    const seen = new Set<string>()
    const offer = (value: unknown, detail?: string, documentation?: string) => {
      const label = JSON.stringify(value)
      if (label === undefined || seen.has(label)) return
      seen.add(label)
      values.push({ label, kind: typeof value === 'object' && value !== null ? ItemKind.Struct : ItemKind.Value, insertText: label, range, ...(detail ? { detail } : {}), ...(documentation ? { documentation: { kind: 'markdown' as const, value: documentation } } : {}) })
    }
    const candidates = schema ? schemasAt(schema, place.path) : []
    for (const candidate of candidates) {
      candidate.enum?.forEach((value, index) => offer(value, undefined, candidate.enumDescriptions?.[index]))
      if ('const' in candidate) offer(candidate.const)
      if (candidate.default !== undefined) offer(candidate.default, 'Default')
      for (const example of candidate.examples ?? []) offer(example, 'Example')
      const types = Array.isArray(candidate.type) ? candidate.type : candidate.type ? [candidate.type] : []
      if (types.includes('boolean')) {
        offer(true)
        offer(false)
      }
      if (types.includes('null')) offer(null)
    }
    if (!candidates.length) {
      offer(true)
      offer(false)
      offer(null)
    }
    return values
  }

  hover(doc: Document, position: Position): Hover | null {
    const { result } = this.parse(doc)
    const schema = this.schemaFor(doc, result.root)
    if (!schema) return null
    const offset = doc.offsetAt(position)
    const node = nodeAt(result.root, offset)
    if (!node || node.type === 'object' || node.type === 'array') return null
    const isKey = node.parent?.type === 'property' && node.parent.children![0] === node
    const path = isKey ? [...pathOf(node.parent!.parent!), String(node.value)] : pathOf(node)
    const candidates = schemasAt(schema, path)
    const parts: string[] = []
    for (const candidate of candidates) {
      const words = describe(candidate)
      if (words && !parts.includes(words)) parts.push(words)
      if (!isKey && candidate.enum && candidate.enumDescriptions) {
        const index = candidate.enum.findIndex((value) => value === valueOf(node))
        const note = index >= 0 ? candidate.enumDescriptions[index] : undefined
        if (note) parts.push(`\`${escapeMarkdown(JSON.stringify(valueOf(node)))}\`: ${note}`)
      }
    }
    if (!parts.length) return null
    return { contents: { kind: 'markdown', value: parts.join('\n\n') }, range: doc.range(node.offset, node.offset + node.length) }
  }

  symbols(doc: Document): DocumentSymbol[] {
    const { result } = this.parse(doc)
    let count = 0
    const kindOf = (node: JsonNode | undefined) => {
      switch (node?.type) {
        case 'object':
          return SymbolKind.Module
        case 'array':
          return SymbolKind.Array
        case 'string':
          return SymbolKind.String
        case 'number':
          return SymbolKind.Number
        case 'boolean':
          return SymbolKind.Boolean
        default:
          return SymbolKind.Null
      }
    }
    const children = (node: JsonNode | undefined): DocumentSymbol[] => {
      if (!node || count > MAX_SYMBOLS) return []
      if (node.type === 'object') {
        return (node.children ?? []).map((property) => {
          count++
          const key = property.children![0]!
          const value = property.children![1]
          const end = value ? value.offset + value.length : key.offset + key.length
          return {
            name: String(key.value) || '""',
            kind: kindOf(value),
            ...(value && value.type !== 'object' && value.type !== 'array' ? { detail: doc.text.slice(value.offset, Math.min(value.offset + value.length, value.offset + 60)) } : {}),
            range: doc.range(property.offset, end),
            selectionRange: doc.range(key.offset, key.offset + key.length),
            children: children(value),
          }
        })
      }
      if (node.type === 'array') {
        return (node.children ?? []).flatMap((item, index) => {
          if (item.type !== 'object' && item.type !== 'array') return []
          count++
          return [{ name: `[${index}]`, kind: kindOf(item), range: doc.range(item.offset, item.offset + item.length), selectionRange: doc.range(item.offset, item.offset + 1), children: children(item) }]
        })
      }
      return []
    }
    return children(result.root ?? undefined)
  }

  folding(doc: Document): FoldingRange[] {
    const { result } = this.parse(doc)
    const ranges: FoldingRange[] = []
    const walk = (node: JsonNode) => {
      if (node.type === 'object' || node.type === 'array') {
        const start = doc.positionAt(node.offset).line
        const endPosition = doc.positionAt(node.offset + node.length)
        // The closing bracket's line stays shown.
        const end = endPosition.line - 1
        if (end > start) ranges.push({ startLine: start, endLine: end })
      }
      for (const child of node.children ?? []) walk(child)
    }
    if (result.root) walk(result.root)
    const regions: number[] = []
    for (const comment of result.comments) {
      const start = doc.positionAt(comment.offset).line
      const end = doc.positionAt(comment.offset + comment.length).line
      const body = doc.text.slice(comment.offset, comment.offset + comment.length)
      if (/^\/\/\s*#region\b/.test(body)) regions.push(start)
      else if (/^\/\/\s*#endregion\b/.test(body) && regions.length) ranges.push({ startLine: regions.pop()!, endLine: start, kind: 'region' })
      else if (comment.block && end > start) ranges.push({ startLine: start, endLine: end, kind: 'comment' })
    }
    return ranges.sort((a, b) => a.startLine - b.startLine)
  }

  /** The whole document laid out again; nothing when it has problems reading it, so nothing is lost. */
  format(doc: Document, options: FormatOptions): TextEdit[] {
    const { result, comments: allowed } = this.parse(doc)
    if (result.problems.length) return []
    const formatted = formatJson(doc.text, options, allowed)
    if (formatted === null || formatted === doc.text) return []
    return [{ range: doc.range(0, doc.text.length), newText: formatted }]
  }
}

function valueSnippet(type: string | undefined, schemas: Schema[]): string {
  const defaultValue = schemas.find((schema) => schema.default !== undefined)?.default
  if (defaultValue !== undefined && (typeof defaultValue !== 'object' || defaultValue === null)) return `\${1:${JSON.stringify(defaultValue).replace(/[$}\\]/g, '\\$&')}}`
  switch (type) {
    case 'string':
      return '"$1"'
    case 'object':
      return '{$1}'
    case 'array':
      return '[$1]'
    case 'boolean':
      return '${1:false}'
    case 'number':
    case 'integer':
      return '${1:0}'
    case 'null':
      return 'null'
    default:
      return '$1'
  }
}

/** JSON laid out with one value a line, indented, comments kept where they were (on their line or after a value). */
export function formatJson(text: string, options: FormatOptions, keepComments: boolean): string | null {
  const problems: ParseProblem[] = []
  const comments: JsonDocument['comments'] = []
  const tokens = scan(text, problems, comments).filter((token) => token.kind !== 'eof')
  if (problems.length || (!keepComments && comments.length)) return null
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const unit = options.insertSpaces ? ' '.repeat(Math.max(1, Math.min(16, options.tabSize))) : '\t'
  type Piece = { offset: number; length: number; kind: string; block?: boolean }
  const pieces: Piece[] = [...tokens.map((token) => ({ offset: token.offset, length: token.length, kind: token.kind as string })), ...comments.map((comment) => ({ offset: comment.offset, length: comment.length, kind: 'comment', block: comment.block }))].sort((a, b) => a.offset - b.offset)
  let out = ''
  let depth = 0
  let needLine = false
  let previous: Piece | null = null
  const gap = (to: Piece) => (previous ? (text.slice(previous.offset + previous.length, to.offset).match(/\r\n|\r|\n/g)?.length ?? 0) : 0)
  // A new line for `piece`, with one blank line kept where the text had any.
  const startLine = (piece: Piece) => {
    out = out.replace(/[ \t]+$/, '')
    if (out.length) out += (gap(piece) >= 2 ? eol : '') + eol
    out += unit.repeat(depth)
    needLine = false
  }
  for (const piece of pieces) {
    const raw = text.slice(piece.offset, piece.offset + piece.length)
    if (piece.kind === 'comment') {
      // A comment after a value on its line stays there; one on its own line keeps a line of its own.
      if (previous && gap(piece) === 0) out = `${out.replace(/ $/, '')} ${raw}`
      else {
        startLine(piece)
        out += raw
      }
      if (!piece.block) needLine = true
      previous = piece
      continue
    }
    if (piece.kind === '}' || piece.kind === ']') {
      depth = Math.max(0, depth - 1)
      if (previous && (previous.kind === '{' || previous.kind === '[')) needLine = false
      else startLine(piece)
      out += raw
      previous = piece
      continue
    }
    if (needLine) startLine(piece)
    else if (previous?.kind === 'comment' && out && !/\s$/.test(out)) out += ' '
    switch (piece.kind) {
      case '{':
      case '[':
        out += raw
        depth++
        needLine = true
        break
      case ',':
        out = `${out.replace(/[ \t]+$/, '')},`
        needLine = true
        break
      case ':':
        out += ': '
        break
      default:
        out += raw
    }
    previous = piece
  }
  out = out.replace(/[ \t]+$/gm, '')
  return /\r?\n$/.test(text) ? out.replace(/(\r?\n)*$/, '') + eol : out.replace(/(\r?\n)*$/, '')
}


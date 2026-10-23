/**
 * Semantic tokens as a language server gives them (`textDocument/semanticTokens/full`), in the relative format: read
 * defensively, since a server is another program, turned into absolute places and the editor's own kinds, and capped.
 * Lines and characters are the server's, 0-based, in UTF-16 units.
 */

/** The token types eNCode tells servers it knows: the protocol's standard ones. */
export const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator',
] as const

/** The token modifiers eNCode tells servers it knows. Only `deprecated` changes how a token is drawn. */
export const SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary'] as const

/** The kinds the editor draws a semantic token as: names of its own token kinds. */
export const SEMANTIC_KINDS = ['type', 'variable', 'property', 'constant', 'function', 'meta', 'keyword', 'comment', 'string', 'number', 'regexp', 'operator', 'bool', 'escape'] as const
export type SemanticKind = (typeof SEMANTIC_KINDS)[number]

/** A token's flag: the server marked it deprecated. */
export const SEMANTIC_DEPRECATED = 1

/**
 * What each type a server may name is drawn as. The standard types, then those servers add of their own
 * (rust-analyzer, clangd, basedpyright) where one plainly matches; a type not here is left to the editor's own colours.
 */
const KIND_OF: Readonly<Record<string, SemanticKind>> = {
  namespace: 'type',
  type: 'type',
  class: 'type',
  enum: 'type',
  interface: 'type',
  struct: 'type',
  typeParameter: 'type',
  typeAlias: 'type',
  builtinType: 'type',
  concept: 'type',
  union: 'type',
  parameter: 'variable',
  variable: 'variable',
  selfParameter: 'keyword',
  clsParameter: 'keyword',
  property: 'property',
  event: 'property',
  enumMember: 'constant',
  function: 'function',
  method: 'function',
  macro: 'meta',
  decorator: 'meta',
  attribute: 'meta',
  derive: 'meta',
  lifetime: 'meta',
  keyword: 'keyword',
  modifier: 'keyword',
  selfKeyword: 'keyword',
  selfTypeKeyword: 'keyword',
  comment: 'comment',
  string: 'string',
  character: 'string',
  number: 'number',
  boolean: 'bool',
  regexp: 'regexp',
  operator: 'operator',
  escapeSequence: 'escape',
  formatSpecifier: 'escape',
}

/** The most tokens read from one answer; the rest of a larger file keeps the editor's own colours. */
export const MAX_SEMANTIC_TOKENS = 100_000

/** The legend a server declared: the names its numbers stand for. */
export interface SemanticLegend {
  tokenTypes: readonly string[]
  tokenModifiers: readonly string[]
}

/**
 * The tokens of a document, flat, five numbers each: line, character, length, kind (an index into `SEMANTIC_KINDS`)
 * and flags (`SEMANTIC_DEPRECATED`). Sorted by place, as the server sent them.
 */
export interface EditorSemanticTokens {
  data: number[]
}

/** The legend from a server's capability, or null when it declared none that can be read. */
export function readLegend(provider: unknown): SemanticLegend | null {
  if (typeof provider !== 'object' || provider === null) return null
  const legend = (provider as { legend?: unknown }).legend
  if (typeof legend !== 'object' || legend === null) return null
  const { tokenTypes, tokenModifiers } = legend as { tokenTypes?: unknown; tokenModifiers?: unknown }
  if (!Array.isArray(tokenTypes) || tokenTypes.length > 1_000) return null
  const names = (list: unknown[]) => list.map((item) => (typeof item === 'string' ? item : ''))
  return { tokenTypes: names(tokenTypes), tokenModifiers: Array.isArray(tokenModifiers) ? names(tokenModifiers.slice(0, 32)) : [] }
}

const isUint = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000_000

/**
 * A server's answer as the editor's tokens. A token of a type the editor has no kind for is skipped but still moves
 * the place the next one counts from; an answer that is not five whole numbers a token, or that goes back, ends where
 * it stops making sense.
 */
export function readSemanticTokens(value: unknown, legend: SemanticLegend): EditorSemanticTokens | null {
  if (value === null || value === undefined || typeof value !== 'object') return null
  const raw = (value as { data?: unknown }).data
  if (!Array.isArray(raw)) return null
  const kinds = legend.tokenTypes.map((name) => {
    const kind = Object.prototype.hasOwnProperty.call(KIND_OF, name) ? KIND_OF[name] : undefined
    return kind === undefined ? -1 : SEMANTIC_KINDS.indexOf(kind)
  })
  const deprecatedBit = legend.tokenModifiers.indexOf('deprecated')
  const data: number[] = []
  let line = 0
  let character = 0
  for (let index = 0; index + 4 < raw.length; index += 5) {
    if (data.length >= MAX_SEMANTIC_TOKENS * 5) break
    const deltaLine = raw[index]
    const deltaStart = raw[index + 1]
    const length = raw[index + 2]
    const type = raw[index + 3]
    const modifiers = raw[index + 4]
    if (!isUint(deltaLine) || !isUint(deltaStart) || !isUint(length) || !isUint(type) || !isUint(modifiers)) break
    line += deltaLine
    character = deltaLine === 0 ? character + deltaStart : deltaStart
    if (line > 100_000_000 || character > 100_000_000) break
    const kind = type < kinds.length ? kinds[type] : -1
    if (kind < 0 || length === 0) continue
    const flags = deprecatedBit >= 0 && deprecatedBit < 31 && modifiers & (1 << deprecatedBit) ? SEMANTIC_DEPRECATED : 0
    data.push(line, character, length, kind, flags)
  }
  return { data }
}

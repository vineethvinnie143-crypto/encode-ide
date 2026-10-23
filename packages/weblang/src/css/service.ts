/**
 * CSS, SCSS and Less: reading problems, unknown properties, at-rules, pseudo-classes and values (with the likely
 * name), completion of each of those, hovers with a property's syntax, symbols and folding (ADR 0085). The names come
 * from mdn-data, written into `../data/css-data.ts` by `scripts/web-data.mjs`.
 */
import { CSS_AT_RULES, CSS_FUNCTIONS, CSS_PROPERTIES, CSS_PSEUDO_CLASSES, CSS_PSEUDO_ELEMENTS } from '../data/css-data'
import { HTML_ELEMENTS } from '../data/html-data'
import { closest, escapeMarkdown, ItemKind, Severity, SymbolKind, type CompletionItem, type Diagnostic, type Document, type DocumentSymbol, type FoldingRange, type Hover, type Position } from '../text'
import { DESCRIPTOR_AT_RULES, parseStylesheet, walk, type AtRule, type Dialect, type Node, type Rule, type Stylesheet } from './parser'

interface PropertyInfo {
  name: string
  syntax: string
  keywords: readonly string[]
  status?: string
}

let properties: Map<string, PropertyInfo> | null = null
function propertyTable(): Map<string, PropertyInfo> {
  if (!properties) properties = new Map(CSS_PROPERTIES.map(([name, syntax, keywords, status]) => [name, { name, syntax, keywords, ...(status ? { status } : {}) }]))
  return properties
}
const atRules = new Map(CSS_AT_RULES.map(([name, descriptors]) => [name, descriptors]))
const pseudoClasses = new Set(CSS_PSEUDO_CLASSES.map((name) => name.replace(/\(\)$/, '').slice(1)))
const pseudoElements = new Set(CSS_PSEUDO_ELEMENTS.map((name) => name.replace(/\(\)$/, '').slice(2)))
/** Written with one colon before CSS 3, still read that way. */
const LEGACY_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter'])
/** From CSS modules, Vue, Svelte and Angular, which projects use in plain .css files too. */
const FRAMEWORK_PSEUDOS = new Set(['global', 'local', 'export', 'import', 'deep', 'v-deep', 'v-global', 'v-slotted', 'ng-deep'])
export const GLOBAL_KEYWORDS = ['inherit', 'initial', 'unset', 'revert', 'revert-layer']
/** Tailwind's directives (v3 and v4) and the preprocessors' at-rules: never unknown. */
const EXTRA_AT_RULES: Record<Dialect, string[]> = {
  css: ['@tailwind', '@apply', '@config', '@theme', '@utility', '@variant', '@custom-variant', '@source', '@plugin', '@reference', '@screen', '@layer', '@custom-media', '@custom-selector'],
  scss: ['@use', '@forward', '@import', '@mixin', '@include', '@function', '@return', '@if', '@else', '@each', '@for', '@while', '@extend', '@at-root', '@debug', '@warn', '@error', '@content'],
  less: ['@import', '@plugin'],
}

export function dialectOf(languageId: string): Dialect {
  return languageId === 'scss' ? 'scss' : languageId === 'less' ? 'less' : 'css'
}

const SOURCE: Record<Dialect, string> = { css: 'css', scss: 'scss', less: 'less' }

/** A selector's text with strings, attribute brackets and interpolations blanked, offsets kept. */
function selectorShape(text: string): string {
  return text.replace(/"[^"]*"|'[^']*'|\[[^\]]*\]|#\{[^}]*\}|@\{[^}]*\}|\([^)]*\)/g, (match) => (match.startsWith('(') ? `(${' '.repeat(match.length - 2)})` : ' '.repeat(match.length)))
}

export class CssService {
  private readonly parsed = new Map<string, { version: number; text: string; sheet: Stylesheet }>()

  parse(doc: Document): Stylesheet {
    const cached = this.parsed.get(doc.uri)
    if (cached && cached.version === doc.version && cached.text === doc.text) return cached.sheet
    const sheet = parseStylesheet(doc.text, dialectOf(doc.languageId))
    this.parsed.set(doc.uri, { version: doc.version, text: doc.text, sheet })
    return sheet
  }

  forget(uri: string): void {
    this.parsed.delete(uri)
  }

  diagnostics(doc: Document): Diagnostic[] {
    const dialect = dialectOf(doc.languageId)
    const source = SOURCE[dialect]
    const sheet = this.parse(doc)
    const text = doc.text
    const out: Diagnostic[] = sheet.problems.map((problem) => ({ range: doc.range(problem.start, problem.end), severity: Severity.Error, message: problem.message, source }))
    const warn = (start: number, end: number, message: string, tags?: number[]) => out.push({ range: doc.range(start, end), severity: Severity.Warning, message, source, ...(tags ? { tags } : {}) })
    const table = propertyTable()
    for (const { node, parents } of walk(sheet.children)) {
      if (node.type === 'declaration') {
        if (node.variable) continue
        const name = node.property.name
        const lower = name.toLowerCase()
        if (dialect === 'less' && node.colon === null && /^[.#]/.test(name)) continue
        if (/^(--|-|\*|_)/.test(name) || /[#@$]\{|\$|@/.test(name) || node.colon === null) continue
        const host = parents.at(-1)
        if (host?.type === 'at-rule' && DESCRIPTOR_AT_RULES.has(host.name.name)) {
          const descriptors = atRules.get(host.name.name)
          if (descriptors && descriptors.length && !descriptors.includes(lower)) {
            const near = closest(lower, descriptors)
            warn(node.property.start, node.property.end, `${host.name.name} has no descriptor ${name}.${near ? ` Did you mean ${near}?` : ''}`)
          }
          continue
        }
        // SCSS's nested properties (`font: { family: ... }`) put a property's start in the rule above.
        if (host?.type === 'rule' && /:\s*$/.test(text.slice(host.selector.start, host.selector.end))) continue
        const info = table.get(lower)
        if (!info) {
          const near = closest(lower, table.keys())
          warn(node.property.start, node.property.end, `Unknown property ${name}.${near ? ` Did you mean ${near}?` : ''}`)
          continue
        }
        if (info.status === 'obsolete') warn(node.property.start, node.property.end, `${name} is obsolete.`, [2])
        // A property that takes only keywords, given one it does not take.
        const value = text.slice(node.value.start, node.value.end).replace(/\s*!\s*important\s*$/i, '').trim()
        if (!info.syntax.includes('<') && /^-?[A-Za-z][\w-]*$/.test(value)) {
          const word = value.toLowerCase()
          if (!info.keywords.includes(word) && !GLOBAL_KEYWORDS.includes(word) && !word.startsWith('-')) {
            const near = closest(word, info.keywords)
            const at = text.indexOf(value, node.value.start)
            warn(at, at + value.length, `${value} is not a value ${name} takes.${near ? ` Did you mean ${near}?` : ''}`)
          }
        }
      } else if (node.type === 'at-rule') {
        const name = node.name.name
        if (dialect === 'css' && !atRules.has(name) && !EXTRA_AT_RULES.css.includes(name) && !name.startsWith('@-')) {
          const near = closest(name, [...atRules.keys(), ...EXTRA_AT_RULES.css])
          warn(node.name.start, node.name.end, `Unknown at-rule ${name}.${near ? ` Did you mean ${near}?` : ''}`)
        }
      } else if (node.type === 'rule') {
        const host = parents.at(-1)
        if (host?.type === 'at-rule' && /keyframes$/.test(host.name.name)) continue
        const raw = text.slice(node.selector.start, node.selector.end)
        const shape = selectorShape(raw)
        for (const match of shape.matchAll(/(::?)(-?[A-Za-z][\w-]*)/g)) {
          const [, colons, name] = match
          const lower = name!.toLowerCase()
          if (lower.startsWith('-') || FRAMEWORK_PSEUDOS.has(lower)) continue
          // A Less mixin guard or a SCSS placeholder's `%` reads like a selector but is not one.
          const known = colons === '::' ? pseudoElements.has(lower) : pseudoClasses.has(lower) || LEGACY_ELEMENTS.has(lower)
          if (known) continue
          // `a:hover` in SCSS's nested properties (`font:bold`) is not a selector.
          if (dialect !== 'css' && /:\s*$/.test(raw)) continue
          const start = node.selector.start + match.index!
          const pool = colons === '::' ? pseudoElements : pseudoClasses
          const near = closest(lower, pool)
          warn(start, start + match[0].length, `Unknown pseudo-${colons === '::' ? 'element' : 'class'} ${match[0]}.${near ? ` Did you mean ${colons}${near}?` : ''}`)
        }
      }
    }
    return out
  }

  completion(doc: Document, position: Position): CompletionItem[] {
    const dialect = dialectOf(doc.languageId)
    const sheet = this.parse(doc)
    const text = doc.text
    const offset = doc.offsetAt(position)
    // The word being typed, which a suggestion replaces.
    let start = offset
    while (start > 0 && /[\w-]/.test(text[start - 1]!)) start--
    const range = doc.range(start, offset)
    const before = text[start - 1] ?? ''
    const items: CompletionItem[] = []
    const add = (item: Omit<CompletionItem, 'range'>) => items.push({ ...item, range })

    // Which block the cursor is in, and the statement it is in, from the statement's start to the cursor.
    const { block, host } = innermost(sheet.children, offset, text.length)
    const statementStart = Math.max(block ? block.start + 1 : 0, lastStop(text, offset, block ? block.start + 1 : 0))
    const statement = text.slice(statementStart, offset)
    const allowsDeclarations = block !== null && !(host?.type === 'at-rule' && /keyframes$/.test(host.name.name))

    if (before === '@' && /^\s*@?[\w-]*$/.test(statement)) {
      const names = [...atRules.keys(), ...EXTRA_AT_RULES[dialect], ...(dialect === 'css' ? [] : EXTRA_AT_RULES.css.slice(0, 2))]
      for (const name of new Set(names)) add({ label: name, kind: ItemKind.Keyword, insertText: name.slice(1), filterText: name.slice(1) })
      return items
    }
    const colon = topLevelColon(statement)
    const property = colon >= 0 ? statement.slice(0, colon).trim().toLowerCase() : ''
    const table = propertyTable()
    const isDeclaration = allowsDeclarations && colon >= 0 && (table.has(property) || property.startsWith('--') || /\s/.test(statement.slice(colon + 1, colon + 2)) || statement.slice(colon + 1).length > 0 && !/^[\w-]*$/.test(statement.slice(colon + 1)))
    if (isDeclaration && !/[{}]/.test(statement)) {
      // A value: the property's keywords, the global ones, functions, and the custom properties and variables here.
      const info = table.get(property)
      const inVar = /var\(\s*-*[\w-]*$/.test(text.slice(Math.max(0, start - 40), offset))
      if (inVar || before === '-') {
        let customStart = start
        while (customStart > 0 && text[customStart - 1] === '-') customStart--
        for (const name of customProperties(sheet, text)) items.push({ label: name, kind: ItemKind.Variable, range: doc.range(customStart, offset) })
        if (inVar) return items
      }
      for (const keyword of info?.keywords ?? []) add({ label: keyword, kind: ItemKind.Value })
      for (const keyword of GLOBAL_KEYWORDS) add({ label: keyword, kind: ItemKind.Keyword, sortText: `z${keyword}` })
      for (const fn of CSS_FUNCTIONS) add({ label: fn, kind: ItemKind.Function, insertText: `${fn.slice(0, -1)}$1)`, insertTextFormat: 2, sortText: `y${fn}` })
      if (dialect === 'scss') for (const name of variables(sheet, '$')) add({ label: name, kind: ItemKind.Variable })
      if (dialect === 'less') for (const name of variables(sheet, '@')) add({ label: name, kind: ItemKind.Variable })
      return items
    }
    if (allowsDeclarations && /^\s*[\w-]*$/.test(statement) && before !== ':' && before !== '.' && before !== '#') {
      for (const info of table.values()) {
        if (info.status === 'obsolete') continue
        add({
          label: info.name,
          kind: ItemKind.Property,
          insertText: `${info.name}: `,
          detail: info.syntax.length > 120 ? `${info.syntax.slice(0, 117)}...` : info.syntax,
          ...(info.status === 'nonstandard' || info.name.startsWith('-') ? { sortText: `z${info.name}` } : {}),
        })
      }
      if (dialect === 'scss') for (const name of variables(sheet, '$')) add({ label: name, kind: ItemKind.Variable })
      // A nested rule starts here too: element names follow the properties.
      if (dialect !== 'css' || block) for (const [name] of HTML_ELEMENTS) add({ label: name, kind: ItemKind.Class, sortText: `zz${name}` })
      return items
    }
    // A selector.
    if (before === ':') {
      const elements = text[start - 2] === ':'
      const pool = elements ? CSS_PSEUDO_ELEMENTS : CSS_PSEUDO_CLASSES
      for (const name of pool) {
        const bare = name.replace(/^::?/, '')
        add({ label: name, kind: ItemKind.Function, filterText: bare, insertText: bare.endsWith('()') ? `${bare.slice(0, -2)}($1)` : bare, insertTextFormat: 2 })
      }
      return items
    }
    if (before !== '.' && before !== '#' && !/[\w-]$/.test(text.slice(0, start))) {
      for (const [name, , flags] of HTML_ELEMENTS) if (!(flags & 2)) add({ label: name, kind: ItemKind.Class })
    }
    return items
  }

  hover(doc: Document, position: Position): Hover | null {
    const sheet = this.parse(doc)
    const offset = doc.offsetAt(position)
    for (const { node } of walk(sheet.children)) {
      if (node.type === 'declaration' && offset >= node.property.start && offset < node.property.end && !node.variable) {
        const info = propertyTable().get(node.property.name.toLowerCase())
        if (!info) return null
        const lines = [`**${info.name}**`, '```\n' + info.syntax.replace(/```/g, "'''") + '\n```']
        if (info.status) lines.push(`Status: ${info.status}`)
        return { contents: { kind: 'markdown', value: lines.join('\n\n') }, range: doc.range(node.property.start, node.property.end) }
      }
      if (node.type === 'at-rule' && offset >= node.name.start && offset < node.name.end) {
        const descriptors = atRules.get(node.name.name)
        if (!descriptors) return null
        const lines = [`**${node.name.name}**`]
        if (descriptors.length) lines.push(`Descriptors: ${descriptors.map((name) => `\`${escapeMarkdown(name)}\``).join(', ')}`)
        return { contents: { kind: 'markdown', value: lines.join('\n\n') }, range: doc.range(node.name.start, node.name.end) }
      }
    }
    return null
  }

  symbols(doc: Document): DocumentSymbol[] {
    const sheet = this.parse(doc)
    const text = doc.text
    let count = 0
    const make = (nodes: Node[]): DocumentSymbol[] => {
      const out: DocumentSymbol[] = []
      for (const node of nodes) {
        if (++count > 5000) break
        if (node.type === 'rule') {
          const name = text.slice(node.selector.start, node.selector.end).replace(/\s+/g, ' ').trim()
          out.push({ name: name.length > 120 ? `${name.slice(0, 117)}...` : name || '(no selector)', kind: SymbolKind.Class, range: doc.range(node.start, node.end), selectionRange: doc.range(node.selector.start, node.selector.end), children: make(node.block.children) })
        } else if (node.type === 'at-rule') {
          const prelude = text.slice(node.prelude.start, node.prelude.end).replace(/\s+/g, ' ').trim()
          const kind = /^@(mixin|function)$/.test(node.name.name) ? SymbolKind.Function : SymbolKind.Module
          out.push({ name: `${node.name.name}${prelude ? ` ${prelude.length > 100 ? `${prelude.slice(0, 97)}...` : prelude}` : ''}`, kind, range: doc.range(node.start, node.end), selectionRange: doc.range(node.name.start, node.name.end), children: node.block ? make(node.block.children) : [] })
        } else if (node.variable || node.property.name.startsWith('--')) {
          out.push({ name: node.property.name, kind: SymbolKind.Variable, range: doc.range(node.start, node.end), selectionRange: doc.range(node.property.start, node.property.end) })
        }
      }
      return out
    }
    return make(sheet.children)
  }

  folding(doc: Document): FoldingRange[] {
    const sheet = this.parse(doc)
    const ranges: FoldingRange[] = []
    for (const { node } of walk(sheet.children)) {
      const body = node.type === 'rule' ? node.block : node.type === 'at-rule' ? node.block : null
      if (!body) continue
      const start = doc.positionAt(node.start).line
      const end = doc.positionAt(body.end).line - 1
      if (end > start) ranges.push({ startLine: start, endLine: end })
    }
    const regions: number[] = []
    for (const token of sheet.tokens) {
      if (token.kind !== 'comment') continue
      const start = doc.positionAt(token.start).line
      const end = doc.positionAt(token.end).line
      if (/^\/[*/]\s*#region\b/.test(token.text)) regions.push(start)
      else if (/^\/[*/]\s*#endregion\b/.test(token.text) && regions.length) ranges.push({ startLine: regions.pop()!, endLine: start, kind: 'region' })
      else if (end > start) ranges.push({ startLine: start, endLine: end, kind: 'comment' })
    }
    return ranges.sort((a, b) => a.startLine - b.startLine)
  }
}

/** The innermost block holding an offset, and the rule or at-rule it belongs to; a block not closed runs to the end. */
function innermost(nodes: readonly Node[], offset: number, length: number): { block: { start: number; end: number } | null; host: Rule | AtRule | null } {
  let found: { block: { start: number; end: number } | null; host: Rule | AtRule | null } = { block: null, host: null }
  let level: readonly Node[] = nodes
  for (;;) {
    let next: Rule | AtRule | null = null
    for (const node of level) {
      if (node.type === 'declaration') continue
      const body = node.block
      if (body && offset > body.start && (offset < body.end || (body.end === length && offset === length))) next = node
    }
    if (!next) return found
    const block = next.type === 'rule' ? next.block : next.block!
    found = { block, host: next }
    level = block.children
  }
}

/** Where the statement at `offset` starts: after the last `;`, `{` or `}` before it, outside brackets. */
function lastStop(text: string, offset: number, floor: number): number {
  let depth = 0
  for (let index = offset - 1; index >= floor; index--) {
    const char = text[index]
    if (char === ')') depth++
    else if (char === '(') depth = Math.max(0, depth - 1)
    else if (depth === 0 && (char === ';' || char === '{' || char === '}')) return index + 1
  }
  return floor
}

function topLevelColon(statement: string): number {
  let depth = 0
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index]
    if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    else if (char === ':' && depth === 0 && statement[index + 1] !== ':' && statement[index - 1] !== ':') return index
  }
  return -1
}

function customProperties(sheet: Stylesheet, text: string): string[] {
  const names = new Set<string>()
  for (const { node } of walk(sheet.children)) if (node.type === 'declaration' && node.property.name.startsWith('--')) names.add(node.property.name)
  for (const match of text.matchAll(/var\(\s*(--[\w-]+)/g)) names.add(match[1]!)
  return [...names].slice(0, 2000)
}

function variables(sheet: Stylesheet, sigil: '$' | '@'): string[] {
  const names = new Set<string>()
  for (const { node } of walk(sheet.children)) if (node.type === 'declaration' && node.variable && node.property.name.startsWith(sigil)) names.add(node.property.name)
  return [...names].slice(0, 2000)
}


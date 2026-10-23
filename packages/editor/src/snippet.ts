/**
 * Snippets as language servers write them (the LSP's syntax, which is TextMate's): tab stops `$1` and `${1}`,
 * placeholders `${1:text}` that may hold others, choices `${1|one,two|}`, the final stop `$0`, and variables `$NAME`,
 * `${NAME}`, `${NAME:default}` and `${NAME/regex/format/flags}`. A backslash escapes `$`, `}` and `\`, and in a
 * choice `,` and `|` as well. Anything the grammar does not cover is kept as it is written, so a broken snippet still
 * inserts its text.
 */

export interface SnippetRange {
  from: number
  to: number
}

export interface SnippetStop {
  /** The stop's number; 0 is the last one Tab visits. */
  index: number
  /** Where its text is in the expanded snippet: the first holds the placeholder, the others mirror it. */
  ranges: SnippetRange[]
  /** The values a choice offers; the first is the one inserted. */
  choices?: string[]
}

export interface Snippet {
  /** The text the snippet expands to. */
  text: string
  /** In the order Tab visits them: 1, 2, and so on, then 0, which is at the end of the text when the snippet has none. */
  stops: SnippetStop[]
}

export interface SnippetOptions {
  /** Put after each line break: the indentation of the line the snippet goes on. */
  indent?: string
  /** What a tab character in the snippet becomes: the document's unit of indentation. */
  indentUnit?: string
  /** A variable's value, or undefined when it has none (then its default, or its name as a placeholder, is used). */
  variable?(name: string): string | undefined
}

type Node =
  | { type: 'text'; value: string }
  | { type: 'stop'; index: number; children: Node[] | null; choices: string[] | null }
  | { type: 'variable'; name: string; children: Node[] | null; transform: Transform | null }

interface Transform {
  regex: RegExp
  format: FormatPart[]
}

type CaseChange = 'upcase' | 'downcase' | 'capitalize' | 'camelcase' | 'pascalcase'

type FormatPart = { type: 'text'; value: string } | { type: 'group'; group: number; how: CaseChange | null; ifText?: string; elseText?: string }

/** Deepest nesting of placeholders taken as written; deeper text is kept as plain text. */
const MAX_DEPTH = 32

class Parser {
  index = 0
  constructor(readonly source: string) {}

  /** Nodes up to the end, or up to an unescaped `}` when inside a placeholder (which is left for the caller). */
  nodes(nested: boolean, depth: number): Node[] {
    const out: Node[] = []
    let text = ''
    const flush = () => {
      if (text) out.push({ type: 'text', value: text })
      text = ''
    }
    const { source } = this
    while (this.index < source.length) {
      const char = source[this.index]
      if (char === '\\' && this.index + 1 < source.length && '$}\\'.includes(source[this.index + 1])) {
        text += source[this.index + 1]
        this.index += 2
        continue
      }
      if (char === '}' && nested) break
      if (char === '$' && depth < MAX_DEPTH) {
        const start = this.index
        const node = this.dollar(depth)
        if (node) {
          flush()
          out.push(node)
          continue
        }
        this.index = start + 1
        text += '$'
        continue
      }
      text += char
      this.index++
    }
    flush()
    return out
  }

  /** What a `$` starts, or null when it starts nothing the grammar knows (it is then plain text). */
  private dollar(depth: number): Node | null {
    const { source } = this
    this.index++
    const digits = /^\d+/.exec(source.slice(this.index, this.index + 10))
    if (digits) {
      this.index += digits[0].length
      return { type: 'stop', index: Number(digits[0]), children: null, choices: null }
    }
    const name = /^[_a-zA-Z][_a-zA-Z0-9]*/.exec(source.slice(this.index, this.index + 200))
    if (name) {
      this.index += name[0].length
      return { type: 'variable', name: name[0], children: null, transform: null }
    }
    if (source[this.index] !== '{') return null
    this.index++
    const number = /^\d+/.exec(source.slice(this.index, this.index + 10))
    if (number) {
      this.index += number[0].length
      const index = Number(number[0])
      const next = source[this.index]
      if (next === '}') {
        this.index++
        return { type: 'stop', index, children: null, choices: null }
      }
      if (next === ':') {
        this.index++
        const children = this.nodes(true, depth + 1)
        if (source[this.index] !== '}') return null
        this.index++
        return { type: 'stop', index, children, choices: null }
      }
      if (next === '|') {
        this.index++
        const choices = this.choices()
        if (!choices) return null
        return { type: 'stop', index, children: null, choices }
      }
      return null
    }
    const variable = /^[_a-zA-Z][_a-zA-Z0-9]*/.exec(source.slice(this.index, this.index + 200))
    if (!variable) return null
    this.index += variable[0].length
    const next = source[this.index]
    if (next === '}') {
      this.index++
      return { type: 'variable', name: variable[0], children: null, transform: null }
    }
    if (next === ':') {
      this.index++
      const children = this.nodes(true, depth + 1)
      if (source[this.index] !== '}') return null
      this.index++
      return { type: 'variable', name: variable[0], children, transform: null }
    }
    if (next === '/') {
      this.index++
      const transform = this.transform()
      if (!transform) return null
      return { type: 'variable', name: variable[0], children: null, transform }
    }
    return null
  }

  /** `one,two|}` after `${1|`, or null when it does not end. */
  private choices(): string[] | null {
    const { source } = this
    const out: string[] = []
    let current = ''
    while (this.index < source.length) {
      const char = source[this.index]
      if (char === '\\' && this.index + 1 < source.length && ',|\\$}'.includes(source[this.index + 1])) {
        current += source[this.index + 1]
        this.index += 2
        continue
      }
      if (char === ',') {
        out.push(current)
        current = ''
        this.index++
        continue
      }
      if (char === '|') {
        if (source[this.index + 1] !== '}') return null
        out.push(current)
        this.index += 2
        return out
      }
      current += char
      this.index++
    }
    return null
  }

  /** `regex/format/flags}` after `${NAME/`, or null when it does not end or the expression is not valid. */
  private transform(): Transform | null {
    const pattern = this.until('/')
    if (pattern === null) return null
    const format = this.until('/', true)
    if (format === null) return null
    const flags = this.until('}')
    if (flags === null || !/^[gimsuy]*$/.test(flags)) return null
    try {
      return { regex: new RegExp(pattern, flags), format: parseFormat(format) }
    } catch {
      return null
    }
  }

  /**
   * The text up to an unescaped `end`, which is consumed; a backslash before `end` keeps it. In a format (`braced`),
   * an `end` inside `${...}` is part of it (`${1:/upcase}`). Null at the end of the source.
   */
  private until(end: string, braced = false): string | null {
    const { source } = this
    let out = ''
    let depth = 0
    while (this.index < source.length) {
      const char = source[this.index]
      if (char === '\\' && source[this.index + 1] === end) {
        out += end
        this.index += 2
        continue
      }
      if (braced && char === '$' && source[this.index + 1] === '{') {
        depth++
        out += '${'
        this.index += 2
        continue
      }
      if (braced && char === '}' && depth > 0) {
        depth--
        out += char
        this.index++
        continue
      }
      if (char === end && depth === 0) {
        this.index++
        return out
      }
      out += char
      this.index++
    }
    return null
  }
}

function parseFormat(format: string): FormatPart[] {
  const out: FormatPart[] = []
  let text = ''
  let index = 0
  const flush = () => {
    if (text) out.push({ type: 'text', value: text })
    text = ''
  }
  while (index < format.length) {
    const char = format[index]
    if (char === '\\' && index + 1 < format.length) {
      const next = format[index + 1]
      text += next === 'n' ? '\n' : next === 't' ? '\t' : next
      index += 2
      continue
    }
    if (char === '$') {
      const simple = /^\$(\d+)/.exec(format.slice(index))
      if (simple) {
        flush()
        out.push({ type: 'group', group: Number(simple[1]), how: null })
        index += simple[0].length
        continue
      }
      const braced = /^\$\{(\d+)(?::(?:\/(upcase|downcase|capitalize|camelcase|pascalcase)|\+([^}]*)|\?([^:}]*):([^}]*)|-?([^}]*)))?\}/.exec(format.slice(index))
      if (braced) {
        flush()
        const [whole, group, how, plus, ifText, elseText, minus] = braced
        const part: FormatPart = { type: 'group', group: Number(group), how: (how as CaseChange | undefined) ?? null }
        if (plus !== undefined) part.ifText = plus
        else if (ifText !== undefined) {
          part.ifText = ifText
          part.elseText = elseText
        } else if (minus !== undefined && whole.includes(':')) part.elseText = minus
        out.push(part)
        index += whole.length
        continue
      }
    }
    text += char
    index++
  }
  flush()
  return out
}

function applyTransform(value: string, transform: Transform): string {
  const { regex, format } = transform
  const replace = (match: string, ...rest: unknown[]): string => {
    // The groups are the arguments before the offset (a number) and the whole string.
    const groups: (string | undefined)[] = [match]
    for (const item of rest) {
      if (typeof item === 'number') break
      groups.push(item as string | undefined)
    }
    let out = ''
    for (const part of format) {
      if (part.type === 'text') {
        out += part.value
        continue
      }
      const group = groups[part.group]
      if (part.ifText !== undefined || part.elseText !== undefined) {
        out += group ? (part.ifText ?? group) : (part.elseText ?? '')
        continue
      }
      if (!group) continue
      out += caseOf(group, part.how)
    }
    return out
  }
  return value.replace(regex, replace)
}

function caseOf(value: string, how: CaseChange | null): string {
  switch (how) {
    case 'upcase':
      return value.toUpperCase()
    case 'downcase':
      return value.toLowerCase()
    case 'capitalize':
      return value.charAt(0).toUpperCase() + value.slice(1)
    case 'camelcase':
    case 'pascalcase': {
      const words = value.split(/[^a-zA-Z0-9]+/).filter(Boolean)
      const joined = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join('')
      return how === 'camelcase' ? joined.charAt(0).toLowerCase() + joined.slice(1) : joined
    }
    default:
      return value
  }
}

/** The plain text of nodes, as a mirror of a placeholder shows it. */
function plainOf(nodes: readonly Node[], options: SnippetOptions): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') out += node.value
    else if (node.type === 'stop') out += node.choices ? (node.choices[0] ?? '') : node.children ? plainOf(node.children, options) : ''
    else {
      const value = options.variable?.(node.name)
      if (value !== undefined) out += node.transform ? applyTransform(value, node.transform) : value
      else if (node.children) out += plainOf(node.children, options)
      else out += node.name
    }
  }
  return out
}

/** The first occurrence of each stop that has text of its own (a placeholder or a choice), which the others mirror. */
function primaries(nodes: readonly Node[], out = new Map<number, Node & { type: 'stop' }>()): Map<number, Node & { type: 'stop' }> {
  for (const node of nodes) {
    if (node.type === 'stop') {
      if ((node.children || node.choices) && !out.has(node.index)) out.set(node.index, node)
      if (node.children) primaries(node.children, out)
    } else if (node.type === 'variable' && node.children) primaries(node.children, out)
  }
  return out
}

function highestIndex(nodes: readonly Node[]): number {
  let top = 0
  for (const node of nodes) {
    if (node.type === 'stop') top = Math.max(top, node.index, node.children ? highestIndex(node.children) : 0)
    else if (node.type === 'variable' && node.children) top = Math.max(top, highestIndex(node.children))
  }
  return top
}

/** Expands a snippet into its text and the places of its stops. */
export function parseSnippet(source: string, options: SnippetOptions = {}): Snippet {
  const nodes = new Parser(source).nodes(false, 0)
  const main = primaries(nodes)
  const stops = new Map<number, SnippetStop>()
  // A variable without a value or a default becomes a placeholder of its name, after the snippet's own stops.
  let extra = highestIndex(nodes)
  const indent = options.indent ?? ''
  const unit = options.indentUnit
  const shape = (value: string): string => {
    let out = value
    if (unit !== undefined && out.includes('\t')) out = out.replace(/\t/g, unit)
    if (indent && out.includes('\n')) out = out.replace(/\n/g, `\n${indent}`)
    return out
  }
  let text = ''
  const stopOf = (index: number): SnippetStop => {
    let stop = stops.get(index)
    if (!stop) stops.set(index, (stop = { index, ranges: [] }))
    return stop
  }
  const emit = (list: readonly Node[]): void => {
    for (const node of list) {
      if (node.type === 'text') {
        text += shape(node.value)
        continue
      }
      if (node.type === 'variable') {
        const value = options.variable?.(node.name)
        if (value !== undefined) text += shape(node.transform ? applyTransform(value, node.transform) : value)
        else if (node.children) emit(node.children)
        else {
          const from = text.length
          text += node.name
          stopOf(++extra).ranges.push({ from, to: text.length })
        }
        continue
      }
      const from = text.length
      const primary = main.get(node.index)
      const stop = stopOf(node.index)
      if (node === primary) {
        if (node.choices) {
          text += shape(node.choices[0] ?? '')
          stop.choices = node.choices
        } else emit(node.children ?? [])
        // The placeholder's own range goes first, so that it is the main selection when the stop is reached.
        stop.ranges.unshift({ from, to: text.length })
      } else {
        // A mirror: the placeholder's text, without stops of its own.
        if (primary) text += shape(primary.choices ? (primary.choices[0] ?? '') : plainOf(primary.children ?? [], options))
        stop.ranges.push({ from, to: text.length })
      }
    }
  }
  emit(nodes)
  const ordered = [...stops.values()].filter((stop) => stop.index !== 0).sort((a, b) => a.index - b.index)
  const last = stops.get(0) ?? { index: 0, ranges: [{ from: text.length, to: text.length }] }
  return { text, stops: [...ordered, last] }
}

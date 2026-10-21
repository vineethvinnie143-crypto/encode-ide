/**
 * Repairs the JSON a model wrote for a tool call's arguments. Weaker models,
 * and strong ones on a bad day, wrap it in a code fence, quote with single
 * quotes, write Python literals, leave a trailing comma, put raw newlines in
 * strings or encode the whole object as a string. Each of those has one
 * meaning, so it is fixed and reported.
 *
 * What is never "fixed" is text that stops early: a string, object or array
 * left open. Closing it would invent an ending (a file's content cut in half
 * would be written as if complete), so such text is reported as truncated,
 * and the caller asks again instead of running the call. Text that holds more
 * than one value (two calls glued together) is refused for the same reason.
 */

export interface JsonRepair {
  value: unknown
  /** What was fixed, in words. Empty when the text parsed as it was. */
  repairs: string[]
  /** The text ended inside a value. The repaired value would be missing whatever came after. */
  truncated: boolean
}

class Unrepairable extends Error {}

const WHITESPACE = /\s/
const IDENTIFIER_START = /[A-Za-z_$]/
const IDENTIFIER = /[\w$-]/
/** A bare value a model may leave unquoted: a path, a word, a dotted name. */
const BARE_VALUE = /^[A-Za-z_][\w./-]*/
const NUMBER_STRICT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/
const NUMBER_LOOSE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/
const LITERALS: Record<string, { json: string; repair?: string }> = {
  true: { json: 'true' },
  false: { json: 'false' },
  null: { json: 'null' },
  True: { json: 'true', repair: 'replaced Python literals' },
  False: { json: 'false', repair: 'replaced Python literals' },
  None: { json: 'null', repair: 'replaced Python literals' },
  undefined: { json: 'null', repair: 'replaced undefined with null' },
  NaN: { json: 'null', repair: 'replaced a non-number with null' },
  Infinity: { json: 'null', repair: 'replaced a non-number with null' },
}
const ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't'])
const CONTROL_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }

/** Rewrites lenient JSON into strict JSON, one value at a time. */
class Scanner {
  private index = 0
  readonly repairs = new Set<string>()
  truncated = false

  constructor(private readonly text: string) {}

  get done(): boolean {
    return this.index >= this.text.length
  }

  rest(): string {
    return this.text.slice(this.index)
  }

  private peek(): string {
    return this.text[this.index] ?? ''
  }

  /** Skips whitespace and comments. */
  skip(): void {
    while (!this.done) {
      const char = this.peek()
      if (WHITESPACE.test(char)) {
        this.index++
      } else if (char === '/' && this.text[this.index + 1] === '/') {
        const end = this.text.indexOf('\n', this.index)
        this.index = end === -1 ? this.text.length : end + 1
        this.repairs.add('removed comments')
      } else if (char === '/' && this.text[this.index + 1] === '*') {
        const end = this.text.indexOf('*/', this.index + 2)
        if (end === -1) throw new Unrepairable('an unclosed comment')
        this.index = end + 2
        this.repairs.add('removed comments')
      } else {
        return
      }
    }
  }

  value(): string {
    this.skip()
    if (this.done) {
      this.truncated = true
      return 'null'
    }
    const char = this.peek()
    if (char === '{') return this.object()
    if (char === '[') return this.array()
    if (char === '"' || char === "'") return this.string()
    if (/[-+.\d]/.test(char)) return this.number()
    if (IDENTIFIER_START.test(char)) return this.word()
    throw new Unrepairable(`an unexpected "${char}"`)
  }

  private object(): string {
    this.index++
    const members: string[] = []
    let expectMember = true
    while (true) {
      this.skip()
      if (this.done) {
        this.truncated = true
        break
      }
      const char = this.peek()
      if (char === '}') {
        this.index++
        if (expectMember && members.length) this.repairs.add('removed a trailing comma')
        break
      }
      if (char === ',') {
        this.index++
        if (expectMember) this.repairs.add('removed an extra comma')
        expectMember = true
        continue
      }
      if (!expectMember) this.repairs.add('added a missing comma')
      const key = this.key()
      this.skip()
      if (this.done) {
        this.truncated = true
        break
      }
      if (this.peek() === ':') {
        this.index++
      } else if (this.peek() === '=') {
        this.index++
        this.repairs.add('replaced = with :')
      } else {
        throw new Unrepairable(`no colon after the key ${key}`)
      }
      const value = this.value()
      if (this.truncated) break
      members.push(`${key}:${value}`)
      expectMember = false
    }
    return `{${members.join(',')}}`
  }

  private key(): string {
    const char = this.peek()
    if (char === '"' || char === "'") return this.string()
    if (IDENTIFIER_START.test(char)) {
      const start = this.index
      while (!this.done && IDENTIFIER.test(this.peek())) this.index++
      this.repairs.add('quoted keys')
      return JSON.stringify(this.text.slice(start, this.index))
    }
    throw new Unrepairable(`an unexpected "${char}" where a key belongs`)
  }

  private array(): string {
    this.index++
    const items: string[] = []
    let expectItem = true
    while (true) {
      this.skip()
      if (this.done) {
        this.truncated = true
        break
      }
      const char = this.peek()
      if (char === ']') {
        this.index++
        if (expectItem && items.length) this.repairs.add('removed a trailing comma')
        break
      }
      if (char === ',') {
        this.index++
        if (expectItem) this.repairs.add('removed an extra comma')
        expectItem = true
        continue
      }
      if (!expectItem) this.repairs.add('added a missing comma')
      const item = this.value()
      if (this.truncated) break
      items.push(item)
      expectItem = false
    }
    return `[${items.join(',')}]`
  }

  private string(): string {
    const quote = this.peek()
    if (quote === "'") this.repairs.add('replaced single quotes')
    this.index++
    let out = ''
    while (true) {
      if (this.done) {
        this.truncated = true
        break
      }
      const char = this.peek()
      if (char === quote) {
        this.index++
        break
      }
      if (char === '\\') {
        const next = this.text[this.index + 1]
        if (next === undefined) {
          this.truncated = true
          this.index++
          break
        }
        if (ESCAPES.has(next)) {
          out += `\\${next}`
          this.index += 2
        } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(this.text.slice(this.index + 2, this.index + 6))) {
          out += this.text.slice(this.index, this.index + 6)
          this.index += 6
        } else if (next === "'") {
          out += "'"
          this.index += 2
          if (quote === '"') this.repairs.add('fixed invalid escapes')
        } else {
          // An escape JSON does not know (\x, \a, a Windows path's \U): the backslash is a character of its own.
          out += '\\\\'
          this.index++
          this.repairs.add('fixed invalid escapes')
        }
        continue
      }
      if (char === '"') {
        out += '\\"'
      } else if (char < ' ') {
        out += CONTROL_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
        this.repairs.add('escaped control characters in strings')
      } else {
        out += char
      }
      this.index++
    }
    return `"${out}"`
  }

  private number(): string {
    const rest = this.rest()
    const strict = NUMBER_STRICT.exec(rest)
    const loose = NUMBER_LOOSE.exec(rest)
    if (strict && (!loose || strict[0].length >= loose[0].length)) {
      this.index += strict[0].length
      return strict[0]
    }
    if (!loose) throw new Unrepairable('a malformed number')
    const value = Number(loose[0])
    if (!Number.isFinite(value)) throw new Unrepairable('a malformed number')
    this.index += loose[0].length
    this.repairs.add('normalized numbers')
    return JSON.stringify(value)
  }

  private word(): string {
    const match = BARE_VALUE.exec(this.rest())
    if (!match) throw new Unrepairable('an unexpected word')
    const literal = LITERALS[match[0]]
    this.index += match[0].length
    if (literal) {
      if (literal.repair) this.repairs.add(literal.repair)
      return literal.json
    }
    this.repairs.add('quoted bare values')
    return JSON.stringify(match[0])
  }
}

const FENCE = /^```[a-z]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i

function parseStrict(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

function scan(text: string, repairs: string[]): JsonRepair | undefined {
  let body = text
  const fence = FENCE.exec(body)
  if (fence) {
    body = fence[1].trim()
    repairs.push('removed a code fence')
  }
  const strict = parseStrict(body)
  if (strict.ok) return { value: strict.value, repairs, truncated: false }

  // Prose before the JSON ("Here are the arguments: {…}") is dropped.
  if (!/^[{["']/.test(body)) {
    const start = body.search(/[{[]/)
    if (start === -1) return undefined
    body = body.slice(start)
    repairs.push('removed text around the JSON')
  }

  const scanner = new Scanner(body)
  let json: string
  try {
    json = scanner.value()
    scanner.skip()
  } catch (error) {
    if (error instanceof Unrepairable) return undefined
    throw error
  }
  if (!scanner.done) {
    // A second value would be a second call, glued on: refuse it rather than drop it.
    if (/^[{[]/.test(scanner.rest().trim())) return undefined
    if (!repairs.includes('removed text around the JSON')) repairs.push('removed text around the JSON')
  }
  const parsed = parseStrict(json)
  if (!parsed.ok) return undefined
  return { value: parsed.value, repairs: [...repairs, ...scanner.repairs], truncated: scanner.truncated }
}

/**
 * Parses lenient JSON. Returns undefined when the text cannot be read as
 * one JSON value at all. A string that holds JSON is decoded once.
 */
export function repairJsonText(raw: string): JsonRepair | undefined {
  const text = raw.trim()
  if (!text) return undefined
  const result = scan(text, [])
  if (!result || typeof result.value !== 'string' || result.truncated) return result
  const inner = result.value.trim()
  if (!/^[{[]/.test(inner)) return result
  const decoded = scan(inner, [])
  return decoded ? { value: decoded.value, repairs: [...result.repairs, 'decoded JSON inside a string', ...decoded.repairs], truncated: decoded.truncated } : result
}

/**
 * The assembler's repair hook: the repaired value, or undefined when the
 * text cannot be repaired without guessing (it was cut off, or holds more
 * than one value).
 */
export function repairJson(raw: string): unknown {
  const result = repairJsonText(raw)
  return result && !result.truncated ? result.value : undefined
}

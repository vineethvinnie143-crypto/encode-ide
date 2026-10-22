import { T, type LineTokens, type Tokenizer } from '../language'
import { ESCAPE, IDENTIFIER, NUMBER, Scanner, WHITESPACE, quoted, quotedBody, stackOf, words } from './scan'

/**
 * One tokenizer for the curly-brace family (JavaScript and TypeScript with
 * JSX, C, C++, C#, Java, Kotlin, Go, Rust, Swift), configured per language.
 *
 * The state is a stack of open constructs, comma-separated: `b` block
 * comment (one per nesting level), `` ` `` template literal, `$` template
 * expression, `{` brace inside an expression that must find its partner,
 * `q"` string continued with a backslash, `"""` triple-quoted string, `v`
 * verbatim string, `g` raw backtick string, `rN` raw string with N hashes,
 * and `j<` / `j>` / `j{` for a JSX tag, its children and an expression in it.
 */
export interface ClikeSpec {
  keywords: string
  /** Keywords that are also ordinary names (`type`, `get`, `from`): keywords only when a name or literal follows. */
  softKeywords?: string
  types?: string
  constants?: string
  booleans?: string
  /** Default "//"; null for none. */
  lineComment?: string | null
  /** C-style block comments. Default true. */
  blockComment?: boolean
  nestedComments?: boolean
  /** String quote characters. Default `"'`. */
  quotes?: string
  /** Template literals with `${}` (JavaScript). */
  template?: boolean
  /** Backtick raw strings (Go). */
  rawBacktick?: boolean
  /** `"""` strings (Kotlin, Java text blocks, C# raw strings, Swift). */
  tripleQuote?: boolean
  /** `@"…"` verbatim strings (C#). */
  verbatim?: boolean
  /** `r#"…"#` raw strings (Rust). */
  rawStrings?: boolean
  /** Regular expression literals (JavaScript). */
  regex?: boolean
  jsx?: boolean
  /** `@Name` annotations and decorators. */
  annotations?: boolean
  /** `#include` and friends at the start of a line. */
  preprocessor?: boolean
  /** `#[…]` attributes (Rust). */
  attributes?: boolean
  /** `name!` macro calls (Rust). */
  macros?: boolean
  /** `'a` lifetimes (Rust). */
  lifetimes?: boolean
}

const OPERATOR = /[+\-*/%=<>!&|^~?:#@\\]+/y
const REGEX = /\/(?![*/])(?:[^/\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*/y
const JSX_NAME = /[\p{L}_$][\p{L}\p{N}_$.:-]*/uy
const JSX_ATTR = /[\p{L}_$][\p{L}\p{N}_$:-]*/uy
const DOC_TAG = /(?:^|(?<=\s))@[a-zA-Z]+/g
/** Keywords that end an expression, after which `/` divides and `<` compares. */
const VALUE_KEYWORDS = words('this super self Self')

interface Compiled {
  spec: ClikeSpec
  keywords: ReadonlySet<string>
  soft: ReadonlySet<string>
  types: ReadonlySet<string>
  constants: ReadonlySet<string>
  booleans: ReadonlySet<string>
  lineComment: string | null
  quotes: string
}

/** The state of tokenizing one line. */
class Run {
  readonly s: Scanner
  readonly stack: string[]
  /** The last significant token ended an expression. */
  value = false
  /** The last significant token was a member access (`.` or `?.`). */
  dot = false

  constructor(
    readonly c: Compiled,
    text: string,
    state: string,
  ) {
    this.s = new Scanner(text)
    this.stack = stackOf(state)
  }

  run(): LineTokens {
    const { s, stack } = this
    while (!s.eol) {
      const top = stack[stack.length - 1]
      if (top === 'b') this.comment()
      else if (top === '`') this.template()
      else if (top === 'q"' || top === "q'" || top === 'q`') {
        if (!quotedBody(s, top[1])) stack.pop()
      } else if (top === '"""') this.until('"""')
      else if (top === 'v') this.verbatim()
      else if (top === 'g') this.until('`')
      else if (top !== undefined && top[0] === 'r') this.until(`"${'#'.repeat(Number(top.slice(1)))}`)
      else if (top === 'j<') this.jsxTag()
      else if (top === 'j>') this.jsxChildren()
      else this.code()
    }
    return { tokens: s.tokens(), state: stack.join(',') }
  }

  private comment(): void {
    const { s, stack } = this
    const text = s.text
    const from = s.pos
    const close = text.indexOf('*/', from)
    let end = close < 0 ? text.length : close + 2
    let nested = false
    if (this.c.spec.nestedComments) {
      const open = text.indexOf('/*', from)
      if (open >= 0 && (close < 0 || open < close)) {
        end = open + 2
        nested = true
      }
    }
    s.mark(from, T.comment)
    // Documentation tags (@param, @returns) stand out inside the comment.
    DOC_TAG.lastIndex = 0
    const body = text.slice(from, end)
    for (let found = DOC_TAG.exec(body); found; found = DOC_TAG.exec(body)) {
      s.mark(from + found.index, T.keyword)
      s.mark(from + found.index + found[0].length, T.comment)
    }
    s.pos = end
    if (nested) stack.push('b')
    else if (close >= 0) stack.pop()
  }

  private template(): void {
    const { s, stack } = this
    while (!s.eol) {
      const char = s.peek()
      if (char === '`') {
        s.take(1, T.string)
        stack.pop()
        this.value = true
        return
      }
      if (char === '\\') {
        if (!s.token(ESCAPE, T.escape)) s.take(1, T.string)
        continue
      }
      if (char === '$' && s.peek(1) === '{') {
        s.take(2, T.punct)
        stack.push('$')
        this.value = false
        return
      }
      if (!s.token(/[^`\\$]+/y, T.string)) s.take(1, T.string)
    }
  }

  /** A multi-line string that ends at `close`. */
  private until(close: string): void {
    const { s } = this
    const end = s.text.indexOf(close, s.pos)
    s.mark(s.pos, T.string)
    if (end < 0) {
      s.pos = s.text.length
      return
    }
    s.pos = end + close.length
    this.stack.pop()
    this.value = true
  }

  private verbatim(): void {
    const { s } = this
    while (!s.eol) {
      if (s.startsWith('""')) s.take(2, T.escape)
      else if (s.peek() === '"') {
        s.take(1, T.string)
        this.stack.pop()
        this.value = true
        return
      } else if (!s.token(/[^"]+/y, T.string)) s.take(1, T.string)
    }
  }

  private code(): void {
    const { s, stack, c } = this
    const { spec } = c
    const start = s.pos
    const char = s.peek()
    const top = stack[stack.length - 1]

    if (char === ' ' || char === '\t') {
      s.token(WHITESPACE, T.plain)
      return
    }
    if (c.lineComment && s.startsWith(c.lineComment)) {
      s.rest(T.comment)
      return
    }
    if (spec.blockComment !== false && char === '/' && s.peek(1) === '*') {
      s.take(2, T.comment)
      stack.push('b')
      return
    }
    if (spec.preprocessor && char === '#' && s.atLineStart()) {
      const directive = s.match(/#\s*[A-Za-z_]\w*/y) ?? s.match(/#/y)!
      s.mark(start, T.meta)
      if (/include|import/.test(directive)) s.token(/\s*<[^>\n]*>/y, T.string)
      this.value = false
      return
    }
    if (spec.attributes && char === '#' && (s.peek(1) === '[' || (s.peek(1) === '!' && s.peek(2) === '['))) {
      this.attribute()
      return
    }
    if (spec.template && char === '`') {
      s.take(1, T.string)
      stack.push('`')
      return
    }
    if (spec.rawBacktick && char === '`') {
      s.take(1, T.string)
      stack.push('g')
      return
    }
    if (spec.tripleQuote && s.startsWith('"""')) {
      s.take(3, T.string)
      stack.push('"""')
      return
    }
    if (spec.verbatim && s.sees(/\$?@\$?"/y)) {
      s.match(/\$?@\$?"/y)
      s.mark(start, T.string)
      stack.push('v')
      return
    }
    if (spec.rawStrings && s.sees(/b?r#*"/y)) {
      const opening = s.match(/b?r#*"/y)!
      s.mark(start, T.string)
      stack.push(`r${opening.length - opening.indexOf('r') - 2}`)
      return
    }
    if (spec.lifetimes && char === "'" && s.sees(/'[\p{L}_][\p{L}\p{N}_]*(?!['\p{L}\p{N}_])/uy)) {
      s.token(/'[\p{L}_][\p{L}\p{N}_]*/uy, T.type)
      this.value = true
      return
    }
    if (c.quotes.includes(char)) {
      if (quoted(s, char)) stack.push(`q${char}`)
      this.value = true
      this.dot = false
      return
    }
    if ((char >= '0' && char <= '9') || (char === '.' && s.peek(1) >= '0' && s.peek(1) <= '9')) {
      s.token(NUMBER, T.number)
      this.value = true
      return
    }
    const word = s.match(IDENTIFIER)
    if (word !== null) {
      this.identifier(word, start)
      return
    }
    if (spec.annotations && char === '@' && s.sees(/@[\p{L}_]/uy)) {
      s.token(/@[\p{L}_][\p{L}\p{N}_.]*/uy, T.meta)
      this.value = false
      return
    }
    if (spec.regex && char === '/' && !this.value && s.token(REGEX, T.regexp)) {
      this.value = true
      return
    }
    if (spec.jsx && char === '<' && !this.value && s.sees(/<(?:[\p{L}_$]|>)/uy)) {
      this.openJsx()
      return
    }
    if (char === '{') {
      s.take(1, T.punct)
      if (stack.length) stack.push('{')
      this.value = false
      this.dot = false
      return
    }
    if (char === '}') {
      s.take(1, T.punct)
      if (top === '{' || top === '$' || top === 'j{') stack.pop()
      this.value = true
      this.dot = false
      return
    }
    if (char === '.' && !s.startsWith('...')) {
      s.take(1, T.punct)
      this.dot = true
      this.value = false
      return
    }
    if ('()[];,'.includes(char)) {
      s.take(1, T.punct)
      this.value = char === ')' || char === ']'
      this.dot = false
      return
    }
    if (s.startsWith('?.') && !/\d/.test(s.peek(2))) {
      s.take(2, T.operator)
      this.dot = true
      this.value = false
      return
    }
    if (s.token(OPERATOR, T.operator) || s.token(/\.\.\.?/y, T.operator)) {
      this.value = false
      this.dot = false
      return
    }
    s.take(1, T.plain)
  }

  private identifier(word: string, start: number): void {
    const { s, c } = this
    const afterDot = this.dot
    this.dot = false
    this.value = true
    const next = s.nextNonSpace()
    if (afterDot) {
      s.mark(start, next === '(' ? T.function : T.property)
      return
    }
    if (c.keywords.has(word) || (c.soft.has(word) && /^[\p{L}_$"'`{[*]/u.test(next))) {
      s.mark(start, T.keyword)
      this.value = VALUE_KEYWORDS.has(word)
      return
    }
    if (c.booleans.has(word)) {
      s.mark(start, T.bool)
      return
    }
    if (c.constants.has(word)) {
      s.mark(start, T.constant)
      return
    }
    if (c.spec.macros && s.peek() === '!' && s.peek(1) !== '=') {
      s.mark(start, T.function)
      s.pos++
      return
    }
    if (c.types.has(word)) {
      s.mark(start, T.type)
      return
    }
    if (next === '(') {
      s.mark(start, T.function)
      return
    }
    const first = word.charCodeAt(0)
    if (first >= 65 && first <= 90) {
      // ALL_CAPS reads as a constant, PascalCase as a type.
      s.mark(start, word.length > 1 && word === word.toUpperCase() ? T.constant : T.type)
      return
    }
    s.mark(start, T.variable)
  }

  private attribute(): void {
    const { s } = this
    const start = s.pos
    let depth = 0
    for (; !s.eol; s.pos++) {
      const char = s.peek()
      if (char === '[') depth++
      else if (char === ']' && --depth === 0) {
        s.pos++
        break
      }
    }
    s.mark(start, T.meta)
  }

  private openJsx(): void {
    const { s, stack } = this
    s.take(1, T.punct)
    if (s.peek() === '>') {
      s.take(1, T.punct)
      stack.push('j>')
      return
    }
    s.token(JSX_NAME, T.tag)
    stack.push('j<')
  }

  private jsxTag(): void {
    const { s, stack } = this
    const char = s.peek()
    if (char === ' ' || char === '\t') s.token(WHITESPACE, T.plain)
    else if (char === '/' && s.peek(1) === '>') {
      s.take(2, T.punct)
      stack.pop()
      this.value = true
    } else if (char === '>') {
      s.take(1, T.punct)
      stack[stack.length - 1] = 'j>'
    } else if (char === '{') {
      s.take(1, T.punct)
      stack.push('j{')
      this.value = false
    } else if (char === '"' || char === "'") quoted(s, char, false)
    else if (!s.token(JSX_ATTR, T.attr)) s.take(1, char === '=' ? T.operator : T.plain)
  }

  private jsxChildren(): void {
    const { s, stack } = this
    const char = s.peek()
    if (char === '{') {
      s.take(1, T.punct)
      stack.push('j{')
      this.value = false
      return
    }
    if (char === '<' && s.peek(1) === '/') {
      s.take(2, T.punct)
      s.token(JSX_NAME, T.tag)
      s.token(WHITESPACE, T.plain)
      if (s.peek() === '>') s.take(1, T.punct)
      stack.pop()
      this.value = true
      return
    }
    if (char === '<' && s.sees(/<(?:[\p{L}_$]|>)/uy)) {
      this.openJsx()
      return
    }
    if (char === '&' && s.token(/&(?:#\d+|#x[\da-fA-F]+|[a-zA-Z]\w*);/y, T.escape)) return
    if (!s.token(/[^{<&]+/y, T.plain)) s.take(1, T.plain)
  }
}

export function clike(spec: ClikeSpec): Tokenizer {
  const compiled: Compiled = {
    spec,
    keywords: words(spec.keywords),
    soft: words(spec.softKeywords ?? ''),
    types: words(spec.types ?? ''),
    constants: words(spec.constants ?? ''),
    booleans: words(spec.booleans ?? 'true false'),
    lineComment: spec.lineComment === undefined ? '//' : spec.lineComment,
    quotes: spec.quotes ?? `"'`,
  }
  return { start: '', line: (text, state) => new Run(compiled, text, state).run() }
}

const JS_KEYWORDS =
  'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield await enum implements interface package private protected public'
const JS_SOFT = 'as async from get of set static type declare abstract readonly namespace module keyof infer is satisfies accessor override out unique asserts using'

export const javascript = clike({
  keywords: JS_KEYWORDS,
  softKeywords: JS_SOFT,
  constants: 'null undefined NaN Infinity',
  types: 'string number boolean any unknown never object symbol bigint void',
  template: true,
  regex: true,
  jsx: true,
  annotations: true,
})

/** TypeScript without JSX, where `<T>` is a type argument. */
export const typescript = clike({
  keywords: JS_KEYWORDS,
  softKeywords: JS_SOFT,
  constants: 'null undefined NaN Infinity',
  types: 'string number boolean any unknown never object symbol bigint void',
  template: true,
  regex: true,
  annotations: true,
})

const C_KEYWORDS =
  'auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while _Alignas _Alignof _Atomic _Generic _Noreturn _Static_assert _Thread_local'
const C_TYPES =
  'char double float int long short signed unsigned void bool _Bool _Complex size_t ssize_t ptrdiff_t intptr_t uintptr_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t wchar_t FILE'

export const c = clike({ keywords: C_KEYWORDS, types: C_TYPES, constants: 'NULL', preprocessor: true })

export const cpp = clike({
  keywords: `${C_KEYWORDS} alignas alignof and and_eq asm catch class co_await co_return co_yield concept consteval constexpr constinit const_cast decltype delete dynamic_cast explicit export friend mutable namespace new noexcept not not_eq operator or or_eq private protected public reinterpret_cast requires static_assert static_cast template this thread_local throw try typeid typename using virtual xor xor_eq final override`,
  types: `${C_TYPES} char8_t char16_t char32_t auto string vector map set unique_ptr shared_ptr`,
  constants: 'nullptr NULL',
  preprocessor: true,
})

export const csharp = clike({
  keywords:
    'abstract as base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual volatile while async await yield record required init get set add remove partial where when with nameof not and or file scoped global',
  softKeywords: 'var value let from select orderby group into join on equals by ascending descending',
  types: 'bool byte char decimal double float int long object sbyte short string uint ulong ushort void nint nuint dynamic',
  constants: 'null',
  tripleQuote: true,
  verbatim: true,
  annotations: false,
  preprocessor: true,
})

export const java = clike({
  keywords:
    'abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record sealed permits yield',
  types: 'boolean byte char double float int long short void String Object',
  constants: 'null',
  tripleQuote: true,
  annotations: true,
})

export const kotlin = clike({
  keywords:
    'as break class continue do else for fun if in interface is object package return super this throw try typealias typeof val var when while by catch constructor finally import init where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg value',
  softKeywords: 'get set field it',
  types: 'Any Boolean Byte Char Double Float Int Long Nothing Short String Unit',
  constants: 'null',
  tripleQuote: true,
  nestedComments: true,
  annotations: true,
})

export const go = clike({
  keywords:
    'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  types:
    'bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any comparable',
  constants: 'nil iota',
  rawBacktick: true,
})

export const rust = clike({
  keywords:
    'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while yield union macro_rules',
  types: 'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str',
  constants: 'None',
  nestedComments: true,
  rawStrings: true,
  attributes: true,
  macros: true,
  lifetimes: true,
})

export const swift = clike({
  keywords:
    'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while as is super self Self throws try async await actor some any convenience dynamic final indirect lazy mutating nonmutating optional override required unowned weak willSet didSet get set',
  types: 'Int Double Float String Bool Character Array Dictionary Set Optional Any AnyObject Void',
  constants: 'nil',
  quotes: '"',
  tripleQuote: true,
  nestedComments: true,
  annotations: true,
})

/**
 * A small, dependency-free syntax tokenizer used by eNCode's hand-built editor.
 * Every tokenizer must preserve the source exactly: concatenating token values
 * must reproduce the input string byte for byte.
 */

export type TokenType =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'type'
  | 'function'
  | 'punct'
  | 'operator'
  | 'tag'
  | 'attr'
  | 'value'
  | 'key'
  | 'bool'
  | 'heading'
  | 'emphasis'
  | 'variable'
  | 'link'
  | 'meta'

export interface Token {
  type: TokenType
  value: string
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const NUMBER_RE = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/
const IDENT_RE = /^[A-Za-z_$][\w$]*/
const OPERATOR_RE = /^(?:=>|===|!==|==|!=|<=|>=|\+\+|--|\+=|-=|\*=|\/=|&&|\|\||\?\?|\.\.\.|[+\-*/%=<>!&|^~?:])/
const PUNCT_RE = /[{}()[\];,.]/

interface StringSpec {
  open: string
  close: string
  multiline?: boolean
  escape?: boolean
}

interface CodeProfile {
  lineComments: string[]
  blockComments?: [string, string]
  strings: StringSpec[]
  keywords: Set<string>
  literals?: Set<string>
  types?: Set<string>
  decorators?: boolean
  hexColors?: boolean
  atRules?: boolean
  caseInsensitive?: boolean
}

const JS_KEYWORDS = new Set(
  `const let var function return if else for while do switch case default break continue new class extends super this import export from as async await try catch finally throw typeof instanceof in of delete void yield static get set interface type enum implements private public protected readonly declare namespace abstract keyof infer is satisfies`.split(
    ' ',
  ),
)
const JS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])
const JS_TYPES = new Set(
  `Array Promise Record Partial Pick Omit Readonly Map Set WeakMap WeakSet Date RegExp Error Object String Number Boolean BigInt Symbol JSON Math console window document process require module exports Buffer`.split(
    ' ',
  ),
)

const PYTHON_KEYWORDS = new Set(
  `def class return if elif else for while in not and or is lambda import from as with try except finally raise pass break continue global nonlocal yield assert del async await match case`.split(
    ' ',
  ),
)
const PYTHON_LITERALS = new Set(['True', 'False', 'None'])

const SHELL_KEYWORDS = new Set(
  `if then else elif fi for while until do done case esac function in select time coproc local export return echo cd exit set unset read source alias`.split(
    ' ',
  ),
)

const PWSH_KEYWORDS = new Set(
  `function param if elseif else foreach for while do switch try catch finally throw return break continue begin process end filter class enum`.split(
    ' ',
  ),
)

const SQL_KEYWORDS = new Set(
  `select from where insert into values update set delete create table drop alter add index join left right inner outer full on group by order limit offset as and or not null is like between distinct union all having primary key foreign references default varchar int integer bigint text boolean date timestamp case when then else end`.split(
    ' ',
  ),
)

const YAML_LITERALS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off'])

const JS_PROFILE: CodeProfile = {
  lineComments: ['//'],
  blockComments: ['/*', '*/'],
  strings: [
    { open: '`', close: '`', multiline: true, escape: true },
    { open: '"', close: '"', escape: true },
    { open: "'", close: "'", escape: true },
  ],
  keywords: JS_KEYWORDS,
  literals: JS_LITERALS,
  types: JS_TYPES,
}

const JSON_PROFILE: CodeProfile = {
  lineComments: ['//'],
  blockComments: ['/*', '*/'],
  strings: [{ open: '"', close: '"', escape: true }],
  keywords: new Set(),
  literals: JS_LITERALS,
}

const CSS_PROFILE: CodeProfile = {
  lineComments: [],
  blockComments: ['/*', '*/'],
  strings: [
    { open: '"', close: '"', escape: true },
    { open: "'", close: "'", escape: true },
  ],
  keywords: new Set(),
  hexColors: true,
  atRules: true,
}

const PYTHON_PROFILE: CodeProfile = {
  lineComments: ['#'],
  strings: [
    { open: '"""', close: '"""', multiline: true, escape: true },
    { open: "'''", close: "'''", multiline: true, escape: true },
    { open: '"', close: '"', escape: true },
    { open: "'", close: "'", escape: true },
  ],
  keywords: PYTHON_KEYWORDS,
  literals: PYTHON_LITERALS,
  types: new Set(['self', 'cls']),
  decorators: true,
}

const SHELL_PROFILE: CodeProfile = {
  lineComments: ['#'],
  strings: [
    { open: '"', close: '"', multiline: true, escape: true },
    { open: "'", close: "'", multiline: true },
  ],
  keywords: SHELL_KEYWORDS,
  literals: new Set(['true', 'false']),
}

const PWSH_PROFILE: CodeProfile = {
  lineComments: ['#'],
  blockComments: ['<#', '#>'],
  strings: [
    { open: '"', close: '"', multiline: true, escape: true },
    { open: "'", close: "'", multiline: true },
  ],
  keywords: PWSH_KEYWORDS,
  literals: new Set(['$true', '$false', '$null']),
}

const SQL_PROFILE: CodeProfile = {
  lineComments: ['--'],
  blockComments: ['/*', '*/'],
  strings: [{ open: "'", close: "'", escape: true }],
  keywords: SQL_KEYWORDS,
  caseInsensitive: true,
}

const YAML_PROFILE: CodeProfile = {
  lineComments: ['#'],
  strings: [
    { open: '"', close: '"', escape: true },
    { open: "'", close: "'" },
  ],
  keywords: new Set(),
  literals: YAML_LITERALS,
}

function pushToken(tokens: Token[], type: TokenType, value: string): void {
  if (!value) return
  const last = tokens[tokens.length - 1]
  if (last && last.type === type && type === 'plain') {
    last.value += value
    return
  }
  tokens.push({ type, value })
}

function tokenizeCode(source: string, profile: CodeProfile): Token[] {
  const tokens: Token[] = []
  let index = 0

  while (index < source.length) {
    const rest = source.slice(index)

    // Whitespace (including newlines) stays plain.
    if (/\s/.test(source[index])) {
      let end = index + 1
      while (end < source.length && /\s/.test(source[end])) end++
      pushToken(tokens, 'plain', source.slice(index, end))
      index = end
      continue
    }

    const lineComment = profile.lineComments.find((marker) => source.startsWith(marker, index))
    if (lineComment) {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      pushToken(tokens, 'comment', source.slice(index, stop))
      index = stop
      continue
    }

    if (profile.blockComments && source.startsWith(profile.blockComments[0], index)) {
      const closeIndex = source.indexOf(profile.blockComments[1], index + profile.blockComments[0].length)
      const stop = closeIndex === -1 ? source.length : closeIndex + profile.blockComments[1].length
      pushToken(tokens, 'comment', source.slice(index, stop))
      index = stop
      continue
    }

    if (profile.atRules && source[index] === '@') {
      const match = /^@[A-Za-z-]+/.exec(rest)
      if (match) {
        pushToken(tokens, 'keyword', match[0])
        index += match[0].length
        continue
      }
    }

    if (profile.hexColors && source[index] === '#') {
      const match = /^#[0-9a-fA-F]{3,8}\b/.exec(rest)
      if (match) {
        pushToken(tokens, 'number', match[0])
        index += match[0].length
        continue
      }
    }

    const stringSpec = profile.strings.find((spec) => source.startsWith(spec.open, index))
    if (stringSpec) {
      const start = index
      index += stringSpec.open.length
      while (index < source.length) {
        if (stringSpec.escape && source[index] === '\\') {
          index += 2
          continue
        }
        if (source.startsWith(stringSpec.close, index)) {
          index += stringSpec.close.length
          break
        }
        if (!stringSpec.multiline && source[index] === '\n') break
        index++
      }
      pushToken(tokens, 'string', source.slice(start, index))
      continue
    }

    if (profile.decorators && source[index] === '@') {
      const match = /^@[A-Za-z_][\w.]*/.exec(rest)
      if (match) {
        pushToken(tokens, 'meta', match[0])
        index += match[0].length
        continue
      }
    }

    const numberMatch = NUMBER_RE.exec(rest)
    if (numberMatch && /\d/.test(source[index])) {
      pushToken(tokens, 'number', numberMatch[0])
      index += numberMatch[0].length
      continue
    }

    const identMatch = IDENT_RE.exec(rest)
    if (identMatch) {
      const word = identMatch[0]
      let type: TokenType = 'plain'
      const keyword = profile.caseInsensitive ? word.toLowerCase() : word
      if (profile.keywords.has(keyword)) type = 'keyword'
      else if (profile.literals?.has(word)) type = 'bool'
      else if (profile.types?.has(word)) type = 'type'
      else if (/^[A-Z]/.test(word) && word.length > 1) type = 'type'
      else if (/^\s*\(/.test(source.slice(index + word.length))) type = 'function'
      pushToken(tokens, type, word)
      index += word.length
      continue
    }

    const operatorMatch = OPERATOR_RE.exec(rest)
    if (operatorMatch) {
      pushToken(tokens, 'operator', operatorMatch[0])
      index += operatorMatch[0].length
      continue
    }

    if (PUNCT_RE.test(source[index])) {
      pushToken(tokens, 'punct', source[index])
      index++
      continue
    }

    if (source[index] === '$') {
      const variable = /^\$[A-Za-z_][\w]*|^\$\{[^}]*\}/.exec(rest)
      if (variable) {
        pushToken(tokens, 'variable', variable[0])
        index += variable[0].length
        continue
      }
    }

    pushToken(tokens, 'plain', source[index])
    index++
  }

  return tokens
}

/** Mark identifier/string tokens directly followed by ":" as object keys. */
function markKeys(tokens: Token[]): Token[] {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!['plain', 'type', 'function', 'string'].includes(token.type)) continue
    let cursor = index + 1
    while (cursor < tokens.length && tokens[cursor].type === 'plain' && tokens[cursor].value.trim() === '') cursor++
    if (cursor < tokens.length && tokens[cursor].type === 'punct' && tokens[cursor].value === ':') {
      token.type = 'key'
    }
  }
  return tokens
}

function tokenizeHtml(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0

  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4)
      const stop = end === -1 ? source.length : end + 3
      pushToken(tokens, 'comment', source.slice(index, stop))
      index = stop
      continue
    }

    if (source[index] === '<') {
      if (/^<!doctype/i.test(source.slice(index))) {
        const end = source.indexOf('>', index)
        const stop = end === -1 ? source.length : end + 1
        pushToken(tokens, 'meta', source.slice(index, stop))
        index = stop
        continue
      }

      const tagMatch = /^<\/?[A-Za-z][\w:-]*/.exec(source.slice(index))
      if (tagMatch) {
        const raw = tagMatch[0]
        if (raw.startsWith('</')) pushToken(tokens, 'punct', '</')
        else pushToken(tokens, 'punct', '<')
        pushToken(tokens, 'tag', raw.replace(/^<\/?/, ''))
        index += raw.length

        while (index < source.length) {
          const char = source[index]
          if (char === '>') {
            pushToken(tokens, 'punct', '>')
            index++
            break
          }
          if (char === '/' && source[index + 1] === '>') {
            pushToken(tokens, 'punct', '/>')
            index += 2
            break
          }
          if (/\s/.test(char)) {
            let end = index + 1
            while (end < source.length && /\s/.test(source[end])) end++
            pushToken(tokens, 'plain', source.slice(index, end))
            index = end
            continue
          }
          if (char === '=') {
            pushToken(tokens, 'operator', '=')
            index++
            continue
          }
          const quoted = /^"[^"]*"|^'[^']*'/.exec(source.slice(index))
          if (quoted) {
            pushToken(tokens, 'value', quoted[0])
            index += quoted[0].length
            continue
          }
          const attribute = /^[^\s=>/]+/.exec(source.slice(index))
          if (attribute) {
            pushToken(tokens, 'attr', attribute[0])
            index += attribute[0].length
            continue
          }
          pushToken(tokens, 'plain', char)
          index++
        }
        continue
      }

      const nextTag = source.indexOf('<', index + 1)
      const stop = nextTag === -1 ? source.length : nextTag
      pushToken(tokens, 'plain', source.slice(index, stop))
      index = stop
      continue
    }

    const next = source.indexOf('<', index)
    const stop = next === -1 ? source.length : next
    pushToken(tokens, 'plain', source.slice(index, stop))
    index = stop
  }

  return tokens
}

function pushInline(tokens: Token[], text: string): void {
  if (!text) return
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]*\]\([^)\n]*\))/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) pushToken(tokens, 'plain', text.slice(cursor, match.index))
    if (match[1]) pushToken(tokens, 'string', match[1])
    else if (match[2]) pushToken(tokens, 'emphasis', match[2])
    else if (match[3]) pushToken(tokens, 'emphasis', match[3])
    else if (match[4]) pushToken(tokens, 'link', match[4])
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) pushToken(tokens, 'plain', text.slice(cursor))
}

function tokenizeMarkdown(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  let inFence = false

  while (index < source.length) {
    const newline = source.indexOf('\n', index)
    const stop = newline === -1 ? source.length : newline
    const line = source.slice(index, stop)

    if (/^\s*```/.test(line)) {
      pushToken(tokens, 'meta', line)
      inFence = !inFence
    } else if (inFence) {
      pushToken(tokens, 'string', line)
    } else {
      const heading = /^(#{1,6})(\s+)(.*)$/.exec(line)
      const quote = /^(\s*>+\s?)(.*)$/.exec(line)
      const list = /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/.exec(line)
      if (heading) {
        pushToken(tokens, 'meta', heading[1])
        pushToken(tokens, 'plain', heading[2])
        pushToken(tokens, 'heading', heading[3])
      } else if (quote) {
        pushToken(tokens, 'comment', quote[1])
        pushInline(tokens, quote[2])
      } else if (list) {
        pushToken(tokens, 'plain', list[1])
        pushToken(tokens, 'punct', list[2])
        pushToken(tokens, 'plain', list[3])
        pushInline(tokens, list[4])
      } else {
        pushInline(tokens, line)
      }
    }

    if (stop < source.length) {
      pushToken(tokens, 'plain', '\n')
      index = stop + 1
    } else {
      index = stop
    }
  }

  return tokens
}

export function tokenize(source: string, language: string): Token[] {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return tokenizeCode(source, JS_PROFILE)
    case 'json':
      return markKeys(tokenizeCode(source, JSON_PROFILE))
    case 'css':
    case 'scss':
    case 'less':
      return markKeys(tokenizeCode(source, CSS_PROFILE))
    case 'html':
    case 'xml':
      return tokenizeHtml(source)
    case 'markdown':
      return tokenizeMarkdown(source)
    case 'python':
      return tokenizeCode(source, PYTHON_PROFILE)
    case 'shell':
    case 'bat':
      return tokenizeCode(source, SHELL_PROFILE)
    case 'powershell':
      return tokenizeCode(source, PWSH_PROFILE)
    case 'yaml':
      return markKeys(tokenizeCode(source, YAML_PROFILE))
    case 'sql':
      return tokenizeCode(source, SQL_PROFILE)
    default:
      return [{ type: 'plain', value: source }]
  }
}

export function renderTokens(tokens: Token[]): string {
  let html = ''
  for (const token of tokens) {
    const escaped = escapeHtml(token.value)
    html += token.type === 'plain' ? escaped : `<span class="tok-${token.type}">${escaped}</span>`
  }
  return html
}

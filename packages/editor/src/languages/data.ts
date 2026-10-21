import { T, type Tokenizer } from '../language'
import { Scanner, WHITESPACE, quoted, quotedBody, words } from './scan'
import { shell } from './shell'

// ---------------------------------------------------------------- JSON (with comments, as in tsconfig.json)

const JSON_STRING = /"(?:[^"\\]|\\.)*"?/y
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y

/** A double-quoted string as a key (followed by `:`) or a value with escapes. */
function jsonString(s: Scanner): void {
  const start = s.pos
  JSON_STRING.lastIndex = start
  const end = start + JSON_STRING.exec(s.text)![0].length
  let after = end
  while (s.text[after] === ' ' || s.text[after] === '\t') after++
  if (s.text[after] === ':') {
    s.mark(start, T.key)
    s.pos = end
    return
  }
  s.take(1, T.string)
  quotedBody(s, '"')
}

/** State: "" or `c` inside a block comment. */
export const json: Tokenizer = {
  start: '',
  line(text, state) {
    const s = new Scanner(text)
    let comment = state === 'c'
    while (!s.eol) {
      if (comment) {
        const end = text.indexOf('*/', s.pos)
        s.mark(s.pos, T.comment)
        s.pos = end < 0 ? text.length : end + 2
        if (end >= 0) comment = false
        continue
      }
      const char = s.peek()
      if (char === ' ' || char === '\t') s.token(WHITESPACE, T.plain)
      else if (char === '"') jsonString(s)
      else if (char === '-' || (char >= '0' && char <= '9')) {
        if (!s.token(JSON_NUMBER, T.number)) s.take(1, T.plain)
      } else if (s.startsWith('//')) s.rest(T.comment)
      else if (s.startsWith('/*')) {
        s.take(2, T.comment)
        comment = true
      } else if (s.token(/true|false/y, T.bool) || s.token(/null/y, T.constant)) continue
      else if ('{}[],:'.includes(char)) s.take(1, T.punct)
      else if (!s.token(/[A-Za-z_$][\w$]*/y, T.plain)) s.take(1, T.plain)
    }
    return { tokens: s.tokens(), state: comment ? 'c' : '' }
  },
}

// ---------------------------------------------------------------- YAML

const YAML_KEY = /(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{}[\],:&*!|>%@`-](?:[^:#{}[\],]|:(?!\s|$)|#(?<!\s#))*?|-(?!\s)(?:[^:#{}[\],]|:(?!\s|$))*?)[ \t]*:(?=\s|$)/y
const YAML_NUMBER = /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$|^0x[\da-fA-F_]+$|^0o[0-7_]+$|^[-+]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/
const YAML_DATE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s*(?:Z|[-+]\d{1,2}(?::?\d{2})?)?)?$/
const YAML_BOOL = words('true false True False TRUE FALSE yes no Yes No YES NO on off On Off ON OFF')
const YAML_NULL = words('null Null NULL ~')

function yamlScalar(s: Scanner, flow: number): void {
  const start = s.pos
  const stop = flow > 0 ? /[ \t]+#|[,\]}]|:(?=[\s,\]}])/g : /[ \t]+#/g
  stop.lastIndex = s.pos
  const found = stop.exec(s.text)
  const end = found ? found.index : s.text.length
  const value = s.text.slice(start, end).trimEnd()
  const kind = YAML_BOOL.has(value)
    ? T.bool
    : YAML_NULL.has(value)
      ? T.constant
      : YAML_NUMBER.test(value) || YAML_DATE.test(value)
        ? T.number
        : T.string
  s.mark(start, kind)
  s.pos = start + Math.max(1, value.length)
}

/**
 * YAML. State: "" or `b<column>` inside a block scalar (`|` or `>`), whose
 * lines are those indented past the column of the key that opened it.
 */
export const yaml: Tokenizer = {
  start: '',
  line(text, state) {
    const s = new Scanner(text)
    const indent = text.length - text.trimStart().length
    if (state) {
      const column = Number(state.slice(1))
      if (!text.trim() || indent > column) {
        s.rest(T.string)
        return { tokens: s.tokens(), state }
      }
    }
    let next = ''
    let flow = 0
    let keyColumn = indent
    let keyAllowed = true
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(text) || text.startsWith('%')) {
      const marker = text.startsWith('%') ? text.length : 3
      s.take(marker, T.meta)
      keyAllowed = false
    }
    while (!s.eol) {
      const char = s.peek()
      if (char === ' ' || char === '\t') {
        s.token(WHITESPACE, T.plain)
        continue
      }
      if (char === '#' && (s.pos === 0 || /\s/.test(text[s.pos - 1]))) {
        s.rest(T.comment)
        break
      }
      if ((char === '-' || char === '?') && /\s|^$/.test(s.peek(1) || '') && keyAllowed) {
        s.take(1, T.punct)
        keyColumn = s.pos + 1
        continue
      }
      if (keyAllowed && s.sees(YAML_KEY)) {
        const start = s.pos
        keyColumn = start
        YAML_KEY.lastIndex = start
        const key = YAML_KEY.exec(text)![0]
        const colon = start + key.lastIndexOf(':')
        s.mark(start, T.key)
        s.pos = colon
        s.take(1, T.punct)
        keyAllowed = flow > 0
        continue
      }
      keyAllowed = false
      if (char === '&' || char === '*') {
        if (!s.token(/[&*][^\s,[\]{}]+/y, T.variable)) s.take(1, T.plain)
      } else if (char === '!') s.token(/![^\s,[\]{}]*/y, T.type)
      else if (char === '"' || char === "'") {
        if (char === '"') quoted(s, '"')
        else {
          s.take(1, T.string)
          while (!s.eol) {
            if (s.startsWith("''")) s.take(2, T.escape)
            else if (s.peek() === "'") {
              s.take(1, T.string)
              break
            } else if (!s.token(/[^']+/y, T.string)) s.take(1, T.string)
          }
        }
      } else if ((char === '|' || char === '>') && flow === 0 && s.sees(/[|>][-+0-9]*[ \t]*(?:#.*)?$/y)) {
        s.token(/[|>][-+0-9]*/y, T.operator)
        next = `b${keyColumn}`
      } else if (char === '{' || char === '[') {
        s.take(1, T.punct)
        flow++
        keyAllowed = true
      } else if (char === '}' || char === ']') {
        s.take(1, T.punct)
        flow = Math.max(0, flow - 1)
      } else if (char === ',') {
        s.take(1, T.punct)
        keyAllowed = flow > 0
      } else yamlScalar(s, flow)
    }
    return { tokens: s.tokens(), state: next }
  },
}

// ---------------------------------------------------------------- TOML

const TOML_KEY = /(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:[ \t]*\.[ \t]*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*[ \t]*=/y
const TOML_DATE = /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?(?:[Zz]|[-+]\d{2}:\d{2})?|\d{2}:\d{2}:\d{2}(?:\.\d+)?/y
const TOML_NUMBER = /[-+]?(?:0x[\da-fA-F_]+|0o[0-7_]+|0b[01_]+|inf|nan|(?:\d[\d_]*)(?:\.[\d_]+)?(?:[eE][-+]?\d[\d_]*)?)/y

/** TOML. State: "" or an open multi-line string (`"""` or `'''`). */
export const toml: Tokenizer = {
  start: '',
  line(text, state) {
    const s = new Scanner(text)
    let open = state
    if (open) {
      const end = text.indexOf(open)
      s.mark(0, T.string)
      if (end < 0) {
        s.pos = text.length
        return { tokens: s.tokens(), state: open }
      }
      s.pos = end + 3
      open = ''
    }
    s.token(WHITESPACE, T.plain)
    if (s.peek() === '[') {
      s.token(/\[\[?[^\]#]*\]\]?/y, T.heading)
    }
    let keyAllowed = true
    while (!s.eol) {
      const char = s.peek()
      if (char === ' ' || char === '\t') {
        s.token(WHITESPACE, T.plain)
        continue
      }
      if (char === '#') {
        s.rest(T.comment)
        break
      }
      if (keyAllowed && s.sees(TOML_KEY)) {
        const start = s.pos
        TOML_KEY.lastIndex = start
        const key = TOML_KEY.exec(text)![0]
        s.mark(start, T.key)
        s.pos = start + key.length - 1
        s.take(1, T.operator)
        keyAllowed = false
        continue
      }
      keyAllowed = false
      if (s.startsWith('"""') || s.startsWith("'''")) {
        const quote = text.slice(s.pos, s.pos + 3)
        const end = text.indexOf(quote, s.pos + 3)
        s.mark(s.pos, T.string)
        if (end < 0) {
          s.pos = text.length
          open = quote
        } else s.pos = end + 3
      } else if (char === '"') quoted(s, '"')
      else if (char === "'") {
        const end = text.indexOf("'", s.pos + 1)
        s.mark(s.pos, T.string)
        s.pos = end < 0 ? text.length : end + 1
      } else if (s.token(/true|false/y, T.bool)) continue
      else if (s.token(TOML_DATE, T.number) || s.token(TOML_NUMBER, T.number)) continue
      else if (char === '{' || char === ',') {
        s.take(1, T.punct)
        keyAllowed = true
      } else if ('}[]'.includes(char)) s.take(1, T.punct)
      else s.take(1, T.plain)
    }
    return { tokens: s.tokens(), state: open }
  },
}

// ---------------------------------------------------------------- INI, properties and .env files

/** Line-based `key = value` files: INI, .properties, .env, .editorconfig, .gitconfig. */
export const ini: Tokenizer = {
  start: '',
  line(text) {
    const s = new Scanner(text)
    s.token(WHITESPACE, T.plain)
    const char = s.peek()
    if (char === ';' || char === '#' || char === '!') {
      s.rest(T.comment)
      return { tokens: s.tokens(), state: '' }
    }
    if (char === '[') {
      s.rest(T.heading)
      return { tokens: s.tokens(), state: '' }
    }
    if (s.token(/export(?=\s)/y, T.keyword)) s.token(WHITESPACE, T.plain)
    if (s.sees(/[^=:\s][^=:]*?\s*[=:]/y)) {
      s.token(/[^=:\s][^=:]*?(?=\s*[=:])/y, T.key)
      s.token(WHITESPACE, T.plain)
      s.take(1, T.operator)
      s.token(WHITESPACE, T.plain)
      if (s.sees(/(?:true|false|yes|no|on|off)\s*$/iy)) s.rest(T.bool)
      else if (s.sees(/-?\d+(?:\.\d+)?\s*$/y)) s.rest(T.number)
    }
    while (!s.eol) {
      const char = s.peek()
      if (char === '"' || char === "'") quoted(s, char, char === '"')
      else if (char === '$' && s.sees(/\$\{[^}]*\}|\$[A-Za-z_]\w*/y)) s.token(/\$\{[^}]*\}|\$[A-Za-z_]\w*/y, T.variable)
      else if (char === ' ' && s.peek(1) === '#') s.rest(T.comment)
      else if (!s.token(/[^"'$ ]+| /y, T.string)) s.take(1, T.string)
    }
    return { tokens: s.tokens(), state: '' }
  },
}

// ---------------------------------------------------------------- SQL

const SQL_KEYWORDS = words(
  'add all alter and any as asc authorization backup begin between break by cascade case check checkpoint close clustered coalesce collate column commit compute constraint contains continue convert create cross current current_date current_time current_timestamp current_user cursor database deallocate declare default delete deny desc distinct distributed do drop dump else end errlvl escape except exec execute exists exit external fetch file fillfactor for foreign from full function goto grant group having holdlock identity if in index inner insert intersect into is join key kill left like limit lineno load merge national natural nocheck nonclustered not nullif of off offset offsets on open option or order outer over percent pivot plan primary print proc procedure public raiserror read readtext reconfigure references replace replication restore restrict return returning returns revert revoke right rollback rowcount rule save schema select session_user set setuser shutdown some statistics system_user table tablesample then to top tran transaction trigger truncate try_convert tsequal union unique unpivot update updatetext use user using values varying view waitfor when where while with within writetext window partition rows range unbounded preceding following recursive lateral ilike similar returning conflict nothing do instead language plpgsql security definer immutable stable volatile engine charset auto_increment unsigned zerofill if not exists temporary temp materialized sequence trigger before after each row execute procedure',
)
const SQL_TYPES = words(
  'int integer bigint smallint tinyint mediumint decimal numeric float real double precision money smallmoney bit boolean bool char varchar nchar nvarchar text ntext tinytext mediumtext longtext binary varbinary image blob longblob date time datetime datetime2 datetimeoffset smalldatetime timestamp timestamptz interval year json jsonb uuid uniqueidentifier xml serial bigserial smallserial bytea inet cidr macaddr point enum array',
)

/** SQL across the common dialects (MySQL and MariaDB, PostgreSQL, SQLite, T-SQL). State: `c` comment, `'` string, `$tag$` dollar quote. */
export const sql: Tokenizer = {
  start: '',
  line(text, state) {
    const s = new Scanner(text)
    let open = state
    while (!s.eol) {
      if (open === 'c') {
        const end = text.indexOf('*/', s.pos)
        s.mark(s.pos, T.comment)
        s.pos = end < 0 ? text.length : end + 2
        if (end >= 0) open = ''
        continue
      }
      if (open === "'") {
        while (!s.eol) {
          if (s.startsWith("''")) s.take(2, T.escape)
          else if (s.peek() === "'") {
            s.take(1, T.string)
            open = ''
            break
          } else if (!s.token(/[^']+/y, T.string)) s.take(1, T.string)
        }
        continue
      }
      if (open[0] === '$') {
        const end = text.indexOf(open, s.pos)
        s.mark(s.pos, T.string)
        s.pos = end < 0 ? text.length : end + open.length
        if (end >= 0) open = ''
        continue
      }
      const start = s.pos
      const char = s.peek()
      if (char === ' ' || char === '\t') s.token(WHITESPACE, T.plain)
      else if (s.startsWith('--') || (char === '#' && s.atLineStart())) s.rest(T.comment)
      else if (s.startsWith('/*')) {
        s.take(2, T.comment)
        open = 'c'
      } else if (char === "'" || ((char === 'E' || char === 'e' || char === 'N') && s.peek(1) === "'")) {
        s.take(char === "'" ? 1 : 2, T.string)
        open = "'"
      } else if (char === '$' && s.sees(/\$[A-Za-z_]*\$/y)) {
        const tag = s.match(/\$[A-Za-z_]*\$/y)!
        s.mark(start, T.string)
        open = tag
      } else if (char === '"' || char === '`' || char === '[') {
        const close = char === '[' ? ']' : char
        const end = text.indexOf(close, s.pos + 1)
        if (char === '[' && end < 0) s.take(1, T.punct)
        else {
          s.mark(start, T.variable)
          s.pos = end < 0 ? text.length : end + 1
        }
      } else if ((char >= '0' && char <= '9') || (char === '.' && /\d/.test(s.peek(1)))) s.token(/0x[\da-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y, T.number)
      else if ((char === '@' || char === ':' || char === '$') && s.sees(/(?:@@?|:|\$)[A-Za-z_\d][\w]*/y)) s.token(/(?:@@?|:|\$)[A-Za-z_\d][\w]*/y, T.variable)
      else {
        const word = s.match(/[A-Za-z_][\w$]*/y)
        if (word !== null) {
          const lower = word.toLowerCase()
          const next = s.nextNonSpace()
          const afterDot = text[start - 1] === '.'
          let kind: number
          if (afterDot) kind = T.property
          else if (lower === 'null') kind = T.constant
          else if (lower === 'true' || lower === 'false') kind = T.bool
          else if (SQL_TYPES.has(lower)) kind = T.type
          else if (next === '(' && !SQL_KEYWORDS.has(lower)) kind = T.function
          else if (SQL_KEYWORDS.has(lower)) kind = T.keyword
          else kind = T.variable
          s.mark(start, kind)
        } else if ('(),;.'.includes(char)) s.take(1, T.punct)
        else if (!s.token(/[<>=!]=?|<>|\|\||::|->>?|[-+*/%&|^~?]/y, T.operator)) s.take(1, T.plain)
      }
    }
    return { tokens: s.tokens(), state: open }
  },
}

// ---------------------------------------------------------------- Diff and patch files

export const diff: Tokenizer = {
  start: '',
  line(text) {
    const s = new Scanner(text)
    if (/^(?:diff |index |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(text)) s.rest(T.heading)
    else if (text.startsWith('+++') || text.startsWith('---')) s.rest(T.meta)
    else if (text.startsWith('@@')) {
      const end = text.indexOf('@@', 2)
      s.mark(0, T.meta)
      s.pos = end < 0 ? text.length : end + 2
      s.rest(T.function)
    } else if (text[0] === '+' || text[0] === '>') s.rest(T.inserted)
    else if (text[0] === '-' || text[0] === '<') s.rest(T.deleted)
    else if (text[0] === '\\') s.rest(T.comment)
    else s.rest(T.plain)
    return { tokens: s.tokens(), state: '' }
  },
}

// ---------------------------------------------------------------- Dockerfile

const DOCKER_INSTRUCTIONS = words(
  'FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL',
)

/** Dockerfiles. State: `c` on a line continued from the one above (no instruction at its start). */
export const dockerfile: Tokenizer = {
  start: '',
  line(text, state) {
    const s = new Scanner(text)
    s.token(WHITESPACE, T.plain)
    if (s.peek() === '#') {
      s.rest(/^#\s*(?:syntax|escape|check)\s*=/.test(text) ? T.meta : T.comment)
      return { tokens: s.tokens(), state }
    }
    if (state !== 'c') {
      const start = s.pos
      const word = s.match(/[A-Za-z]+/y)
      if (word !== null) s.mark(start, DOCKER_INSTRUCTIONS.has(word.toUpperCase()) ? T.keyword : T.plain)
    }
    while (!s.eol) {
      const char = s.peek()
      if (char === ' ' || char === '\t') s.token(WHITESPACE, T.plain)
      else if (char === '\\' && s.pos === text.trimEnd().length - 1) s.take(1, T.escape)
      else if (char === '"' || char === "'") quoted(s, char)
      else if (char === '$' && s.sees(/\$\{[^}]*\}|\$[A-Za-z_]\w*/y)) s.token(/\$\{[^}]*\}|\$[A-Za-z_]\w*/y, T.variable)
      else if (char === '-' && s.sees(/--[\w-]+/y)) s.token(/--[\w-]+/y, T.attr)
      else if (s.token(/\b(?:AS|as)\b(?=\s)/y, T.keyword)) continue
      else if ('[],='.includes(char)) s.take(1, T.punct)
      else if (!s.token(/[^\s"'$\\[\],=-]+/y, T.plain)) s.take(1, T.plain)
    }
    return { tokens: s.tokens(), state: /\\\s*$/.test(text) ? 'c' : '' }
  },
}

// ---------------------------------------------------------------- Makefile

const MAKE_DIRECTIVES = words('include -include sinclude define endef ifdef ifndef ifeq ifneq else endif export unexport override vpath private undefine')
const MAKE_FUNCTIONS = words(
  'subst patsubst strip findstring filter filter-out sort word wordlist words firstword lastword dir notdir suffix basename addsuffix addprefix join wildcard realpath abspath error warning info shell origin flavor foreach if or and call eval file value',
)

function makeReference(s: Scanner): boolean {
  const start = s.pos
  if (s.match(/\$[@<^+?*%|$]/y) !== null) {
    s.mark(start, T.variable)
    return true
  }
  if (!s.startsWith('$(') && !s.startsWith('${')) return false
  const close = s.peek(1) === '(' ? ')' : '}'
  s.take(2, T.punct)
  const name = s.match(/[\w.-]+/y)
  if (name !== null) s.mark(s.pos - name.length, MAKE_FUNCTIONS.has(name) && s.peek() === ' ' ? T.function : T.variable)
  let depth = 1
  while (!s.eol && depth > 0) {
    const char = s.peek()
    if (char === '$' && makeReference(s)) continue
    if (char === s.text[start + 1]) depth++
    if (char === close && --depth === 0) {
      s.take(1, T.punct)
      return true
    }
    s.take(1, T.plain)
  }
  return true
}

/** GNU make. Recipe lines (starting with a tab) are shell. State: `c` on a continued line. */
export const makefile: Tokenizer = {
  start: '',
  line(text, state) {
    const s = new Scanner(text)
    const continued = /\\$/.test(text) ? 'c' : ''
    if (text.startsWith('\t')) {
      return { tokens: shell.line(text, '').tokens, state: continued }
    }
    s.token(WHITESPACE, T.plain)
    if (s.peek() === '#') {
      s.rest(T.comment)
      return { tokens: s.tokens(), state: continued }
    }
    if (state !== 'c') {
      const start = s.pos
      const word = s.match(/-?[\w.-]+/y)
      if (word !== null && MAKE_DIRECTIVES.has(word)) s.mark(start, T.keyword)
      else if (word !== null && s.sees(/\s*(?::{1,3}=|\?=|\+=|!=|=)/y)) {
        s.mark(start, T.variable)
        s.token(WHITESPACE, T.plain)
        s.token(/:{1,3}=|\?=|\+=|!=|=/y, T.operator)
      } else if (/^[^:#=\s][^:#=]*?::?(?!=)/.test(text.slice(start))) {
        s.pos = start
        s.token(/[^:#=]+?(?=\s*::?(?!=))/y, T.function)
        s.token(WHITESPACE, T.plain)
        s.token(/::?/y, T.operator)
      } else s.pos = start
    }
    while (!s.eol) {
      const char = s.peek()
      if (char === '#') s.rest(T.comment)
      else if (char === '$' && makeReference(s)) continue
      else if (!s.token(/[^#$]+/y, T.plain)) s.take(1, T.plain)
    }
    return { tokens: s.tokens(), state: continued }
  },
}


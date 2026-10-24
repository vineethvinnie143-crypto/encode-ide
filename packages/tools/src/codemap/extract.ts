/**
 * The definitions of a file, and the names it uses (ADR 0090): classes, functions, methods, types and constants, and
 * for FiveM the events, commands, callbacks and exports a resource registers by name. Read with a lexer and rules per
 * language from the code alone (lexer.ts), so they come the same way for every language and every file, without a
 * language server and without running anything.
 *
 * A definition keeps its line as written: the map shows what the model would see with Read, in one line.
 */
import { codeOnly, SYNTAX, type Syntax } from './lexer'

export type DefinitionKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'module'
  | 'function'
  | 'method'
  | 'constant'
  | 'macro'
  | 'table'
  | 'event'
  | 'command'
  | 'callback'
  | 'export'

export interface Definition {
  name: string
  kind: DefinitionKind
  /** 1-based. */
  line: number
  /** The line as written, trimmed and shortened. */
  text: string
  /** The class, impl or table it belongs to. */
  parent?: string
  /** A private member, a local function: used less from outside. */
  private?: boolean
  /** A container (an impl block) shown only as the heading of members that are shown. */
  heading?: boolean
}

export interface Extracted {
  language: string
  definitions: Definition[]
  /** Names the file uses, with how often, most used first; capped. */
  names: Map<string, number>
}

/** Names a file uses, kept for ranking. */
const MAX_NAMES = 600
const MAX_DEFINITIONS = 2_000
const SHOWN_CHARS = 110
/** How much of a definition's line is searched for secrets: many times what is shown. */
const SEARCHED_CHARS = 1_000
/** What of a line the definition rules read. */
const RULE_CHARS = 1_000

const LANGUAGES: Record<string, { language: string; syntax: Syntax; rules: Rules }> = {}

/**
 * Text shaped like a credential: a provider's key, a long token, a JWT, a password in a URL. A definition's line goes
 * to the model without its asking for the file, so it never carries one.
 */
const CREDENTIAL = /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|glpat|AKIA|ASIA|AIza|ya29)[-_.A-Za-z0-9]{10,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}|(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}|(?<=:\/\/[^/\s:@]+:)[^@\s]+(?=@)/g

/**
 * Where a definition's line stops being its signature, read from the code (so a brace in a string does not count):
 * at the body's `{` outside any parentheses, after Python's closing `:`, after Lua's parameter list.
 */
function signatureEnd(code: string, language: string): number {
  // A signature longer than this is cut where it is shown anyway; the Lua pattern would take seconds on a long line.
  code = code.slice(0, 4 * SEARCHED_CHARS)
  if (language === 'lua') {
    const match = /\bfunction\b[^(]*\([^)]*\)/.exec(code)
    return match ? match.index + match[0].length : code.length
  }
  if (language === 'ruby' || language === 'shell' || language === 'sql') return code.length
  let depth = 0
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (c === '(' || c === '[' || c === '<' && language !== 'python' && /\w/.test(code[i - 1] ?? '')) depth++
    else if (c === ')' || c === ']' || (c === '>' && depth > 0 && code[i - 1] !== '=' && code[i - 1] !== '-')) depth = Math.max(0, depth - 1)
    else if (depth === 0 && ((language === 'python' && c === ':') || (language !== 'python' && c === '{'))) return i
  }
  return code.length
}

/** A definition's line for the map: one line, its body left off, nothing that looks like a secret. */
function shorten(line: string, language: string, kind?: DefinitionKind, code?: string): string {
  // Only the start is shown, and only it is searched for secrets: on a line of a hundred thousand letters the search
  // would take minutes. A secret that starts where the text is shown is in the part searched, or long enough to be found.
  const signature = code === undefined ? line : line.slice(0, signatureEnd(code, language))
  let text = signature.replace(/\s+/g, ' ').trim().slice(0, SEARCHED_CHARS).replace(CREDENTIAL, '…')
  // A constant is shown by its name and type: its value may be anything.
  if (kind === 'constant') text = text.replace(/\s*(?<![=!<>])=(?![=>]).*$/, '')
  text = text.replace(/\s*(?:=>\s*)?\{\s*$/, '').replace(/\s+(?:then|do)\s*$/, '')
  if (language === 'python') text = text.replace(/\s*:\s*$/, '')
  return text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS - 1)}…` : text
}

// ---------------------------------------------------------------------------
// Rules

interface Rule {
  re: RegExp
  kind: DefinitionKind
  /** The group holding the name; 1 by default. */
  group?: number
  /** Opens a body whose lines are members (a class), or is transparent (a namespace). */
  container?: 'members' | 'transparent'
  /** Only where members are (inside a class). */
  member?: boolean
  /** Also below the top level (FiveM registrations inside a thread). */
  anywhere?: boolean
  /** A heading only, not a definition of its own. */
  heading?: boolean
  /** The group holding the parent's name (a Go receiver). */
  parentGroup?: number
  private?: (match: RegExpExecArray, line: string) => boolean
}

type Rules = Rule[]

const KEYWORDS = new Set(
  (
    'if else for while do switch case break continue return function class const let var new delete typeof instanceof in of void ' +
    'try catch finally throw async await yield import export from default extends implements interface type enum static public ' +
    'private protected readonly abstract declare namespace module this super null undefined true false def lambda pass raise ' +
    'with as global nonlocal elif not and or is None True False self cls local then end until repeat nil goto fn let mut pub ' +
    'impl trait struct use crate mod where match loop move ref unsafe extern dyn func package go defer chan select range map ' +
    'interface fallthrough var string int bool float double char long short byte unsigned signed sizeof typedef union auto ' +
    'register volatile inline virtual override final sealed internal object fun val when constructor get set operator lateinit ' +
    'begin rescue ensure elsif unless yield require include alias undef echo print foreach endif endforeach endwhile array list'
  ).split(' '),
)

const isKeyword = (name: string) => KEYWORDS.has(name)

/**
 * Names a file uses that say nothing about which definition it means: types of the language, built-in objects and the
 * members everything has (`length`, `toString`, `push`). A project's own `get length()` is not used by every `.length`.
 */
const COMMON_NAMES = new Set(
  (
    'number boolean unknown never symbol bigint any keyof infer satisfies asserts object Object String Number Boolean Symbol BigInt ' +
    'Array Map Set WeakMap WeakSet Promise Error TypeError RangeError Record Partial Required Readonly Pick Omit Exclude Extract ' +
    'ReturnType Parameters Awaited NonNullable Date JSON Math RegExp console window document globalThis process require module ' +
    'length toString valueOf prototype push pop shift unshift map filter reduce forEach find findIndex some every includes indexOf ' +
    'lastIndexOf slice splice join split trim replace keys values entries has get set add delete clear then catch finally resolve ' +
    'reject apply call bind size next done value name type data error message text line index count path file key item items list ' +
    'args options config result state event node start end from len str int float dict tuple print range self cls ' +
    'pairs ipairs tostring tonumber table math string Citizen Wait CreateThread'
  ).split(' '),
)

/** Words a rule may take for a name where the line is a statement, not a definition. */
const NOT_NAMES = new Set('if else for foreach while do switch case catch return function new delete typeof sizeof throw await yield import export from in of match loop when unless elif elsif and or not lambda'.split(' '))

const EXPORTED = /^\s*export\b/
const JS_ID = '[A-Za-z_$][\\w$]*'

const JS_RULES: Rules = [
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${JS_ID})`), kind: 'class', container: 'members' },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+(${JS_ID})`), kind: 'interface' },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+(${JS_ID})\\s*(?:<[^=]*>)?\\s*=`), kind: 'type' },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${JS_ID})`), kind: 'enum' },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:namespace|module)\\s+(${JS_ID})[\\w$.]*\\s*\\{`), kind: 'module', container: 'transparent' },
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${JS_ID})`), kind: 'function', private: (_m, line) => !EXPORTED.test(line) },
  {
    re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(${JS_ID})\\s*(?::[^=]*)?=\\s*(?:async\\s+)?(?:function\\b|\\(.*=>|\\($|${JS_ID}\\s*=>)`),
    kind: 'function',
    private: (_m, line) => !EXPORTED.test(line),
  },
  { re: new RegExp(`^\\s*export\\s+(?:declare\\s+)?(?:const|let|var)\\s+(${JS_ID})`), kind: 'constant' },
  {
    re: new RegExp(`^\\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|accessor|get|set)\\s+)*\\*?(#?${JS_ID})\\s*[?!]?\\s*(?:<[^>()]*>)?\\s*\\(`),
    kind: 'method',
    member: true,
    private: (m, line) => m[1].startsWith('#') || /^\s*(?:protected\s+|private\s+)/.test(line),
  },
  {
    re: new RegExp(`^\\s*(?:(?:public|private|protected|static|readonly|override)\\s+)*(#?${JS_ID})\\s*(?::[^=]*)?=\\s*(?:async\\s+)?(?:\\(.*=>|${JS_ID}\\s*=>)`),
    kind: 'method',
    member: true,
    private: (m, line) => m[1].startsWith('#') || /^\s*(?:protected\s+|private\s+)/.test(line),
  },
]

const PY_RULES: Rules = [
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class', container: 'members' },
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class', container: 'members', member: true },
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: 'function', private: (m) => m[1].startsWith('_') && !m[1].startsWith('__') },
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: 'method', member: true, private: (m) => m[1].startsWith('_') && !/^__\w+__$/.test(m[1]) },
  { re: /^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=(?!=)/, kind: 'constant' },
]

const RUBY_RULES: Rules = [
  { re: /^\s*(?:class|module)\s+([A-Z][\w:]*)/, kind: 'class', container: 'members' },
  { re: /^\s*(?:class|module)\s+([A-Z][\w:]*)/, kind: 'class', container: 'members', member: true },
  { re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, kind: 'function' },
  { re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, kind: 'method', member: true },
]

const RS_VIS = '(?:pub(?:\\s*\\([^)]*\\))?\\s+)?'
const RUST_RULES: Rules = [
  { re: new RegExp(`^\\s*${RS_VIS}(?:default\\s+)?(?:const\\s+|async\\s+|unsafe\\s+|extern\\s+(?:"[^"]*"\\s+)?)*fn\\s+([A-Za-z_]\\w*)`), kind: 'function', private: (_m, line) => !/^\s*pub\b/.test(line) },
  { re: new RegExp(`^\\s*${RS_VIS}(?:default\\s+)?(?:const\\s+|async\\s+|unsafe\\s+|extern\\s+(?:"[^"]*"\\s+)?)*fn\\s+([A-Za-z_]\\w*)`), kind: 'method', member: true, private: (_m, line) => !/^\s*pub\b/.test(line) },
  { re: new RegExp(`^\\s*${RS_VIS}struct\\s+([A-Za-z_]\\w*)`), kind: 'struct' },
  { re: new RegExp(`^\\s*${RS_VIS}enum\\s+([A-Za-z_]\\w*)`), kind: 'enum' },
  { re: new RegExp(`^\\s*${RS_VIS}union\\s+([A-Za-z_]\\w*)`), kind: 'struct' },
  { re: new RegExp(`^\\s*${RS_VIS}(?:unsafe\\s+)?trait\\s+([A-Za-z_]\\w*)`), kind: 'trait', container: 'members' },
  { re: new RegExp(`^\\s*${RS_VIS}type\\s+([A-Za-z_]\\w*)`), kind: 'type' },
  { re: new RegExp(`^\\s*${RS_VIS}mod\\s+([A-Za-z_]\\w*)\\s*\\{`), kind: 'module', container: 'transparent' },
  { re: new RegExp(`^\\s*${RS_VIS}(?:const|static)\\s+(?:mut\\s+)?([A-Z_][A-Z0-9_]*)\\b`), kind: 'constant' },
  { re: /^\s*macro_rules!\s*([A-Za-z_]\w*)/, kind: 'macro' },
  { re: /^\s*(?:unsafe\s+)?impl\b(?:\s*<[^{]*?>)?\s+(?:[\w:<>, &']+?\s+for\s+)?&?([A-Za-z_]\w*)/, kind: 'impl', container: 'members', heading: true },
]

const GO_RULES: Rules = [
  { re: /^func\s+\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)[^)]*\)\s*([A-Za-z_]\w*)/, kind: 'method', group: 2, parentGroup: 1, private: (m) => !/^[A-Z]/.test(m[2]) },
  { re: /^func\s+([A-Za-z_]\w*)/, kind: 'function', private: (m) => !/^[A-Z]/.test(m[1]) },
  { re: /^type\s+([A-Za-z_]\w*)\s+struct\b/, kind: 'struct' },
  { re: /^type\s+([A-Za-z_]\w*)\s+interface\b/, kind: 'interface' },
  { re: /^type\s+([A-Za-z_]\w*)/, kind: 'type' },
  { re: /^(?:var|const)\s+([A-Z]\w*)/, kind: 'constant' },
]

const OO_MODS = '(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|open|data|inner|readonly|unsafe|export|fileprivate|override|virtual|async|synchronized|native|extern|new|default|suspend|inline|operator|infix|tailrec|external|actual|expect|const|lateinit|mutating|@\\w+(?:\\([^)]*\\))?)\\s+)*'
const OO_RULES: Rules = [
  { re: new RegExp(`^\\s*${OO_MODS}(?:class|interface|enum|record|struct|protocol|extension|actor|trait|annotation\\s+class|enum\\s+class|data\\s+class|sealed\\s+class)\\s+([A-Za-z_]\\w*)`), kind: 'class', container: 'members' },
  { re: new RegExp(`^\\s*${OO_MODS}(?:class|interface|enum|record|struct|protocol|extension|actor|trait|annotation\\s+class|enum\\s+class|data\\s+class|sealed\\s+class)\\s+([A-Za-z_]\\w*)`), kind: 'class', container: 'members', member: true },
  { re: /^\s*namespace\s+([\w.]+)\s*\{?\s*$/, kind: 'module', container: 'transparent' },
  { re: new RegExp(`^\\s*${OO_MODS}(?:fun|func)\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?([A-Za-z_]\\w*)`), kind: 'function' },
  { re: new RegExp(`^\\s*${OO_MODS}(?:fun|func)\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?([A-Za-z_]\\w*)`), kind: 'method', member: true, private: (_m, line) => /\bprivate\b|\bfileprivate\b/.test(line) },
  { re: new RegExp(`^\\s*${OO_MODS}function\\s+&?([A-Za-z_]\\w*)`), kind: 'function' },
  { re: new RegExp(`^\\s*${OO_MODS}function\\s+&?([A-Za-z_]\\w*)`), kind: 'method', member: true, private: (_m, line) => /\bprivate\b/.test(line) },
  {
    re: new RegExp(`^\\s*${OO_MODS}(?:<[^>]+>\\s+)?[\\w<>\\[\\],.?]+(?:\\s*<[^>]*>)?\\s+([A-Za-z_]\\w*)\\s*\\(`),
    kind: 'method',
    member: true,
    private: (_m, line) => /\bprivate\b/.test(line),
  },
  { re: /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?([A-Z]\w*)\s*\([^;]*$/, kind: 'method', member: true },
]

/** Kotlin's and Scala's `object`: in C# and Java it is a type. */
const KOTLIN_RULES: Rules = [
  { re: new RegExp(`^\\s*${OO_MODS}(?:companion\\s+)?object\\s+([A-Za-z_]\\w*)`), kind: 'class', container: 'members' },
  { re: new RegExp(`^\\s*${OO_MODS}(?:companion\\s+)?object\\s+([A-Za-z_]\\w*)`), kind: 'class', container: 'members', member: true },
  ...OO_RULES,
]

// A C or C++ type word with its template arguments, two deep (`std::map<int, std::vector<char*>>`), then the spaces,
// `*` and `&` before the next word. Each part takes characters the others do not, so a line that does not match fails
// in one pass: with `*` and `&` allowed in three parts in a row, a line of a thousand of them took seconds.
const C_ARGS = String.raw`(?:<[^<>;(){}]*(?:<[^<>;(){}]*(?:<[^<>;(){}]*>[^<>;(){}]*)*>[^<>;(){}]*)*>)?`
const C_TEMPLATE = String.raw`(?:template\s*<[^>]*>\s*)?`
const C_WORD = String.raw`(?:(?:::)?[A-Za-z_]\w*${C_ARGS}(?:::[A-Za-z_]\w*${C_ARGS})*[\s*&]+)`

const C_RULES: Rules = [
  { re: /^\s*(?:template\s*<.*>\s*)?(?:class|struct|union)\s+(?:\w+\s+)*?([A-Za-z_]\w*)\s*(?:final\s*)?(?::[^;{]*)?\{?\s*$/, kind: 'class', container: 'members' },
  { re: /^\s*(?:typedef\s+)?enum(?:\s+class|\s+struct)?\s+([A-Za-z_]\w*)\s*(?::[^;{]*)?\{?\s*$/, kind: 'enum' },
  { re: /^\s*namespace\s+([\w:]+)\s*\{/, kind: 'module', container: 'transparent' },
  { re: /^\s*#\s*define\s+([A-Za-z_]\w*)/, kind: 'macro', anywhere: true },
  { re: /^\s*typedef\b[^;]*?\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;/, kind: 'type' },
  { re: new RegExp(String.raw`^\s*${C_TEMPLATE}${C_WORD}+([A-Za-z_~][\w~]*(?:::[A-Za-z_~][\w~]*)*)\s*\([^;]*$`), kind: 'function' },
  { re: new RegExp(String.raw`^\s*${C_TEMPLATE}${C_WORD}{1,6}([A-Za-z_]\w*)\s*\([^)]*\)\s*;`), kind: 'function' },
  { re: new RegExp(String.raw`^\s*${C_TEMPLATE}${C_WORD}*([A-Za-z_~][\w~]*)\s*\(`), kind: 'method', member: true },
]

const SHELL_RULES: Rules = [
  { re: /^\s*function\s+([A-Za-z_][\w:.-]*)/, kind: 'function' },
  { re: /^\s*([A-Za-z_][\w:.-]*)\s*\(\s*\)/, kind: 'function' },
]

const PS_RULES: Rules = [
  { re: /^\s*function\s+([\w-]+)/i, kind: 'function' },
  { re: /^\s*class\s+(\w+)/i, kind: 'class', container: 'members' },
  { re: /^\s*(?:\[[\w\[\]]+\]\s*)?(?:hidden\s+|static\s+)*([A-Za-z_]\w*)\s*\(/i, kind: 'method', member: true },
]

const SQL_RULES: Rules = [
  { re: /^\s*create\s+(?:or\s+replace\s+)?(?:temporary\s+|temp\s+)?table\s+(?:if\s+not\s+exists\s+)?[`"[]?([\w.]+)/i, kind: 'table' },
  { re: /^\s*create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?[`"[]?([\w.]+)/i, kind: 'table' },
  { re: /^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+(?:if\s+not\s+exists\s+)?[`"[]?([\w.]+)/i, kind: 'function' },
  { re: /^\s*create\s+(?:or\s+replace\s+)?trigger\s+(?:if\s+not\s+exists\s+)?[`"[]?([\w.]+)/i, kind: 'function' },
  { re: /^\s*create\s+type\s+[`"[]?([\w.]+)/i, kind: 'type' },
]

// FiveM registers by name what other resources and the other side call by name.
const LUA_REGISTER: [RegExp, DefinitionKind][] = [
  [/\b(?:RegisterNetEvent|RegisterServerEvent|AddEventHandler|AddNetEventHandler)\s*\(\s*(['"])/g, 'event'],
  [/\b(?:RegisterCommand|lib\.addCommand|QBCore\.Commands\.Add|ESX\.RegisterCommand)\s*\(\s*(['"])/g, 'command'],
  [/\bRegisterNUICallback\s*\(\s*(['"])/g, 'callback'],
  [/\b(?:lib\.callback\.register|QBCore\.Functions\.CreateCallback|ESX\.RegisterServerCallback)\s*\(\s*(['"])/g, 'callback'],
  [/\bexports\s*\(\s*(['"])/g, 'export'],
]
const LUA_CALLS = /\b(?:TriggerServerEvent|TriggerClientEvent|TriggerEvent|TriggerNetEvent|TriggerLatentClientEvent|TriggerLatentServerEvent|lib\.callback\.await|lib\.callback|QBCore\.Functions\.TriggerCallback|ESX\.TriggerServerCallback|SendNUIMessage)\s*\(\s*(['"])/g
const LUA_EXPORT_CALL = /\bexports\s*(?:\[\s*['"][^'"]+['"]\s*\]|\.[\w-]+)\s*[:.]\s*([A-Za-z_]\w*)\s*\(/g
const JS_REGISTER: [RegExp, DefinitionKind][] = [
  [/\b(?:onNet|RegisterNetEvent|on)\s*\(\s*(['"`])/g, 'event'],
  [/\bRegisterCommand\s*\(\s*(['"`])/g, 'command'],
  [/\bRegisterNuiCallback(?:Type)?\s*\(\s*(['"`])/gi, 'callback'],
  [/\bexports\s*\(\s*(['"`])/g, 'export'],
]
const JS_CALLS = /\b(?:emitNet|emit|TriggerServerEvent|TriggerClientEvent|fetchNui)\s*\(\s*(['"`])/g

const LUA_RULES: Rules = [
  { re: /^\s*(local\s+)?function\s+([A-Za-z_][\w.:]*)\s*\(/, kind: 'function', group: 2, private: (m) => Boolean(m[1]) },
  { re: /^\s*(local\s+)?([A-Za-z_][\w.:]*)\s*=\s*function\b/, kind: 'function', group: 2, private: (m) => Boolean(m[1]) },
  { re: /^\s*(local\s+)?([A-Za-z_]\w*)\s*=\s*\{/, kind: 'table', group: 2, private: (m) => Boolean(m[1]) },
]

function register(language: string, syntax: Syntax, rules: Rules, extensions: string[]) {
  for (const extension of extensions) LANGUAGES[extension] = { language, syntax, rules }
}
register('typescript', SYNTAX.js, JS_RULES, ['.ts', '.tsx', '.mts', '.cts'])
register('javascript', SYNTAX.js, JS_RULES, ['.js', '.jsx', '.mjs', '.cjs'])
register('svelte', SYNTAX.js, JS_RULES, ['.svelte'])
register('vue', SYNTAX.js, JS_RULES, ['.vue'])
register('python', SYNTAX.python, PY_RULES, ['.py', '.pyi'])
register('lua', SYNTAX.lua, LUA_RULES, ['.lua'])
register('rust', SYNTAX.rust, RUST_RULES, ['.rs'])
register('go', SYNTAX.go, GO_RULES, ['.go'])
register('java', SYNTAX.jvm, OO_RULES, ['.java'])
register('kotlin', SYNTAX.jvm, KOTLIN_RULES, ['.kt', '.kts'])
register('scala', SYNTAX.jvm, KOTLIN_RULES, ['.scala'])
register('swift', SYNTAX.jvm, OO_RULES, ['.swift'])
register('dart', SYNTAX.jvm, OO_RULES, ['.dart'])
register('csharp', SYNTAX.csharp, OO_RULES, ['.cs'])
register('php', SYNTAX.php, OO_RULES, ['.php'])
register('c', SYNTAX.c, C_RULES, ['.c', '.h'])
register('cpp', SYNTAX.c, C_RULES, ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.ino'])
register('ruby', SYNTAX.ruby, RUBY_RULES, ['.rb'])
register('shell', SYNTAX.shell, SHELL_RULES, ['.sh', '.bash', '.zsh'])
register('powershell', SYNTAX.powershell, PS_RULES, ['.ps1', '.psm1'])
register('sql', SYNTAX.sql, SQL_RULES, ['.sql'])

/** The language eNCode reads definitions of, by the file's name; undefined for any other file. */
export function languageOf(file: string): string | undefined {
  const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? LANGUAGES[name.slice(dot)]?.language : undefined
}

const extensionOf = (file: string) => {
  const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase()
  return name.slice(name.lastIndexOf('.'))
}

// ---------------------------------------------------------------------------
// Scopes: which lines are top level, which are members of what

type Scope = 'top' | 'member' | 'nested'

interface Open {
  name: string
  /** Braces: the depth of the body. Indentation: the container's own indentation. */
  at: number
  kind: 'members' | 'transparent' | 'body'
}

/** Brace depth at the start of each line. */
function braceDepths(code: string[]): number[] {
  const depths: number[] = []
  let depth = 0
  for (const line of code) {
    depths.push(depth)
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i)
      if (c === 123) depth++
      else if (c === 125) depth = Math.max(0, depth - 1)
    }
  }
  return depths
}

const LUA_OPEN = /\b(function|if|do|repeat)\b/g
const LUA_CLOSE = /\b(end|until)\b/g

/** Lua's depth at the start of each line: its blocks by their keywords, and its tables by their braces. */
function luaDepths(code: string[]): number[] {
  const depths: number[] = []
  let depth = 0
  for (const line of code) {
    depths.push(depth)
    let braces = 0
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i)
      if (c === 123) braces++
      else if (c === 125) braces--
    }
    depth += (line.match(LUA_OPEN)?.length ?? 0) - (line.match(LUA_CLOSE)?.length ?? 0) + braces
    if (depth < 0) depth = 0
  }
  return depths
}

const indentOf = (line: string) => {
  let width = 0
  for (const char of line) {
    if (char === ' ') width++
    else if (char === '\t') width += 4
    else break
  }
  return width
}

/** The code of a Svelte or Vue file is in its script elements; the rest is blanked, in place. */
function scriptsOnly(text: string): string {
  const parts: string[] = []
  let at = 0
  const open = /<script\b[^>]*>/gi
  for (let match = open.exec(text); match; match = open.exec(text)) {
    const start = match.index + match[0].length
    const end = text.toLowerCase().indexOf('</script>', start)
    const stop = end < 0 ? text.length : end
    parts.push(text.slice(at, start).replace(/[^\n]/g, ' '), text.slice(start, stop))
    at = stop
    open.lastIndex = stop
  }
  parts.push(text.slice(at).replace(/[^\n]/g, ' '))
  return parts.join('')
}

// ---------------------------------------------------------------------------

const NAME = /[A-Za-z_$][\w$]*/g

/** A copy of a piece of the file that does not keep the whole file in memory, as a slice of it would. */
const own = (value: string) => (value.length < 13 ? value : ` ${value}`.slice(1))

/** The definitions and the names used, of a file's text; undefined for a file in no language eNCode reads. */
export function extract(file: string, text: string): Extracted | undefined {
  const spec = LANGUAGES[extensionOf(file)]
  if (!spec) return undefined
  const source = spec.language === 'svelte' || spec.language === 'vue' ? scriptsOnly(text) : text
  const code = codeOnly(source, spec.syntax)
  const lines = text.split('\n')
  const codeLines = code.split('\n')
  const definitions: Definition[] = []
  const add = (definition: Definition) => {
    if (definitions.length < MAX_DEFINITIONS) definitions.push(definition)
  }

  const indented = spec.language === 'python' || spec.language === 'ruby'
  const depths = indented ? [] : spec.language === 'lua' ? luaDepths(codeLines) : braceDepths(codeLines)
  const open: Open[] = []
  /** A container whose `{` has not come yet, by the line it was found on. */
  let pending: { open: Open; line: number } | undefined

  for (let index = 0; index < codeLines.length; index++) {
    const codeLine = codeLines[index]
    if (!codeLine.trim()) continue
    let scope: Scope
    if (indented) {
      const indent = indentOf(codeLine)
      while (open.length && indent <= open[open.length - 1].at) open.pop()
      const inner = open[open.length - 1]
      scope = !inner ? 'top' : inner.kind === 'members' ? 'member' : 'nested'
    } else {
      const depth = depths[index]
      if (pending) {
        // A container's body opens on the next line (`class Foo` then `{`, or a header that goes on), or it has none.
        const opens = /^\s*(?:\{|(?:extends|implements|where|:|,)[^;]*\{\s*$)/.test(codeLine) && (depths[index + 1] ?? depth) >= pending.open.at
        if (opens) open.push(pending.open)
        pending = undefined
        if (opens) continue
      }
      while (open.length && depth < open[open.length - 1].at) open.pop()
      const transparent = open.filter((entry) => entry.kind === 'transparent').length
      const inner = [...open].reverse().find((entry) => entry.kind !== 'transparent')
      if (inner) scope = depth === inner.at ? (inner.kind === 'members' ? 'member' : 'nested') : 'nested'
      else scope = depth === transparent ? 'top' : 'nested'
    }

    // A definition starts near the start of its line; reading a long line's start bounds what a rule can cost.
    const head = codeLine.length > RULE_CHARS ? codeLine.slice(0, RULE_CHARS) : codeLine
    for (const rule of spec.rules) {
      if (scope === 'nested' && !rule.anywhere) continue
      if (rule.member ? scope !== 'member' : scope === 'member' && !rule.anywhere) continue
      const match = rule.re.exec(head)
      if (!match) continue
      const at = match.index + match[0].lastIndexOf(match[rule.group ?? 1])
      // The name as written in the file, at the place the code has it.
      let name = lines[index].slice(at, at + match[rule.group ?? 1].length)
      if (!name || NOT_NAMES.has(name)) continue
      let parent = rule.parentGroup ? match[rule.parentGroup] : undefined
      // `function Player:save()` in Lua, `void Router::handle()` in C++: the member of what comes before.
      const cut = spec.language === 'lua' ? Math.max(name.lastIndexOf('.'), name.lastIndexOf(':')) : name.lastIndexOf('::')
      if (cut > 0) {
        parent = name.slice(0, cut)
        name = name.slice(cut + (spec.language === 'lua' ? 1 : 2))
        if (!name) continue
      }
      const inner = indented ? open[open.length - 1] : [...open].reverse().find((entry) => entry.kind !== 'transparent')
      if (rule.member && inner) parent = inner.name
      // A namespace holds definitions; it is not one worth showing.
      if (rule.container !== 'transparent')
        add({
        name: own(name),
        kind: rule.member && rule.kind === 'function' ? 'method' : rule.kind,
        line: index + 1,
        text: own(shorten(lines[index], spec.language, rule.kind, codeLines[index])),
        ...(parent ? { parent: own(parent) } : {}),
        ...(rule.private?.(match, codeLine) ? { private: true } : {}),
        ...(rule.heading ? { heading: true } : {}),
      })
      if (rule.container) {
        const entry: Open = { name, kind: rule.container, at: indented ? indentOf(codeLine) : depths[index] + 1 }
        if (indented) open.push(entry)
        else if ((depths[index + 1] ?? depths[index]) >= entry.at) open.push(entry)
        else if (!/[;}]\s*$/.test(codeLine)) pending = { open: entry, line: index }
      } else if (indented && (rule.kind === 'function' || rule.kind === 'method')) {
        open.push({ name, kind: 'body', at: indentOf(codeLine) })
      }
      break
    }
  }

  // FiveM: what a resource registers by name, wherever it is, and what it calls by name.
  const starts = [0]
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1)
  const lineAt = (offset: number) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (starts[middle] <= offset) low = middle
      else high = middle - 1
    }
    return low + 1
  }
  const strings: string[] = []
  const registered = spec.language === 'lua' ? LUA_REGISTER : spec.language === 'javascript' || spec.language === 'typescript' ? JS_REGISTER : []
  const seen = new Set<string>()
  for (const [pattern, kind] of registered) {
    for (const match of code.matchAll(pattern)) {
      const quote = match[1]
      const start = (match.index ?? 0) + match[0].length
      const end = text.indexOf(quote, start)
      const name = end > start ? text.slice(start, end) : ''
      if (!name || name.length > 120 || /\s{2}|\n/.test(name)) continue
      // `on('x', …)` counts only for a name that looks like an event (resource:side:what).
      if (kind === 'event' && /^\s*on\b/.test(match[0].replace(/^\W+/, '')) && !name.includes(':')) continue
      const key = `${kind === 'export' ? 'export' : kind}\u0000${name}`
      if (seen.has(key)) continue
      seen.add(key)
      const line = lineAt(match.index ?? 0)
      add({ name: own(name), kind, line, text: own(shorten(lines[line - 1], spec.language, kind, codeLines[line - 1])) })
    }
  }
  const calls = spec.language === 'lua' ? LUA_CALLS : spec.language === 'javascript' || spec.language === 'typescript' ? JS_CALLS : undefined
  if (calls) {
    for (const match of code.matchAll(calls)) {
      const start = (match.index ?? 0) + match[0].length
      const end = text.indexOf(match[1], start)
      if (end > start && end - start <= 120) strings.push(text.slice(start, end))
    }
    if (spec.language === 'lua') for (const match of code.matchAll(LUA_EXPORT_CALL)) strings.push(match[1])
  }
  definitions.sort((a, b) => a.line - b.line)
  // A C prototype and the function it declares, in one file: the definition is the one to show.
  const defined = new Set(definitions.filter((definition) => !definition.text.endsWith(';')).map((definition) => `${definition.parent ?? ''}\u0000${definition.name}`))
  const kept = definitions.filter((definition) => !(spec.syntax === SYNTAX.c && definition.text.endsWith(';') && definition.kind === 'function' && defined.has(`${definition.parent ?? ''}\u0000${definition.name}`)))

  return { language: spec.language, definitions: kept, names: namesUsed(code, strings) }
}

/** The names a file's code uses, most used first, with the strings it calls by name. */
function namesUsed(code: string, strings: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const match of code.matchAll(NAME)) {
    const name = match[0]
    if (name.length < 3 || isKeyword(name) || COMMON_NAMES.has(name)) continue
    const count = counts.get(name)
    counts.set(count ? name : own(name), (count ?? 0) + 1)
  }
  for (const name of strings) {
    const count = counts.get(name)
    counts.set(count ? name : own(name), (count ?? 0) + 1)
  }
  if (counts.size <= MAX_NAMES) return counts
  return new Map([...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_NAMES))
}

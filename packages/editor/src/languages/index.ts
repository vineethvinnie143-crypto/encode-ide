import { BRACKETS, T, plainText, type Language, type Tokenizer } from '../language'
import * as clike from './clike'
import { cssTokenizer, scssTokenizer } from './css'
import { diff, dockerfile, ini, json, makefile, sql, toml, yaml } from './data'
import { lua } from './lua'
import { htmlTokenizer, markdownTokenizer, xmlTokenizer } from './markup'
import { python } from './python'
import { batch, powershell, shell } from './shell'

export interface LanguageEntry extends Language {
  /** File extensions without the dot, lower case. */
  readonly extensions: readonly string[]
  /** Whole file names that pick this language (Dockerfile, Makefile). */
  readonly filenames?: readonly string[]
  /** Other names, as written after a Markdown code fence. */
  readonly aliases?: readonly string[]
}

const C_COMMENTS = { lineComment: '//', blockComment: ['/*', '*/'] } as const
const QUOTES = ['"', "'"]
const JS_QUOTES = ['"', "'", '`']
/** An opening tag left open at the end of the line (not a void element). */
const OPEN_TAG = /<(?!\/|!|(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b)[\w:-]+(?:\s[^<>]*)?(?<!\/)>[^<]*$/i
const CLOSE_TAG = /^\s*<\/[\w:.-]+>$/

const ignoreTokenizer: Tokenizer = {
  start: '',
  line: (text) => {
    if (/^\s*#/.test(text)) return { tokens: [0, T.comment], state: '' }
    if (text.startsWith('!')) return { tokens: [0, T.operator, 1, T.plain], state: '' }
    return { tokens: text ? [0, T.plain] : [], state: '' }
  },
}

function entry(spec: Omit<LanguageEntry, 'brackets' | 'quotes'> & Partial<Pick<Language, 'brackets' | 'quotes'>>): LanguageEntry {
  return { brackets: BRACKETS, quotes: QUOTES, ...spec }
}

const javascriptLike = (id: string, name: string, extensions: string[], tokenizer: Tokenizer, aliases: string[]) =>
  entry({ id, name, extensions, aliases, ...C_COMMENTS, quotes: JS_QUOTES, wordChars: '$', tokenizer })

const html = htmlTokenizer(json)

const list: LanguageEntry[] = [
  javascriptLike('javascript', 'JavaScript', ['js', 'mjs', 'cjs'], clike.javascript, ['js', 'node']),
  javascriptLike('javascriptreact', 'JavaScript React', ['jsx'], clike.javascript, ['jsx']),
  javascriptLike('typescript', 'TypeScript', ['ts', 'mts', 'cts'], clike.typescript, ['ts']),
  javascriptLike('typescriptreact', 'TypeScript React', ['tsx'], clike.javascript, ['tsx']),
  entry({
    id: 'json',
    name: 'JSON',
    extensions: ['json', 'webmanifest', 'map', 'har'],
    filenames: ['.prettierrc', 'composer.lock'],
    aliases: ['json'],
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    quotes: ['"'],
    tokenizer: json,
  }),
  entry({
    id: 'jsonc',
    name: 'JSON with Comments',
    extensions: ['jsonc', 'json5', 'code-workspace'],
    filenames: ['tsconfig.json', 'jsconfig.json', '.eslintrc', '.eslintrc.json', '.babelrc', 'devcontainer.json', 'settings.json', 'keybindings.json', 'launch.json', 'tasks.json', 'extensions.json'],
    aliases: ['jsonc', 'json5'],
    ...C_COMMENTS,
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    quotes: ['"'],
    tokenizer: json,
  }),
  entry({ id: 'css', name: 'CSS', extensions: ['css'], aliases: ['css'], blockComment: ['/*', '*/'], wordChars: '-', tokenizer: cssTokenizer }),
  entry({ id: 'scss', name: 'SCSS', extensions: ['scss', 'sass'], aliases: ['scss', 'sass'], ...C_COMMENTS, wordChars: '-$', tokenizer: scssTokenizer }),
  entry({ id: 'less', name: 'Less', extensions: ['less'], aliases: ['less'], ...C_COMMENTS, wordChars: '-@', tokenizer: scssTokenizer }),
  entry({
    id: 'html',
    name: 'HTML',
    extensions: ['html', 'htm', 'xhtml', 'shtml'],
    aliases: ['html'],
    blockComment: ['<!--', '-->'],
    brackets: [...BRACKETS, ['<', '>']],
    wordChars: '-',
    indentAfter: OPEN_TAG,
    dedentOn: CLOSE_TAG,
    tokenizer: html,
  }),
  entry({ id: 'vue', name: 'Vue', extensions: ['vue'], aliases: ['vue'], blockComment: ['<!--', '-->'], wordChars: '-', indentAfter: OPEN_TAG, dedentOn: CLOSE_TAG, tokenizer: html }),
  entry({ id: 'svelte', name: 'Svelte', extensions: ['svelte'], aliases: ['svelte'], blockComment: ['<!--', '-->'], wordChars: '-', indentAfter: OPEN_TAG, dedentOn: CLOSE_TAG, tokenizer: html }),
  entry({
    id: 'xml',
    name: 'XML',
    extensions: ['xml', 'svg', 'xsd', 'xsl', 'xslt', 'plist', 'csproj', 'fsproj', 'vbproj', 'props', 'targets', 'resx', 'xaml', 'nuspec', 'config', 'manifest', 'rss', 'atom', 'wsdl'],
    aliases: ['xml', 'svg'],
    blockComment: ['<!--', '-->'],
    wordChars: '-:',
    indentAfter: OPEN_TAG,
    dedentOn: CLOSE_TAG,
    tokenizer: xmlTokenizer,
  }),
  entry({
    id: 'markdown',
    name: 'Markdown',
    extensions: ['md', 'markdown', 'mdx', 'mdown', 'mkd'],
    filenames: ['ENCODE.md', 'README', 'CHANGELOG'],
    aliases: ['md', 'markdown'],
    blockComment: ['<!--', '-->'],
    quotes: [],
    brackets: [...BRACKETS],
    tokenizer: plainText.tokenizer,
  }),
  entry({
    id: 'python',
    name: 'Python',
    extensions: ['py', 'pyw', 'pyi', 'pyx'],
    filenames: ['SConstruct', 'SConscript'],
    aliases: ['py', 'python3', 'py3'],
    lineComment: '#',
    indentAfter: /:\s*(?:#.*)?$/,
    dedentOn: /^\s*(?:else|elif\b.*|except\b.*|finally):\s*$/,
    tokenizer: python,
  }),
  entry({
    id: 'lua',
    name: 'Lua',
    extensions: ['lua', 'luau', 'rockspec'],
    filenames: ['fxmanifest.lua', '__resource.lua', '.luacheckrc'],
    aliases: ['lua', 'luau', 'cfxlua'],
    lineComment: '--',
    blockComment: ['--[[', ']]'],
    indentAfter: /(?:\b(?:then|do|else|repeat)|\bfunction\b[^)]*\))\s*(?:--.*)?$/,
    dedentOn: /^\s*(?:end|else|elseif|until)\b.*$/,
    tokenizer: lua,
  }),
  entry({
    id: 'shellscript',
    name: 'Shell',
    extensions: ['sh', 'bash', 'zsh', 'ksh', 'command'],
    filenames: ['.bashrc', '.bash_profile', '.zshrc', '.profile', '.bash_aliases', 'PKGBUILD', 'gradlew'],
    aliases: ['sh', 'bash', 'zsh', 'shell', 'console', 'shellscript'],
    lineComment: '#',
    quotes: ['"', "'", '`'],
    indentAfter: /(?:\b(?:then|do|else)|\{)\s*(?:#.*)?$/,
    dedentOn: /^\s*(?:fi|done|esac|else|elif)\b.*$/,
    tokenizer: shell,
  }),
  entry({
    id: 'powershell',
    name: 'PowerShell',
    extensions: ['ps1', 'psm1', 'psd1', 'pssc', 'psrc'],
    aliases: ['ps1', 'powershell', 'pwsh', 'ps'],
    lineComment: '#',
    blockComment: ['<#', '#>'],
    wordChars: '-',
    tokenizer: powershell,
  }),
  entry({ id: 'bat', name: 'Batch', extensions: ['bat', 'cmd'], aliases: ['bat', 'batch', 'cmd'], lineComment: 'REM', tokenizer: batch }),
  entry({
    id: 'yaml',
    name: 'YAML',
    extensions: ['yml', 'yaml'],
    filenames: ['.clang-format', '.clangd'],
    aliases: ['yml', 'yaml'],
    lineComment: '#',
    indentAfter: /:\s*(?:[|>][-+]?\d*)?\s*(?:#.*)?$/,
    tokenizer: yaml,
  }),
  entry({ id: 'toml', name: 'TOML', extensions: ['toml'], filenames: ['Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile'], aliases: ['toml'], lineComment: '#', tokenizer: toml }),
  entry({
    id: 'ini',
    name: 'INI',
    extensions: ['ini', 'cfg', 'conf', 'properties', 'env', 'cnf', 'inf', 'reg'],
    filenames: ['.env', '.editorconfig', '.gitconfig', '.npmrc', '.yarnrc', '.flake8', 'pylintrc', '.pylintrc', 'server.cfg'],
    aliases: ['ini', 'properties', 'env', 'dotenv', 'cfg'],
    lineComment: ';',
    tokenizer: ini,
  }),
  entry({
    id: 'ignore',
    name: 'Ignore',
    extensions: ['gitignore', 'dockerignore', 'npmignore', 'eslintignore', 'prettierignore'],
    filenames: ['.gitignore', '.dockerignore', '.npmignore', '.eslintignore', '.prettierignore', '.gitattributes', 'CODEOWNERS'],
    aliases: ['gitignore', 'ignore'],
    lineComment: '#',
    tokenizer: ignoreTokenizer,
  }),
  entry({ id: 'sql', name: 'SQL', extensions: ['sql', 'psql', 'mysql', 'pgsql', 'ddl', 'dml'], aliases: ['sql', 'mysql', 'postgres', 'postgresql', 'sqlite', 'tsql'], lineComment: '--', blockComment: ['/*', '*/'], tokenizer: sql }),
  entry({ id: 'c', name: 'C', extensions: ['c', 'h'], aliases: ['c'], ...C_COMMENTS, tokenizer: clike.c }),
  entry({ id: 'cpp', name: 'C++', extensions: ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++', 'ino', 'ipp', 'tpp', 'inl'], aliases: ['cpp', 'c++', 'cxx'], ...C_COMMENTS, tokenizer: clike.cpp }),
  entry({ id: 'csharp', name: 'C#', extensions: ['cs', 'csx', 'cake'], aliases: ['cs', 'csharp', 'c#'], ...C_COMMENTS, tokenizer: clike.csharp }),
  entry({ id: 'java', name: 'Java', extensions: ['java', 'jav'], aliases: ['java'], ...C_COMMENTS, tokenizer: clike.java }),
  entry({ id: 'kotlin', name: 'Kotlin', extensions: ['kt', 'kts'], aliases: ['kotlin', 'kt'], ...C_COMMENTS, tokenizer: clike.kotlin }),
  entry({ id: 'go', name: 'Go', extensions: ['go'], aliases: ['go', 'golang'], ...C_COMMENTS, quotes: ['"', "'", '`'], tokenizer: clike.go }),
  entry({ id: 'rust', name: 'Rust', extensions: ['rs'], aliases: ['rust', 'rs'], ...C_COMMENTS, quotes: ['"'], tokenizer: clike.rust }),
  entry({ id: 'swift', name: 'Swift', extensions: ['swift'], aliases: ['swift'], ...C_COMMENTS, quotes: ['"'], tokenizer: clike.swift }),
  entry({
    id: 'dockerfile',
    name: 'Dockerfile',
    extensions: ['dockerfile', 'containerfile'],
    filenames: ['Dockerfile', 'Containerfile'],
    aliases: ['dockerfile', 'docker'],
    lineComment: '#',
    tokenizer: dockerfile,
  }),
  entry({
    id: 'makefile',
    name: 'Makefile',
    extensions: ['mk', 'mak', 'make'],
    filenames: ['Makefile', 'makefile', 'GNUmakefile', 'BSDmakefile'],
    aliases: ['make', 'makefile', 'mk'],
    lineComment: '#',
    tokenizer: makefile,
  }),
  entry({ id: 'diff', name: 'Diff', extensions: ['diff', 'patch', 'rej'], aliases: ['diff', 'patch'], quotes: [], tokenizer: diff }),
]

const byId = new Map<string, LanguageEntry>()
const byName = new Map<string, LanguageEntry>()
const byExtension = new Map<string, LanguageEntry>()
const byFilename = new Map<string, LanguageEntry>()

function register(language: LanguageEntry): void {
  byId.set(language.id, language)
  byName.set(language.id, language)
  byName.set(language.name.toLowerCase(), language)
  for (const alias of language.aliases ?? []) byName.set(alias, language)
  for (const extension of language.extensions) byExtension.set(extension, language)
  for (const filename of language.filenames ?? []) byFilename.set(filename.toLowerCase(), language)
}

for (const language of list) register(language)

// Markdown needs the registry for its code fences, so it is completed last.
const markdownIndex = list.findIndex((language) => language.id === 'markdown')
const markdown: LanguageEntry = {
  ...list[markdownIndex],
  tokenizer: markdownTokenizer((name) => languageByName(name)?.tokenizer ?? null, yaml, html),
}
list[markdownIndex] = markdown
register(markdown)

export const plain: LanguageEntry = { ...plainText, extensions: ['txt', 'text', 'log'], aliases: ['text', 'txt', 'plaintext', 'plain'] }
register(plain)

/** Every language, for a picker. */
export const languages: readonly LanguageEntry[] = [...list, plain]

export function languageById(id: string): LanguageEntry | undefined {
  return byId.get(id)
}

/** A language by a name as people write it (`ts`, `bash`, `C#`), for Markdown fences. */
export function languageByName(name: string): LanguageEntry | undefined {
  const key = name.trim().toLowerCase()
  return byName.get(key) ?? byExtension.get(key)
}

/** The language for a file path (either separator), falling back to plain text. */
export function languageForPath(path: string): LanguageEntry {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const lower = base.toLowerCase()
  const named = byFilename.get(lower)
  if (named) return named
  if (lower.startsWith('.env')) return byId.get('ini')!
  if (lower.startsWith('dockerfile') || lower.endsWith('.dockerfile')) return byId.get('dockerfile')!
  const dot = lower.lastIndexOf('.')
  if (dot >= 0) {
    const language = byExtension.get(lower.slice(dot + 1))
    if (language) return language
  }
  // A dotfile such as ".gitignore" names its type after the dot.
  if (dot === 0) return byExtension.get(lower.slice(1)) ?? plain
  return plain
}

/** Picks a language from a shebang line when the path did not decide one. */
export function languageForContent(firstLine: string): LanguageEntry | undefined {
  const shebang = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?([\w.-]+)/.exec(firstLine)
  if (!shebang) return undefined
  const program = shebang[1].replace(/\d+(?:\.\d+)*$/, '')
  if (program === 'node' || program === 'deno' || program === 'bun') return byId.get('javascript')
  if (program === 'python') return byId.get('python')
  if (program === 'lua' || program === 'luajit') return byId.get('lua')
  if (program === 'pwsh' || program === 'powershell') return byId.get('powershell')
  if (/^(?:ba|z|k|da)?sh$/.test(program)) return byId.get('shellscript')
  return byName.get(program)
}

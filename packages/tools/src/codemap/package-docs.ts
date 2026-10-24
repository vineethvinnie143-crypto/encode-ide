/**
 * An installed package's API at the version the project has (ADR 0091): what it exports, and one name's declaration
 * with its documentation, read from the package's own files (its type declarations first). FiveM's natives come from
 * the index eNCode writes when it installs them.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { NativeDoc } from '@encode/lsp'
import { decodeText } from '../text'
import { walk } from '../walk'
import { extract, languageOf, type Definition } from './extract'
import { codeOnly, SYNTAX, type Syntax } from './lexer'
import { npmPackage, type InstalledPackage } from './packages'

/** The files of one package that are read for a lookup. */
const MAX_FILES = 600
const MAX_FILE_BYTES = 2_000_000
const MAX_TOTAL_BYTES = 24_000_000
/** Files followed from a types entry by its `export … from`. */
const MAX_ENTRY_FILES = 24
const MAX_MATCHES = 6
const DOC_LINES = 24
const BODY_LINES = 40
const SIGNATURE_LINES = 14

const DECLARATION_FILE = /\.d\.[cm]?ts$|\.pyi$/
const CONTAINERS = new Set<Definition['kind']>(['class', 'interface', 'struct', 'trait', 'enum', 'type', 'module', 'impl', 'table'])
/** The order an overview fills its budget in. */
const KIND_ORDER: Partial<Record<Definition['kind'], number>> = { function: 0, class: 0, callback: 0, export: 0, event: 0, command: 0, constant: 1, struct: 1, trait: 1, module: 1, table: 1, method: 2, interface: 3, enum: 3, type: 4 }
/** Kinds whose body is their API even in source: the fields of a struct, the members of an interface. */
const BODY_IS_API = new Set<Definition['kind']>(['interface', 'struct', 'enum', 'type', 'trait'])

interface PackageFile {
  /** Relative to the package's folder, with forward slashes. */
  path: string
  absolute: string
  text: string
}

/** Whether a lookup may read a file: one inside the folder it reads, through no link out of it, that the person's rules allow. */
type Allow = (absolute: string) => Promise<boolean>

function allowIn(dir: string, readable?: (absolute: string) => boolean): Allow {
  const base = fs.realpath(dir).catch(() => path.resolve(dir))
  return async (absolute) => {
    if (readable && !readable(absolute)) return false
    try {
      const [real, inside] = await Promise.all([fs.realpath(absolute), base])
      return real === inside || real.startsWith(inside.endsWith(path.sep) ? inside : `${inside}${path.sep}`)
    } catch {
      return false
    }
  }
}

async function readFile(file: string, allow: Allow): Promise<string | undefined> {
  try {
    if (!(await allow(file))) return undefined
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined
    return decodeText(await fs.readFile(file))?.text
  } catch {
    return undefined
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

/** Which of a package's files a lookup reads: its declarations, or its code where it has none. */
function wanted(pkg: InstalledPackage, relative: string, declarations: boolean): boolean {
  const name = relative.toLowerCase()
  if (/(^|\/)(tests?|__tests__|spec|examples?|benches|testdata|fixtures?)\//.test(name)) return false
  // `ts5.0/`: the same declarations for an older TypeScript.
  if (/(^|\/)ts\d+\.\d+\//.test(name)) return false
  switch (pkg.ecosystem) {
    case 'npm':
      return declarations ? DECLARATION_FILE.test(name) : /\.[cm]?js$/.test(name) && !/\.min\.js$/.test(name)
    case 'python':
      return declarations ? name.endsWith('.pyi') : name.endsWith('.py')
    case 'cargo':
      return name.endsWith('.rs') && (name.startsWith('src/') || !name.includes('/'))
    case 'go':
      // One folder is one Go package.
      return name.endsWith('.go') && !name.endsWith('_test.go') && !name.includes('/')
    case 'fivem':
      return /\.(lua|js|ts)$/.test(name)
  }
}

/** The package's files a lookup reads, its declaration files where it has them. */
async function packageFiles(pkg: InstalledPackage, dir: string, allow: Allow, signal?: AbortSignal): Promise<PackageFile[]> {
  const walked = await walk({ dir, gitignore: false, skipNames: ['node_modules', '.git', 'target'], limit: MAX_FILES * 4, ...(signal ? { signal } : {}) })
  const relative = walked.files.filter((entry) => !entry.isDirectory && !entry.isSymlink).map((entry) => entry.relative)
  let chosen = relative.filter((file) => wanted(pkg, file, true))
  if (!chosen.length) chosen = relative.filter((file) => wanted(pkg, file, false))
  const out: PackageFile[] = []
  let total = 0
  for (const file of chosen.sort(byDepth).slice(0, MAX_FILES)) {
    const absolute = path.join(dir, ...file.split('/'))
    const text = await readFile(absolute, allow)
    if (text === undefined) continue
    total += text.length
    if (total > MAX_TOTAL_BYTES) break
    out.push({ path: file, absolute, text })
  }
  return out
}

/** Shallow files first: a package's entry is near its top. */
const byDepth = (a: string, b: string) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1)

interface Types {
  dir: string
  /** The folder as the project reaches it, when `dir` is behind a link. */
  link?: string
  entry?: string
  version?: string
  from?: string
}

/** Where an npm package keeps its types: its own, or `@types/name` as the project would load it. */
async function npmTypes(lookup: PackageLookup): Promise<Types | undefined> {
  const { pkg } = lookup
  if (!pkg.dir) return undefined
  const own = { dir: pkg.dir, ...(pkg.link ? { link: pkg.link } : {}) }
  const manifest = await readJsonObject(path.join(pkg.dir, 'package.json'), allowIn(pkg.dir, lookup.readable))
  const entry = typesEntry(manifest)
  if (entry && (await exists(path.join(pkg.dir, entry)))) return { ...own, entry }
  if (await exists(path.join(pkg.dir, 'index.d.ts'))) return { ...own, entry: 'index.d.ts' }
  // react -> @types/react; @scope/name -> @types/scope__name.
  const typesName = `@types/${pkg.name.startsWith('@') ? pkg.name.slice(1).replace('/', '__') : pkg.name}`
  const types = lookup.from && lookup.root ? await npmPackage(typesName, lookup.from, lookup.root) : undefined
  if (!types?.dir) return undefined
  const typesManifest = await readJsonObject(path.join(types.dir, 'package.json'), allowIn(types.dir, lookup.readable))
  return { dir: types.dir, ...(types.link ? { link: types.link } : {}), entry: typesEntry(typesManifest) ?? 'index.d.ts', ...(types.version ? { version: types.version } : {}), from: typesName }
}

/** A file of the package as the project reaches it: through `node_modules/name`, not the store it links to. */
function shownPath(lookup: PackageLookup, absolute: string, base?: { dir: string; link?: string }): string {
  const from = base ?? (lookup.pkg.dir ? { dir: lookup.pkg.dir, ...(lookup.pkg.link ? { link: lookup.pkg.link } : {}) } : undefined)
  if (from?.link && (absolute === from.dir || absolute.startsWith(`${from.dir}${path.sep}`))) return lookup.display(from.link + absolute.slice(from.dir.length))
  return lookup.display(absolute)
}

async function readJsonObject(file: string, allow: Allow): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(file, allow)
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** `types`, `typings`, or the types of `exports['.']`. */
function typesEntry(manifest: Record<string, unknown> | undefined): string | undefined {
  if (!manifest) return undefined
  for (const key of ['types', 'typings']) if (typeof manifest[key] === 'string') return safeRelative(manifest[key] as string)
  const exportsField = manifest.exports
  const root = exportsField && typeof exportsField === 'object' ? ((exportsField as Record<string, unknown>)['.'] ?? exportsField) : undefined
  const find = (value: unknown, depth: number): string | undefined => {
    if (depth > 4 || !value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    if (typeof record.types === 'string') return record.types
    for (const key of ['import', 'require', 'default', 'node']) {
      const found = find(record[key], depth + 1)
      if (found) return found
    }
    return undefined
  }
  const found = find(root, 0)
  return found ? safeRelative(found) : undefined
}

/** A path inside the package, never one that climbs out of it. */
function safeRelative(value: string): string | undefined {
  const normal = path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '')
  return normal.startsWith('..') || path.posix.isAbsolute(normal) ? undefined : normal
}

/** A package's entry file of declarations, and what it re-exports with `export … from` or references. */
async function entryFiles(dir: string, entry: string, allow: Allow): Promise<PackageFile[]> {
  const out: PackageFile[] = []
  const queue = [entry]
  const seen = new Set<string>()
  while (queue.length && out.length < MAX_ENTRY_FILES) {
    const relative = queue.shift()!
    if (seen.has(relative)) continue
    seen.add(relative)
    const absolute = path.join(dir, ...relative.split('/'))
    const text = await readFile(absolute, allow)
    if (text === undefined) continue
    out.push({ path: relative, absolute, text })
    const targets = [...text.matchAll(/^\s*export\s+(?:\*|\{[^}]*\}|\*\s+as\s+\w+)\s+from\s+['"](\.[^'"]+)['"]/gm), ...text.matchAll(/^\/\/\/\s*<reference\s+path=['"]([^'"]+)['"]/gm)].map((match) => match[1]!)
    for (const target of targets) {
      const base = safeRelative(path.posix.join(path.posix.dirname(relative), target))
      if (!base) continue
      const stem = base.replace(/\.(?:[cm]?js|d\.[cm]?ts)$/, '')
      for (const candidate of [`${stem}.d.ts`, `${stem}.d.mts`, `${stem}.d.cts`, `${stem}/index.d.ts`, base]) {
        if (DECLARATION_FILE.test(candidate) && (await exists(path.join(dir, ...candidate.split('/'))))) {
          queue.push(candidate)
          break
        }
      }
    }
  }
  return out
}

const syntaxOf = (file: string): Syntax => {
  switch (languageOf(file)) {
    case 'python':
      return SYNTAX.python
    case 'lua':
      return SYNTAX.lua
    case 'rust':
      return SYNTAX.rust
    case 'go':
      return SYNTAX.go
    default:
      return SYNTAX.js
  }
}

/** The comment lines just above a definition: JSDoc, `///`, `//`, `---`, `#`. */
function docAbove(lines: readonly string[], index: number, language: string): string[] {
  const out: string[] = []
  let at = index - 1
  // Decorators and attributes belong to the declaration.
  while (at >= 0 && /^\s*(?:@\w|#\[)/.test(lines[at]!)) at--
  if (at >= 0 && /\*\/\s*$/.test(lines[at]!)) {
    while (at >= 0 && out.length < DOC_LINES * 4) {
      out.unshift(lines[at]!)
      if (/^\s*\/\*/.test(lines[at]!)) break
      at--
    }
    return trimDoc(out)
  }
  const marker = language === 'lua' ? /^\s*--/ : language === 'python' || language === 'ruby' || language === 'shell' ? /^\s*#/ : /^\s*\/\//
  while (at >= 0 && marker.test(lines[at]!) && out.length < DOC_LINES * 4) out.unshift(lines[at--]!)
  return trimDoc(out)
}

/** A long comment keeps its start: what the thing is and its parameters come first. */
function trimDoc(lines: string[]): string[] {
  if (lines.length <= DOC_LINES) return lines
  return [...lines.slice(0, DOC_LINES - 1), `${/^\s*/.exec(lines[0]!)?.[0] ?? ''}… (${lines.length - DOC_LINES + 1} more lines of documentation)`]
}

/** Python's docstring, the lines after the `def` or `class` line. */
function docstringBelow(lines: readonly string[], index: number): string[] {
  let at = index + 1
  while (at < lines.length && !/:\s*(#.*)?$/.test(lines[at - 1]!) && at < index + SIGNATURE_LINES) at++
  const first = lines[at]
  if (!first || !/^\s*[rRuUbB]?("""|''')/.test(first)) return []
  const quote = /("""|''')/.exec(first)![1]!
  const out = [first]
  if (first.split(quote).length > 2) return out
  for (at++; at < lines.length && out.length < DOC_LINES; at++) {
    out.push(lines[at]!)
    if (lines[at]!.includes(quote)) return out
  }
  return trimDoc(out)
}

/** The declaration's own lines: a signature, or a body that is its API, within limits. */
function declarationLines(file: PackageFile, definition: Definition, members: readonly Definition[]): string[] {
  const lines = file.text.split('\n').map((line) => line.replace(/\r$/, ''))
  const code = codeOnly(file.text, syntaxOf(file.path)).split('\n')
  const start = definition.line - 1
  const language = languageOf(file.path) ?? ''
  const declarationFile = DECLARATION_FILE.test(file.path)
  const container = CONTAINERS.has(definition.kind)
  // Indentation: Python, and anything without braces, to the line before the body.
  if (language === 'python') {
    const out: string[] = []
    for (let at = start; at < lines.length && out.length < SIGNATURE_LINES; at++) {
      out.push(lines[at]!)
      if (/:\s*(#.*)?$/.test(code[at]!)) break
    }
    out.push(...docstringBelow(lines, start + out.length - 1))
    if (container) for (const member of members) out.push(lines[member.line - 1] ?? '')
    return out
  }
  if (language === 'lua') return [lines[start]!]
  // Braces: to the end of the signature, or to the end of a body that is the API.
  const wholeBody = declarationFile || BODY_IS_API.has(definition.kind)
  const out: string[] = []
  let depth = 0
  let opened = false
  const limit = wholeBody ? BODY_LINES : SIGNATURE_LINES
  for (let at = start; at < lines.length; at++) {
    const line = code[at] ?? ''
    if (!wholeBody && opened) break
    out.push(lines[at]!)
    for (const char of line) {
      if (char === '{') {
        depth++
        opened = true
      } else if (char === '}') depth--
    }
    if (opened && depth <= 0) break
    if (!opened && /;\s*$/.test(line) && depth <= 0) break
    if (out.length >= limit) {
      // A body too long to show whole: its header, then a line for each member.
      if (container && members.length) return [...out.slice(0, headerLength(code, start, out.length)), ...memberLines(lines, members)]
      out.push(`${/^\s*/.exec(lines[start]!)?.[0] ?? ''}  … (more in ${file.path})`)
      break
    }
  }
  // A class in source code: its header, then its members' lines rather than their bodies.
  if (container && !wholeBody && members.length) out.push(...memberLines(lines, members))
  return out
}

/** The lines of a declaration up to the one that opens its body. */
function headerLength(code: readonly string[], start: number, shown: number): number {
  for (let at = start; at < start + shown; at++) if ((code[at] ?? '').includes('{')) return at - start + 1
  return 1
}

/** A member's first line each, overloads of one name as one line with their count (an event's `on`, `once`, `off`). */
function memberLines(lines: readonly string[], members: readonly Definition[]): string[] {
  const byName = new Map<string, { line: string; forms: number }>()
  for (const member of members) {
    const known = byName.get(member.name)
    if (known) known.forms++
    else byName.set(member.name, { line: (lines[member.line - 1] ?? '').trimEnd().slice(0, 200), forms: 1 })
  }
  const out = [...byName.values()].slice(0, BODY_LINES).map(({ line, forms }) => (forms > 1 ? `${line} (${forms} forms)` : line))
  if (byName.size > BODY_LINES) out.push(`  … and ${byName.size - BODY_LINES} more members (symbol ${members[0]!.parent ?? 'Class'}.member shows one)`)
  return out
}

export interface PackageLookup {
  pkg: InstalledPackage
  /** A file or folder as the agent names it: relative to the folder it works in when inside it. */
  display(absolute: string): string
  /** Where the agent works and the project's root, to find `@types` packages as Node would. */
  from?: string
  root?: string
  /** False for a file the person's rules forbid reading: it is left out, as from the project's map. */
  readable?(absolute: string): boolean
}

/** The header of every answer: the name, the version and where it is. */
function header(lookup: PackageLookup, types?: Types): string {
  const { pkg } = lookup
  const where = pkg.dir ? shownPath(lookup, pkg.dir) : 'nowhere'
  const kind = { npm: 'npm', python: 'Python', cargo: 'Rust crate', go: 'Go module', fivem: 'FiveM resource' }[pkg.ecosystem]
  const version = pkg.version ? ` ${pkg.version}` : ''
  const typesNote = types?.from ? `, types from ${types.from}${types.version ? ` ${types.version}` : ''}` : ''
  return `${pkg.name}${version} (${kind}, installed at ${where}${typesNote})`
}

/** What a package exports, by file and line, from its entry; the start of its README when it has no declarations. */
export async function packageOverview(lookup: PackageLookup, maxChars: number, signal?: AbortSignal): Promise<string> {
  const { pkg } = lookup
  if (!pkg.dir) return `${pkg.name}${pkg.version ? ` ${pkg.version}` : ''} is named by the project but not installed, so its code cannot be read. Install the project's dependencies, then ask again.`
  const types = pkg.ecosystem === 'npm' ? await npmTypes(lookup) : undefined
  let files: PackageFile[]
  const allow = allowIn(types?.dir ?? pkg.dir, lookup.readable)
  if (types?.entry) files = await entryFiles(types.dir, types.entry, allow)
  else {
    const all = await packageFiles(pkg, pkg.dir, allow, signal)
    const entry = (file: string) => /^(?:__init__\.pyi?|src\/lib\.rs|lib\.rs|index\.[cm]?[jt]s|main\.[cm]?js|fxmanifest\.lua)$/.test(file) || (pkg.ecosystem === 'go' && !file.includes('/'))
    files = all.filter((file) => entry(file.path))
    if (!files.length) files = all.slice(0, MAX_ENTRY_FILES)
  }
  const lines = [header(lookup, types), 'Exports, by file and line (CodeMap with package and symbol shows one with its documentation):']
  let length = lines.join('\n').length
  // What a package is used for comes first: its functions and classes, then its interfaces, then the rest.
  const found: { file: PackageFile; definition: Definition; order: number }[] = []
  const forms = new Map<Definition, number>()
  files.forEach((file, fileOrder) => {
    // Overloads of one name are one entry.
    const first = new Map<string, Definition>()
    for (const definition of extract(file.path, file.text)?.definitions ?? []) {
      if (!isExported(pkg, file, definition)) continue
      const key = `${definition.parent ?? ''}\u0000${definition.name}\u0000${definition.kind}`
      const known = first.get(key)
      if (known) {
        forms.set(known, (forms.get(known) ?? 1) + 1)
        continue
      }
      first.set(key, definition)
      found.push({ file, definition, order: fileOrder })
    }
  })
  const total = found.length
  const chosen: typeof found = []
  for (const entry of [...found].sort((a, b) => (KIND_ORDER[a.definition.kind] ?? 5) - (KIND_ORDER[b.definition.kind] ?? 5) || a.order - b.order || a.definition.line - b.definition.line)) {
    const line = `    ${entry.definition.line} ${entry.definition.text}`
    if (length + line.length + 1 > maxChars - 200) break
    chosen.push(entry)
    length += line.length + 1
  }
  for (const file of files) {
    const own = chosen.filter((entry) => entry.file === file).sort((a, b) => a.definition.line - b.definition.line)
    if (!own.length) continue
    lines.push(shownPath(lookup, file.absolute, types))
    for (const { definition } of own) lines.push(`${definition.parent ? '    ' : '  '}${definition.line} ${definition.text}${(forms.get(definition) ?? 1) > 1 ? ` (${forms.get(definition)} forms)` : ''}`)
  }
  const shown = chosen.length
  if (!total) {
    const intro = await readmeOf(pkg.dir, allowIn(pkg.dir, lookup.readable))
    lines[1] = intro ? 'No declarations found to list; the start of its README:' : 'No declarations found in its files.'
    if (intro) lines.push(intro.slice(0, Math.max(0, maxChars - length - 10)))
  } else if (shown < total) lines.push(`(${shown} of ${total} shown; ask with query for the ones about a subject.)`)
  return lines.join('\n')
}

/** Go exports what starts with a capital; Python's names starting with `_` are private; the rest as the index reads it. */
function isExported(pkg: InstalledPackage, file: PackageFile, definition: Definition): boolean {
  if (definition.heading) return false
  if (pkg.ecosystem === 'go') return /^[A-Z]/.test(definition.name)
  if (pkg.ecosystem === 'python') return !definition.name.startsWith('_') || /^__\w+__$/.test(definition.name)
  if (pkg.ecosystem === 'cargo') return /^\s*pub\b/.test(definition.text) || definition.kind === 'method'
  return !definition.private || DECLARATION_FILE.test(file.path)
}

async function readmeOf(dir: string, allow: Allow): Promise<string | undefined> {
  for (const name of ['README.md', 'readme.md', 'README.rst', 'README', 'README.txt']) {
    const text = await readFile(path.join(dir, name), allow)
    if (!text) continue
    // Badges and pictures say nothing about the API.
    return text
      .replace(/^\s*(?:\[!\[[^\n]*|!\[[^\n]*|<img[^\n]*|<p[^\n]*>|<\/p>)\s*$/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
  return undefined
}

/** Where `symbol` is declared in the package, each with its documentation and its declaration. */
export async function packageSymbol(lookup: PackageLookup, symbol: string, maxChars: number, signal?: AbortSignal): Promise<string> {
  const { pkg } = lookup
  if (!pkg.dir) return `${pkg.name} is not installed, so its code cannot be read.`
  const types = pkg.ecosystem === 'npm' ? await npmTypes(lookup) : undefined
  const dir = types?.dir ?? pkg.dir
  const files = await packageFiles(pkg, dir, allowIn(dir, lookup.readable), signal)
  const [parent, name] = splitSymbol(symbol)
  const matches: { file: PackageFile; definition: Definition; members: Definition[] }[] = []
  for (const file of files) {
    const found = extract(file.path, file.text)
    if (!found) continue
    for (const definition of found.definitions) {
      if (definition.heading || definition.name !== name || (parent && definition.parent !== parent)) continue
      const members = found.definitions.filter((other) => other.parent === definition.name && other.line > definition.line && !other.heading)
      matches.push({ file, definition, members })
    }
  }
  if (!matches.length) {
    // Names that hold the name asked for, or one of its words: `alphaWalk` brings `alphaRun`.
    const near = new Set<string>()
    const key = name.toLowerCase()
    const parts = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length >= 4)
    for (const file of files) {
      for (const definition of extract(file.path, file.text)?.definitions ?? []) {
        const other = definition.name.toLowerCase()
        if (near.size < 12 && !definition.heading && (other.includes(key) || parts.some((part) => other.includes(part)))) near.add(definition.parent ? `${definition.parent}.${definition.name}` : definition.name)
      }
    }
    return `${header(lookup, types)}\nNothing named ${symbol} is declared in it${near.size ? `. Names like it: ${[...near].join(', ')}` : ''}. It may not exist in this version.`
  }
  // Declarations first; overloads of one name stay together.
  matches.sort((a, b) => Number(DECLARATION_FILE.test(b.file.path)) - Number(DECLARATION_FILE.test(a.file.path)) || byDepth(a.file.path, b.file.path) || a.definition.line - b.definition.line)
  const out = [header(lookup, types)]
  let length = out[0]!.length
  let shown = 0
  let previous: { file: PackageFile; end: number } | undefined
  for (const { file, definition, members } of matches.slice(0, MAX_MATCHES * 3)) {
    const lines = file.text.split('\n').map((line) => line.replace(/\r$/, ''))
    const doc = docAbove(lines, definition.line - 1, languageOf(file.path) ?? '')
    const declaration = declarationLines(file, definition, members)
    // An overload right after the one before, with no documentation of its own, joins it.
    if (previous?.file === file && !doc.length && definition.line - previous.end <= 1 && out.length > 1) {
      const added = declaration.join('\n')
      if (length + added.length + 1 > maxChars) break
      out[out.length - 1] += `\n${added}`
      length += added.length + 1
      previous = { file, end: definition.line + declaration.length - 1 }
      shown++
      continue
    }
    if (shown >= MAX_MATCHES && out.length > MAX_MATCHES) break
    const where = `${shownPath(lookup, file.absolute, types)}:${definition.line}`
    const block = [where, ...doc, ...declaration].join('\n')
    if (shown && length + block.length + 2 > maxChars) break
    out.push(block.length > maxChars - length ? `${block.slice(0, maxChars - length - 2)}…` : block)
    length += block.length + 2
    previous = { file, end: definition.line + declaration.length - 1 }
    shown++
  }
  if (matches.length > shown) out.push(`(${matches.length - shown} more declarations of ${symbol})`)
  return out.join('\n\n')
}

/** `Foo.bar`, `Foo::bar` or `Foo:bar` is the member bar of Foo. */
function splitSymbol(symbol: string): [string | undefined, string] {
  const match = /^(.+?)(?:::|\.|:)([A-Za-z_$][\w$]*)$/.exec(symbol.trim())
  return match ? [match[1], match[2]!] : [undefined, symbol.trim()]
}

/** The package's declarations whose names hold the words of a query, the closest first. */
export async function packageQuery(lookup: PackageLookup, terms: readonly string[], maxChars: number, signal?: AbortSignal): Promise<string> {
  const { pkg } = lookup
  if (!pkg.dir) return `${pkg.name} is not installed, so its code cannot be read.`
  const types = pkg.ecosystem === 'npm' ? await npmTypes(lookup) : undefined
  const dir = types?.dir ?? pkg.dir
  const files = await packageFiles(pkg, dir, allowIn(dir, lookup.readable), signal)
  const words = terms.map((term) => term.toLowerCase()).filter((term) => term.length >= 2)
  const joined = words.join('')
  interface Hit {
    file: PackageFile
    definition: Definition
    score: number
    overloads: number
  }
  const byKey = new Map<string, Hit>()
  for (const file of files) {
    for (const definition of extract(file.path, file.text)?.definitions ?? []) {
      if (!isExported(pkg, file, definition)) continue
      const name = definition.name.toLowerCase()
      const parent = (definition.parent ?? '').toLowerCase()
      // A word in the name counts for more than one in the name of what holds it: BrowserWindow before its members.
      const inName = words.filter((word) => name.includes(word)).length
      const inParent = words.filter((word) => !name.includes(word) && parent.includes(word)).length
      if (!inName && !inParent) continue
      const exact = name === joined || words.includes(name) ? 25 : 0
      const score = inName * 10 + inParent * 3 + exact + (CONTAINERS.has(definition.kind) ? 3 : 0) - file.path.split('/').length - (DECLARATION_FILE.test(file.path) ? 0 : 1)
      const key = `${file.path}\u0000${parent}\u0000${name}`
      const known = byKey.get(key)
      if (known) known.overloads++
      else byKey.set(key, { file, definition, score, overloads: 1 })
    }
  }
  let hits = [...byKey.values()].sort((a, b) => b.score - a.score)
  // Members found only by the name of what holds them come in only when the names themselves find few.
  const named = hits.filter((hit) => words.some((word) => hit.definition.name.toLowerCase().includes(word)))
  if (named.length >= 10) hits = named
  const out = [header(lookup, types)]
  if (!hits.length) return `${out[0]}\nNo declaration's name holds ${words.join(' or ')}. CodeMap with the package alone lists what it exports.`
  // By file, the best first, each file's in line order.
  const chosen: Hit[] = []
  let length = out[0]!.length
  for (const hit of hits) {
    const line = `  ${hit.definition.line} ${hit.definition.text}`
    if (length + line.length + 60 > maxChars) break
    chosen.push(hit)
    length += line.length + 1
  }
  const shownFiles = [...new Set(chosen.map((hit) => hit.file))]
  for (const file of shownFiles) {
    out.push(shownPath(lookup, file.absolute, types))
    for (const hit of chosen.filter((entry) => entry.file === file).sort((a, b) => a.definition.line - b.definition.line)) {
      const member = hit.definition.parent ? `${hit.definition.parent}.` : ''
      const text = member && !hit.definition.text.includes(hit.definition.parent!) ? `${hit.definition.text}  (in ${hit.definition.parent})` : hit.definition.text
      out.push(`  ${hit.definition.line} ${text}${hit.overloads > 1 ? ` (${hit.overloads} forms)` : ''}`)
    }
  }
  if (chosen.length < hits.length) out.push(`(${chosen.length} of ${hits.length} shown)`)
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// FiveM's natives

const SIDE: Record<NativeDoc['side'], string> = { client: 'client only', server: 'server only', both: 'client and server' }

function nativeSignature(native: Pick<NativeDoc, 'name' | 'params' | 'returns'>): string {
  const params = native.params.map((param) => `${param.name}${param.optional ? '?' : ''}: ${param.type}`).join(', ')
  return `${native.name}(${params})${native.returns.length ? `: ${native.returns.join(', ')}` : ''}`
}

/** One native in full: its form on each side, what it does, and its parameters. */
export function renderNative(native: NativeDoc): string {
  const out = [`${native.name}: a FiveM native, ${SIDE[native.side]}.`, nativeSignature(native)]
  if (native.server) out.push(`On the server: ${nativeSignature({ ...native.server, name: native.name })}`)
  if (native.aliasOf) out.push(`Another name of ${native.aliasOf}; use that one.`)
  const doc = native.doc.join('\n').trim()
  if (doc) out.push(doc.length > 2_400 ? `${doc.slice(0, 2_399)}…` : doc)
  const params = native.params.filter((param) => param.doc)
  if (params.length) out.push(...params.map((param) => `- ${param.name}: ${param.doc}`))
  if (native.returnDoc) out.push(`Returns: ${native.returnDoc}`)
  return out.join('\n')
}

/** `GetEntityCoords` → get entity coords. */
const wordsOf = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase()

/** The natives whose names hold the words of a query, or else whose descriptions do. */
export function searchNatives(natives: readonly NativeDoc[], query: string, maxChars: number): string {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 2)
  if (!words.length) return 'Name a native, or give words to search the natives for.'
  const scored: { native: NativeDoc; score: number }[] = []
  for (const native of natives) {
    if (native.aliasOf) continue
    const name = wordsOf(native.name)
    const inName = words.filter((word) => name.includes(word)).length
    const doc = inName === words.length ? 0 : words.filter((word) => native.doc.join(' ').toLowerCase().includes(word)).length
    const score = inName * 10 + doc - (native.name.startsWith('_') || native.name.startsWith('N_') ? 5 : 0) - native.name.length / 100
    if (inName === words.length || inName + doc === words.length) scored.push({ native, score })
  }
  scored.sort((a, b) => b.score - a.score)
  if (!scored.length) return `No FiveM native's name or description holds ${words.join(' and ')}.`
  const out = [`FiveM natives for "${words.join(' ')}" (CodeMap with symbol shows one in full):`]
  let length = out[0]!.length
  for (const { native } of scored) {
    const first = native.doc.find((line) => line.trim() && !/^[A-Z0-9_]+$/.test(line.trim()))?.trim() ?? ''
    const line = `${nativeSignature(native)} (${native.side})${first ? `: ${first.length > 90 ? `${first.slice(0, 89)}…` : first}` : ''}`
    if (length + line.length + 1 > maxChars - 40) break
    out.push(line)
    length += line.length + 1
  }
  if (out.length - 1 < scored.length) out.push(`(${out.length - 1} of ${scored.length} shown)`)
  return out.join('\n')
}

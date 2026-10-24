/**
 * CodeMap (ADR 0090): where things are defined in the project, without reading its files. A map of the definitions
 * that matter most, for the project, a folder or the words of the work; every definition of one file, as an outline
 * to read by line range; or where one name is defined and which files use it.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fail } from '../files'
import { displayPath, realPathOf, resolveInputPath, toPosix } from '../paths'
import { plural } from '../text'
import type { Tool, ToolContext } from '../types'
import { languageOf } from './extract'
import { packageOverview, packageQuery, packageSymbol, renderNative, searchNatives } from './package-docs'
import { findPackage, type InstalledPackage } from './packages'
import { definitionsOf, outline, renderMap, termsOf, usersOf } from './rank'

interface CodeMapInput extends Record<string, unknown> {
  path?: string
  query?: string
  symbol?: string
  package?: string
}

/** The name that asks for FiveM's natives rather than a package. */
const NATIVES = 'natives'
const PACKAGE_CHARS = 8_000

/** What one call shows. */
const MAP_CHARS = 6_000
const OUTLINE_CHARS = 12_000
const SHOWN_DEFINITIONS = 30
const SHOWN_USERS = 20

const workdir = (ctx: ToolContext) => ctx.cwd ?? ctx.root

function targetOf(input: CodeMapInput, ctx: ToolContext): string {
  const raw = typeof input.path === 'string' ? input.path.trim() : ''
  return raw ? resolveInputPath(raw, { root: workdir(ctx), home: ctx.home, platform: ctx.platform }) : workdir(ctx)
}

export const codeMapTool: Tool<CodeMapInput> = {
  brief:
    "Where things are defined, by line, without reading files (and FiveM events, commands, callbacks, exports). No input: the most used. path: a folder or a file. query: names to center on. symbol: one name's definition and users. package: an installed dependency's API (npm, Python, Rust, Go, FiveM) or FiveM's natives. Matches names, not meaning.",
  definition: {
    name: 'CodeMap',
    description: [
      'Shows where things are defined, by line, without reading files: classes, functions, methods, types and constants (and FiveM events, commands, callbacks, exports).',
      '- No input: the most used definitions.',
      '- path: a folder, or one file (all its definitions, to Read by line range).',
      '- query: words or names to center the map on.',
      '- symbol: one exact name: where it is defined, which files use it.',
      '- package: an installed dependency (npm, Python, Rust, Go, FiveM) or natives (FiveM\'s): its API at the installed version; with symbol or query, only those.',
      'Cheaper than reading files. It matches names, not meaning.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A folder or a file; omit for the project.' },
        query: { type: 'string' },
        symbol: { type: 'string', minLength: 1 },
        package: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  kind: 'read',
  readOnly: true,
  async access(input, ctx) {
    const name = input.package?.trim()
    // The natives are eNCode's own data; a package is read where it is installed, which may be outside the folder.
    if (name?.toLowerCase() === NATIVES) return { type: 'none' }
    const pkg = name ? await installed(name, ctx) : undefined
    return { type: 'read', paths: [pkg?.dir ?? (await realPathOf(targetOf(input, ctx)))] }
  },
  describe(input, ctx) {
    const name = input.package?.trim()
    if (name) return { title: input.symbol?.trim() ? `Look up ${input.symbol.trim()} in ${name}` : `Read the API of ${name}${input.query?.trim() ? ` for ${input.query.trim()}` : ''}` }
    const target = targetOf(input, ctx)
    const where = target === workdir(ctx) ? '' : ` of ${displayPath(target, { root: workdir(ctx), platform: ctx.platform })}`
    if (input.symbol?.trim()) return { title: `Find ${input.symbol.trim()}${where ? ` in ${where.slice(4)}` : ''}` }
    return { title: `Map the code${where}${input.query?.trim() ? ` for ${input.query.trim()}` : ''}` }
  },
  async run(input, ctx) {
    if (input.package?.trim()) return lookUpPackage(input, ctx)
    if (!ctx.codeMap) return fail('The code map is not available here. Use Glob and Grep to find code.')
    const dir = workdir(ctx)
    const target = targetOf(input, ctx)
    const relative = toPosix(path.relative(dir, target))
    if (relative.startsWith('..') || path.isAbsolute(relative)) return fail(`${displayPath(target, { root: dir, platform: ctx.platform })} is outside the folder the agent works in; the code map covers that folder only.`)
    let isFile = false
    try {
      isFile = (await fs.stat(target)).isFile()
    } catch {
      return fail(`${relative || '.'} does not exist.`)
    }

    const index = await ctx.codeMap.files(dir, ctx.signal)
    const partial = index.truncated ? '\nThe folder has more source files than the map reads; files past them are not in it.' : ''
    const files = index.files
    const symbol = input.symbol?.trim()
    if (!files.length && !symbol) return { ok: true, content: `No definitions found: the folder has no source files in a language the code map reads.${partial}` }

    if (symbol) {
      const scope = isFile ? files.filter((file) => file.path === relative) : files.filter((file) => !relative || file.path === relative || file.path.startsWith(`${relative}/`))
      const found = definitionsOf(scope, symbol)
      const users = usersOf(scope, found[0]?.definition.name ?? symbol).filter((user) => !found.some((place) => place.path === user.path && user.uses === 1))
      const lines: string[] = []
      if (found.length) {
        lines.push(found[0].definition.name === symbol ? `${symbol} is defined at:` : `No definition is named exactly ${symbol}; in another case:`)
        for (const { path: file, definition } of found.slice(0, SHOWN_DEFINITIONS)) lines.push(`${file}:${definition.line} ${definition.text}`)
        if (found.length > SHOWN_DEFINITIONS) lines.push(`… and ${found.length - SHOWN_DEFINITIONS} more.`)
      } else {
        // A FiveM native is no definition of the project's, but it is what the name means there.
        const native = ctx.codeMap.natives?.()?.find((entry) => entry.name === symbol)
        if (native) return { ok: true, content: renderNative(native), display: { output: 'FiveM native' } }
        lines.push(`No definition of ${symbol} in the code map. It holds the classes, functions, methods, types and constants of source files; Grep finds any text.`)
      }
      if (users.length) {
        const shown = users.slice(0, SHOWN_USERS).map((user) => `${user.path} (${user.uses})`)
        lines.push(`Used by name in ${plural(users.length, 'file')}: ${shown.join(', ')}${users.length > SHOWN_USERS ? ', …' : ''}.`)
        if (ctx.code) lines.push('A name used in a file may be another thing of the same name; the LSP tool (findReferences) tells them apart.')
      }
      return { ok: true, content: lines.join('\n') + partial, display: { output: found.length ? plural(found.length, 'definition') : 'Not found' } }
    }

    if (isFile) {
      const file = files.find((entry) => entry.path === relative)
      if (!file) {
        const reason = languageOf(relative) ? 'is not in the code map (it is ignored, too large or generated)' : 'is not a source file the code map reads'
        return { ok: true, content: `${relative} ${reason}.${ctx.code ? ' The LSP tool (documentSymbol) outlines files its servers know.' : ''} Read it instead.` }
      }
      if (!file.definitions.length) return { ok: true, content: `No definitions found in ${relative}.` }
      const made = outline(file, OUTLINE_CHARS)
      const more = made.shown < file.definitions.length ? `\n(${made.shown} of ${file.definitions.length} definitions shown; Read the file by line range for the rest.)` : ''
      return { ok: true, content: `${relative}, ${plural(file.definitions.length, 'definition')} (line, then the line as written):\n${made.text}${more}`, display: { output: plural(file.definitions.length, 'definition') } }
    }

    const terms = input.query ? termsOf(input.query) : []
    const map = renderMap(files, { within: relative, terms, ...(relative ? { focus: [relative] } : {}), maxChars: MAP_CHARS })
    if (!map.shownDefinitions) return { ok: true, content: `No definitions found${relative ? ` in ${relative}` : ''}.${partial}` }
    const more = map.shownFiles < map.files ? `\n(${plural(map.shownDefinitions, 'definition')} in ${map.shownFiles} of ${map.files} files with definitions. Narrow it with path or query, or name one file for all of its definitions.)` : ''
    return { ok: true, content: `${map.text}${more}${partial}`, display: { output: `${plural(map.shownDefinitions, 'definition')} in ${plural(map.shownFiles, 'file')}` } }
  },
}

const installed = (name: string, ctx: ToolContext): Promise<InstalledPackage | undefined> =>
  findPackage(ctx.root, workdir(ctx), name, { home: ctx.home, platform: ctx.platform, env: process.env })

async function lookUpPackage(input: CodeMapInput, ctx: ToolContext) {
  const name = input.package!.trim()
  const symbol = input.symbol?.trim()
  const query = input.query?.trim()
  if (name.toLowerCase() === NATIVES) {
    const natives = ctx.codeMap?.natives?.()
    if (!natives) return fail("FiveM's natives are not installed. They are installed from Settings > Language servers (FiveM natives); until then, WebFetch can read docs.fivem.net.")
    if (symbol) {
      const native = natives.find((entry) => entry.name === symbol) ?? natives.find((entry) => entry.name.toLowerCase() === symbol.toLowerCase())
      if (native) return { ok: true, content: renderNative(native), display: { output: 'FiveM native' } }
      return { ok: true, content: `No FiveM native is named ${symbol}.\n${searchNatives(natives, symbol.replace(/([a-z0-9])([A-Z])/g, '$1 $2'), PACKAGE_CHARS)}`, display: { output: 'Not found' } }
    }
    if (!query) return fail('Give symbol (a native\'s name) or query (words to search them for) with package natives.')
    return { ok: true, content: searchNatives(natives, query, PACKAGE_CHARS), display: { output: 'FiveM natives' } }
  }
  const pkg = await installed(name, ctx)
  if (!pkg) return { ok: true, content: `${name} is not a dependency the project has installed (looked in node_modules, the folder's virtual environments, Cargo.lock and go.mod, and FiveM's resources). Check the name as the manifest spells it.`, display: { output: 'Not found' } }
  const source = ctx.codeMap
  const lookup = { pkg, display: (absolute: string) => displayPath(absolute, { root: workdir(ctx), platform: ctx.platform }), from: workdir(ctx), root: ctx.root, ...(source?.readable ? { readable: (absolute: string) => source.readable!(absolute) } : {}) }
  const content = symbol ? await packageSymbol(lookup, symbol, PACKAGE_CHARS, ctx.signal) : query ? await packageQuery(lookup, termsOf(query).length ? termsOf(query) : query.split(/\s+/), PACKAGE_CHARS, ctx.signal) : await packageOverview(lookup, PACKAGE_CHARS, ctx.signal)
  return { ok: true, content, display: { output: `${pkg.name}${pkg.version ? ` ${pkg.version}` : ''}` } }
}

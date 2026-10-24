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
import { definitionsOf, outline, renderMap, termsOf, usersOf } from './rank'

interface CodeMapInput extends Record<string, unknown> {
  path?: string
  query?: string
  symbol?: string
}

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
  definition: {
    name: 'CodeMap',
    description: [
      "Shows where things are defined without reading files: each file's classes, functions, methods, types and constants (and FiveM events, commands, callbacks and exports), by line.",
      '- No input: the definitions most used across the project.',
      '- path: a folder, or one file (all its definitions, to Read by line range).',
      '- query: words or names to center the map on.',
      '- symbol: one exact name: where it is defined, which files use it.',
      'Cheaper than reading files to find code. It matches names, not meaning.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A folder or a file; omit for the project.' },
        query: { type: 'string' },
        symbol: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  kind: 'read',
  readOnly: true,
  async access(input, ctx) {
    return { type: 'read', paths: [await realPathOf(targetOf(input, ctx))] }
  },
  describe(input, ctx) {
    const target = targetOf(input, ctx)
    const where = target === workdir(ctx) ? '' : ` of ${displayPath(target, { root: workdir(ctx), platform: ctx.platform })}`
    if (input.symbol?.trim()) return { title: `Find ${input.symbol.trim()}${where ? ` in ${where.slice(4)}` : ''}` }
    return { title: `Map the code${where}${input.query?.trim() ? ` for ${input.query.trim()}` : ''}` }
  },
  async run(input, ctx) {
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
    if (!files.length) return { ok: true, content: `No definitions found: the folder has no source files in a language the code map reads.${partial}` }

    const symbol = input.symbol?.trim()
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

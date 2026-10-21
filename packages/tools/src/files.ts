/**
 * Read, Write, Edit and MultiEdit, with Claude Code's contracts: absolute
 * paths, `cat -n` output, read-before-write, exact-match edits.
 *
 * Writes keep a file's encoding (UTF-8, UTF-8 with a byte order mark, UTF-16
 * LE) and its CRLF line endings, refuse when the file changed since the agent
 * read it, and call `beforeWrite` first so checkpoints can save the old bytes.
 */
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ImageBlock, ImageMediaType, TextBlock } from '@encode/providers'
import { buildDiff } from './diff'
import { applyEdit, applyEdits, changedRegion, type EditSpec } from './edit'
import { stateOf, staleness } from './file-state'
import { displayPath, realPathOf, resolveInputPath } from './paths'
import { decodeText, encodeText, lineEndingOf, numberLines, plural, splitLines, type TextEncodingName } from './text'
import type { Tool, ToolContext, ToolOutcome } from './types'

export const READ_DEFAULT_LIMIT = 2000
const READ_MAX_CHARS = 256_000
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const SNIPPET_MAX_LINES = 40

const IMAGE_TYPES: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export function fail(content: string): ToolOutcome {
  return { ok: false, content }
}

function where(ctx: ToolContext) {
  return { root: ctx.root, home: ctx.home, platform: ctx.platform }
}

export function filePath(input: { file_path?: unknown }, ctx: ToolContext): string {
  return resolveInputPath(String(input.file_path ?? ''), where(ctx))
}

export function shown(file: string, ctx: ToolContext): string {
  return displayPath(file, where(ctx))
}

async function statOf(file: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

/** Names in the same folder that look like the missing one, to suggest instead. */
async function similarNames(file: string): Promise<string[]> {
  const dir = path.dirname(file)
  const base = path.basename(file).toLowerCase()
  const stem = base.replace(/\.[^.]*$/, '')
  try {
    const names = await fs.readdir(dir)
    return names.filter((name) => {
      const lower = name.toLowerCase()
      return lower === base || (stem.length > 2 && lower.replace(/\.[^.]*$/, '') === stem)
    })
  } catch {
    return []
  }
}

async function missingFile(file: string, ctx: ToolContext, advice: string): Promise<ToolOutcome> {
  const similar = await similarNames(file)
  const hint = similar.length ? ` Did you mean ${similar.map((name) => shown(path.join(path.dirname(file), name), ctx)).join(' or ')}?` : ''
  return fail(`${shown(file, ctx)} does not exist.${hint}${advice ? ` ${advice}` : ''}`)
}

interface Loaded {
  bytes: Buffer
  text: string
  encoding: TextEncodingName
}

/** The file's bytes and text, `null` when it does not exist, or a failure to report. */
async function loadForWrite(file: string, ctx: ToolContext): Promise<Loaded | null | ToolOutcome> {
  const stats = await statOf(file)
  if (!stats) return null
  if (stats.isDirectory()) return fail(`${shown(file, ctx)} is a directory, not a file.`)
  const bytes = await fs.readFile(file)
  const freshness = await staleness(ctx.files, file, bytes)
  if (freshness.kind === 'unread') return fail(`${shown(file, ctx)} has not been read in this session. Read it first, then try again.`)
  if (freshness.kind === 'changed') {
    return fail(`${shown(file, ctx)} changed since it was last read, by the user or another program. Read it again before changing it.`)
  }
  const decoded = decodeText(bytes)
  if (!decoded) return fail(`${shown(file, ctx)} is a binary file; it cannot be edited as text.`)
  return { bytes, ...decoded }
}

function isOutcome(value: unknown): value is ToolOutcome {
  return Boolean(value && typeof value === 'object' && 'ok' in value && 'content' in value)
}

/** Writes through the checkpoint seam and records what the agent now knows of the file. */
export async function writeFileBytes(ctx: ToolContext, file: string, bytes: Buffer, previous: Buffer | null): Promise<void> {
  if (ctx.signal.aborted) throw ctx.signal.reason
  await ctx.beforeWrite?.(file, previous, { turnId: ctx.turnId, toolUseId: ctx.toolUseId })
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, bytes)
  ctx.files.set(file, stateOf(bytes, await fs.stat(file), false))
}

/** New text in the file's own conventions: CRLF when the file uses it, and its encoding. */
function inFileStyle(text: string, loaded: Loaded | null): Buffer {
  if (!loaded) return encodeText(text, 'utf8')
  const crlf = lineEndingOf(loaded.text) === '\r\n'
  return encodeText(crlf && !text.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text, loaded.encoding)
}

function snippet(before: string, after: string): string {
  const region = changedRegion(before, after)
  if (!region) return ''
  const lines = splitLines(after)
  const end = Math.min(region.end, region.start + SNIPPET_MAX_LINES - 1)
  const body = numberLines(lines.slice(region.start - 1, end), region.start)
  return `${body}${end < region.end ? '\n… (more changed lines follow)' : ''}`
}

const pathSchema = { type: 'string', description: 'Absolute path of the file. A relative path resolves from the workspace root.' }

// ---------------------------------------------------------------------------
// Read

interface ReadInput extends Record<string, unknown> {
  file_path: string
  offset?: number
  limit?: number
}

function renderNotebook(text: string): string | undefined {
  let notebook: { cells?: { cell_type?: string; id?: string; source?: string | string[]; outputs?: Record<string, unknown>[] }[] }
  try {
    notebook = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!Array.isArray(notebook.cells)) return undefined
  const join = (value: unknown) => (Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : '')
  return notebook.cells
    .map((cell, index) => {
      const outputs = (cell.outputs ?? [])
        .map((output) => {
          if (output.output_type === 'stream') return join(output.text)
          if (output.output_type === 'error') return `${String(output.ename)}: ${String(output.evalue)}`
          const data = output.data as Record<string, unknown> | undefined
          if (data?.['text/plain']) return join(data['text/plain'])
          return data && Object.keys(data).some((type) => type.startsWith('image/')) ? '[image output]' : ''
        })
        .filter(Boolean)
        .join('\n')
      const id = cell.id ? ` id="${cell.id}"` : ''
      return `<cell index="${index}"${id} type="${cell.cell_type ?? 'code'}">\n${join(cell.source)}\n</cell>${outputs ? `\n<outputs index="${index}">\n${outputs}\n</outputs>` : ''}`
    })
    .join('\n\n')
}

export const readTool: Tool<ReadInput> = {
  definition: {
    name: 'Read',
    description: [
      'Reads a file from the local filesystem.',
      '',
      '- file_path should be absolute; a relative path resolves from the workspace root.',
      `- Reads up to ${READ_DEFAULT_LIMIT} lines from the start. For long files, pass offset (the 1-based line to start at) and limit (how many lines).`,
      '- Output is numbered like `cat -n`: spaces, the line number, a tab, then the line. The prefix is not part of the file; leave it out when you copy text into Edit.',
      '- Lines longer than 2000 characters are cut short.',
      '- PNG, JPEG, GIF and WebP images are returned as images you can see. Jupyter notebooks (.ipynb) are shown cell by cell with their outputs.',
      '- A file must be read in this session before Write or Edit can change it.',
      '- Read several files at once by calling Read more than once in the same reply.',
      '- Read reads files, not directories; use Glob, or ls through Bash, to list a directory.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        file_path: pathSchema,
        offset: { type: 'integer', minimum: 0, description: 'The 1-based line number to start reading at.' },
        limit: { type: 'integer', minimum: 1, description: 'How many lines to read.' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  kind: 'read',
  readOnly: true,
  async access(input, ctx) {
    return { type: 'read', paths: [await realPathOf(filePath(input, ctx))] }
  },
  describe(input, ctx) {
    return { title: `Read ${shown(filePath(input, ctx), ctx)}` }
  },
  async run(input, ctx) {
    const file = filePath(input, ctx)
    const stats = await statOf(file)
    if (!stats) return missingFile(file, ctx, '')
    if (stats.isDirectory()) return fail(`${shown(file, ctx)} is a directory. Use Glob to find files in it, or ls through Bash.`)
    const extension = path.extname(file).toLowerCase()

    const mediaType = IMAGE_TYPES[extension]
    if (mediaType) {
      if (stats.size > IMAGE_MAX_BYTES) return fail(`${shown(file, ctx)} is ${(stats.size / 1024 / 1024).toFixed(1)} MB; images over 5 MB cannot be read.`)
      const bytes = await fs.readFile(file)
      ctx.files.set(file, stateOf(bytes, stats, false))
      const blocks: (TextBlock | ImageBlock)[] = [
        { type: 'text', text: `Image ${shown(file, ctx)} (${Math.max(1, Math.round(bytes.length / 1024))} KB):` },
        { type: 'image', mediaType, data: bytes.toString('base64') },
      ]
      return { ok: true, content: blocks, display: { output: `Image, ${Math.max(1, Math.round(bytes.length / 1024))} KB` } }
    }
    if (extension === '.pdf') {
      return fail(`${shown(file, ctx)} is a PDF, which Read cannot show yet. If a converter such as pdftotext is installed, run it through Bash.`)
    }

    const bytes = await fs.readFile(file)
    const decoded = decodeText(bytes)
    if (!decoded) return fail(`${shown(file, ctx)} is a binary file (${plural(bytes.length, 'byte')}); it cannot be shown as text.`)

    if (extension === '.ipynb') {
      const rendered = renderNotebook(decoded.text)
      if (rendered !== undefined) {
        ctx.files.set(file, stateOf(bytes, stats, false))
        return { ok: true, content: rendered || `${shown(file, ctx)} has no cells.` }
      }
    }

    const lines = splitLines(decoded.text)
    if (!lines.length) {
      ctx.files.set(file, stateOf(bytes, stats, false))
      return { ok: true, content: `${shown(file, ctx)} exists but is empty.` }
    }
    const offset = Math.max(1, input.offset ?? 1)
    if (offset > lines.length) {
      return fail(`${shown(file, ctx)} has ${plural(lines.length, 'line')}, so offset ${offset} is past its end.`)
    }
    const limit = input.limit ?? READ_DEFAULT_LIMIT
    let end = Math.min(lines.length, offset - 1 + limit)
    let body = numberLines(lines.slice(offset - 1, end), offset)
    let cutForSize = false
    while (body.length > READ_MAX_CHARS && end > offset) {
      end = offset - 1 + Math.max(1, Math.floor((end - offset + 1) / 2))
      body = numberLines(lines.slice(offset - 1, end), offset)
      cutForSize = true
    }
    const partial = offset > 1 || end < lines.length
    ctx.files.set(file, stateOf(bytes, stats, partial))
    const note = partial
      ? `\n\n(Lines ${offset}-${end} of ${lines.length}${cutForSize ? ', shortened to fit' : ''}. Pass offset and limit to read other lines.)`
      : ''
    return { ok: true, content: body + note, display: { output: `${plural(end - offset + 1, 'line')}${partial ? ` of ${lines.length}` : ''}` } }
  },
}

// ---------------------------------------------------------------------------
// Write

interface WriteInput extends Record<string, unknown> {
  file_path: string
  content: string
}

async function currentText(file: string): Promise<string> {
  try {
    const decoded = decodeText(await fs.readFile(file))
    return decoded?.text ?? ''
  } catch {
    return ''
  }
}

export const writeTool: Tool<WriteInput> = {
  definition: {
    name: 'Write',
    description: [
      'Writes a file to the local filesystem, replacing it if it exists.',
      '',
      '- An existing file must have been read with Read in this session, or the write fails.',
      '- Prefer Edit for changes to an existing file; Write is for new files and complete rewrites.',
      '- Missing parent directories are created.',
      "- An existing file keeps its encoding and its CRLF line endings.",
      '- Do not create documentation or README files unless the user asked for them.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        file_path: pathSchema,
        content: { type: 'string', description: 'The complete contents of the file.' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
  },
  kind: 'write',
  readOnly: false,
  async access(input, ctx) {
    return { type: 'write', paths: [await realPathOf(filePath(input, ctx))] }
  },
  async describe(input, ctx) {
    const file = filePath(input, ctx)
    const before = await currentText(file)
    return {
      title: `Write ${shown(file, ctx)}`,
      detail: `${plural(splitLines(input.content).length, 'line')}`,
      preview: buildDiff(file, before, input.content),
    }
  },
  async run(input, ctx) {
    const file = filePath(input, ctx)
    const loaded = await loadForWrite(file, ctx)
    if (isOutcome(loaded)) return loaded
    const bytes = inFileStyle(input.content, loaded)
    await writeFileBytes(ctx, file, bytes, loaded?.bytes ?? null)
    const lines = splitLines(input.content).length
    return {
      ok: true,
      content: loaded ? `Updated ${shown(file, ctx)} (${plural(lines, 'line')}).` : `Created ${shown(file, ctx)} (${plural(lines, 'line')}).`,
      display: { diff: buildDiff(file, loaded?.text ?? '', input.content) },
      changed: [file],
    }
  },
}

// ---------------------------------------------------------------------------
// Edit and MultiEdit

interface EditInput extends Record<string, unknown> {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

interface MultiEditInput extends Record<string, unknown> {
  file_path: string
  edits: EditSpec[]
}

async function previewEdits(file: string, edits: EditSpec[]): Promise<{ before: string; after?: string }> {
  const before = await currentText(file)
  if (edits.length === 1 && !edits[0].old_string) return { before, after: edits[0].new_string }
  const outcome = applyEdits(before, edits)
  return { before, after: outcome.ok ? outcome.text : undefined }
}

async function runEdits(file: string, edits: EditSpec[], ctx: ToolContext): Promise<ToolOutcome> {
  const loaded = await loadForWrite(file, ctx)
  if (isOutcome(loaded)) return loaded
  const name = shown(file, ctx)

  // An empty old_string creates the file, or fills an empty one.
  if (edits.length === 1 && !edits[0].old_string) {
    if (loaded && loaded.text.trim()) return fail(`old_string is empty, but ${name} already has content. Give the exact text to replace.`)
    const text = edits[0].new_string
    await writeFileBytes(ctx, file, inFileStyle(text, loaded), loaded?.bytes ?? null)
    return { ok: true, content: `${loaded ? 'Filled' : 'Created'} ${name} (${plural(splitLines(text).length, 'line')}).`, display: { diff: buildDiff(file, loaded?.text ?? '', text) }, changed: [file] }
  }
  if (!loaded) return missingFile(file, ctx, 'Use Write to create a new file.')

  const outcome = applyEdits(loaded.text, edits)
  if (!outcome.ok) return fail(`${name}: ${outcome.error}`)
  await writeFileBytes(ctx, file, encodeText(outcome.text, loaded.encoding), loaded.bytes)
  const replaced = outcome.replacements > 1 ? ` (${outcome.replacements} replacements)` : ''
  const lines = snippet(loaded.text, outcome.text)
  return {
    ok: true,
    content: `Edited ${name}${replaced}.${lines ? ` The changed part now reads:\n${lines}` : ''}`,
    display: { diff: buildDiff(file, loaded.text, outcome.text) },
    changed: [file],
  }
}

const editProperties = {
  old_string: { type: 'string', description: 'The exact text to replace.' },
  new_string: { type: 'string', description: 'The text to put in its place; it must differ from old_string.' },
  replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one. Default false.' },
}

export const editTool: Tool<EditInput> = {
  definition: {
    name: 'Edit',
    description: [
      'Replaces exact text in a file.',
      '',
      '- The file must have been read with Read in this session.',
      "- old_string must match the file exactly, indentation included, without Read's line-number prefix.",
      '- old_string must occur exactly once, unless replace_all is true. Include neighbouring lines to make it unique.',
      '- Use replace_all to rename something throughout the file.',
      '- An empty old_string creates a new file whose content is new_string.',
      '- Keep the edit as small as the change; MultiEdit makes several changes to one file in one step.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: { file_path: pathSchema, ...editProperties },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  kind: 'write',
  readOnly: false,
  check(input) {
    return input.old_string === input.new_string ? 'old_string and new_string are identical, so there is nothing to change.' : undefined
  },
  async access(input, ctx) {
    return { type: 'write', paths: [await realPathOf(filePath(input, ctx))] }
  },
  async describe(input, ctx) {
    const file = filePath(input, ctx)
    const { before, after } = await previewEdits(file, [input])
    return {
      title: `Edit ${shown(file, ctx)}`,
      ...(after === undefined ? { detail: 'The text to replace was not found; the edit will fail.' } : { preview: buildDiff(file, before, after) }),
    }
  },
  run(input, ctx) {
    return runEdits(filePath(input, ctx), [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }], ctx)
  },
}

export const multiEditTool: Tool<MultiEditInput> = {
  definition: {
    name: 'MultiEdit',
    description: [
      'Makes several replacements in one file in a single step.',
      '',
      '- Each edit follows the rules of Edit, and applies to the text the edits before it produced.',
      '- Either every edit succeeds or none is applied.',
      '- The file must have been read with Read in this session.',
      '- Prefer it to several Edit calls on the same file.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        file_path: pathSchema,
        edits: {
          type: 'array',
          minItems: 1,
          items: { type: 'object', properties: editProperties, required: ['old_string', 'new_string'], additionalProperties: false },
          description: 'The replacements, applied in order.',
        },
      },
      required: ['file_path', 'edits'],
      additionalProperties: false,
    },
  },
  kind: 'write',
  readOnly: false,
  check(input) {
    const same = input.edits.findIndex((edit) => edit.old_string === edit.new_string)
    if (same !== -1) return `edits[${same}] has identical old_string and new_string.`
    if (input.edits.length > 1 && input.edits.some((edit) => !edit.old_string)) return 'only a single edit may have an empty old_string.'
    return undefined
  },
  async access(input, ctx) {
    return { type: 'write', paths: [await realPathOf(filePath(input, ctx))] }
  },
  async describe(input, ctx) {
    const file = filePath(input, ctx)
    const { before, after } = await previewEdits(file, input.edits)
    return {
      title: `Edit ${shown(file, ctx)}`,
      ...(after === undefined
        ? { detail: `${plural(input.edits.length, 'edit')}; one of them does not match, so none will apply.` }
        : { detail: plural(input.edits.length, 'edit'), preview: buildDiff(file, before, after) }),
    }
  },
  run(input, ctx) {
    return runEdits(filePath(input, ctx), input.edits, ctx)
  },
}

export { applyEdit }

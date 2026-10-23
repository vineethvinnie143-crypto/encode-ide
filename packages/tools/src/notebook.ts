/**
 * Jupyter notebooks: how Read shows one, and NotebookEdit, which changes one cell at a time.
 *
 * NotebookEdit splices the changed cell into the file's own text, so every other byte stays as it was: the
 * indentation, the key order, the line endings and how the file escapes characters. A diff of the notebook shows
 * only the cell that changed, the way Jupyter would have saved it. Only when the file's layout cannot be followed
 * (a duplicated "cells" key, say) is the notebook written out whole, in the indentation it used.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { buildDiff } from './diff'
import { currentText, fail, filePath, loadForWrite, shown, writeNotebook, type Loaded } from './files'
import { realPathOf } from './paths'
import { plural } from './text'
import type { Tool, ToolContext, ToolOutcome } from './types'

/** One output's text in a Read, before the middle is left out. */
const OUTPUT_MAX_CHARS = 3_000
/** Images in outputs make notebooks big; their text is what Read and NotebookEdit load. */
export const NOTEBOOK_MAX_BYTES = 64 * 1024 * 1024
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

type Source = string | string[]

interface Cell {
  cell_type?: string
  id?: string
  source?: Source
  outputs?: Record<string, unknown>[]
  [key: string]: unknown
}

interface Notebook {
  cells?: Cell[]
  nbformat?: number
  nbformat_minor?: number
  [key: string]: unknown
}

const joined = (value: unknown): string => (Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : '')

function clipped(text: string): string {
  const clean = text.replace(ANSI, '')
  if (clean.length <= OUTPUT_MAX_CHARS) return clean
  const head = clean.slice(0, 2_000)
  const tail = clean.slice(-800)
  return `${head}\n… (${clean.length - head.length - tail.length} characters left out) …\n${tail}`
}

function outputText(output: Record<string, unknown>): string {
  switch (output.output_type) {
    case 'stream':
      return clipped(joined(output.text))
    case 'error': {
      const trace = Array.isArray(output.traceback) ? output.traceback.map(String).join('\n') : ''
      return clipped(trace || `${String(output.ename)}: ${String(output.evalue)}`)
    }
    default: {
      const data = output.data as Record<string, unknown> | undefined
      if (!data) return ''
      if (data['text/plain'] !== undefined) return clipped(joined(data['text/plain']))
      if (data['text/markdown'] !== undefined) return clipped(joined(data['text/markdown']))
      const image = Object.keys(data).find((type) => type.startsWith('image/'))
      if (image) return `[${image} output]`
      return data['text/html'] !== undefined ? '[HTML output]' : ''
    }
  }
}

function parse(text: string): Notebook | undefined {
  try {
    const notebook = JSON.parse(text) as Notebook
    return notebook && typeof notebook === 'object' && Array.isArray(notebook.cells) ? notebook : undefined
  } catch {
    return undefined
  }
}

function renderCell(cell: Cell, index: number): string {
  const outputs = (Array.isArray(cell.outputs) ? cell.outputs : []).map(outputText).filter(Boolean).join('\n')
  const id = typeof cell.id === 'string' && cell.id ? ` id="${cell.id}"` : ''
  return `<cell index="${index}"${id} type="${cell.cell_type ?? 'code'}">\n${joined(cell.source)}\n</cell>${outputs ? `\n<outputs index="${index}">\n${outputs}\n</outputs>` : ''}`
}

export interface RenderedNotebook {
  text: string
  /** The first and one past the last cell shown, and how many the notebook has. */
  from: number
  to: number
  total: number
}

/**
 * The cells from `offset` (a cell index), as many as `limit` allows and `maxChars` holds; undefined when the text is
 * not a notebook Read can show.
 */
export function renderNotebook(text: string, options: { offset?: number; limit?: number; maxChars?: number } = {}): RenderedNotebook | undefined {
  const notebook = parse(text)
  if (!notebook?.cells) return undefined
  const total = notebook.cells.length
  const from = Math.min(Math.max(0, options.offset ?? 0), total)
  const last = Math.min(total, from + (options.limit ?? total))
  const parts: string[] = []
  let size = 0
  let to = from
  for (; to < last; to++) {
    const part = renderCell(notebook.cells[to], to)
    // The first cell is shown however long it is; past it, a cell that does not fit waits for the next read.
    if (parts.length && options.maxChars && size + part.length > options.maxChars) break
    parts.push(part)
    size += part.length + 2
  }
  return { text: parts.join('\n\n'), from, to, total }
}

// ---------------------------------------------------------------------------
// Where the cells are in the file's text

interface Span {
  start: number
  end: number
}

/** The text ranges of the top-level "cells" array and of each cell in it; undefined when they cannot be followed. */
function cellSpans(text: string): { open: number; close: number; cells: Span[] } | undefined {
  const n = text.length
  let i = 0
  const space = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++
  }
  const string = () => {
    i++
    while (i < n) {
      if (text[i] === '\\') i += 2
      else if (text[i++] === '"') return
    }
    throw new Error('unterminated string')
  }
  const value = () => {
    space()
    if (text[i] === '"') return string()
    if (text[i] === '{' || text[i] === '[') {
      let depth = 0
      while (i < n) {
        const c = text[i]
        if (c === '"') {
          string()
          continue
        }
        if (c === '{' || c === '[') depth++
        else if (c === '}' || c === ']') {
          i++
          if (--depth === 0) return
          continue
        }
        i++
      }
      throw new Error('unterminated value')
    }
    while (i < n && !',]} \t\r\n'.includes(text[i])) i++
  }
  try {
    space()
    if (text[i++] !== '{') return undefined
    let found: { open: number; close: number; cells: Span[] } | undefined
    for (;;) {
      space()
      if (text[i] === '}') return found
      if (text[i] !== '"') return undefined
      const keyStart = i
      string()
      const key = JSON.parse(text.slice(keyStart, i)) as string
      space()
      if (text[i++] !== ':') return undefined
      space()
      if (key === 'cells') {
        // JSON.parse keeps the last of two "cells"; the spans would not match it.
        if (found || text[i] !== '[') return undefined
        const open = i++
        const cells: Span[] = []
        for (;;) {
          space()
          if (text[i] === ']') break
          const start = i
          value()
          cells.push({ start, end: i })
          space()
          if (text[i] === ',') i++
          else if (text[i] !== ']') return undefined
        }
        found = { open, close: i++, cells }
      } else {
        value()
      }
      space()
      if (text[i] === ',') i++
      else if (text[i] !== '}') return undefined
    }
  } catch {
    return undefined
  }
}

/** The text's way of writing JSON, so a cell written into it looks like the cells around it. */
interface Layout {
  /** One level of indentation; '' when the file is on one line. */
  unit: string
  eol: string
  /** The file writes characters past ASCII as \u escapes. */
  ascii: boolean
}

function layoutOf(text: string): Layout {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const first = /^\{\r?\n([ \t]+)"/.exec(text)
  const unit = first ? first[1] : text.includes('\n') ? ' ' : ''
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\u0000-\u007f]*$/.test(text) && /\\u(?:00[89a-f]|0[1-9a-f][0-9a-f]|[1-9a-f][0-9a-f]{2})[0-9a-f]/i.test(text)
  return { unit, eol, ascii }
}

function written(value: unknown, layout: Layout, base: string): string {
  let json = layout.unit ? JSON.stringify(value, null, layout.unit) : JSON.stringify(value)
  if (layout.ascii) json = json.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return layout.unit ? json.split('\n').join(layout.eol + base) : json
}

/** The indentation in front of the cell that starts at `start`, when nothing else is on its line. */
function indentAt(text: string, start: number): string {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const before = text.slice(lineStart, start)
  return /^[ \t]*$/.test(before) ? before : ''
}

// ---------------------------------------------------------------------------
// NotebookEdit

type EditMode = 'replace' | 'insert' | 'delete'
type CellType = 'code' | 'markdown'

interface NotebookEditInput extends Record<string, unknown> {
  notebook_path: string
  cell_id?: string
  new_source?: string
  cell_type?: CellType
  edit_mode?: EditMode
}

/** A cell's source the way the notebook writes it: lines with their line breaks (as Jupyter saves), or one string. */
function sourceLike(text: string, asLines: boolean): Source {
  if (!asLines) return text
  return text ? text.split(/(?<=\n)/) : []
}

const sortedKeys = (cell: object): boolean => {
  const keys = Object.keys(cell)
  return keys.every((key, index) => index === 0 || keys[index - 1] <= key)
}

function inOrder(cell: Cell, sorted: boolean): Cell {
  if (!sorted) return cell
  return Object.fromEntries(Object.entries(cell).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as Cell
}

/** A cell's place from what the model gave: the cell's id, or its index ("3", or "cell-3" as Claude Code names them). */
function findCell(cells: readonly Cell[], id: string): number | undefined {
  const exact = cells.findIndex((cell) => cell.id === id)
  if (exact !== -1) return exact
  const index = /^\s*(?:cell-)?(\d+)\s*$/.exec(id)
  if (index && Number(index[1]) < cells.length) return Number(index[1])
  return undefined
}

function labelOf(cells: readonly Cell[], index: number): string {
  const id = cells[index]?.id
  return typeof id === 'string' && id ? `${index} (id ${id})` : String(index)
}

function cellsList(cells: readonly Cell[]): string {
  const listed = cells.slice(0, 20).map((cell, index) => labelOf(cells, index))
  return `${listed.join(', ')}${cells.length > 20 ? `, and ${cells.length - 20} more` : ''}`
}

function newCellId(cells: readonly Cell[]): string {
  const taken = new Set(cells.map((cell) => cell.id))
  for (;;) {
    const id = randomUUID().replace(/-/g, '').slice(0, 8)
    if (!taken.has(id)) return id
  }
}

interface Planned {
  /** The notebook's new text. */
  text: string
  /** What the model is told. */
  summary: string
}

/** The edit applied to the notebook's text, or why it cannot be. */
function plan(text: string, input: NotebookEditInput, name: string): Planned | { error: string } {
  const notebook = parse(text)
  if (!notebook) return { error: `${name} is not a notebook NotebookEdit can read: it is not JSON with a "cells" list.` }
  if (typeof notebook.nbformat === 'number' && notebook.nbformat < 4) {
    return { error: `${name} is in notebook format ${notebook.nbformat}; NotebookEdit edits format 4. Convert it with "jupyter nbconvert --to notebook" first.` }
  }
  const cells = notebook.cells!
  const mode: EditMode = input.edit_mode ?? 'replace'
  const id = typeof input.cell_id === 'string' && input.cell_id.trim() ? input.cell_id.trim() : undefined
  const index = id === undefined ? undefined : findCell(cells, id)
  if (id !== undefined && index === undefined) {
    return { error: `${name} has no cell ${JSON.stringify(id)}.${cells.length ? ` Its cells, by index: ${cellsList(cells)}.` : ' It has no cells.'}` }
  }
  if (mode !== 'insert' && index === undefined) return { error: `cell_id is required to ${mode} a cell. Read the notebook to see the cells' ids.` }
  if (mode !== 'delete' && typeof input.new_source !== 'string') return { error: `new_source is required to ${mode} a cell.` }

  const layout = layoutOf(text)
  const spans = cellSpans(text)
  const followed = spans && spans.cells.length === cells.length ? spans : undefined
  const asLines = cells.some((cell) => Array.isArray(cell.source)) || !cells.some((cell) => typeof cell.source === 'string')
  const withIds = (notebook.nbformat_minor ?? 0) >= 5 || cells.some((cell) => typeof cell.id === 'string')

  let next: Cell | undefined
  let at: number
  let summary: string
  if (mode === 'delete') {
    at = index!
    summary = `Deleted cell ${labelOf(cells, at)} from ${name}; ${plural(cells.length - 1, 'cell')} left.`
  } else if (mode === 'insert') {
    if (input.cell_type !== 'code' && input.cell_type !== 'markdown') return { error: 'cell_type is required to insert a cell: code or markdown.' }
    at = index === undefined ? 0 : index + 1
    const fresh: Cell = { cell_type: input.cell_type, ...(withIds ? { id: newCellId(cells) } : {}), metadata: {}, source: sourceLike(input.new_source!, asLines) }
    if (input.cell_type === 'code') Object.assign(fresh, { execution_count: null, outputs: [] })
    next = inOrder(fresh, true)
    summary = `Inserted a ${input.cell_type} cell${next.id ? ` (id ${next.id})` : ''} at index ${at} of ${name}.`
  } else {
    at = index!
    const old = cells[at]
    const type = input.cell_type ?? (old.cell_type === 'markdown' ? 'markdown' : old.cell_type === 'raw' ? 'raw' : 'code')
    const sameSource = joined(old.source) === input.new_source
    if (sameSource && type === (old.cell_type ?? 'code')) return { error: `Cell ${labelOf(cells, at)} already has that source and type; nothing changed.` }
    const changed: Cell = { ...old, cell_type: type, source: sourceLike(input.new_source!, Array.isArray(old.source) || (old.source === undefined && asLines)) }
    const hadOutputs = Array.isArray(old.outputs) && old.outputs.length > 0
    if (type === 'code') {
      // The outputs came from the old code: they would mislead the next read.
      changed.execution_count = null
      changed.outputs = []
      delete changed.attachments
    } else {
      delete changed.execution_count
      delete changed.outputs
    }
    next = inOrder(changed, sortedKeys(old))
    const notes = [
      type !== (old.cell_type ?? 'code') ? ` It is a ${type} cell now.` : '',
      hadOutputs && type === 'code' ? ' Its outputs were cleared, since they came from the old code.' : '',
    ]
    summary = `Replaced cell ${labelOf(cells, at)} of ${name}.${notes.join('')}`
  }

  if (!followed) {
    const all = [...cells]
    if (mode === 'delete') all.splice(at, 1)
    else if (mode === 'insert') all.splice(at, 0, next!)
    else all[at] = next!
    const whole = written({ ...notebook, cells: all }, layout, '')
    return { text: text.endsWith('\n') && !whole.endsWith('\n') ? whole + layout.eol : whole, summary }
  }

  const spansOf = followed.cells
  let result: string
  if (mode === 'replace') {
    const span = spansOf[at]
    result = text.slice(0, span.start) + written(next, layout, indentAt(text, span.start)) + text.slice(span.end)
  } else if (mode === 'delete') {
    const span = spansOf[at]
    if (spansOf.length === 1) result = text.slice(0, followed.open + 1) + text.slice(followed.close)
    else if (at + 1 < spansOf.length) result = text.slice(0, span.start) + text.slice(spansOf[at + 1].start)
    else result = text.slice(0, spansOf[at - 1].end) + text.slice(span.end)
  } else if (!spansOf.length) {
    // An empty list: the cell goes on a line of its own, one level in from the "cells" key, and the bracket under the key.
    const outer = indentAt(text, text.lastIndexOf('"cells"', followed.open))
    const base = outer + layout.unit
    const cell = written(next, layout, base)
    result = layout.unit
      ? text.slice(0, followed.open + 1) + layout.eol + base + cell + layout.eol + outer + text.slice(followed.close)
      : text.slice(0, followed.open + 1) + cell + text.slice(followed.close)
  } else {
    const neighbour = spansOf[Math.min(at, spansOf.length - 1)]
    const base = indentAt(text, neighbour.start)
    const cell = written(next, layout, base)
    const gap = layout.unit ? `,${layout.eol}${base}` : ','
    result = at < spansOf.length
      ? text.slice(0, spansOf[at].start) + cell + gap + text.slice(spansOf[at].start)
      : text.slice(0, spansOf[at - 1].end) + gap + cell + text.slice(spansOf[at - 1].end)
  }
  return { text: result, summary }
}

function rendered(text: string): string {
  return renderNotebook(text)?.text ?? text
}

export const notebookEditTool: Tool<NotebookEditInput> = {
  definition: {
    name: 'NotebookEdit',
    description: [
      'Changes one cell of a Jupyter notebook (.ipynb). Read it first; cell_id is the id Read shows, or the index.',
      '',
      "- edit_mode replace (default) sets the cell's source and clears a code cell's outputs; cell_type changes the type.",
      '- insert adds a cell after cell_id (first without one) and needs cell_type. delete removes the cell.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'Absolute path of the notebook.' },
        cell_id: { type: 'string', description: 'The cell to change, or to insert after.' },
        new_source: { type: 'string', description: 'The new source of the cell.' },
        cell_type: { type: 'string', enum: ['code', 'markdown'] },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'] },
      },
      required: ['notebook_path'],
      additionalProperties: false,
    },
  },
  kind: 'write',
  readOnly: false,
  // Notebooks are rare, so the definition waits for ToolSearch; Read and Edit name it when one comes up.
  defer: 'always',
  check(input) {
    if (path.extname(input.notebook_path).toLowerCase() !== '.ipynb') return 'NotebookEdit changes Jupyter notebooks (.ipynb); use Edit for other files.'
    return undefined
  },
  async access(input, ctx) {
    return { type: 'write', paths: [await realPathOf(notebookPath(input, ctx))] }
  },
  async describe(input, ctx) {
    const file = notebookPath(input, ctx)
    const name = shown(file, ctx)
    const mode = input.edit_mode ?? 'replace'
    const title = `${mode === 'insert' ? 'Add a cell to' : mode === 'delete' ? 'Delete a cell of' : 'Edit'} ${name}`
    const before = await currentNotebook(file)
    if (before === undefined) return { title }
    const planned = plan(before, input, name)
    if ('error' in planned) return { title, detail: planned.error }
    return { title, preview: buildDiff(file, rendered(before), rendered(planned.text)) }
  },
  async run(input, ctx) {
    const file = notebookPath(input, ctx)
    const name = shown(file, ctx)
    const loaded = await loadForWrite(file, ctx, NOTEBOOK_MAX_BYTES)
    if (loaded === null) return fail(`${name} does not exist. Create it with Write (a notebook is JSON), then edit its cells here.`)
    if (!isLoaded(loaded)) return loaded
    const planned = plan(loaded.text, input, name)
    if ('error' in planned) return fail(planned.error)
    return writeNotebook(ctx, file, loaded, planned.text, planned.summary, buildDiff(file, rendered(loaded.text), rendered(planned.text)))
  },
}

function notebookPath(input: NotebookEditInput, ctx: ToolContext): string {
  return filePath({ file_path: input.notebook_path }, ctx)
}

function isLoaded(value: Loaded | ToolOutcome): value is Loaded {
  return 'bytes' in value
}

async function currentNotebook(file: string): Promise<string | undefined> {
  return (await currentText(file, NOTEBOOK_MAX_BYTES)) || undefined
}

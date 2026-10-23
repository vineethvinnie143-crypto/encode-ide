/**
 * The changes the editor makes through a folder's language servers: renaming a symbol, and taking a code action.
 *
 * A server's plan names every file it changes. A file the editor has open with unsaved changes is changed in the
 * editor only: its unsaved text is what the server read, and saving it stays the person's call. Every other file is
 * changed on disk, each only while it still holds what the server read, in its own encoding and with its own line
 * breaks; one the editor has open without unsaved changes is then changed in the editor too, where its cursor and its
 * undo history stay. A plan is checked whole before anything is written, nothing outside the folder is touched, and a
 * file the editor has open but the servers were not given (too large) is not touched either. An applied change can be
 * taken back as a whole while nothing it touched has changed since.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { applyTextEdits, type EditPlan, type LanguageServers, type TextEdit } from '@encode/lsp'
import { decodeText, encodeText, isInsideReal, MAX_TEXT_FILE_BYTES, UnencodableTextError, type TextEncodingName } from '@encode/tools'
import type { EditorChangeFile } from './code'

/** The lines of one file a preview shows, and of all its files. */
const PREVIEW_LINES_PER_FILE = 200
const PREVIEW_LINES = 2_000
const PREVIEW_LINE_CHARS = 300

export interface ChangeContext {
  /** The folder, as a real path. */
  root: string
  servers: LanguageServers
  /** Every file the editor has open, as absolute paths. */
  open: readonly string[]
  platform: NodeJS.Platform
}

/** What a change did, kept so that it can be taken back. */
export interface AppliedRecord {
  /** In the order written: what each path held before (null: nothing was there) and after (null: it is gone). */
  disk: { file: string; before: Buffer | null; after: Buffer | null }[]
  /** The editor's documents changed, in order: their text before and after, and whether the disk was written too. */
  editor: { file: string; before: string; after: string; written: boolean; dirty: boolean }[]
}

export interface AppliedChange {
  editor: { file: string; edits: TextEdit[]; written: boolean }[]
  written: string[]
  created: string[]
  moved: { from: string; to: string }[]
  deleted: string[]
  places: number
  record: AppliedRecord
}

interface Sim {
  exists: boolean
  directory?: boolean
  bytes?: Buffer
  text?: string
  encoding?: TextEncodingName
}

type Step = { kind: 'write'; file: string; bytes: Buffer; previous: Buffer | null } | { kind: 'move'; from: string; to: string; bytes: Buffer; previousTo: Buffer | null } | { kind: 'delete'; file: string; previous: Buffer }

/** Two texts with the same lines, whatever their line breaks. */
function sameLines(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n')
}

async function bytesOf(file: string): Promise<Buffer | null> {
  try {
    const stats = await fs.stat(file)
    if (!stats.isFile()) return null
    return await fs.readFile(file)
  } catch {
    return null
  }
}

export class ChangeRefused extends Error {}

/**
 * Applies a server's plan for the editor. Throws a ChangeRefused, with what to do in words, when any part of it cannot
 * be made; nothing is changed then.
 */
export async function applyEditorPlan(plan: EditPlan, ctx: ChangeContext): Promise<AppliedChange> {
  const key = (file: string) => (ctx.platform === 'win32' || ctx.platform === 'darwin' ? path.resolve(file).toLowerCase() : path.resolve(file))
  const name = (file: string) => path.relative(ctx.root, file).split(path.sep).join('/') || path.basename(file)
  for (const file of plan.files) {
    if (!(await isInsideReal(ctx.root, file))) throw new ChangeRefused(`The change reaches ${file}, outside the folder, so nothing was changed.`)
  }
  const open = new Set(ctx.open.map(key))
  const sims = new Map<string, Sim>()
  const sim = async (file: string): Promise<Sim> => {
    const known = sims.get(key(file))
    if (known) return known
    let value: Sim
    try {
      const stats = await fs.stat(file)
      if (stats.isDirectory()) value = { exists: true, directory: true }
      else if (stats.size > MAX_TEXT_FILE_BYTES) value = { exists: true }
      else {
        const bytes = await fs.readFile(file)
        const decoded = decodeText(bytes)
        value = { exists: true, bytes, ...(decoded ? { text: decoded.text, encoding: decoded.encoding } : {}) }
      }
    } catch {
      value = { exists: false }
    }
    sims.set(key(file), value)
    return value
  }
  /** The editor's documents the plan reaches: their text before it, and as the plan goes. */
  const editorTexts = new Map<string, { file: string; before: string; text: string; dirty: boolean; written: boolean }>()
  const editorDoc = (file: string) => {
    const known = editorTexts.get(key(file))
    if (known) return known
    const doc = ctx.servers.editorText(file)
    if (!doc) {
      if (open.has(key(file))) throw new ChangeRefused(`${name(file)} is open in the editor, but it is too large for the language servers, so its unsaved text is not known. Close it and try again.`)
      return null
    }
    const entry = { file, before: doc.text, text: doc.text, dirty: doc.dirty, written: false }
    editorTexts.set(key(file), entry)
    return entry
  }
  /** A document of the editor's with unsaved changes is not moved, replaced or deleted under it. */
  const notUnsaved = (file: string, what: string) => {
    if (editorDoc(file)?.dirty) throw new ChangeRefused(`The change ${what} ${name(file)}, which has unsaved changes in the editor. Save it and try again.`)
  }

  const steps: Step[] = []
  const editor: AppliedChange['editor'] = []
  const created: string[] = []
  const moved: { from: string; to: string }[] = []
  const deleted: string[] = []
  let places = 0
  for (const change of plan.changes) {
    if (change.kind === 'edit') {
      places += change.textEdits.length
      const doc = editorDoc(change.file)
      if (doc?.dirty) {
        // The server read the editor's unsaved text; the change goes there, and nowhere else.
        if (!sameLines(doc.text, change.before)) throw new ChangeRefused(`${name(change.file)} has changes in the editor that its language server has not seen. Save it and try again.`)
        doc.text = applyTextEdits(doc.text, change.textEdits)
        editor.push({ file: change.file, edits: change.textEdits, written: false })
        continue
      }
      const now = await sim(change.file)
      if (!now.exists || now.directory) throw new ChangeRefused(`${name(change.file)} is not there any more, so nothing was changed.`)
      if (now.text === undefined) throw new ChangeRefused(`${name(change.file)} is not a text file eNCode can change, so nothing was changed.`)
      if (!sameLines(now.text, change.before) || (doc && !sameLines(doc.text, change.before))) throw new ChangeRefused(`${name(change.file)} changed since its language server read it, so nothing was changed. Try again.`)
      // The edits go on the file's own text, so the line breaks it has stay as they are.
      const after = applyTextEdits(now.text, change.textEdits)
      let bytes: Buffer
      try {
        bytes = encodeText(after, now.encoding ?? 'utf8')
      } catch (error) {
        if (error instanceof UnencodableTextError) throw new ChangeRefused(`${name(change.file)} is an older ANSI text file and cannot hold ${JSON.stringify(error.character)}, so nothing was changed.`)
        throw error
      }
      steps.push({ kind: 'write', file: change.file, bytes, previous: now.bytes ?? null })
      sims.set(key(change.file), { exists: true, bytes, text: after, encoding: now.encoding ?? 'utf8' })
      if (doc) {
        doc.text = applyTextEdits(doc.text, change.textEdits)
        doc.written = true
        editor.push({ file: change.file, edits: change.textEdits, written: true })
      }
    } else if (change.kind === 'create') {
      notUnsaved(change.file, 'replaces')
      const now = await sim(change.file)
      if (now.directory) throw new ChangeRefused(`${name(change.file)} is a folder, so nothing was changed.`)
      if (now.exists && !change.overwrite) {
        if (change.ignoreIfExists) continue
        throw new ChangeRefused(`${name(change.file)} already exists, so nothing was changed.`)
      }
      const bytes = Buffer.alloc(0)
      steps.push({ kind: 'write', file: change.file, bytes, previous: now.bytes ?? null })
      sims.set(key(change.file), { exists: true, bytes, text: '', encoding: 'utf8' })
      created.push(change.file)
    } else if (change.kind === 'rename') {
      notUnsaved(change.from, 'moves')
      notUnsaved(change.to, 'replaces')
      const from = await sim(change.from)
      const to = await sim(change.to)
      if (!from.exists) throw new ChangeRefused(`${name(change.from)} is not there to move, so nothing was changed.`)
      if (from.directory || to.directory || !from.bytes) throw new ChangeRefused(`eNCode moves single files for a language server, not folders (${name(change.from)}), so nothing was changed.`)
      if (to.exists && !change.overwrite) {
        if (change.ignoreIfExists) continue
        throw new ChangeRefused(`${name(change.to)} already exists, so nothing was changed.`)
      }
      steps.push({ kind: 'move', from: change.from, to: change.to, bytes: from.bytes, previousTo: to.bytes ?? null })
      sims.set(key(change.to), from)
      sims.set(key(change.from), { exists: false })
      moved.push({ from: change.from, to: change.to })
    } else {
      notUnsaved(change.file, 'deletes')
      const now = await sim(change.file)
      if (!now.exists) {
        if (change.ignoreIfNotExists) continue
        throw new ChangeRefused(`${name(change.file)} is not there to delete, so nothing was changed.`)
      }
      if (now.directory || !now.bytes) throw new ChangeRefused(`eNCode deletes single files for a language server, not folders (${name(change.file)}), so nothing was changed.`)
      steps.push({ kind: 'delete', file: change.file, previous: now.bytes })
      sims.set(key(change.file), { exists: false })
      deleted.push(change.file)
    }
  }

  // Everything holds: write, in order. A write that fails takes back the ones before it.
  const disk: AppliedRecord['disk'] = []
  try {
    for (const step of steps) {
      if (step.kind === 'write') {
        await fs.mkdir(path.dirname(step.file), { recursive: true })
        await fs.writeFile(step.file, step.bytes)
        disk.push({ file: step.file, before: step.previous, after: step.bytes })
      } else if (step.kind === 'move') {
        await fs.mkdir(path.dirname(step.to), { recursive: true })
        await fs.rename(step.from, step.to)
        disk.push({ file: step.to, before: step.previousTo, after: step.bytes }, { file: step.from, before: step.bytes, after: null })
      } else {
        await fs.rm(step.file)
        disk.push({ file: step.file, before: step.previous, after: null })
      }
    }
  } catch (error) {
    await restore(disk).catch(() => undefined)
    throw new ChangeRefused(`The change could not be written (${error instanceof Error ? error.message : String(error)}), so nothing was changed.`)
  }

  // The servers see what changed: the editor's documents as they are now, and the files on disk.
  const record: AppliedRecord = { disk, editor: [] }
  for (const doc of editorTexts.values()) {
    if (doc.text === doc.before) continue
    record.editor.push({ file: doc.file, before: doc.before, after: doc.text, written: doc.written, dirty: doc.dirty })
    ctx.servers.editorChange(doc.file, doc.text, doc.dirty)
  }
  const editorKeys = new Set(editor.map((item) => key(item.file)))
  const changedOnDisk = disk.filter((item) => !editorKeys.has(key(item.file)))
  if (changedOnDisk.length) await ctx.servers.changed(changedOnDisk.map((item) => ({ file: item.file, kind: item.after === null ? ('deleted' as const) : item.before === null ? ('created' as const) : ('changed' as const) }))).catch(() => undefined)
  const written = [...new Set(steps.filter((step): step is Extract<Step, { kind: 'write' }> => step.kind === 'write' && !editorKeys.has(key(step.file))).map((step) => step.file))]
  return { editor, written, created, moved, deleted, places, record }
}

/** Puts back what the disk entries changed, last first. */
async function restore(disk: AppliedRecord['disk']): Promise<void> {
  for (const entry of [...disk].reverse()) {
    if (entry.before === null) {
      await fs.rm(entry.file, { force: true })
    } else {
      await fs.mkdir(path.dirname(entry.file), { recursive: true })
      await fs.writeFile(entry.file, entry.before)
    }
  }
}

/**
 * Takes an applied change back, whole, while everything it touched still holds what it left: the files on disk, and the
 * editor's documents as the editor last sent them. Throws a ChangeRefused naming what changed since.
 */
export async function undoEditorChange(record: AppliedRecord, ctx: ChangeContext): Promise<{ editor: { file: string; written: boolean }[]; written: string[]; created: string[]; deleted: string[] }> {
  const key = (file: string) => (ctx.platform === 'win32' || ctx.platform === 'darwin' ? path.resolve(file).toLowerCase() : path.resolve(file))
  const name = (file: string) => path.relative(ctx.root, file).split(path.sep).join('/') || path.basename(file)
  // What each path holds after the change: the last entry for it.
  const last = new Map<string, { file: string; after: Buffer | null; first: Buffer | null }>()
  for (const entry of record.disk) {
    const known = last.get(key(entry.file))
    last.set(key(entry.file), { file: entry.file, after: entry.after, first: known ? known.first : entry.before })
  }
  for (const { file, after } of last.values()) {
    const now = await bytesOf(file)
    const same = after === null ? now === null : now !== null && now.equals(after)
    if (!same) throw new ChangeRefused(`${name(file)} changed since, so the change was not taken back. Use Undo in each file instead.`)
  }
  const docs = new Map<string, { file: string; before: string; after: string; written: boolean; dirty: boolean }>()
  for (const entry of record.editor) {
    const known = docs.get(key(entry.file))
    // A document changed more than once (a command's several edits) goes back to what it was before the first.
    docs.set(key(entry.file), known ? { ...entry, before: known.before, written: known.written || entry.written, dirty: known.dirty } : entry)
  }
  for (const doc of docs.values()) {
    const now = ctx.servers.editorText(doc.file)
    if (!now || now.text !== doc.after) throw new ChangeRefused(`${name(doc.file)} was edited since, so the change was not taken back. Use Undo in each file instead.`)
  }
  await restore(record.disk)
  const created: string[] = []
  const deleted: string[] = []
  const written: string[] = []
  for (const { file, after, first } of last.values()) {
    if (docs.has(key(file))) continue
    if (first === null) deleted.push(file)
    else if (after === null) created.push(file)
    else written.push(file)
  }
  for (const doc of docs.values()) ctx.servers.editorChange(doc.file, doc.before, doc.dirty)
  const onDisk = [...last.values()].filter((item) => !docs.has(key(item.file)))
  if (onDisk.length) await ctx.servers.changed(onDisk.map((item) => ({ file: item.file, kind: item.first === null ? ('deleted' as const) : item.after === null ? ('created' as const) : ('changed' as const) }))).catch(() => undefined)
  return { editor: [...docs.values()].map((doc) => ({ file: doc.file, written: doc.written })), written, created, deleted }
}

/** The files of a plan as a preview shows them: what each change does, and the lines an edit changes, before and after. */
export function previewPlan(plan: EditPlan, ctx: { root: string; servers: LanguageServers }): EditorChangeFile[] {
  const name = (file: string) => path.relative(ctx.root, file).split(path.sep).join('/')
  const files: EditorChangeFile[] = []
  let shown = 0
  for (const change of plan.changes) {
    if (change.kind === 'create') files.push({ path: name(change.file), kind: 'create', places: 0 })
    else if (change.kind === 'rename') files.push({ path: name(change.from), kind: 'move', to: name(change.to), places: 0 })
    else if (change.kind === 'delete') files.push({ path: name(change.file), kind: 'delete', places: 0 })
    else {
      const lines = changedLines(change.before, change.after, change.textEdits, Math.min(PREVIEW_LINES_PER_FILE, PREVIEW_LINES - shown))
      shown += lines.length
      const inEditor = Boolean(ctx.servers.editorText(change.file)?.dirty)
      const known = files.find((item) => item.kind === 'edit' && item.path === name(change.file))
      if (known) {
        known.places += change.textEdits.length
        known.lines = [...(known.lines ?? []), ...lines]
        if (lines.cut) known.cut = true
      } else files.push({ path: name(change.file), kind: 'edit', places: change.textEdits.length, lines: [...lines], ...(lines.cut ? { cut: true } : {}), ...(inEditor ? { inEditor: true } : {}) })
    }
  }
  // By path, as a list of files reads; the order the plan applies them in is kept by the plan itself.
  return files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }))
}

/** The first line of each edit, before and after it, in the order of the text: one row a line, however many edits it has. */
function changedLines(before: string, after: string, edits: readonly TextEdit[], max: number): { line: number; before: string; after: string }[] & { cut?: boolean } {
  if (max <= 0) return Object.assign([], { cut: edits.length > 0 })
  const beforeLines = before.split(/\r\n?|\n/)
  const afterLines = after.split(/\r\n?|\n/)
  const sorted = [...edits].sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character)
  const out: { line: number; before: string; after: string }[] & { cut?: boolean } = []
  // How many lines the edits before a line added (or took away), so its line after them is known.
  let shift = 0
  let lastLine = -1
  for (const edit of sorted) {
    const line = edit.range.start.line
    if (line !== lastLine) {
      if (out.length >= max) {
        out.cut = true
        break
      }
      const cut = (text: string | undefined) => (text ?? '').trimEnd().slice(0, PREVIEW_LINE_CHARS)
      out.push({ line, before: cut(beforeLines[line]), after: cut(afterLines[line + shift]) })
      lastLine = line
    }
    const added = edit.newText.split(/\r\n?|\n/).length - 1
    const removed = edit.range.end.line - edit.range.start.line
    shift += added - removed
  }
  return out
}

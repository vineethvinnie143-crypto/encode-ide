/**
 * A repository's changes in one scope, as the Review tab shows them, and what it does to them.
 *
 * Scopes: `unstaged` (the working tree against the index, with new files), `staged` (the index against HEAD),
 * `branch` (the working tree against where the branch left its base) and `commit` (one commit against its first
 * parent). Both sides of every file are read once (objects through one `cat-file`, files from the disk) and compared
 * by eNCode's own diff, so a hunk is exactly what is shown.
 *
 * Staging, unstaging and reverting one hunk work the way `git add -p` does: the new index content is the old one with
 * the hunk put in or taken out, written as an object and set on the index entry; a reverted hunk is written to the
 * file. Every action first reads the file again and refuses when it changed since the person looked at it.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { applyHunk, diffContents, hunkHeader, reverseHunk, type ReviewHunk } from './hunks'
import { objectInfo, readObjects } from './objects'
import { parseRaw } from './raw'
import type { GitRunner } from './runner'
import { isNullOid, parseStatus, type Status, type StatusEntry } from './status'
import { decode, encode, type Content, type TextContent } from './text'

export type ReviewScope = { kind: 'unstaged' } | { kind: 'staged' } | { kind: 'branch'; base?: string } | { kind: 'commit'; commit: string }

export type FileChange = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted'

export type FileKind = 'text' | 'binary' | 'large' | 'submodule' | 'symlink' | 'folder'

export interface ReviewOptions {
  /** Unchanged lines around each change; Infinity shows whole files. */
  context: number
  /** Lines that differ only in whitespace count as unchanged; hunks cannot then be staged or reverted alone. */
  ignoreWhitespace: boolean
}

export const DEFAULT_REVIEW_OPTIONS: ReviewOptions = { context: 3, ignoreWhitespace: false }

export interface ReviewFile {
  /** Relative to the repository, with `/`. */
  path: string
  /** Where a renamed or copied file came from. */
  oldPath?: string
  change: FileChange
  kind: FileKind
  oldMode?: string
  newMode?: string
  added: number
  removed: number
  hunks: ReviewHunk[]
  /** The diff ran out of time: correct, but coarser than it could be. */
  approximate?: boolean
  /** Whether single hunks can be staged, unstaged or reverted; when not, why. */
  hunkActions: boolean
  hunkActionsOff?: string
  /** A change no line shows (endings, the byte order mark, the mode), or why there are no lines to show. */
  note?: string
  /** Sizes in bytes, for files whose lines are not shown. */
  size?: { old?: number; new?: number }
  /** Names this state of both sides; an action on the file refuses when it no longer matches. */
  fingerprint: string
}

export interface RepoState {
  /** The repository's top folder, as the system writes it. */
  root: string
  /** Where the folder the repository was opened from sits in it: `/`-separated and ending in `/`, or empty at the top. */
  folder: string
  branch: string | null
  head: string | null
  upstream?: string
  ahead?: number
  behind?: number
}

export interface CommitInfo {
  oid: string
  short: string
  subject: string
  author: string
  /** Seconds since 1970. */
  time: number
}

export interface ReviewSnapshot {
  scope: ReviewScope
  repo: RepoState
  files: ReviewFile[]
  added: number
  removed: number
  /** How many files the scopes that can change hold, for the scope menu. */
  counts: { unstaged: number; staged: number }
  /** Branch scope: the base and the commit the branch left it at. */
  base?: { ref: string; oid: string | null }
  /** Commit scope: the commit shown. */
  commit?: CommitInfo
  /** Files listed whose lines were not read because the review is too large to show at once. */
  skipped: number
  /** Nothing can be staged, unstaged or reverted in this scope. */
  readOnly: boolean
  options: ReviewOptions
}

export type ReviewAction =
  | { type: 'stage-hunk' | 'unstage-hunk' | 'revert-hunk'; path: string; hunk: string; fingerprint: string }
  | { type: 'stage-file' | 'unstage-file' | 'revert-file'; path: string; fingerprint?: string }
  | { type: 'stage-all' | 'unstage-all' | 'revert-all' }

export interface ActionResult {
  /** What was done, in a few words, for a toast. */
  message: string
  /** A revert that can be taken back with `undo`. */
  undoable: boolean
}

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly code: 'stale' | 'refused' | 'not-found' | 'failed',
  ) {
    super(message)
    this.name = 'ReviewError'
  }
}

/** Where a side of a file comes from. */
type Side = { from: 'none' } | { from: 'blob'; oid: string; mode: string } | { from: 'worktree'; mode?: string }

interface Entry {
  path: string
  oldPath?: string
  change: FileChange
  old: Side
  new: Side
  submodule?: boolean
}

interface Loaded {
  content: Content | { kind: 'submodule'; oid?: string } | { kind: 'folder' }
  /** Names what was read: the object, or a hash of the file's bytes. */
  identity: string
  bytes?: Buffer
}

export interface RepositoryOptions {
  /** A file larger than this is listed without its lines. Default 2 MB. */
  maxFileBytes?: number
  /** Past this many bytes read in one review, files are listed without their lines. Default 48 MB. */
  maxTotalBytes?: number
  /** Puts a file the person reverted, which git does not track, where it can be recovered; without it, it is deleted. */
  trash?: (file: string) => Promise<void>
  /** How many reverts `undo` can take back. Default 20. */
  undoDepth?: number
}

const EMPTY_TREE_INPUT = ''
const MODE_LABEL: Record<string, string> = { '100644': 'a file', '100755': 'an executable file', '120000': 'a symbolic link', '160000': 'a submodule' }
/** Reverted files kept for `undo` only up to this size each. */
const UNDO_MAX_FILE = 8 * 1024 * 1024

function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex')
}

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value)
}

/** What a file held before a revert: its bytes, nothing (it did not exist), or too much to keep. */
type Kept = { state: 'bytes'; bytes: Buffer } | { state: 'missing' } | { state: 'unknown' }

/** A revert `undo` can take back: what each file held, to put it back, and a hash of what the revert left, to check first. */
interface UndoRecord {
  label: string
  files: Array<{ file: string; before: Kept; after: string | null }>
}

async function keep(file: string): Promise<Kept> {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > UNDO_MAX_FILE) return { state: 'unknown' }
    return { state: 'bytes', bytes: await fs.readFile(file) }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unknown' }
  }
}

function kept(bytes: Buffer | undefined): Kept {
  if (!bytes) return { state: 'missing' }
  return bytes.length <= UNDO_MAX_FILE ? { state: 'bytes', bytes } : { state: 'unknown' }
}

/**
 * Where `folder` sits in the repository at `root`. Git echoes the folder the way it was named, which on a file system
 * that ignores case can differ from how it is stored, and then the paths git lists would not start with it; the real
 * paths name both as they are stored. Git's own answer stands when they cannot be compared.
 */
async function folderWithin(root: string, folder: string, prefix: string): Promise<string> {
  try {
    const [realRoot, realFolder] = await Promise.all([fs.realpath(root), fs.realpath(folder)])
    const relative = path.relative(realRoot, realFolder)
    if (!relative) return ''
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return prefix
    return `${relative.split(path.sep).join('/')}/`
  } catch {
    return prefix
  }
}

async function hashOfFile(file: string): Promise<string | null> {
  const bytes = await fs.readFile(file).catch(() => null)
  return bytes ? sha1(bytes) : null
}

export class Repository {
  private readonly maxFileBytes: number
  private readonly maxTotalBytes: number
  private readonly undoDepth: number
  private readonly undos: UndoRecord[] = []
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly runner: GitRunner,
    /** The repository's top folder. */
    readonly root: string,
    /** The folder it was opened from, within it: see `RepoState.folder`. */
    readonly folder: string,
    private readonly options: RepositoryOptions,
  ) {
    this.maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024
    this.maxTotalBytes = options.maxTotalBytes ?? 48 * 1024 * 1024
    this.undoDepth = options.undoDepth ?? 20
  }

  /**
   * The repository the folder is in, or why there is none: not a repository, git missing, or a repository git will
   * not work in (another user's, without `safe.directory`).
   */
  static async open(makeRunner: (cwd: string) => GitRunner, folder: string, options: RepositoryOptions = {}): Promise<Repository | { reason: string }> {
    const probe = makeRunner(folder)
    let result
    try {
      result = await probe.run(['rev-parse', '--show-toplevel', '--show-prefix'])
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) }
    }
    if (result.code !== 0) {
      const said = result.stderr.trim()
      if (/not a git repository/i.test(said)) return { reason: 'This folder is not in a git repository.' }
      return { reason: said.split(/\r?\n/).filter((line) => !/^hint:/.test(line)).join(' ').slice(0, 500) || 'git could not read this folder.' }
    }
    const [top = '', prefix = ''] = result.stdout.toString('utf8').split(/\r?\n/)
    if (!top) return { reason: 'This folder is inside a repository’s git folder, not its working tree.' }
    const root = path.resolve(top)
    return new Repository(makeRunner(root), root, await folderWithin(root, folder, prefix), options)
  }

  /** One action at a time: they read and write the index. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work, work)
    this.queue = task.catch(() => undefined)
    return task
  }

  // ------------------------------------------------------------------ reading

  async status(): Promise<Status> {
    return parseStatus(await this.runner.ok(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=none']))
  }

  private repoState(status: Status): RepoState {
    const { branch } = status
    return {
      root: this.root,
      folder: this.folder,
      branch: branch.head,
      head: branch.oid,
      ...(branch.upstream ? { upstream: branch.upstream } : {}),
      ...(branch.ahead !== undefined ? { ahead: branch.ahead, behind: branch.behind } : {}),
    }
  }

  private counts(status: Status): { unstaged: number; staged: number } {
    return {
      unstaged: unstagedEntries(status).length,
      staged: stagedEntries(status).length,
    }
  }

  /** The changes in a scope, read now. */
  review(scope: ReviewScope, options: ReviewOptions = DEFAULT_REVIEW_OPTIONS): Promise<ReviewSnapshot> {
    return this.serial(() => this.load(scope, options))
  }

  private async load(scope: ReviewScope, options: ReviewOptions): Promise<ReviewSnapshot> {
    const status = await this.status()
    let entries: Entry[]
    let resolved: ReviewScope = scope
    let base: ReviewSnapshot['base']
    let commit: CommitInfo | undefined
    if (scope.kind === 'unstaged') entries = unstagedEntries(status)
    else if (scope.kind === 'staged') entries = stagedEntries(status)
    else if (scope.kind === 'branch') {
      const ref = scope.base ?? (await this.defaultBase(status))
      if (!ref) throw new ReviewError('There is no base branch to compare with. Choose one.', 'not-found')
      const refs = await this.refs()
      if (!refs.includes(ref)) throw new ReviewError(`There is no branch called ${ref}.`, 'not-found')
      const mergeBase = status.branch.oid ? await this.mergeBase(ref) : null
      base = { ref, oid: mergeBase }
      resolved = { kind: 'branch', base: ref }
      entries = await this.branchEntries(mergeBase, status)
    } else {
      commit = await this.commitInfo(scope.commit)
      resolved = { kind: 'commit', commit: commit.oid }
      entries = await this.commitEntries(commit.oid)
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const readOnly = scope.kind === 'branch' || scope.kind === 'commit'
    const { files, skipped } = await this.files(entries, options, readOnly ? null : scope.kind)
    let added = 0
    let removed = 0
    for (const file of files) {
      added += file.added
      removed += file.removed
    }
    return {
      scope: resolved,
      repo: this.repoState(status),
      files,
      added,
      removed,
      counts: this.counts(status),
      ...(base ? { base } : {}),
      ...(commit ? { commit } : {}),
      skipped,
      readOnly,
      options,
    }
  }

  /** Reads both sides of every entry and compares them. */
  private async files(entries: Entry[], options: ReviewOptions, editable: 'unstaged' | 'staged' | null): Promise<{ files: ReviewFile[]; skipped: number }> {
    const loaded = await this.read(entries)
    const blocked = editable ? await this.blockedByAttributes(entries.filter((entry) => entry.old.from !== 'none' && entry.new.from !== 'none').map((entry) => entry.path)) : new Map<string, string>()
    let skipped = 0
    const files = entries.map((entry) => {
      const [oldSide, newSide] = loaded.get(entry) ?? [undefined, undefined]
      if (!oldSide || !newSide) {
        skipped++
        return placeholder(entry, 'Not read: this review is too large to show every file at once.')
      }
      return this.compare(entry, oldSide, newSide, options, editable, blocked.get(entry.path))
    })
    return { files, skipped }
  }

  private compare(entry: Entry, oldSide: Loaded, newSide: Loaded, options: ReviewOptions, editable: 'unstaged' | 'staged' | null, attribute: string | undefined): ReviewFile {
    const fingerprint = sha1(JSON.stringify([entry.change, oldSide.identity, newSide.identity, modeOf(entry.old), modeOf(entry.new)]))
    const base: Omit<ReviewFile, 'kind' | 'hunks' | 'added' | 'removed' | 'hunkActions'> = {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      change: entry.change,
      ...(modeOf(entry.old) ? { oldMode: modeOf(entry.old) } : {}),
      ...(modeOf(entry.new) ? { newMode: modeOf(entry.new) } : {}),
      fingerprint,
    }
    const a = oldSide.content
    const b = newSide.content
    if (entry.submodule || a.kind === 'submodule' || b.kind === 'submodule') {
      return { ...base, kind: 'submodule', hunks: [], added: 0, removed: 0, hunkActions: false, hunkActionsOff: 'A submodule is changed as a whole.', note: submoduleNote(entry) }
    }
    if (a.kind === 'folder' || b.kind === 'folder') {
      return { ...base, kind: 'folder', hunks: [], added: 0, removed: 0, hunkActions: false, hunkActionsOff: 'A folder with a repository of its own is changed as a whole.', note: 'A folder with its own git repository.' }
    }
    if (a.kind === 'binary' || b.kind === 'binary' || a.kind === 'large' || b.kind === 'large') {
      const kind: FileKind = a.kind === 'large' || b.kind === 'large' ? 'large' : 'binary'
      const size = { ...(sizeOf(a) !== undefined ? { old: sizeOf(a) } : {}), ...(sizeOf(b) !== undefined ? { new: sizeOf(b) } : {}) }
      return { ...base, kind, size, hunks: [], added: 0, removed: 0, hunkActions: false, hunkActionsOff: kind === 'large' ? 'This file is too large to show by lines.' : 'A binary file is changed as a whole.', note: kind === 'large' ? 'Too large to show here.' : 'Binary file.' }
    }
    const oldText: TextContent = a.kind === 'text' ? a : { kind: 'text', lines: [], endings: [], eol: b.kind === 'text' ? b.eol : '\n', bom: false, lossy: false }
    const newText: TextContent = b.kind === 'text' ? b : { kind: 'text', lines: [], endings: [], eol: oldText.eol, bom: false, lossy: false }
    const diff = diffContents(oldText, newText, { context: options.context, ignoreWhitespace: options.ignoreWhitespace })
    const symlink = modeOf(entry.old) === '120000' || modeOf(entry.new) === '120000'
    let off: string | undefined
    if (!editable) off = undefined
    else if (entry.change === 'conflicted') off = 'Resolve the conflict in the file first.'
    else if (symlink) off = 'A symbolic link is changed as a whole.'
    else if (oldText.lossy || newText.lossy) off = 'This file is not UTF-8 text, so it is changed as a whole.'
    else if (attribute) off = attribute
    else if (options.ignoreWhitespace) off = 'Whitespace is hidden: show it to stage or revert single changes.'
    else if (diff.approximate) off = 'This diff is approximate, so the file is changed as a whole.'
    const note = textNote(entry, oldText, newText, diff.hunks.length === 0, a.kind === 'none', b.kind === 'none')
    return {
      ...base,
      kind: symlink ? 'symlink' : 'text',
      hunks: diff.hunks,
      added: diff.added,
      removed: diff.removed,
      ...(diff.approximate ? { approximate: true } : {}),
      hunkActions: Boolean(editable) && !off,
      ...(editable && off ? { hunkActionsOff: off } : {}),
      ...(note ? { note } : {}),
    }
  }

  /** Reads both sides of each entry within the budget: objects through one `cat-file`, files from the disk. */
  private async read(entries: Entry[]): Promise<Map<Entry, [Loaded, Loaded]>> {
    const blobs: string[] = []
    for (const entry of entries) {
      for (const side of [entry.old, entry.new]) if (side.from === 'blob' && side.mode !== '160000') blobs.push(side.oid)
    }
    const info = await objectInfo(this.runner, blobs)
    const wanted = blobs.filter((oid) => (info.get(oid)?.size ?? Infinity) <= this.maxFileBytes)
    const objects = await readObjects(this.runner, wanted)
    const out = new Map<Entry, [Loaded, Loaded]>()
    let total = 0
    for (const entry of entries) {
      if (total > this.maxTotalBytes) break
      const sides: Loaded[] = []
      for (const side of [entry.old, entry.new]) {
        const loaded = await this.side(entry, side, info, objects)
        total += loaded.bytes?.length ?? 0
        sides.push(loaded)
      }
      out.set(entry, [sides[0], sides[1]])
    }
    return out
  }

  private async side(entry: Entry, side: Side, info: Map<string, { size: number }>, objects: Map<string, Buffer>): Promise<Loaded> {
    if (side.from === 'none') return { content: { kind: 'none' }, identity: 'none' }
    if (side.from === 'blob') {
      if (side.mode === '160000') return { content: { kind: 'submodule', oid: side.oid }, identity: side.oid }
      const bytes = objects.get(side.oid)
      if (!bytes) {
        const size = info.get(side.oid)?.size ?? 0
        return { content: { kind: 'large', size }, identity: side.oid }
      }
      return { content: decode(bytes), identity: side.oid, bytes }
    }
    return this.worktreeSide(entry.path)
  }

  private async worktreeSide(relative: string): Promise<Loaded> {
    const file = this.absolute(relative)
    let stat
    try {
      stat = await fs.lstat(file)
    } catch {
      return { content: { kind: 'none' }, identity: 'none' }
    }
    if (stat.isSymbolicLink()) {
      // git keeps a link as the path it points to.
      const target = await fs.readlink(file).catch(() => '')
      const bytes = Buffer.from(target.split(path.sep).join('/'), 'utf8')
      return { content: decode(bytes), identity: sha1(bytes), bytes }
    }
    if (stat.isDirectory()) return { content: { kind: 'folder' }, identity: 'folder' }
    if (stat.size > this.maxFileBytes) return { content: { kind: 'large', size: stat.size }, identity: `size:${stat.size}:${stat.mtimeMs}` }
    const bytes = await fs.readFile(file)
    return { content: decode(bytes), identity: sha1(bytes), bytes }
  }

  /** A path git gave, on the disk; one that would leave the repository is refused. */
  private absolute(relative: string): string {
    const file = path.resolve(this.root, ...relative.split('/'))
    const inside = path.relative(this.root, file)
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new ReviewError(`${relative} is not inside the repository.`, 'refused')
    return file
  }

  /** Paths whose content git changes on the way in or out (a filter, another encoding): their hunks cannot be written by line. */
  private async blockedByAttributes(paths: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (!paths.length) return out
    const result = await this.runner.run(['check-attr', '-z', '--stdin', 'filter', 'working-tree-encoding'], { input: paths.join('\0') + '\0' })
    if (result.code !== 0) return out
    const tokens = result.stdout.toString('utf8').split('\0')
    for (let index = 0; index + 2 < tokens.length; index += 3) {
      const [file, attribute, value] = [tokens[index], tokens[index + 1], tokens[index + 2]]
      if (value === 'unspecified' || value === 'unset') continue
      if (attribute === 'filter') out.set(file, `git runs the "${value}" filter on this file, so it is staged as a whole.`)
      else if (attribute === 'working-tree-encoding') out.set(file, `This file is kept as ${value}, so it is staged as a whole.`)
    }
    return out
  }

  // ------------------------------------------------------------------ scopes

  private async branchEntries(mergeBase: string | null, status: Status): Promise<Entry[]> {
    const from = mergeBase ?? (await this.emptyTree())
    const raw = parseRaw(await this.runner.ok(['diff', '--raw', '-z', '-M', '--no-abbrev', '--no-color', '--end-of-options', from, '--']))
    const entries: Entry[] = raw.map((item) => ({
      path: item.path,
      ...(item.oldPath ? { oldPath: item.oldPath } : {}),
      change: changeOf(item.status),
      old: isNullOid(item.oldOid) || item.status === 'A' ? { from: 'none' as const } : { from: 'blob' as const, oid: item.oldOid, mode: item.oldMode },
      new: item.status === 'D' ? { from: 'none' as const } : isNullOid(item.newOid) ? { from: 'worktree' as const, mode: item.newMode } : { from: 'blob' as const, oid: item.newOid, mode: item.newMode },
      ...(item.oldMode === '160000' || item.newMode === '160000' ? { submodule: true } : {}),
    }))
    for (const item of status.entries) {
      if (item.type === 'untracked') entries.push({ path: item.path, change: 'untracked', old: { from: 'none' }, new: { from: 'worktree' } })
    }
    return entries
  }

  private async commitEntries(oid: string): Promise<Entry[]> {
    const parent = await this.runner.run(['rev-parse', '--verify', '-q', '--end-of-options', `${oid}^1`])
    const from = parent.code === 0 ? parent.stdout.toString('utf8').trim() : await this.emptyTree()
    const raw = parseRaw(await this.runner.ok(['diff', '--raw', '-z', '-M', '--no-abbrev', '--no-color', '--end-of-options', from, oid, '--']))
    return raw.map((item) => ({
      path: item.path,
      ...(item.oldPath ? { oldPath: item.oldPath } : {}),
      change: changeOf(item.status),
      old: item.status === 'A' || isNullOid(item.oldOid) ? { from: 'none' as const } : { from: 'blob' as const, oid: item.oldOid, mode: item.oldMode },
      new: item.status === 'D' || isNullOid(item.newOid) ? { from: 'none' as const } : { from: 'blob' as const, oid: item.newOid, mode: item.newMode },
      ...(item.oldMode === '160000' || item.newMode === '160000' ? { submodule: true } : {}),
    }))
  }

  private async emptyTree(): Promise<string> {
    // Written for the repository's own object format (SHA-1 or SHA-256).
    return (await this.runner.text(['hash-object', '-t', 'tree', '--stdin'], { input: EMPTY_TREE_INPUT })).trim()
  }

  private async mergeBase(ref: string): Promise<string | null> {
    const result = await this.runner.run(['merge-base', '--end-of-options', ref, 'HEAD'])
    return result.code === 0 ? result.stdout.toString('utf8').trim() : null
  }

  /** Local and remote branches by their short names. */
  async refs(): Promise<string[]> {
    const text = await this.runner.text(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith('/HEAD'))
  }

  /**
   * The branch work is usually compared with: where the remote's HEAD points, else main or master. On that branch
   * itself, its upstream: what has not been pushed.
   */
  async defaultBase(status?: Status): Promise<string | null> {
    const current = (status ?? (await this.status())).branch
    const refs = new Set(await this.refs())
    const head = await this.runner.run(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
    const candidates = [head.code === 0 ? head.stdout.toString('utf8').trim() : '', 'origin/main', 'origin/master', 'main', 'master', 'origin/develop', 'develop']
    for (const candidate of candidates) {
      if (!candidate || !refs.has(candidate)) continue
      if (candidate === current.head) continue
      // On main, origin/main is the upstream: the review is what is not pushed yet.
      return candidate
    }
    if (current.upstream && refs.has(current.upstream)) return current.upstream
    return null
  }

  async commitInfo(commit: string): Promise<CommitInfo> {
    if (!/^[0-9a-f]{4,64}$/i.test(commit) && !/^HEAD(~\d{1,4})?$/.test(commit)) throw new ReviewError('That is not a commit.', 'not-found')
    const result = await this.runner.run(['log', '-1', '--no-color', '--format=%H%x00%h%x00%s%x00%an%x00%at', '--end-of-options', `${commit}^{commit}`, '--'])
    if (result.code !== 0) throw new ReviewError(`There is no commit ${commit}.`, 'not-found')
    const [oid, short, subject, author, time] = result.stdout.toString('utf8').replace(/\n$/, '').split('\0')
    if (!oid || !isOid(oid)) throw new ReviewError(`There is no commit ${commit}.`, 'not-found')
    return { oid, short, subject, author, time: Number(time) }
  }

  /** The latest commits on HEAD, newest first, for the commit picker. */
  async commits(limit = 50): Promise<CommitInfo[]> {
    const result = await this.runner.run(['log', `-${Math.max(1, Math.min(500, limit))}`, '--no-color', '--format=%H%x00%h%x00%s%x00%an%x00%at%x1e', 'HEAD', '--'])
    if (result.code !== 0) return []
    return result.stdout
      .toString('utf8')
      .split('\x1e')
      .map((record) => record.replace(/^\n/, ''))
      .filter(Boolean)
      .map((record) => {
        const [oid, short, subject, author, time] = record.split('\0')
        return { oid, short, subject, author, time: Number(time) }
      })
      .filter((item) => isOid(item.oid))
  }

  // ------------------------------------------------------------------ actions

  /** Does one action in a scope that can change; refuses when the file is not as the person last saw it. */
  act(scope: ReviewScope, action: ReviewAction, options: ReviewOptions = DEFAULT_REVIEW_OPTIONS): Promise<ActionResult> {
    return this.serial(async () => {
      if (scope.kind === 'branch' || scope.kind === 'commit') throw new ReviewError('Nothing can be changed in this view.', 'refused')
      switch (action.type) {
        case 'stage-all':
          return this.stageAll(scope.kind)
        case 'unstage-all':
          return this.unstageAll(scope.kind)
        case 'revert-all':
          return this.revertAll(scope.kind)
        default:
          return this.actOnFile(scope.kind, action, options)
      }
    })
  }

  private async entryFor(scope: 'unstaged' | 'staged', file: string): Promise<{ entry: Entry; status: Status }> {
    const status = await this.status()
    const entries = scope === 'unstaged' ? unstagedEntries(status) : stagedEntries(status)
    const entry = entries.find((item) => item.path === file)
    if (!entry) throw new ReviewError(`${file} has no ${scope} changes any more.`, 'stale')
    return { entry, status }
  }

  private async actOnFile(scope: 'unstaged' | 'staged', action: Exclude<ReviewAction, { type: 'stage-all' | 'unstage-all' | 'revert-all' }>, options: ReviewOptions): Promise<ActionResult> {
    const allowed: Record<'unstaged' | 'staged', ReadonlyArray<ReviewAction['type']>> = {
      unstaged: ['stage-hunk', 'revert-hunk', 'stage-file', 'revert-file'],
      staged: ['unstage-hunk', 'unstage-file'],
    }
    if (!allowed[scope].includes(action.type)) throw new ReviewError('That cannot be done in this view.', 'refused')
    const { entry } = await this.entryFor(scope, action.path)
    const read = await this.read([entry])
    const [oldSide, newSide] = read.get(entry)!
    const file = this.compare(entry, oldSide, newSide, options, scope, (await this.blockedByAttributes(oldSide.content.kind !== 'none' && newSide.content.kind !== 'none' ? [entry.path] : [])).get(entry.path))
    if (action.fingerprint && action.fingerprint !== file.fingerprint) throw new ReviewError(`${entry.path} changed since you looked at it. The review shows it as it is now.`, 'stale')

    const isHunk = action.type === 'stage-hunk' || action.type === 'unstage-hunk' || action.type === 'revert-hunk'
    // A file with only one side is one hunk: what is done to it is done to the file.
    const whole = !isHunk || oldSide.content.kind === 'none' || newSide.content.kind === 'none'
    if (isHunk && !whole) {
      if (!file.hunkActions) throw new ReviewError(file.hunkActionsOff ?? 'This change cannot be taken on its own.', 'refused')
      const hunk = file.hunks.find((item) => item.id === (action as { hunk: string }).hunk)
      if (!hunk) throw new ReviewError(`That change in ${entry.path} is not there any more. The review shows the file as it is now.`, 'stale')
      if (action.type === 'stage-hunk') return this.stageHunk(entry, oldSide, hunk)
      if (action.type === 'unstage-hunk') return this.unstageHunk(entry, oldSide, newSide, hunk)
      return this.revertHunk(entry, newSide, hunk)
    }
    const kind = action.type.replace('-hunk', '-file')
    if (kind === 'stage-file') return this.stageFile(entry)
    if (kind === 'unstage-file') return this.unstageFile(entry)
    return this.revertFile(entry, newSide)
  }

  private async writeIndex(file: string, mode: string, content: TextContent): Promise<void> {
    const oid = (await this.runner.text(['hash-object', '-w', '--stdin', '--no-filters'], { input: encode(content) })).trim()
    if (!isOid(oid)) throw new ReviewError('git did not take the new content.', 'failed')
    await this.runner.ok(['update-index', '--cacheinfo', `${mode},${oid},${file}`])
  }

  private async stageHunk(entry: Entry, oldSide: Loaded, hunk: ReviewHunk): Promise<ActionResult> {
    if (oldSide.content.kind !== 'text' || entry.old.from !== 'blob') throw new ReviewError('This change cannot be staged on its own.', 'refused')
    const next = applyHunk(oldSide.content, hunk)
    if (!next) throw new ReviewError(`That change in ${entry.path} no longer fits the staged file. The review shows it as it is now.`, 'stale')
    await this.writeIndex(entry.path, entry.old.mode, next)
    return { message: `Staged a change in ${baseName(entry.path)}`, undoable: false }
  }

  private async unstageHunk(entry: Entry, oldSide: Loaded, newSide: Loaded, hunk: ReviewHunk): Promise<ActionResult> {
    if (newSide.content.kind !== 'text' || entry.new.from !== 'blob' || oldSide.content.kind !== 'text') throw new ReviewError('This change cannot be unstaged on its own.', 'refused')
    const next = reverseHunk(newSide.content, hunk)
    if (!next) throw new ReviewError(`That change in ${entry.path} no longer fits the staged file. The review shows it as it is now.`, 'stale')
    await this.writeIndex(entry.path, entry.new.mode, next)
    return { message: `Unstaged a change in ${baseName(entry.path)}`, undoable: false }
  }

  private async revertHunk(entry: Entry, newSide: Loaded, hunk: ReviewHunk): Promise<ActionResult> {
    if (newSide.content.kind !== 'text' || entry.new.from !== 'worktree' || !newSide.bytes) throw new ReviewError('This change cannot be reverted on its own.', 'refused')
    const next = reverseHunk(newSide.content, hunk)
    if (!next) throw new ReviewError(`That change in ${entry.path} no longer fits the file. The review shows it as it is now.`, 'stale')
    const file = this.absolute(entry.path)
    const bytes = encode(next)
    await fs.writeFile(file, bytes)
    const label = `Reverted a change in ${baseName(entry.path)}`
    return this.remember(label, [{ file, before: kept(newSide.bytes), after: sha1(bytes) }])
  }

  private async stageFile(entry: Entry): Promise<ActionResult> {
    await this.runner.ok(['add', '-A', '--', entry.path])
    return { message: `Staged ${baseName(entry.path)}`, undoable: false }
  }

  private async unstageFile(entry: Entry): Promise<ActionResult> {
    const paths = entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]
    if (await this.hasHead()) await this.runner.ok(['reset', '-q', '--', ...paths])
    else await this.runner.ok(['rm', '--cached', '-q', '-r', '--', ...paths])
    return { message: `Unstaged ${baseName(entry.path)}`, undoable: false }
  }

  private async revertFile(entry: Entry, newSide: Loaded): Promise<ActionResult> {
    if (entry.change === 'conflicted') throw new ReviewError(`${entry.path} has a conflict. Resolve it, or take one side, in the file.`, 'refused')
    if (entry.submodule) throw new ReviewError('A submodule is not reverted from here.', 'refused')
    const file = this.absolute(entry.path)
    if (entry.change === 'untracked') {
      const before = newSide.bytes ? kept(newSide.bytes) : await keep(file)
      await this.deleteFiles([file])
      return this.remember(`Deleted ${baseName(entry.path)}`, [{ file, before, after: null }])
    }
    const before = await keep(file)
    await this.runner.ok(['checkout', '-q', '--', entry.path])
    return this.remember(`Reverted ${baseName(entry.path)}`, [{ file, before, after: await hashOfFile(file) }])
  }

  private async stageAll(scope: 'unstaged' | 'staged'): Promise<ActionResult> {
    if (scope !== 'unstaged') throw new ReviewError('That cannot be done in this view.', 'refused')
    const count = unstagedEntries(await this.status()).length
    if (!count) return { message: 'Nothing to stage', undoable: false }
    await this.runner.ok(['add', '-A', '--', '.'])
    return { message: `Staged ${count} file${count === 1 ? '' : 's'}`, undoable: false }
  }

  private async unstageAll(scope: 'unstaged' | 'staged'): Promise<ActionResult> {
    if (scope !== 'staged') throw new ReviewError('That cannot be done in this view.', 'refused')
    const status = await this.status()
    const count = stagedEntries(status).length
    if (!count) return { message: 'Nothing to unstage', undoable: false }
    if (status.branch.oid) await this.runner.ok(['reset', '-q', '--', '.'])
    else await this.runner.ok(['rm', '--cached', '-r', '-q', '--', '.'])
    return { message: `Unstaged ${count} file${count === 1 ? '' : 's'}`, undoable: false }
  }

  private async revertAll(scope: 'unstaged' | 'staged'): Promise<ActionResult> {
    if (scope !== 'unstaged') throw new ReviewError('That cannot be done in this view.', 'refused')
    const entries = unstagedEntries(await this.status())
    if (entries.some((entry) => entry.change === 'conflicted')) throw new ReviewError('Some files have conflicts. Resolve them first, or revert the other files one by one.', 'refused')
    const tracked = entries.filter((entry) => entry.change !== 'untracked' && !entry.submodule)
    const untracked = entries.filter((entry) => entry.change === 'untracked')
    if (!tracked.length && !untracked.length) return { message: 'Nothing to revert', undoable: false }
    const files: UndoRecord['files'] = []
    for (const entry of tracked) {
      const file = this.absolute(entry.path)
      files.push({ file, before: await keep(file), after: null })
    }
    if (tracked.length) await this.runner.ok(['checkout', '-q', '--', ...tracked.map((entry) => entry.path)])
    for (const item of files) item.after = await hashOfFile(item.file)
    const removed: UndoRecord['files'] = []
    for (const entry of untracked) {
      const file = this.absolute(entry.path)
      removed.push({ file, before: await keep(file), after: null })
    }
    await this.deleteFiles(removed.map((item) => item.file))
    const count = tracked.length + untracked.length
    return this.remember(`Reverted ${count} file${count === 1 ? '' : 's'}`, [...files, ...removed])
  }

  private async hasHead(): Promise<boolean> {
    return (await this.runner.run(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0
  }

  // ------------------------------------------------------------------ undo

  /** Keeps a revert for `undo`; it can be taken back only when every file it changed was kept. */
  private remember(label: string, files: UndoRecord['files']): ActionResult {
    const undoable = files.every((item) => item.before.state !== 'unknown')
    if (undoable) {
      this.undos.push({ label, files })
      while (this.undos.length > this.undoDepth) this.undos.shift()
    }
    return { message: label, undoable }
  }

  private async deleteFiles(files: readonly string[]): Promise<void> {
    for (const file of files) {
      if (this.options.trash) await this.options.trash(file)
      else await fs.rm(file, { force: true })
    }
  }

  // ------------------------------------------------------------------ commit and push

  /** Commits what is staged (everything first, with `all`), running the repository's hooks as git does. */
  commit(request: { message: string; all?: boolean; amend?: boolean }): Promise<CommitInfo> {
    return this.serial(async () => {
      const message = request.message.replace(/\r\n/g, '\n').trim()
      if (!message) throw new ReviewError('Write a commit message first.', 'refused')
      if (message.length > 64 * 1024) throw new ReviewError('That commit message is too long.', 'refused')
      if (request.all) await this.runner.ok(['add', '-A', '--', '.'])
      const status = await this.status()
      if (status.entries.some((entry) => entry.type === 'unmerged')) throw new ReviewError('Some files still have conflicts. Resolve and stage them first.', 'refused')
      if (!request.amend && !stagedEntries(status).length) throw new ReviewError('Nothing is staged. Stage the changes to commit, or commit all of them.', 'refused')
      if (request.amend && !status.branch.oid) throw new ReviewError('There is no commit to amend yet.', 'refused')
      // Hooks such as lint-staged can take a while.
      await this.runner.ok(['commit', '-q', '--cleanup=whitespace', '-F', '-', ...(request.amend ? ['--amend'] : [])], { input: message + '\n', timeoutMs: 10 * 60_000 })
      return this.commitInfo('HEAD')
    })
  }

  /** Pushes the branch to its upstream, or to the remote (origin first) with an upstream set when it has none. */
  push(): Promise<{ remote: string; branch: string; upstream: boolean }> {
    return this.serial(async () => {
      const status = await this.status()
      const branch = status.branch.head
      if (!branch) throw new ReviewError('HEAD is not on a branch. Check one out to push.', 'refused')
      if (status.branch.upstream) {
        await this.runner.ok(['push'], { timeoutMs: 10 * 60_000 })
        return { remote: status.branch.upstream.split('/')[0], branch, upstream: false }
      }
      const remotes = (await this.runner.text(['remote']))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      if (!remotes.length) throw new ReviewError('This repository has no remote to push to.', 'refused')
      const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null
      if (!remote) throw new ReviewError(`This branch has no upstream and the repository has several remotes (${remotes.join(', ')}). Push it once from a terminal to choose.`, 'refused')
      await this.runner.ok(['push', '-u', remote, `HEAD:refs/heads/${branch}`], { timeoutMs: 10 * 60_000 })
      return { remote, branch, upstream: true }
    })
  }

  /**
   * What a drafted message is written from: the staged changes (and, with `all`, those not staged yet) as unified diff
   * text of at most `limit` characters, the files, and the latest subjects.
   */
  async commitContext(options: { all?: boolean; limit?: number } = {}): Promise<{ diff: string; files: string[]; subjects: string[] }> {
    const limit = options.limit ?? 24_000
    const shown: ReviewOptions = { context: 2, ignoreWhitespace: false }
    const changes = (await this.review({ kind: 'staged' }, shown)).files.map((file) => ({ file, later: false }))
    if (options.all) changes.push(...(await this.review({ kind: 'unstaged' }, shown)).files.map((file) => ({ file, later: true })))
    const subjects = (await this.commits(12)).map((commit) => commit.subject)
    const files = changes.map(({ file, later }) => `${file.change} ${file.oldPath ? `${file.oldPath} -> ` : ''}${file.path} (+${file.added} -${file.removed})${later ? ' (not staged yet)' : ''}`)
    let diff = ''
    for (let index = 0; index < changes.length; index++) {
      const { file, later } = changes[index]
      // Each file gets its share of what is left, so one large file cannot crowd out the rest.
      const share = Math.floor((limit - diff.length) / (changes.length - index))
      if (share < 200) {
        diff += `(${changes.length - index} more file(s) not shown)\n`
        break
      }
      const body = file.hunks
        .map((hunk) => `${hunkHeader(hunk)}\n${hunk.lines.map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`).join('\n')}`)
        .join('\n')
      const piece = `--- ${file.oldPath ?? file.path}\n+++ ${file.path}${later ? ' (not staged yet)' : ''}\n${body || `(${file.note ?? file.kind})`}\n`
      diff += piece.length > share ? `${piece.slice(0, share - 14)}\n(cut short)\n` : piece
    }
    return { diff, files, subjects }
  }

  /** What `undo` would take back, if anything. */
  get undoLabel(): string | null {
    return this.undos[this.undos.length - 1]?.label ?? null
  }

  /** Puts back what the latest revert changed, when the files are still as it left them. */
  undo(): Promise<ActionResult> {
    return this.serial(async () => {
      const record = this.undos[this.undos.length - 1]
      if (!record) throw new ReviewError('There is nothing to undo.', 'not-found')
      for (const item of record.files) {
        if ((await hashOfFile(item.file)) !== item.after) {
          this.undos.pop()
          throw new ReviewError(`${path.basename(item.file)} changed after it was reverted, so the revert is not taken back.`, 'stale')
        }
      }
      this.undos.pop()
      for (const item of record.files) {
        if (item.before.state === 'missing') await fs.rm(item.file, { force: true })
        else if (item.before.state === 'bytes') {
          await fs.mkdir(path.dirname(item.file), { recursive: true })
          await fs.writeFile(item.file, item.before.bytes)
        }
      }
      return { message: `Undid: ${record.label.charAt(0).toLowerCase()}${record.label.slice(1)}`, undoable: false }
    })
  }
}

// ------------------------------------------------------------------ helpers

function baseName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1)
}

function modeOf(side: Side): string | undefined {
  if (side.from === 'blob') return side.mode
  if (side.from === 'worktree') return side.mode && side.mode !== '000000' ? side.mode : undefined
  return undefined
}

function sizeOf(content: Content | { kind: 'submodule' } | { kind: 'folder' }): number | undefined {
  if (content.kind === 'binary' || content.kind === 'large') return content.size
  return undefined
}

function changeOf(status: string): FileChange {
  switch (status) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    case 'U':
      return 'conflicted'
    default:
      return 'modified'
  }
}

function placeholder(entry: Entry, note: string): ReviewFile {
  return { path: entry.path, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), change: entry.change, kind: 'large', hunks: [], added: 0, removed: 0, hunkActions: false, hunkActionsOff: note, note, fingerprint: '' }
}

function submoduleNote(entry: Entry): string {
  if (entry.change === 'added') return 'A submodule was added.'
  if (entry.change === 'deleted') return 'A submodule was removed.'
  return 'The submodule points at another commit, or has changes of its own.'
}

function endingName(content: TextContent): string {
  const crlf = content.endings.filter((ending) => ending === '\r\n').length
  const lf = content.endings.filter((ending) => ending === '\n').length
  if (crlf && lf) return 'mixed'
  return crlf ? 'CRLF' : 'LF'
}

/** A sentence for what the lines do not show. */
function textNote(entry: Entry, a: TextContent, b: TextContent, noLines: boolean, oldMissing: boolean, newMissing: boolean): string | undefined {
  const notes: string[] = []
  const oldMode = modeOf(entry.old)
  const newMode = modeOf(entry.new)
  if (oldMode && newMode && oldMode !== newMode) {
    if (oldMode === '100644' && newMode === '100755') notes.push('The file is now executable.')
    else if (oldMode === '100755' && newMode === '100644') notes.push('The file is no longer executable.')
    else notes.push(`It changed from ${MODE_LABEL[oldMode] ?? oldMode} to ${MODE_LABEL[newMode] ?? newMode}.`)
  }
  if (entry.oldPath && entry.change === 'renamed' && noLines) notes.push(`Renamed from ${entry.oldPath}, unchanged.`)
  if (entry.oldPath && entry.change === 'copied' && noLines) notes.push(`Copied from ${entry.oldPath}, unchanged.`)
  if (noLines && !oldMissing && !newMissing && !notes.length) {
    const sameEndings = a.endings.length === b.endings.length && a.endings.every((ending, index) => ending === b.endings[index])
    if (!sameEndings) notes.push(`Only the line endings changed (${endingName(a)} to ${endingName(b)}).`)
    else if (a.bom !== b.bom) notes.push(b.bom ? 'Only a byte order mark was added.' : 'Only the byte order mark was removed.')
    else notes.push('No line changed. git sees a difference its filters or settings make.')
  }
  if (noLines && (oldMissing || newMissing) && !a.lines.length && !b.lines.length) notes.push(newMissing ? 'An empty file was deleted.' : 'An empty file.')
  return notes.length ? notes.join(' ') : undefined
}

/** The working tree against the index: every path with a change there, new files and conflicts included. */
export function unstagedEntries(status: Status): Entry[] {
  const out: Entry[] = []
  for (const item of status.entries) {
    if (item.type === 'untracked') {
      out.push({ path: item.path, change: 'untracked', old: { from: 'none' }, new: { from: 'worktree' } })
      continue
    }
    if (item.type === 'unmerged') {
      const ours = item.oids?.index
      out.push({
        path: item.path,
        change: 'conflicted',
        old: ours && !isNullOid(ours) ? { from: 'blob', oid: ours, mode: item.modes?.index ?? '100644' } : { from: 'none' },
        new: { from: 'worktree', mode: item.modes?.worktree },
        ...(item.submodule ? { submodule: true } : {}),
      })
      continue
    }
    if (item.y === '.') continue
    out.push(unstagedEntry(item))
  }
  return out
}

function unstagedEntry(item: StatusEntry): Entry {
  const index = item.oids?.index
  const indexMode = item.modes?.index ?? '100644'
  const change: FileChange = item.y === 'D' ? 'deleted' : item.y === 'A' ? 'added' : item.y === 'T' ? 'typechange' : 'modified'
  // An entry added with --intent-to-add holds the empty object: nothing is staged for it yet.
  const old: Side = item.y === 'A' || !index || isNullOid(index) ? { from: 'none' } : { from: 'blob', oid: index, mode: indexMode }
  const now: Side = item.y === 'D' ? { from: 'none' } : { from: 'worktree', mode: item.modes?.worktree }
  return { path: item.path, change, old, new: now, ...(item.submodule ? { submodule: true } : {}) }
}

/** The index against HEAD: every path with a staged change. */
export function stagedEntries(status: Status): Entry[] {
  const out: Entry[] = []
  for (const item of status.entries) {
    if (item.type !== 'ordinary' && item.type !== 'renamed') continue
    if (item.x === '.') continue
    const head = item.oids?.head
    const index = item.oids?.index
    const change = changeOf(item.x)
    out.push({
      path: item.path,
      ...(item.origPath ? { oldPath: item.origPath } : {}),
      change,
      old: item.x === 'A' || !head || isNullOid(head) ? { from: 'none' } : { from: 'blob', oid: head, mode: item.modes?.head ?? '100644' },
      new: item.x === 'D' || !index || isNullOid(index) ? { from: 'none' } : { from: 'blob', oid: index, mode: item.modes?.index ?? '100644' },
      ...(item.submodule ? { submodule: true } : {}),
    })
  }
  return out
}


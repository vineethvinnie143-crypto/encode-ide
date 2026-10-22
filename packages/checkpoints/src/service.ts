import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isInside, isProtectedPath } from '@encode/permissions'
import { BlobError, getBlob, putBlob, sha256 } from './blobs'
import { Manifest, MAX_MANIFEST_BYTES, parseManifest, pathKeyOf, serializeEntry } from './manifest'
import type {
  ApplyOutcome,
  ApplyResult,
  CheckpointFs,
  Entry,
  Hash,
  PlannedFile,
  ReadLimits,
  Replacement,
  RewindFile,
  RewindPlan,
  SnapEntry,
  TurnChanges,
  TurnCheckpoint,
  TurnFile,
  TurnVersion,
  UnreadWhy,
  WriteInfo,
  WriteOutcome,
} from './types'

/**
 * Checkpoints for one session of one workspace.
 *
 * Recording. The file tools call `beforeWrite` with a file's previous bytes
 * before every write. The first time a turn touches a file those bytes are
 * saved (compressed, named by their hash) and the manifest gets a `snap`
 * line; the `postToolUse` hook then calls `afterTool`, which hashes what the
 * tool left and appends a `wrote` line. Nothing is copied when a file is
 * written again in the same turn: rewinding to a turn needs only what the
 * files held when the turn first reached them.
 *
 * Rewinding to turn T puts each file the agent touched since T began back to
 * the earliest version saved after T's marker (or deletes it, with any
 * folders the write created, if it did not exist). The marker order is the
 * append order of the manifest, which stays valid across earlier rewinds:
 * their effects were undone on disk, and their lines are history.
 *
 * Safety.
 * - A file the agent did not leave as it is (the user, a build, or a shell
 *   command changed it; the agent's own last write is unconfirmed) is a
 *   conflict, and is only overwritten when the caller says so.
 * - Everything is re-derived from the manifest and the disk when a plan is
 *   applied; the plan handed back only has to match (its fingerprint), so a
 *   plan that went through a renderer cannot name other files.
 * - Every target is checked on its real path right before it is written:
 *   inside the workspace (or an allowed folder), never in .git or .encode,
 *   whatever the manifest says. Restored bytes are checked against their hash.
 * - A rewind journals what it is about to replace first, so it can be undone
 *   (`planRedo`) and a crash half way leaves a way back.
 *
 * Limits, stated plainly: only changes made through the file tools are
 * recorded, not changes a shell command made; the agent must be idle while a
 * rewind runs; and file modes and ownership are not saved.
 */

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_ID = 256
/** What a review reads by default: a version up to 2 MB, 48 MB in all. */
const REVIEW_FILE_BYTES = 2 * 1024 * 1024
const REVIEW_TOTAL_BYTES = 48 * 1024 * 1024

export interface CheckpointOptions {
  fs: CheckpointFs
  /** This workspace's store (see `checkpointDir`): `blobs/` and `sessions/` live under it. */
  dir: string
  /**
   * The workspace root, then any other folders the agent may write in; a rewind restores files only inside these. A
   * function is asked each time, for a list that can change while the session runs (the settings' extra folders).
   */
  roots: readonly string[] | (() => readonly string[])
  /** Names the session's manifest; letters, digits, dot, dash and underscore only. */
  sessionId: string
  platform?: NodeJS.Platform
  now?: () => number
  /** Largest file kept; a larger one is noted but cannot be restored. Default 20 MB. */
  maxFileBytes?: number
  /** Trouble the user should hear about, such as a damaged line in the history. */
  notice?(text: string): void
}

interface Target {
  path: string
  hash: Hash | null
  stored: boolean
  outside: boolean
  /** Contents that mean nobody else touched the file since the agent did. */
  accept: Set<Hash | null>
  madeDir?: string
}

interface Work {
  target: Target
  file: PlannedFile
}

interface Computed {
  plan: RewindPlan
  work: Work[]
  rewindId?: string
}

type Placement = { ok: true; real: string; relative: string } | { ok: false; reason: string }

/** One file of a turn under review: the turn's first copy of it, and the next turn's, with what eNCode had left before that. */
interface Track {
  first: SnapEntry
  later?: SnapEntry
  leftBefore?: Hash | null
}

/** What a review may still read: per version, and in all. */
interface Budget {
  file: number
  left: number
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertId(what: string, value: string): void {
  if (typeof value !== 'string' || !value || value.length > MAX_ID || value.includes('\u0000')) {
    throw new TypeError(`Checkpoints: not a usable ${what}.`)
  }
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

export class CheckpointService {
  private readonly fs: CheckpointFs
  private readonly api: typeof path.posix
  private readonly keyOf: (file: string) => string
  private readonly manifestFile: string
  private readonly maxFileBytes: number
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()
  private loading: Promise<Manifest> | undefined
  private resolvedRoots: Promise<string[]> | undefined
  /** The list `resolvedRoots` was made from. */
  private resolvedFor = ''
  /** The manifest ended in a torn line; the next line must start on a new one. */
  private needsNewline = false
  /** Files each tool call is about to write, until its `postToolUse` hook records what they hold. */
  private readonly pending = new Map<string, Set<string>>()

  constructor(private readonly options: CheckpointOptions) {
    if (!SESSION_ID.test(options.sessionId)) throw new TypeError(`Checkpoints: not a usable session id: ${JSON.stringify(options.sessionId)}`)
    if (!this.wantedRoots().length) throw new TypeError('Checkpoints: at least one root folder is needed.')
    const windows = (options.platform ?? process.platform) === 'win32'
    this.fs = options.fs
    this.api = windows ? path.win32 : path.posix
    this.keyOf = pathKeyOf(windows)
    this.manifestFile = this.api.join(options.dir, 'sessions', `${options.sessionId}.jsonl`)
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.now = options.now ?? Date.now
  }

  // -------------------------------------------------------------------------
  // Recording

  /** The `userPromptSubmit` hook: a user prompt begins a turn. */
  beginTurn(turn: string): Promise<void> {
    assertId('turn id', turn)
    return this.serial(async () => {
      const manifest = await this.manifest()
      this.pending.clear()
      if (manifest.lastTurn() === turn) return
      await this.record(manifest, { t: 'turn', turn, at: this.now() })
    })
  }

  /**
   * `ToolContext.beforeWrite`: saves what the file holds before the tool
   * overwrites it. A rejection fails the write, so a change is never made
   * that cannot be taken back.
   */
  beforeWrite(file: string, previous: Buffer | null, info: WriteInfo): Promise<void> {
    assertId('turn id', info.turnId)
    assertId('tool use id', info.toolUseId)
    if (!this.api.isAbsolute(file)) return Promise.reject(new TypeError('Checkpoints: the path to write is not absolute.'))
    return this.serial(async () => {
      const manifest = await this.manifest()
      let files = this.pending.get(info.toolUseId)
      if (!files) this.pending.set(info.toolUseId, (files = new Set()))
      files.add(file)
      if (manifest.touched(info.turnId, file)) return
      // A turn the prompt hook never announced (a resumed session, a missing hook) still gets its marker, at its first write.
      if (!manifest.hasTurn(info.turnId)) await this.record(manifest, { t: 'turn', turn: info.turnId, at: this.now() })

      const placement = await this.contain(file)
      const hash = previous ? sha256(previous) : null
      const size = previous?.length ?? 0
      let stored = false
      if (previous && hash && placement.ok && size <= this.maxFileBytes) {
        await putBlob(this.fs, this.options.dir, previous, hash, this.api)
        stored = true
      }
      const madeDir = !previous && placement.ok ? await this.outermostMissingDir(file) : undefined
      await this.record(manifest, {
        t: 'snap',
        turn: info.turnId,
        tool: info.toolUseId,
        path: file,
        hash,
        size,
        stored,
        ...(placement.ok ? {} : { outside: true as const }),
        ...(madeDir ? { madeDir } : {}),
        at: this.now(),
      })
    })
  }

  /** The `postToolUse` hook: records what the files of this tool call hold now. */
  afterTool(toolUseId: string): Promise<void> {
    assertId('tool use id', toolUseId)
    return this.serial(async () => {
      const files = this.pending.get(toolUseId)
      if (!files) return
      this.pending.delete(toolUseId)
      const manifest = await this.manifest()
      for (const file of files) {
        // Files outside the workspace are only noted; there is nothing to compare later.
        if (!manifest.tracked(file)) continue
        const bytes = await this.fs.read(file)
        await this.record(manifest, { t: 'wrote', tool: toolUseId, path: file, hash: bytes ? sha256(bytes) : null, at: this.now() })
      }
    })
  }

  // -------------------------------------------------------------------------
  // Reading the history

  /** Every turn with the files its tools changed, oldest first. */
  turns(): Promise<TurnCheckpoint[]> {
    return this.serial(async () => (await this.manifest()).turns())
  }

  /** True while the latest rewind can still be undone. */
  canRedo(): Promise<boolean> {
    return this.serial(async () => (await this.manifest()).redoCandidate() !== undefined)
  }

  // -------------------------------------------------------------------------
  // Rewinding

  /** What putting the workspace back to the start of `turn` would do, without doing it. */
  planRewind(turn: string): Promise<RewindPlan> {
    assertId('turn id', turn)
    return this.serial(async () => {
      const computed = await this.compute(await this.manifest(), { kind: 'rewind', turn })
      return computed!.plan
    })
  }

  /** What undoing the latest rewind would do; null when there is nothing to undo. */
  planRedo(): Promise<RewindPlan | null> {
    return this.serial(async () => (await this.compute(await this.manifest(), { kind: 'redo' }))?.plan ?? null)
  }

  /**
   * Carries out a plan. Files in conflict stay as they are unless `force`.
   * Refuses (`stale`) when the files or the history no longer match the plan,
   * so the caller shows the user the current state before anything is lost.
   */
  apply(plan: RewindPlan, options: { force?: boolean } = {}): Promise<ApplyOutcome> {
    return this.serial(async () => {
      const manifest = await this.manifest()
      const fresh = await this.compute(manifest, plan.kind === 'redo' ? { kind: 'redo' } : { kind: 'rewind', turn: plan.turn })
      if (!fresh || !fresh.plan.known) {
        return { ok: false, reason: 'unavailable', message: plan.kind === 'redo' ? 'There is no rewind to undo.' : 'Nothing was recorded for that turn.' }
      }
      if (fresh.plan.fingerprint !== plan.fingerprint) {
        return { ok: false, reason: 'stale', message: 'The files or the history changed since this plan was made. Look at it again.' }
      }

      const force = options.force === true
      const result: ApplyResult = { ok: true, restored: [], deleted: [], skipped: [], failed: [] }
      const changes: Work[] = []
      for (const item of fresh.work) {
        const { file } = item
        if (file.action === 'unchanged') continue
        if (file.action === 'skip') result.skipped.push({ path: file.path, reason: file.reason ?? 'cannot be restored' })
        else if (file.conflict && !force) result.skipped.push({ path: file.path, reason: 'changed since the agent last wrote it' })
        else changes.push(item)
      }

      const id = fresh.rewindId ?? randomUUID()
      const ready: Work[] = []
      if (plan.kind === 'rewind') {
        // Keep what is about to be replaced, and journal it, before the first file is touched.
        const journal: RewindFile[] = []
        for (const item of changes) {
          const { target, file } = item
          try {
            const bytes = await this.fs.read(target.path)
            const before = bytes ? sha256(bytes) : null
            if (before !== file.current) {
              result.skipped.push({ path: target.path, reason: 'changed while the rewind was being prepared' })
              continue
            }
            if (bytes) {
              if (bytes.length > this.maxFileBytes) {
                result.skipped.push({ path: target.path, reason: 'too large to keep a copy of before it is replaced' })
                continue
              }
              await putBlob(this.fs, this.options.dir, bytes, before!, this.api)
            }
            journal.push({ path: target.path, before, after: target.hash, stored: bytes !== null, ...(target.madeDir ? { madeDir: target.madeDir } : {}) })
            ready.push(item)
          } catch (error) {
            result.failed.push({ path: target.path, error: describe(error) })
          }
        }
        if (journal.length) await this.record(manifest, { t: 'rewind', id, turn: plan.turn, files: journal, at: this.now() })
      } else {
        ready.push(...changes)
      }

      const done: Work[] = []
      for (const item of ready) {
        try {
          await this.place(item.target)
          done.push(item)
          if (item.file.action === 'delete') result.deleted.push(item.target.path)
          else result.restored.push(item.target.path)
        } catch (error) {
          result.failed.push({ path: item.target.path, error: describe(error) })
        }
      }
      for (const item of done) {
        await this.record(manifest, { t: 'wrote', tool: id, path: item.target.path, hash: item.target.hash, at: this.now() })
      }
      if (plan.kind === 'rewind') {
        if (ready.length) await this.record(manifest, { t: 'rewound', id, at: this.now() })
      } else if (!result.skipped.length && !result.failed.length) {
        // Only a complete undo uses the rewind up; a partial one can be finished (or forced) later.
        await this.record(manifest, { t: 'redone', id, at: this.now() })
      }
      return result
    })
  }

  // -------------------------------------------------------------------------
  // Reviewing one turn

  /**
   * What one turn's tools changed, file by file: the version the turn found, and the one it left. The version it left
   * is the copy a later turn kept just before it changed the file again, or else the file as it is now; `changedSince`
   * says when something other than the agent changed the file after the turn's last write. Nothing is written.
   */
  turnChanges(turn: string, limits: ReadLimits = {}): Promise<TurnChanges> {
    assertId('turn id', turn)
    return this.serial(async () => {
      const manifest = await this.manifest()
      const marker = manifest.markerIndex(turn)
      if (marker === undefined) return { turn, known: false, files: [] }
      const tracks = new Map<string, Track>()
      /** What eNCode last left in each file, as the history goes on. */
      const left = new Map<string, Hash | null>()
      for (let index = marker + 1; index < manifest.entries.length; index++) {
        const entry = manifest.entries[index]
        if (entry.t === 'wrote') {
          left.set(this.keyOf(entry.path), entry.hash)
          continue
        }
        if (entry.t !== 'snap') continue
        const key = this.keyOf(entry.path)
        const track = tracks.get(key)
        if (entry.turn === turn) {
          if (!track) tracks.set(key, { first: entry })
        } else if (track && !track.later) {
          track.later = entry
          if (left.has(key)) track.leftBefore = left.get(key)
        }
      }
      const budget: Budget = { file: limits.maxFileBytes ?? REVIEW_FILE_BYTES, left: limits.maxTotalBytes ?? REVIEW_TOTAL_BYTES }
      const files: TurnFile[] = []
      for (const track of [...tracks.values()].sort((a, b) => byPath(a.first, b.first))) files.push(await this.turnFile(manifest, track, budget))
      return { turn, known: true, at: manifest.entries[marker].at, files }
    })
  }

  /**
   * Writes a file the agent changed, for the person: a change of the agent's they took back in a review, or put back
   * again. Only a file the history tracks, only inside the workspace and never in .git or .encode, and only while it
   * holds `expected` (null: there is no file). What it held is kept in the store first. The write is recorded as what
   * eNCode last left there, so that a later rewind does not take the person's choice for someone else's edit.
   */
  write(file: string, expected: Hash | null, next: Replacement): Promise<WriteOutcome> {
    return this.serial(async () => {
      const name = this.api.basename(file)
      const refuse = (message: string): WriteOutcome => ({ ok: false, reason: 'refused', message })
      const manifest = await this.manifest()
      if (!this.api.isAbsolute(file) || !manifest.tracked(file)) return refuse(`eNCode only writes files the agent changed, and ${name} is not one of them.`)
      const placement = await this.contain(file)
      if (!placement.ok) return refuse(`${name} is ${placement.reason}.`)
      const bytes = await this.fs.read(file)
      const current = bytes ? sha256(bytes) : null
      if (current !== expected) return { ok: false, reason: 'stale', message: `${name} changed since you looked at it.` }
      let replacement: Buffer | null = null
      if (next && 'bytes' in next) replacement = next.bytes
      else if (next) {
        try {
          replacement = await getBlob(this.fs, this.options.dir, next.kept, this.api)
        } catch (error) {
          return refuse(`The copy of ${name} to put back is not there any more (${error instanceof BlobError ? error.message : describe(error)}).`)
        }
      }
      const written = replacement ? sha256(replacement) : null
      if (written === current) return { ok: true, previous: current, written }
      if (bytes) {
        if (bytes.length > this.maxFileBytes) return refuse(`${name} is too large to keep a copy of before it is replaced.`)
        await putBlob(this.fs, this.options.dir, bytes, current!, this.api)
      }
      if (replacement) await this.fs.overwrite(file, replacement)
      else {
        await this.fs.remove(file)
        const madeDir = this.madeDirOf(manifest, file)
        if (madeDir) await this.removeMadeDirs(file, madeDir)
      }
      await this.record(manifest, { t: 'wrote', tool: `review-${randomUUID()}`, path: file, hash: written, at: this.now() })
      return { ok: true, previous: current, written }
    })
  }

  // -------------------------------------------------------------------------
  // Internals

  /** Runs one operation at a time, so lines reach the manifest in the order things happened. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work)
    this.queue = run.catch(() => undefined)
    return run
  }

  private manifest(): Promise<Manifest> {
    if (!this.loading) {
      this.loading = this.readManifest()
      // A failed read is tried again next time instead of being remembered.
      this.loading.catch(() => {
        this.loading = undefined
      })
    }
    return this.loading
  }

  private async readManifest(): Promise<Manifest> {
    const manifest = new Manifest(this.keyOf)
    const bytes = await this.fs.read(this.manifestFile)
    if (!bytes) return manifest
    if (bytes.length > MAX_MANIFEST_BYTES) {
      throw new Error(`This session's checkpoint history is larger than ${MAX_MANIFEST_BYTES / 1024 / 1024} MB and was not read.`)
    }
    const { entries, bad } = parseManifest(bytes.toString('utf8'))
    for (const entry of entries) manifest.add(entry)
    this.needsNewline = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a
    if (bad) this.options.notice?.(`${bad} damaged line${bad === 1 ? '' : 's'} in this session's checkpoint history ${bad === 1 ? 'was' : 'were'} skipped.`)
    return manifest
  }

  /** Appends a line, then remembers it; a line that could not be written is not remembered. */
  private async record(manifest: Manifest, entry: Entry): Promise<void> {
    await this.fs.append(this.manifestFile, `${this.needsNewline ? '\n' : ''}${serializeEntry(entry)}`)
    this.needsNewline = false
    manifest.add(entry)
  }

  private wantedRoots(): readonly string[] {
    const { roots } = this.options
    return typeof roots === 'function' ? roots() : roots
  }

  /** The folders a rewind may write in, with their links resolved; resolved again only when the list changes. */
  private roots(): Promise<string[]> {
    const wanted = this.wantedRoots()
    const key = wanted.join('\u0000')
    if (!this.resolvedRoots || this.resolvedFor !== key) {
      const resolving = Promise.all(wanted.map((root) => this.fs.realpath(root)))
      this.resolvedRoots = resolving
      this.resolvedFor = key
      resolving.catch(() => {
        if (this.resolvedRoots === resolving) this.resolvedRoots = undefined
      })
    }
    return this.resolvedRoots
  }

  /** Whether a path, once its links are resolved, is somewhere a rewind may write. */
  private async contain(file: string): Promise<Placement> {
    if (!this.api.isAbsolute(file)) return { ok: false, reason: 'not an absolute path' }
    const real = await this.fs.realpath(file)
    for (const root of await this.roots()) {
      if (!isInside(root, real, this.api)) continue
      const relative = this.api.relative(root, real)
      if (isProtectedPath(relative)) return { ok: false, reason: 'inside .git or .encode, which a rewind never touches' }
      return { ok: true, real, relative }
    }
    return { ok: false, reason: 'outside the workspace' }
  }

  /** The outermost folder above `file` that does not exist yet, which writing the file will create. */
  private async outermostMissingDir(file: string): Promise<string | undefined> {
    let dir = this.api.dirname(file)
    let missing: string | undefined
    for (;;) {
      if (await this.fs.exists(dir)) return missing
      missing = dir
      const parent = this.api.dirname(dir)
      if (parent === dir) return missing
      dir = parent
    }
  }

  /** Works out, for each file, what a rewind or undo would do to it now. */
  private async compute(manifest: Manifest, request: { kind: 'rewind'; turn: string } | { kind: 'redo' }): Promise<Computed | null> {
    const targets: Target[] = []
    let turn: string
    let rewindId: string | undefined
    if (request.kind === 'rewind') {
      turn = request.turn
      const marker = manifest.markerIndex(turn)
      if (marker === undefined) return { plan: this.makePlan('rewind', turn, false, []), work: [] }
      // The earliest version saved after the turn began is the file as the turn found it.
      const seen = new Set<string>()
      for (let index = marker + 1; index < manifest.entries.length; index++) {
        const entry = manifest.entries[index]
        if (entry.t !== 'snap') continue
        const key = this.keyOf(entry.path)
        if (seen.has(key)) continue
        seen.add(key)
        const expected = manifest.expectation(entry.path)
        targets.push({
          path: entry.path,
          hash: entry.hash,
          stored: entry.stored,
          outside: entry.outside === true,
          accept: new Set(expected ? [expected.hash] : []),
          ...(entry.madeDir ? { madeDir: entry.madeDir } : {}),
        })
      }
    } else {
      const candidate = manifest.redoCandidate()
      if (!candidate) return null
      turn = candidate.turn
      rewindId = candidate.id
      for (const file of candidate.files) {
        targets.push({ path: file.path, hash: file.before, stored: file.stored, outside: false, accept: new Set([file.before, file.after]) })
      }
    }
    const work: Work[] = []
    for (const target of targets.sort(byPath)) work.push({ target, file: await this.examine(target) })
    return { plan: this.makePlan(request.kind, turn, true, work.map((item) => item.file)), work, ...(rewindId ? { rewindId } : {}) }
  }

  private async examine(target: Target): Promise<PlannedFile> {
    const skip = (reason: string, current: Hash | null = null): PlannedFile => ({
      path: target.path,
      action: 'skip',
      reason,
      conflict: false,
      current,
      target: target.hash,
    })
    if (target.outside) return skip('outside the workspace')
    const placement = await this.contain(target.path)
    if (!placement.ok) return skip(placement.reason)
    let current: Hash | null
    try {
      const bytes = await this.fs.read(target.path)
      current = bytes ? sha256(bytes) : null
    } catch (error) {
      return skip(`could not be read (${describe(error)})`)
    }
    const base = { path: target.path, current, target: target.hash }
    if (current === target.hash) return { ...base, action: 'unchanged', conflict: false }
    if (target.hash !== null) {
      if (!target.stored) return skip('too large to keep a copy of', current)
      try {
        await getBlob(this.fs, this.options.dir, target.hash, this.api)
      } catch (error) {
        return skip(error instanceof BlobError ? `saved copy ${error.kind}` : `saved copy unreadable (${describe(error)})`, current)
      }
    }
    return { ...base, action: target.hash === null ? 'delete' : 'restore', conflict: !target.accept.has(current) }
  }

  /** One file of a turn as a review shows it. */
  private async turnFile(manifest: Manifest, track: Track, budget: Budget): Promise<TurnFile> {
    const { first, later } = track
    const outside: TurnVersion = { state: 'unread', hash: null, size: 0, why: 'outside' }
    if (first.outside) return { path: first.path, before: this.unread(first, 'outside'), after: outside, afterFrom: 'now', changedSince: false, fixed: 'outside the workspace' }
    const placement = await this.contain(first.path)
    const before = await this.keptVersion(first, budget)
    if (later) {
      return {
        path: first.path,
        before,
        after: await this.keptVersion(later, budget),
        afterFrom: 'later',
        changedSince: track.leftBefore !== undefined && later.hash !== track.leftBefore,
        fixed: placement.ok ? 'changed again by a later request' : placement.reason,
      }
    }
    if (!placement.ok) return { path: first.path, before, after: outside, afterFrom: 'now', changedSince: false, fixed: placement.reason }
    const after = await this.diskVersion(first.path, budget)
    const expected = manifest.expectation(first.path)
    const now = after.state === 'missing' ? null : after.hash
    // Only a write the history saw finish says what the file should hold; a version not read cannot be compared.
    const changedSince = expected?.confirmed === true && (after.state === 'missing' || after.hash !== null) && now !== expected.hash
    return { path: first.path, before, after, afterFrom: 'now', changedSince }
  }

  private unread(snap: SnapEntry, why: UnreadWhy): TurnVersion {
    return { state: 'unread', hash: snap.hash, size: snap.size, why }
  }

  /** The version a turn's copy holds, read from the store within the budget. */
  private async keptVersion(snap: SnapEntry, budget: Budget): Promise<TurnVersion> {
    if (snap.hash === null) return { state: 'missing' }
    if (snap.outside) return this.unread(snap, 'outside')
    if (!snap.stored) return this.unread(snap, 'unkept')
    if (snap.size > budget.file) return this.unread(snap, 'large')
    if (snap.size > budget.left) return this.unread(snap, 'budget')
    try {
      const bytes = await getBlob(this.fs, this.options.dir, snap.hash, this.api)
      budget.left -= bytes.length
      return { state: 'bytes', hash: snap.hash, bytes }
    } catch {
      return this.unread(snap, 'lost')
    }
  }

  /**
   * The file as it is now, read within the budget. A file too large to show is still read for its hash, up to the
   * size the store keeps a copy of, so a review can put it back whole; its bytes are not held.
   */
  private async diskVersion(file: string, budget: Budget): Promise<TurnVersion> {
    try {
      const size = this.fs.size ? await this.fs.size(file) : undefined
      if (size === null) return { state: 'missing' }
      if (size !== undefined && size > this.maxFileBytes) return { state: 'unread', hash: null, size, why: 'large' }
      const bytes = await this.fs.read(file)
      if (!bytes) return { state: 'missing' }
      const hash = sha256(bytes)
      if (bytes.length > budget.file) return { state: 'unread', hash, size: bytes.length, why: 'large' }
      if (bytes.length > budget.left) return { state: 'unread', hash, size: bytes.length, why: 'budget' }
      budget.left -= bytes.length
      return { state: 'bytes', hash, bytes }
    } catch {
      return { state: 'unread', hash: null, size: 0, why: 'lost' }
    }
  }

  /** The folder the agent's latest creation of the file made for it, if any. */
  private madeDirOf(manifest: Manifest, file: string): string | undefined {
    const key = this.keyOf(file)
    for (let index = manifest.entries.length - 1; index >= 0; index--) {
      const entry = manifest.entries[index]
      if (entry.t === 'snap' && entry.hash === null && this.keyOf(entry.path) === key) return entry.madeDir
    }
    return undefined
  }

  private makePlan(kind: RewindPlan['kind'], turn: string, known: boolean, files: PlannedFile[]): RewindPlan {
    const summary = files.map((file) => [file.path, file.action, file.reason ?? '', file.conflict, file.current, file.target])
    const fingerprint = sha256(Buffer.from(JSON.stringify([kind, turn, known, summary]), 'utf8'))
    return { kind, turn, known, files, fingerprint }
  }

  /** Puts one file back, checking its real path again first. */
  private async place(target: Target): Promise<void> {
    const placement = await this.contain(target.path)
    if (!placement.ok) throw new Error(placement.reason)
    if (target.hash === null) {
      await this.fs.remove(target.path)
      if (target.madeDir) await this.removeMadeDirs(target.path, target.madeDir)
      return
    }
    await this.fs.overwrite(target.path, await getBlob(this.fs, this.options.dir, target.hash, this.api))
  }

  /** Takes away the folders a deleted file's write had created, as far as they are empty. */
  private async removeMadeDirs(file: string, madeDir: string): Promise<void> {
    const start = this.api.dirname(file)
    const within = this.api.relative(madeDir, start)
    // Only folders from the file's own down to the one its write created, as the manifest says: anything else is not ours to remove.
    if (within === '..' || within.startsWith(`..${this.api.sep}`) || this.api.isAbsolute(within)) return
    const placement = await this.contain(madeDir)
    if (!placement.ok || placement.relative === '') return
    let dir = start
    for (;;) {
      if (!(await this.fs.removeEmptyDir(dir))) return
      if (this.keyOf(dir) === this.keyOf(madeDir)) return
      const parent = this.api.dirname(dir)
      if (parent === dir) return
      dir = parent
    }
  }
}

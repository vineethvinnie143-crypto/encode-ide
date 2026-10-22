/**
 * The Review tab's Turn view: what one request's file tools changed, from the agent's record of it (its checkpoints),
 * so a folder without git can be reviewed too. The agent host keeps the record and does every write, inside the
 * workspace and only while the file holds what was shown; this side compares the versions with @encode/git's diff,
 * checks each action against the picture the person acted on, and keeps the undo list.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { compareBytes, decode, encode, reverseHunk } from '@encode/git'
import type { ChangeVersion, TurnChangeSet, TurnFileChange, TurnFileWrite, TurnWriteOutcome } from '@encode/core'
import type { ReviewAction, ReviewActOutcome, ReviewFile, ReviewLoad, ReviewOptions, ReviewSnapshot } from '../../shared/types'

export type TurnScope = { kind: 'turn'; session: string; turn?: string }

/** The agent host's side: the record of a request's changes, and the writes the person asks for. */
export interface TurnSource {
  changes(sessionId: string, turn?: string): Promise<TurnChangeSet>
  write(sessionId: string, write: TurnFileWrite): Promise<TurnWriteOutcome>
}

/** A write the person can take back: per file, what it held before (kept by the record) and what the write left. */
interface UndoRecord {
  session: string
  label: string
  files: Array<{ file: string; previous: string | null; written: string | null }>
}

class Refusal extends Error {
  constructor(
    message: string,
    readonly stale: boolean,
  ) {
    super(message)
  }
}

const UNREAD_NOTE: Record<'large' | 'budget' | 'unkept' | 'lost' | 'outside', string> = {
  large: 'Too large to show here.',
  budget: 'Not read: this review is too large to show every file at once.',
  unkept: 'Too large for eNCode to have kept a copy, so the version before this request is not known.',
  lost: 'A saved copy of this file is missing or damaged, so this change cannot be shown.',
  outside: 'Outside the workspace: eNCode keeps no copies of files there.',
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function bytesOf(version: ChangeVersion): Buffer | null {
  return version.state === 'bytes' ? Buffer.from(version.bytes.buffer, version.bytes.byteOffset, version.bytes.byteLength) : null
}

function hashOf(version: ChangeVersion): string | null | undefined {
  if (version.state === 'missing') return null
  return version.hash ?? undefined
}

function sameVersion(a: ChangeVersion, b: ChangeVersion): boolean {
  if (a.state === 'missing' || b.state === 'missing') return a.state === b.state
  return a.hash !== null && a.hash === b.hash
}

/** The bytes as their own ArrayBuffer, the shape a write carries across. */
function arrayBufferOf(bytes: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function baseName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1)
}

/** Whether the file as shown can be written back from the review, and what a whole-file revert would put there. */
function revertTarget(change: TurnFileChange, busy: boolean): { ok: true; next: TurnFileWrite['next']; expected: string | null } | { ok: false; why: string } {
  if (busy) return { ok: false, why: 'eNCode is working on this session. Wait for it to finish, or stop it.' }
  if (change.fixed) return { ok: false, why: `This file cannot be changed from here: ${change.fixed}.` }
  const expected = hashOf(change.after)
  if (expected === undefined) {
    const large = change.after.state === 'unread' && change.after.why === 'large'
    return { ok: false, why: large ? 'It is too large for eNCode to keep a copy of before replacing it, so it is not changed from here.' : 'The file as it is now could not be read, so it is not changed from here.' }
  }
  const { before } = change
  if (before.state === 'missing') return { ok: true, next: null, expected }
  // A copy the review did not read (too large to show, or past what one review reads) is still in the store.
  if (before.hash && (before.state === 'bytes' || before.why === 'large' || before.why === 'budget')) return { ok: true, next: { kept: before.hash }, expected }
  return { ok: false, why: 'The version before this request is not known, so it cannot be put back.' }
}

/** One file of the record as the review shows it; null when the request's change to it is no longer there. */
export function reviewFileOf(change: TurnFileChange, options: ReviewOptions, busy: boolean): ReviewFile | null {
  const { before, after } = change
  if (sameVersion(before, after)) return null
  const kind = before.state === 'missing' ? 'added' : after.state === 'missing' ? 'deleted' : 'modified'
  const target = revertTarget(change, busy)
  const notes: string[] = []
  if (change.afterFrom === 'later') notes.push('A later request changed this file again: it is shown as that request found it.')
  if (change.changedSince) notes.push(change.afterFrom === 'later' ? 'Something other than the agent changed it before that.' : 'Something other than the agent changed it since; that change is shown too.')
  const fixed = target.ok ? undefined : target.why
  if (before.state === 'unread' || after.state === 'unread') {
    const unread = before.state === 'unread' ? before : (after as Extract<ChangeVersion, { state: 'unread' }>)
    const size = { ...(before.state === 'unread' ? { old: before.size } : {}), ...(after.state === 'unread' ? { new: after.size } : {}) }
    return {
      path: change.path,
      change: kind,
      kind: 'large',
      hunks: [],
      added: 0,
      removed: 0,
      hunkActions: false,
      hunkActionsOff: UNREAD_NOTE[unread.why],
      note: [UNREAD_NOTE[unread.why], ...notes].join(' '),
      size,
      fingerprint: sha1(JSON.stringify([kind, hashOf(before) ?? 'unread', hashOf(after) ?? 'unread', unread.why])),
      ...(fixed ? { fixed } : {}),
    }
  }
  const file = compareBytes({ path: change.path, change: kind, old: bytesOf(before), new: bytesOf(after), editable: target.ok }, options)
  const note = [file.note, ...notes].filter(Boolean).join(' ')
  return { ...file, ...(note ? { note } : {}), ...(fixed ? { fixed } : {}) }
}

/** The record of a request as a review: the files it changed that still differ, in the shapes the tab draws. */
export function turnSnapshot(set: TurnChangeSet, scope: TurnScope, options: ReviewOptions): ReviewSnapshot {
  const files: ReviewFile[] = []
  let skipped = 0
  const overBudget = (version: ChangeVersion) => version.state === 'unread' && version.why === 'budget'
  for (const change of set.files) {
    const file = reviewFileOf(change, options, set.busy)
    if (!file) continue
    if (overBudget(change.before) || overBudget(change.after)) skipped++
    files.push(file)
  }
  let added = 0
  let removed = 0
  for (const file of files) {
    added += file.added
    removed += file.removed
  }
  return {
    scope: { kind: 'turn', session: scope.session, ...(set.turn ? { turn: set.turn } : {}) },
    repo: { root: set.root, folder: '', branch: null, head: null },
    files,
    added,
    removed,
    counts: null,
    skipped,
    readOnly: set.busy,
    options,
    turn: { id: set.turn, ...(set.at !== undefined ? { at: set.at } : {}), busy: set.busy },
  }
}

export class TurnReview {
  private readonly undos: UndoRecord[] = []
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly source: TurnSource,
    private readonly undoDepth = 20,
  ) {}

  /** One action at a time: each reads the record, then writes. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work, work)
    this.queue = task.catch(() => undefined)
    return task
  }

  private undoLabel(session: string): string | null {
    for (let index = this.undos.length - 1; index >= 0; index--) if (this.undos[index].session === session) return this.undos[index].label
    return null
  }

  async load(scope: TurnScope, options: ReviewOptions): Promise<ReviewLoad> {
    const set = await this.source.changes(scope.session, scope.turn)
    if (set.problem) return { ok: false, message: set.problem }
    return { ok: true, snapshot: turnSnapshot(set, scope, options), undo: this.undoLabel(scope.session) }
  }

  act(scope: TurnScope, action: ReviewAction, options: ReviewOptions): Promise<ReviewActOutcome> {
    return this.serial(async () => {
      try {
        const done = await this.carryOut(scope, action, options)
        return { ok: true, message: done.message, undoable: done.undoable, load: await this.load(scope, options) }
      } catch (error) {
        if (!(error instanceof Refusal)) throw error
        return { ok: false, message: error.message, stale: error.stale, load: await this.load(scope, options) }
      }
    })
  }

  undo(scope: TurnScope, options: ReviewOptions): Promise<ReviewActOutcome> {
    return this.serial(async () => {
      let index = this.undos.length - 1
      while (index >= 0 && this.undos[index].session !== scope.session) index--
      if (index < 0) return { ok: false, message: 'There is nothing to undo.', stale: false, load: await this.load(scope, options) }
      const [record] = this.undos.splice(index, 1)
      // Put back in the opposite order; a file someone changed since is left as it is, and said.
      const problems: string[] = []
      for (const item of [...record.files].reverse()) {
        const outcome = await this.source.write(scope.session, { file: item.file, expected: item.written, next: item.previous === null ? null : { kept: item.previous } })
        if (!outcome.ok) problems.push(outcome.reason === 'stale' ? `${path.basename(item.file)} changed after it was reverted, so it was left as it is.` : outcome.message)
      }
      const load = await this.load(scope, options)
      if (problems.length) return { ok: false, message: problems.join(' '), stale: true, load }
      return { ok: true, message: `Undid: ${record.label.charAt(0).toLowerCase()}${record.label.slice(1)}`, undoable: false, load }
    })
  }

  private remember(record: UndoRecord): void {
    this.undos.push(record)
    while (this.undos.length > this.undoDepth) this.undos.shift()
  }

  /** Does the action on the record as it is now, refusing when the file moved on from the picture it was taken on. */
  private async carryOut(scope: TurnScope, action: ReviewAction, options: ReviewOptions): Promise<{ message: string; undoable: boolean }> {
    if (action.type !== 'revert-hunk' && action.type !== 'revert-file' && action.type !== 'revert-all') throw new Refusal('In this view a change can only be reverted.', false)
    if (!scope.turn) throw new Refusal('Choose the request to act on first.', true)
    const set = await this.source.changes(scope.session, scope.turn)
    if (set.problem) throw new Refusal(set.problem, true)
    if (set.busy) throw new Refusal('eNCode is working on this session. Wait for it to finish, or stop it.', false)

    if (action.type === 'revert-all') {
      const files: UndoRecord['files'] = []
      const problems: string[] = []
      for (const change of set.files) {
        if (!reviewFileOf(change, options, false)) continue
        const target = revertTarget(change, false)
        if (!target.ok) {
          problems.push(`${baseName(change.path)}: ${target.why}`)
          continue
        }
        const outcome = await this.source.write(scope.session, { file: change.file, expected: target.expected, next: target.next })
        if (outcome.ok) files.push({ file: change.file, previous: outcome.previous, written: outcome.written })
        else problems.push(`${baseName(change.path)}: ${outcome.message}`)
      }
      if (!files.length) throw new Refusal(problems.length ? `Nothing was reverted. ${problems.join(' ')}` : 'Nothing to revert.', false)
      const label = `Reverted ${files.length} file${files.length === 1 ? '' : 's'}`
      this.remember({ session: scope.session, label, files })
      return { message: problems.length ? `${label}. Left as they are: ${problems.join(' ')}` : label, undoable: true }
    }

    if (!('path' in action)) throw new Refusal('In this view a change can only be reverted.', false)
    const change = set.files.find((item) => item.path === action.path)
    const file = change ? reviewFileOf(change, options, false) : null
    if (!change || !file) throw new Refusal(`${action.path} has no change from this request any more.`, true)
    if (action.fingerprint && action.fingerprint !== file.fingerprint) throw new Refusal(`${action.path} changed since you looked at it. The review shows it as it is now.`, true)
    const target = revertTarget(change, false)
    if (!target.ok) throw new Refusal(target.why, false)

    let next: TurnFileWrite['next'] = target.next
    let label = change.before.state === 'missing' ? `Deleted ${baseName(change.path)}` : `Reverted ${baseName(change.path)}`
    // A file with only one side is one hunk: what is done to it is done to the file.
    if (action.type === 'revert-hunk' && change.before.state === 'bytes' && change.after.state === 'bytes') {
      if (!file.hunkActions) throw new Refusal(file.hunkActionsOff ?? 'This change cannot be taken on its own.', false)
      const hunk = file.hunks.find((item) => item.id === action.hunk)
      if (!hunk) throw new Refusal(`That change in ${action.path} is not there any more. The review shows the file as it is now.`, true)
      const content = decode(bytesOf(change.after)!)
      if (content.kind !== 'text') throw new Refusal('This change cannot be taken on its own.', false)
      const reverted = reverseHunk(content, hunk)
      if (!reverted) throw new Refusal(`That change in ${action.path} no longer fits the file. The review shows it as it is now.`, true)
      next = { bytes: arrayBufferOf(encode(reverted)) }
      label = `Reverted a change in ${baseName(change.path)}`
    }
    const outcome = await this.source.write(scope.session, { file: change.file, expected: target.expected, next })
    if (!outcome.ok) throw new Refusal(outcome.message, outcome.reason === 'stale')
    this.remember({ session: scope.session, label, files: [{ file: change.file, previous: outcome.previous, written: outcome.written }] })
    return { message: label, undoable: true }
  }
}

/**
 * Shapes shared by the checkpoint store, its journal and the service.
 *
 * A checkpoint is not a copy of the workspace. The agent's file tools call
 * `beforeWrite` with a file's previous bytes; the first time a turn touches a
 * file those bytes are saved, and a line in the session's manifest says so.
 * "Rewind to turn T" puts every file the agent touched since T back to the
 * earliest version saved after T began.
 */

/** Lowercase hex SHA-256 of a file's bytes. */
export type Hash = string

export interface DirEntry {
  name: string
  isFile: boolean
  size: number
  mtimeMs: number
}

/**
 * The disk, as checkpoints use it: the store (blobs and manifests) and the
 * workspace files a rewind restores. Injected, so the logic is tested against
 * memory and the Node adapter against a real disk.
 */
export interface CheckpointFs {
  /** The file's bytes, or null when it does not exist. */
  read(file: string): Promise<Buffer | null>
  /**
   * Creates a store file that never changes afterwards (its name is its
   * content's hash), creating folders. The file is never seen half written,
   * and one that already exists is left alone.
   */
  writeOnce(file: string, bytes: Buffer): Promise<void>
  /** Writes a workspace file in place, as the agent's own tools do, creating folders. */
  overwrite(file: string, bytes: Buffer): Promise<void>
  /** Deletes a file; a missing file is fine. */
  remove(file: string): Promise<void>
  /** Removes a folder only when it is empty; false when it is not (or is gone). */
  removeEmptyDir(dir: string): Promise<boolean>
  /** Appends text to a store file, creating it and its folders. */
  append(file: string, text: string): Promise<void>
  /** The folder's entries, or none when it does not exist. */
  list(dir: string): Promise<DirEntry[]>
  /** True when something exists at the path; a link counts, whatever it points to. */
  exists(target: string): Promise<boolean>
  /** Resolves links on the longest existing prefix of the path and re-attaches the rest. */
  realpath(target: string): Promise<string>
  /** The size of a file, without reading it; null when there is no file there. Without it, the file is read to learn it. */
  size?(file: string): Promise<number | null>
}

// ---------------------------------------------------------------------------
// The manifest: one JSON line per event, appended as it happens.

/** A user prompt began a turn. Rewinding "to a turn" means to the moment of this line. */
export interface TurnEntry {
  t: 'turn'
  turn: string
  at: number
}

/** The first write of a file in a turn: what the file was before it. */
export interface SnapEntry {
  t: 'snap'
  turn: string
  tool: string
  /** Absolute, as the tool wrote it. */
  path: string
  /** The file before the write; null when it did not exist. */
  hash: Hash | null
  size: number
  /** Whether a copy of those bytes is kept. */
  stored: boolean
  /** Set when the file lies outside the workspace: noted for the user, never copied or restored. */
  outside?: true
  /** The outermost folder the write is about to create, so a rewind can take it away again. */
  madeDir?: string
  at: number
}

/** What a file held once a tool call was over: what the agent "last left". */
export interface WroteEntry {
  t: 'wrote'
  tool: string
  path: string
  hash: Hash | null
  at: number
}

/** One file of a rewind, as it was before and as the rewind left it. */
export interface RewindFile {
  path: string
  before: Hash | null
  after: Hash | null
  /** Whether a copy of `before` is kept, so the rewind can be undone. */
  stored: boolean
  madeDir?: string
}

/** Written before a rewind touches any file, so a crash half way still leaves a way back. */
export interface RewindEntry {
  t: 'rewind'
  id: string
  turn: string
  files: RewindFile[]
  at: number
}

export interface RewoundEntry {
  t: 'rewound'
  id: string
  at: number
}

export interface RedoneEntry {
  t: 'redone'
  id: string
  at: number
}

export type Entry = TurnEntry | SnapEntry | WroteEntry | RewindEntry | RewoundEntry | RedoneEntry

// ---------------------------------------------------------------------------
// What the service reports

/** What the history says about one turn, for the rewind picker. */
export interface TurnCheckpoint {
  turn: string
  at: number
  /** Files in the workspace the agent's tools changed in this turn. */
  files: string[]
  /** Files the tools changed elsewhere, which a rewind does not restore. */
  outside: string[]
}

export type FileAction = 'restore' | 'delete' | 'unchanged' | 'skip'

export interface PlannedFile {
  path: string
  action: FileAction
  /** Why the file is skipped. */
  reason?: string
  /** Not what the agent last left there: restoring would overwrite someone else's change. */
  conflict: boolean
  /** The file's hash now; null when it is missing. */
  current: Hash | null
  /** The hash it would be put back to; null when it would be deleted. */
  target: Hash | null
}

export interface RewindPlan {
  kind: 'rewind' | 'redo'
  /** The turn rewound to (for a redo, the turn of the rewind it undoes). */
  turn: string
  /** False when nothing was recorded for the turn, so there is nothing to restore. */
  known: boolean
  files: PlannedFile[]
  /** Names this state of the disk and the history; `apply` refuses a plan that no longer matches. */
  fingerprint: string
}

export interface ApplyResult {
  ok: true
  restored: string[]
  deleted: string[]
  /** Left as they were, with the reason. */
  skipped: { path: string; reason: string }[]
  failed: { path: string; error: string }[]
}

export interface ApplyRefusal {
  ok: false
  reason: 'stale' | 'unavailable'
  message: string
}

export type ApplyOutcome = ApplyResult | ApplyRefusal

/** The `info` argument of `ToolContext.beforeWrite`. */
export interface WriteInfo {
  turnId: string
  toolUseId: string
}

// ---------------------------------------------------------------------------
// One turn's changes, for the Review tab

/** Why a version of a file is known only by its hash. */
export type UnreadWhy =
  /** Larger than a review reads. */
  | 'large'
  /** The review read as much as it may at once. */
  | 'budget'
  /** Too large to keep a copy of when it was replaced. */
  | 'unkept'
  /** Its saved copy is missing or damaged, or the file could not be read. */
  | 'lost'
  /** Outside the workspace, or in .git or .encode: never copied. */
  | 'outside'

/** One version of a file, as a review reads it. */
export type TurnVersion = { state: 'missing' } | { state: 'bytes'; hash: Hash; bytes: Buffer } | { state: 'unread'; hash: Hash | null; size: number; why: UnreadWhy }

/** One file a turn's tools changed: how the turn found it, and how it left it. */
export interface TurnFile {
  /** Absolute, as the tools wrote it. */
  path: string
  before: TurnVersion
  /** The copy a later turn kept just before it changed the file again (`later`), or the file now (`now`). */
  after: TurnVersion
  afterFrom: 'later' | 'now'
  /** Something other than the agent changed the file after the turn's last write, so `after` holds that change too. */
  changedSince: boolean
  /** Why the file cannot be written from a review: where it lies, or that a later turn changed it again. */
  fixed?: string
}

export interface TurnChanges {
  turn: string
  /** False when nothing was recorded for the turn. */
  known: boolean
  /** When the turn began. */
  at?: number
  /** By path. */
  files: TurnFile[]
}

/** What a review reads at most. */
export interface ReadLimits {
  /** A version larger than this is not read. Default 2 MB. */
  maxFileBytes?: number
  /** Past this many bytes read for one review, versions are not read. Default 48 MB. */
  maxTotalBytes?: number
}

/** What a review write puts in a file: these bytes, a copy the store keeps, or nothing (the file is deleted). */
export type Replacement = { bytes: Buffer } | { kept: Hash } | null

export type WriteOutcome =
  /** `previous` is what the file held (kept in the store), `written` what it holds now. */
  | { ok: true; previous: Hash | null; written: Hash | null }
  | { ok: false; reason: 'stale' | 'refused'; message: string }

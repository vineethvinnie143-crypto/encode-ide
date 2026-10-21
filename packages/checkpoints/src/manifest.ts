import path from 'node:path'
import type { Entry, Hash, RewindEntry, RewindFile, TurnCheckpoint } from './types'

/**
 * A session's manifest: an append-only JSON-lines file, one event per line.
 * It is read back whole, so a line that does not parse (a torn final line
 * after a crash, a hand edit) is skipped and counted, never fatal; and every
 * field is validated, because the file lives where other programs can write.
 */

/** A manifest larger than this is refused rather than read into memory; real sessions stay orders of magnitude below. */
export const MAX_MANIFEST_BYTES = 256 * 1024 * 1024
const MAX_TEXT = 4096
const MAX_REWIND_FILES = 100_000
const HASH = /^[0-9a-f]{64}$/

/** The identity of a path: normalised, without a trailing separator, and on Windows compared without case. */
export function pathKeyOf(windows: boolean): (file: string) => string {
  const api = windows ? path.win32 : path.posix
  return (file) => {
    const normalized = api.normalize(file)
    const rootLength = api.parse(normalized).root.length
    let end = normalized.length
    while (end > rootLength && normalized[end - 1] === api.sep) end--
    const key = normalized.slice(0, end)
    return windows ? key.toLowerCase() : key
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT && !value.includes('\u0000') ? value : null
}

/** A hash, null for "no file", or undefined when the value is neither. */
function hashField(value: unknown): Hash | null | undefined {
  if (value === null) return null
  return typeof value === 'string' && HASH.test(value) ? value : undefined
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function parseRewindFile(raw: unknown): RewindFile | null {
  if (!isObject(raw)) return null
  const file = text(raw.path)
  const before = hashField(raw.before)
  const after = hashField(raw.after)
  if (!file || before === undefined || after === undefined || typeof raw.stored !== 'boolean') return null
  const madeDir = raw.madeDir === undefined ? undefined : text(raw.madeDir)
  if (madeDir === null) return null
  return { path: file, before, after, stored: raw.stored && before !== null, ...(madeDir ? { madeDir } : {}) }
}

export function parseEntry(raw: unknown): Entry | null {
  if (!isObject(raw)) return null
  const at = raw.at
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  switch (raw.t) {
    case 'turn': {
      const turn = text(raw.turn)
      return turn ? { t: 'turn', turn, at } : null
    }
    case 'snap': {
      const turn = text(raw.turn)
      const tool = text(raw.tool)
      const file = text(raw.path)
      const hash = hashField(raw.hash)
      const size = count(raw.size)
      if (!turn || !tool || !file || hash === undefined || size === null || typeof raw.stored !== 'boolean') return null
      const madeDir = raw.madeDir === undefined ? undefined : text(raw.madeDir)
      if (madeDir === null) return null
      return {
        t: 'snap',
        turn,
        tool,
        path: file,
        hash,
        size,
        stored: raw.stored && hash !== null,
        ...(raw.outside === true ? { outside: true as const } : {}),
        ...(madeDir ? { madeDir } : {}),
        at,
      }
    }
    case 'wrote': {
      const tool = text(raw.tool)
      const file = text(raw.path)
      const hash = hashField(raw.hash)
      return tool && file && hash !== undefined ? { t: 'wrote', tool, path: file, hash, at } : null
    }
    case 'rewind': {
      const id = text(raw.id)
      const turn = text(raw.turn)
      if (!id || !turn || !Array.isArray(raw.files) || raw.files.length > MAX_REWIND_FILES) return null
      const files: RewindFile[] = []
      for (const item of raw.files) {
        const parsed = parseRewindFile(item)
        if (!parsed) return null
        files.push(parsed)
      }
      return { t: 'rewind', id, turn, files, at }
    }
    case 'rewound':
    case 'redone': {
      const id = text(raw.id)
      return id ? { t: raw.t, id, at } : null
    }
    default:
      return null
  }
}

export function parseManifest(source: string): { entries: Entry[]; bad: number } {
  const entries: Entry[] = []
  let bad = 0
  for (const line of source.split('\n')) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      bad++
      continue
    }
    const entry = parseEntry(value)
    if (entry) entries.push(entry)
    else bad++
  }
  return { entries, bad }
}

export function serializeEntry(entry: Entry): string {
  return `${JSON.stringify(entry)}\n`
}

/**
 * What the agent last left in a file, as far as the history knows. A snapshot
 * says what the file held before a write ("unconfirmed": the write may not
 * have happened or finished), and a `wrote` line says what it held after.
 * A rewind never overwrites a file whose content is neither.
 */
export interface Expectation {
  hash: Hash | null
  confirmed: boolean
}

/** The session's history in memory, with the indexes the service asks for. */
export class Manifest {
  readonly entries: Entry[] = []
  private readonly markers = new Map<string, number>()
  private readonly touchedKeys = new Set<string>()
  private readonly expectations = new Map<string, Expectation>()
  private latestTurn: string | undefined

  constructor(private readonly keyOf: (file: string) => string) {}

  add(entry: Entry): void {
    const index = this.entries.push(entry) - 1
    if (entry.t === 'turn') {
      this.markers.set(entry.turn, index)
      this.latestTurn = entry.turn
    } else if (entry.t === 'snap') {
      const key = this.keyOf(entry.path)
      this.touchedKeys.add(`${entry.turn}\u0000${key}`)
      if (!entry.outside) this.expectations.set(key, { hash: entry.hash, confirmed: false })
    } else if (entry.t === 'wrote') {
      this.expectations.set(this.keyOf(entry.path), { hash: entry.hash, confirmed: true })
    }
  }

  /** The id of the turn most recently begun. */
  lastTurn(): string | undefined {
    return this.latestTurn
  }

  hasTurn(turn: string): boolean {
    return this.markers.has(turn)
  }

  /** Where the (latest) marker of a turn sits; everything after it happened in or after that turn. */
  markerIndex(turn: string): number | undefined {
    return this.markers.get(turn)
  }

  /** True when the turn already saved this file's earlier version. */
  touched(turn: string, file: string): boolean {
    return this.touchedKeys.has(`${turn}\u0000${this.keyOf(file)}`)
  }

  expectation(file: string): Expectation | undefined {
    return this.expectations.get(this.keyOf(file))
  }

  /** True when the history tracks this file (it is inside the workspace and the agent changed it). */
  tracked(file: string): boolean {
    return this.expectations.has(this.keyOf(file))
  }

  /**
   * The latest rewind, while undoing it still makes sense: no prompt and no
   * write has come since, and it has not been undone. Once the conversation
   * moves on, restoring the files from before the rewind would put them out
   * of step with it.
   */
  redoCandidate(): RewindEntry | undefined {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index]
      if (entry.t === 'rewind') return entry
      if (entry.t === 'turn' || entry.t === 'snap' || entry.t === 'redone') return undefined
    }
    return undefined
  }

  /** Each turn once (its latest run), in order, with the files its tools changed. */
  turns(): TurnCheckpoint[] {
    const byTurn = new Map<string, TurnCheckpoint>()
    for (const entry of this.entries) {
      if (entry.t === 'turn') {
        // A turn run again (its id reused after a rewind) starts over, and moves to the end.
        byTurn.delete(entry.turn)
        byTurn.set(entry.turn, { turn: entry.turn, at: entry.at, files: [], outside: [] })
      } else if (entry.t === 'snap') {
        const checkpoint = byTurn.get(entry.turn)
        if (!checkpoint) continue
        if (entry.outside) checkpoint.outside.push(entry.path)
        else checkpoint.files.push(entry.path)
      }
    }
    return [...byTurn.values()]
  }
}

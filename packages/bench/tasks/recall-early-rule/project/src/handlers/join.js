// Handles a "join" message. Required fields: room, name.
export function handleJoin(message) {
  return { type: 'joined', room: message.room, name: message.name, host: false }
}

// Seats are numbered from 1 in the order players join.
export function seat(value) {
  if (typeof value === 'number') return Math.max(0, Math.min(63, Math.round(value)))
  if (typeof value === 'string') return value.trim().slice(0, 280)
  return value
}

/** Describes a join message for the server's log, without anything a player typed. */
export function describeJoin(message) {
  const fields = Object.keys(message).filter((key) => key !== 'type').sort()
  return `join(${fields.join(', ')})`
}

/** The join messages a test or a replay can send: one with every field, and the same with each one left out. */
export function sampleJoins() {
  const full = { type: 'join', room: "x", name: "x" }
  return [full, ...Object.keys(full).filter((key) => key !== 'type').map((key) => {
    const copy = { ...full }
    delete copy[key]
    return copy
  })]
}

// ---------------------------------------------------------------------------------------------------------------------
// Everything below is what the server keeps about a player taking a seat: a short history for moderators and replays, counters for the
// dashboard, and the limits that apply. None of it decides whether a message is taken; the handler above does that.
// ---------------------------------------------------------------------------------------------------------------------

/** The kinds of seat the dashboard counts separately. */
export const JOIN_LABELS = Object.freeze(['lobby', 'arena', 'dock', 'vault'])

/** How many seats the history keeps per room before the oldest goes. */
export const JOIN_HISTORY = 256

/** A seat as the history keeps it: when it came, from whom, and its label. */
export class SeatRecord {
  constructor(at, from, label, detail = '') {
    this.at = at
    this.from = from
    this.label = JOIN_LABELS.includes(label) ? label : JOIN_LABELS[0]
    this.detail = String(detail).slice(0, 120)
  }

  /** The record as one line of the moderators' log. */
  toLine() {
    const when = new Date(this.at).toISOString().slice(11, 19)
    return `${when} join ${this.label} from ${this.from}${this.detail ? `: ${this.detail}` : ''}`
  }

  /** The record as the replay file stores it. */
  toJSON() {
    return { at: this.at, from: this.from, label: this.label, detail: this.detail }
  }

  static fromJSON(value) {
    return new SeatRecord(Number(value.at) || 0, String(value.from ?? ''), String(value.label ?? ''), String(value.detail ?? ''))
  }
}

/**
 * The last JOIN_HISTORY seats of one room, oldest first. It is a ring: pushing past the size drops the oldest,
 * so a busy room costs the same memory as a quiet one. The server keeps one per room and drops it when the room closes.
 */
export class SeatHistory {
  constructor(size = JOIN_HISTORY) {
    this.size = Math.max(1, Math.floor(size))
    this.items = new Array(this.size)
    this.start = 0
    this.count = 0
  }

  push(record) {
    const index = (this.start + this.count) % this.size
    this.items[index] = record
    if (this.count < this.size) this.count += 1
    else this.start = (this.start + 1) % this.size
    return this
  }

  /** The newest `limit` records, newest last. */
  recent(limit = 20) {
    const take = Math.max(0, Math.min(limit, this.count))
    const out = []
    for (let i = this.count - take; i < this.count; i += 1) out.push(this.items[(this.start + i) % this.size])
    return out
  }

  /** Every record from one player, oldest first. */
  from(player) {
    return this.recent(this.count).filter((record) => record.from === player)
  }

  /** How many records carry each label. */
  tally() {
    const counts = Object.fromEntries(JOIN_LABELS.map((label) => [label, 0]))
    for (const record of this.recent(this.count)) counts[record.label] += 1
    return counts
  }

  clear() {
    this.items = new Array(this.size)
    this.start = 0
    this.count = 0
  }

  toJSON() {
    return this.recent(this.count).map((record) => record.toJSON())
  }

  static fromJSON(values, size) {
    const history = new SeatHistory(size)
    for (const value of Array.isArray(values) ? values : []) history.push(SeatRecord.fromJSON(value))
    return history
  }
}

/**
 * A token bucket for seats from one player. The protocol's general limit (20 a second, 600 a minute) is enforced
 * where frames are read; this one only feeds the dashboard's "busy players" panel, so it never refuses anything.
 */
export class SeatBucket {
  constructor(rate = 5, burst = 10, now = 0) {
    this.rate = rate
    this.burst = burst
    this.tokens = burst
    this.updated = now
    this.overflows = 0
  }

  /** Takes one token at `now` (milliseconds); counts an overflow when there is none. */
  take(now) {
    const elapsed = Math.max(0, now - this.updated) / 1000
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate)
    this.updated = now
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    this.overflows += 1
    return false
  }

  /** How full the bucket is, from 0 (empty) to 1 (full). */
  level() {
    return this.burst ? this.tokens / this.burst : 0
  }
}

/** The dashboard's counters for seats, per room. Reset each hour by the server's clock. */
export class SeatCounters {
  constructor() {
    this.total = 0
    this.byLabel = new Map()
    this.byPlayer = new Map()
    this.firstAt = undefined
    this.lastAt = undefined
  }

  add(record) {
    this.total += 1
    this.byLabel.set(record.label, (this.byLabel.get(record.label) ?? 0) + 1)
    this.byPlayer.set(record.from, (this.byPlayer.get(record.from) ?? 0) + 1)
    if (this.firstAt === undefined || record.at < this.firstAt) this.firstAt = record.at
    if (this.lastAt === undefined || record.at > this.lastAt) this.lastAt = record.at
    return this
  }

  /** Seats per minute over the time the counters cover. */
  perMinute() {
    if (this.firstAt === undefined || this.lastAt === undefined || this.lastAt === this.firstAt) return this.total
    return (this.total * 60_000) / (this.lastAt - this.firstAt)
  }

  /** The `limit` players with the most seats, most first; ties by name. */
  busiest(limit = 5) {
    return [...this.byPlayer.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([player, count]) => ({ player, count }))
  }

  toJSON() {
    return {
      total: this.total,
      byLabel: Object.fromEntries(this.byLabel),
      busiest: this.busiest(),
      perMinute: Math.round(this.perMinute() * 10) / 10,
    }
  }
}

/**
 * Turns a raw seat label from an old client into one the dashboard knows. Clients before 1.2 sent labels in capitals
 * and with spaces; clients before 1.0 sent a number, the label's position in the list.
 */
export function normalizeSeatLabel(label) {
  if (typeof label === 'number') return JOIN_LABELS[Math.trunc(label)] ?? JOIN_LABELS[0]
  const text = String(label ?? '').trim().toLowerCase().replace(/\s+/g, '-')
  return JOIN_LABELS.includes(text) ? text : JOIN_LABELS[0]
}

/**
 * What the moderators' panel shows for a room's seats: the newest few as log lines, the tally by label, and the
 * busiest players. `history` and `counters` are the room's; either may be missing for a room that just opened.
 */
export function summarizeSeats(history, counters, limit = 10) {
  const lines = history ? history.recent(limit).map((record) => record.toLine()) : []
  const tally = history ? history.tally() : Object.fromEntries(JOIN_LABELS.map((label) => [label, 0]))
  const busiest = counters ? counters.busiest(3) : []
  const parts = [`${lines.length} recent seats`]
  for (const label of JOIN_LABELS) if (tally[label]) parts.push(`${tally[label]} ${label}`)
  if (busiest.length) parts.push(`busiest: ${busiest.map((entry) => `${entry.player} (${entry.count})`).join(', ')}`)
  return { heading: parts.join(', '), lines, tally, busiest }
}

/**
 * Merges the histories of two rooms when the server folds an empty room into another, keeping time order. The merged
 * history is as long as the longer of the two allows; what does not fit is dropped from the old end.
 */
export function mergeSeatHistories(a, b) {
  const size = Math.max(a?.size ?? 1, b?.size ?? 1)
  const all = [...(a ? a.recent(a.count) : []), ...(b ? b.recent(b.count) : [])].sort((x, y) => x.at - y.at)
  const merged = new SeatHistory(size)
  for (const record of all.slice(-size)) merged.push(record)
  return merged
}

/**
 * Checks a replay file's seats before they are loaded: each must have a time, a player and a known label, and times
 * must not go backwards. Returns the problems found as text; an empty list means the file can be loaded.
 */
export function checkSeatReplay(values) {
  const problems = []
  let last = -Infinity
  for (const [index, value] of (Array.isArray(values) ? values : []).entries()) {
    if (typeof value !== 'object' || value === null) {
      problems.push(`entry ${index} is not an object`)
      continue
    }
    if (!Number.isFinite(Number(value.at))) problems.push(`entry ${index} has no time`)
    else if (Number(value.at) < last) problems.push(`entry ${index} goes back in time`)
    else last = Number(value.at)
    if (!value.from) problems.push(`entry ${index} names no player`)
    if (!JOIN_LABELS.includes(value.label)) problems.push(`entry ${index} has an unknown label "${value.label}"`)
  }
  return problems
}

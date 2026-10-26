/**
 * Source maps (version 3), read by eNCode's own code: where a place in the code that runs came from in the code the
 * person wrote, and the other way round, so that a breakpoint set in a TypeScript file lands in the JavaScript Node
 * runs, and a pause there shows the TypeScript line.
 *
 * A map comes from the program being debugged, so it is read as untrusted: one larger than the limits is refused, a
 * segment that does not decode ends the reading, and a segment that names a source or a line that is not there is
 * dropped. Places are zero-based lines and columns, as V8 counts them.
 */

const VLQ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const VLQ_VALUE = new Int8Array(128).fill(-1)
for (let index = 0; index < VLQ_CHARS.length; index++) VLQ_VALUE[VLQ_CHARS.charCodeAt(index)] = index

/** The longest `mappings` read: a map for some 50 MB of code. */
export const MAX_MAPPINGS_CHARS = 64 * 1024 * 1024
/** The most sources and sections one map may name. */
export const MAX_SOURCES = 50_000
const MAX_SECTIONS = 10_000
/** The largest line or column a map may name; anything past it is not a place in a file. */
const MAX_PLACE = 0x7fffffff

export interface MapPosition {
  /** Zero-based. */
  line: number
  /** Zero-based, in UTF-16 code units. */
  column: number
}

export interface OriginalPosition extends MapPosition {
  /** Into `SourceMap.sources`. */
  source: number
}

/** A place in the generated code an original line maps to. */
export interface GeneratedPlace extends MapPosition {
  /** The original column it maps from. */
  originalColumn: number
}

/** A map that could not be read, and why, in words. */
export class SourceMapError extends Error {
  override name = 'SourceMapError'
}

/** One generated line's segments: [column, source, original line, original column] repeated; a source of -1 maps nowhere. */
type LineSegments = Int32Array

const EMPTY = new Int32Array(0)

/** Decodes the `mappings` of one map into its lines' segments. */
function decodeMappings(mappings: string, sourceCount: number, into: LineSegments[]): void {
  let line = 0
  let column = 0
  let source = 0
  let originalLine = 0
  let originalColumn = 0
  let current: number[] = []
  const fields: number[] = [0, 0, 0, 0, 0]
  const flush = () => {
    if (current.length && line <= MAX_PLACE) into[line] = sortedLine(current, undefined)
    current = []
  }
  let index = 0
  const length = mappings.length
  while (index < length) {
    const code = mappings.charCodeAt(index)
    if (code === 59 /* ; */) {
      flush()
      line++
      column = 0
      index++
      continue
    }
    if (code === 44 /* , */) {
      index++
      continue
    }
    let count = 0
    while (index < length) {
      const next = mappings.charCodeAt(index)
      if (next === 44 || next === 59) break
      if (count === 5) throw new SourceMapError('A segment of the map has more than five fields.')
      let value = 0
      let shift = 0
      let more = true
      while (more) {
        if (index >= length) throw new SourceMapError('The map ends inside a number.')
        const digit = mappings.charCodeAt(index++)
        const bits = digit < 128 ? VLQ_VALUE[digit] : -1
        if (bits < 0) throw new SourceMapError(`The map has a character it cannot read (${JSON.stringify(String.fromCharCode(digit))}).`)
        if (shift > 30) throw new SourceMapError('A number in the map is too large.')
        value += (bits & 31) * 2 ** shift
        shift += 5
        more = (bits & 32) !== 0
      }
      fields[count++] = value % 2 === 1 ? -Math.floor(value / 2) : Math.floor(value / 2)
    }
    if (count === 0) continue
    if (count !== 1 && count !== 4 && count !== 5) throw new SourceMapError(`A segment of the map has ${count} fields.`)
    column += fields[0]
    if (count === 1) {
      if (column >= 0) current.push(column, -1, 0, 0)
      continue
    }
    source += fields[1]
    originalLine += fields[2]
    originalColumn += fields[3]
    // A segment that names what is not there is dropped; the ones after it still read.
    if (column < 0 || source < 0 || source >= sourceCount || originalLine < 0 || originalColumn < 0 || originalLine > MAX_PLACE || originalColumn > MAX_PLACE) continue
    current.push(column, source, originalLine, originalColumn)
  }
  flush()
}

/** The segments of a line, by column; those already there (from an earlier section) kept. */
function sortedLine(segments: number[], before: LineSegments | undefined): LineSegments {
  const all = before ? [...before, ...segments] : segments
  let sorted = true
  for (let index = 4; index < all.length; index += 4) {
    if (all[index] < all[index - 4]) {
      sorted = false
      break
    }
  }
  if (sorted) return Int32Array.from(all)
  const order: number[] = []
  for (let index = 0; index < all.length; index += 4) order.push(index)
  order.sort((a, b) => all[a] - all[b] || a - b)
  const out = new Int32Array(all.length)
  order.forEach((from, at) => out.set(all.slice(from, from + 4), at * 4))
  return out
}

/** A file path of either system, as a `file:` URL; null when it is not absolute. */
function pathAsUrl(source: string): string | null {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(source)
  if (drive) return `file:///${drive[1].toUpperCase()}:/${drive[2].split(/[\\/]+/).map(encodeURIComponent).join('/')}`
  const share = /^\\\\([^\\]+)\\(.*)$/.exec(source)
  if (share) return `file://${share[1]}/${share[2].split(/[\\/]+/).map(encodeURIComponent).join('/')}`
  return null
}

/** Where a source of the map is, as a URL: resolved against the source root and the map's own address. */
export function resolveSource(source: string, sourceRoot: string | undefined, base: string): string {
  const absolute = pathAsUrl(source)
  if (absolute) return absolute
  const root = sourceRoot ? (pathAsUrl(sourceRoot) ?? sourceRoot) : ''
  const joined = root ? `${root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`}${source}` : source
  const rooted = pathAsUrl(joined)
  if (rooted) return rooted
  try {
    return new URL(joined.replace(/\\/g, '/'), base).href
  } catch {
    return joined
  }
}

interface RawMap {
  version?: unknown
  sources?: unknown
  sourceRoot?: unknown
  sourcesContent?: unknown
  mappings?: unknown
  sections?: unknown
}

export class SourceMap {
  /** Where each source is, as a URL (`file:///…` for a file on disk). */
  readonly sources: string[] = []
  /** The text of each source the map carries, when it carries it. */
  readonly contents: (string | null)[] = []
  private readonly lines: LineSegments[] = []
  /** By source, by original line: the generated places it maps to; built when first asked. */
  private byOriginal: Map<number, number[]>[] | null = null
  private readonly sourceIndex = new Map<string, number>()

  private constructor() {}

  /**
   * Reads a map given as text or as parsed JSON. `base` is the map's own URL (for a map in a file) or the script's (for
   * one inlined as a `data:` URL), which its sources are resolved against.
   */
  static parse(input: string | unknown, base: string): SourceMap {
    let raw: unknown = input
    if (typeof input === 'string') {
      if (input.length > MAX_MAPPINGS_CHARS * 2) throw new SourceMapError('The map is too large to read.')
      // A map may start with a line that keeps it from running as a script.
      const text = input.startsWith(")]}'") ? input.slice(input.indexOf('\n') + 1) : input
      try {
        raw = JSON.parse(text)
      } catch {
        throw new SourceMapError('The map is not JSON.')
      }
    }
    if (!raw || typeof raw !== 'object') throw new SourceMapError('The map is not an object.')
    const map = new SourceMap()
    const top = raw as RawMap
    if (top.version !== 3) throw new SourceMapError('Only version 3 maps are read.')
    if (Array.isArray(top.sections)) {
      if (top.sections.length > MAX_SECTIONS) throw new SourceMapError('The map has too many sections.')
      for (const section of top.sections as unknown[]) {
        const offset = (section as { offset?: { line?: unknown; column?: unknown } } | null)?.offset
        const inner = (section as { map?: unknown } | null)?.map
        const line = offset?.line
        const column = offset?.column
        if (typeof line !== 'number' || typeof column !== 'number' || !Number.isInteger(line) || !Number.isInteger(column) || line < 0 || column < 0) {
          throw new SourceMapError('A section of the map has no place.')
        }
        if (!inner || typeof inner !== 'object' || (inner as RawMap).version !== 3 || (inner as RawMap).sections !== undefined) {
          throw new SourceMapError('A section of the map is not a map of its own.')
        }
        map.add(inner as RawMap, base, line, column)
      }
    } else map.add(top, base, 0, 0)
    return map
  }

  private add(raw: RawMap, base: string, lineOffset: number, columnOffset: number): void {
    if (!Array.isArray(raw.sources)) throw new SourceMapError('The map names no sources.')
    if (typeof raw.mappings !== 'string') throw new SourceMapError('The map has no mappings.')
    if (raw.mappings.length > MAX_MAPPINGS_CHARS) throw new SourceMapError('The map is too large to read.')
    if (this.sources.length + raw.sources.length > MAX_SOURCES) throw new SourceMapError('The map names too many sources.')
    const root = typeof raw.sourceRoot === 'string' ? raw.sourceRoot : undefined
    const contents = Array.isArray(raw.sourcesContent) ? raw.sourcesContent : []
    // The same source in two sections is one source.
    const local: number[] = []
    raw.sources.forEach((source, index) => {
      const url = resolveSource(typeof source === 'string' ? source : '', root, base)
      let at = this.sourceIndex.get(url)
      if (at === undefined) {
        at = this.sources.length
        this.sources.push(url)
        this.contents.push(typeof contents[index] === 'string' ? (contents[index] as string) : null)
        this.sourceIndex.set(url, at)
      }
      local.push(at)
    })
    const lines: LineSegments[] = []
    decodeMappings(raw.mappings, raw.sources.length, lines)
    // Into this map's numbering: its sources by `local`, its lines from the section's place.
    for (let line = 0; line < lines.length; line++) {
      const segments = lines[line]
      if (!segments) continue
      const moved: number[] = []
      for (let index = 0; index < segments.length; index += 4) {
        const source = segments[index + 1]
        moved.push(segments[index] + (line === 0 ? columnOffset : 0), source < 0 ? -1 : local[source], segments[index + 2], segments[index + 3])
      }
      const target = line + lineOffset
      if (target <= MAX_PLACE) this.lines[target] = sortedLine(moved, this.lines[target])
    }
    this.byOriginal = null
  }

  /** The source a URL names, or -1. */
  indexOf(url: string): number {
    return this.sourceIndex.get(url) ?? -1
  }

  /** Where a generated place came from: the last segment at or before it on its line; null when it maps nowhere. */
  originalFor(line: number, column: number): OriginalPosition | null {
    const segments = this.lines[line] ?? EMPTY
    let low = 0
    let high = segments.length / 4 - 1
    let found = -1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (segments[middle * 4] <= column) {
        found = middle
        low = middle + 1
      } else high = middle - 1
    }
    if (found < 0) return null
    const source = segments[found * 4 + 1]
    if (source < 0) return null
    return { source, line: segments[found * 4 + 2], column: segments[found * 4 + 3] }
  }

  private index(): Map<number, number[]>[] {
    if (this.byOriginal) return this.byOriginal
    const index: Map<number, number[]>[] = this.sources.map(() => new Map())
    this.lines.forEach((segments, line) => {
      if (!segments) return
      for (let at = 0; at < segments.length; at += 4) {
        const source = segments[at + 1]
        if (source < 0) continue
        const original = segments[at + 2]
        const places = index[source].get(original)
        const place = [line, segments[at], segments[at + 3]]
        if (places) places.push(...place)
        else index[source].set(original, place)
      }
    })
    this.byOriginal = index
    return index
  }

  /**
   * The generated places an original line maps to: on each generated line, the first that maps from it, in order.
   * Empty when nothing maps from that line.
   */
  generatedFor(source: number, line: number): GeneratedPlace[] {
    const flat = this.index()[source]?.get(line)
    if (!flat) return []
    const first = new Map<number, GeneratedPlace>()
    for (let at = 0; at < flat.length; at += 3) {
      const known = first.get(flat[at])
      if (!known || flat[at + 1] < known.column) first.set(flat[at], { line: flat[at], column: flat[at + 1], originalColumn: flat[at + 2] })
    }
    return [...first.values()].sort((a, b) => a.line - b.line || a.column - b.column)
  }

  /** The first original line at or after `line`, within `within` lines, that something maps from; null when none is. */
  nextMappedLine(source: number, line: number, within = 50): number | null {
    const lines = this.index()[source]
    if (!lines) return null
    for (let next = line; next <= line + within; next++) if (lines.has(next)) return next
    return null
  }
}

/** The text of a `data:` URL that holds a map (`data:application/json;base64,…`), or null when it is not one. */
export function dataUrlText(url: string): string | null {
  const match = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url)
  if (!match) return null
  if (match[3].length > MAX_MAPPINGS_CHARS * 2) return null
  try {
    return match[2] ? Buffer.from(match[3], 'base64').toString('utf8') : decodeURIComponent(match[3])
  } catch {
    return null
  }
}

/** For tests and fixtures: the VLQ spelling of a number. */
export function encodeVlq(value: number): string {
  let rest = value < 0 ? -value * 2 + 1 : value * 2
  let out = ''
  do {
    let digit = rest % 32
    rest = Math.floor(rest / 32)
    if (rest > 0) digit |= 32
    out += VLQ_CHARS[digit]
  } while (rest > 0)
  return out
}

/**
 * For tests and fixtures: the `mappings` of segments given as [generated line, generated column, source, original
 * line, original column], all zero-based, in generated order.
 */
export function encodeMappings(segments: readonly (readonly [number, number, number, number, number])[]): string {
  let out = ''
  let line = 0
  let column = 0
  let source = 0
  let originalLine = 0
  let originalColumn = 0
  let first = true
  for (const [genLine, genColumn, src, oLine, oColumn] of segments) {
    while (line < genLine) {
      out += ';'
      line++
      column = 0
      first = true
    }
    if (!first) out += ','
    out += encodeVlq(genColumn - column) + encodeVlq(src - source) + encodeVlq(oLine - originalLine) + encodeVlq(oColumn - originalColumn)
    column = genColumn
    source = src
    originalLine = oLine
    originalColumn = oColumn
    first = false
  }
  return out
}

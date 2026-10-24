/**
 * The code map (ADR 0090): the definitions of a project that matter most, by file and line, in a budget of
 * characters. What matters is read from the project itself: a definition that many files use, from files that are
 * used much themselves, comes first (a ranking over the graph of which file uses a name another file defines, as
 * Aider's repository map does). The files and words the work is about pull their part of the project forward.
 *
 * Pure: the index (index.ts) gives the files, and this gives the text the model reads.
 */
import type { Definition } from './extract'

export interface IndexedFile {
  /** Relative to the folder, with forward slashes. */
  path: string
  language: string
  definitions: readonly Definition[]
  /** Names the file uses, with how often. */
  names: ReadonlyMap<string, number>
}

export interface MapRequest {
  /** Files or folders the work is about (relative paths): they, and what they use, come first. */
  focus?: readonly string[]
  /** Words and names the work is about. */
  terms?: readonly string[]
  /** Only files in this folder (a relative path; '' for all). */
  within?: string
  maxChars: number
}

export interface CodeMap {
  text: string
  /** Files with definitions, and how many of them the text shows. */
  files: number
  shownFiles: number
  shownDefinitions: number
}

/** A name defined in more files than this is too common to say which one a use means. */
const MAX_DEFINERS = 8
const DAMPING = 0.85
const ROUNDS = 30
/** The most uses the ranking follows: a bound on its time and memory for a project of generated code. */
const MAX_EDGES = 1_000_000
/** The most definitions a map is built from, before the budget cuts it. */
const MAX_CANDIDATES = 4_000
/** Kinds a request names by their word ("the park event"). */
const NAMED_KINDS = new Set<Definition['kind']>(['event', 'command', 'callback', 'export'])
/** What each further definition of one file counts for, against the one before it. */
const SAME_FILE = 0.8

const KIND_WEIGHT: Partial<Record<Definition['kind'], number>> = {
  method: 0.7,
  constant: 0.5,
  macro: 0.4,
  table: 0.8,
  impl: 0,
}

/** Words of a request that say nothing about where in the code it is. */
const COMMON = new Set(
  (
    'the and that this with from have what when where which there their about would could should please make need want into also then them they your does like just some more only each other ' +
    'file files code function functions class method methods error errors test tests change changes fix add update use using work works working new all any can not but for get set run see show ' +
    'how why who its it\'s was were will been being here than very much many well good bad same help create remove delete move rename check build write read look find give take keep let put ' +
    'return returns project app thing things something everything nothing line lines page way time now still really sure okay right wrong issue problem bug bugs feature version'
  ).split(' '),
)

/** Words and names in a person's request that may name code: identifiers, paths and longer words. */
export function termsOf(text: string): string[] {
  const terms = new Set<string>()
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*(?:[./:-][\w$]+)*/g)) {
    const word = match[0].replace(/[.:-]+$/, '')
    if (word.length < 4 && !/[A-Z_]/.test(word.slice(1))) continue
    if (COMMON.has(word.toLowerCase())) continue
    terms.add(word)
    if (terms.size >= 40) break
  }
  return [...terms]
}

const lower = (text: string) => text.toLowerCase()

/** Tests, fixtures and fakes, by their path. */
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec|testing|fixtures?|__mocks__)\/|[._-](?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py|rb|lua)$/i

/**
 * How much the words of the work favour each name: a word that names few definitions (`failover`) says more than one
 * that names hundreds (`model`), and the name itself (`router` for `Router`) more than a part of it. 1 for a name no
 * word matches.
 */
function termWeights(files: readonly IndexedFile[], terms: readonly string[]): (name: string) => number {
  if (!terms.length) return () => 1
  const matches = new Map<string, number>()
  const hits = (name: string) => {
    const key = lower(name)
    return terms.filter((term) => key === term || (term.length >= 4 && key.includes(term)))
  }
  for (const file of files) for (const definition of file.definitions) for (const term of hits(definition.name)) matches.set(term, (matches.get(term) ?? 0) + 1)
  const weight = (term: string) => 1 + 9 * Math.min(1, 4 / (matches.get(term) ?? 1))
  const known = new Map<string, number>()
  return (name) => {
    let value = known.get(name)
    if (value === undefined) {
      const found = hits(name)
      value = 1
      for (const term of found) value = Math.max(value, weight(term) * (lower(name) === term ? 2 : 1))
      if (found.length > 1) value *= 1.5 ** (found.length - 1)
      known.set(name, Math.min(value, 40))
    }
    return value
  }
}

const inFolder = (file: string, folder: string) => !folder || file === folder || file.startsWith(`${folder}/`)

/** The map of `files` the request asks for. */
export function renderMap(files: readonly IndexedFile[], request: MapRequest): CodeMap {
  const within = (request.within ?? '').replace(/\/+$/, '')
  const terms = (request.terms ?? []).map(lower).filter((term) => term.length >= 3)
  const focus = (request.focus ?? []).map((entry) => entry.replace(/\/+$/, ''))
  const scores = scoreDefinitions(files, terms, focus)

  const candidates: { file: number; definition: Definition; score: number }[] = []
  files.forEach((file, index) => {
    if (!inFolder(file.path, within)) return
    for (const definition of file.definitions) if (!definition.heading) candidates.push({ file: index, definition, score: scores.get(definition) ?? 0 })
  })
  const withDefinitions = new Set(candidates.map((candidate) => candidate.file)).size
  // Each further definition of a file counts for a little less, so that one file of many types does not fill the map.
  candidates.sort((a, b) => b.score - a.score)
  const taken = new Map<number, number>()
  for (const candidate of candidates) {
    const before = taken.get(candidate.file) ?? 0
    taken.set(candidate.file, before + 1)
    candidate.score *= SAME_FILE ** before
  }
  candidates.sort((a, b) => b.score - a.score || (files[a.file].path < files[b.file].path ? -1 : files[a.file].path > files[b.file].path ? 1 : a.definition.line - b.definition.line))
  if (candidates.length > MAX_CANDIDATES) candidates.length = MAX_CANDIDATES

  // The most definitions that fit the budget.
  let low = 0
  let high = candidates.length
  let best: Rendered = { text: '', files: 0, definitions: 0 }
  while (low <= high) {
    const middle = (low + high) >> 1
    const made = render(files, candidates.slice(0, middle))
    if (made.text.length <= request.maxChars) {
      best = made
      low = middle + 1
    } else high = middle - 1
  }
  return { text: best.text, files: withDefinitions, shownFiles: best.files, shownDefinitions: best.definitions }
}

interface Rendered {
  text: string
  files: number
  definitions: number
}

const CONTAINER_KINDS = new Set<Definition['kind']>(['class', 'interface', 'struct', 'trait', 'impl', 'enum', 'table', 'module'])

/** The chosen definitions by file, the most important file first, each file's in line order. */
function render(files: readonly IndexedFile[], chosen: readonly { file: number; definition: Definition; score: number }[]): Rendered {
  const byFile = new Map<number, { best: number; definitions: Set<Definition> }>()
  for (const { file, definition, score } of chosen) {
    let entry = byFile.get(file)
    if (!entry) byFile.set(file, (entry = { best: score, definitions: new Set() }))
    entry.definitions.add(definition)
  }
  const out: string[] = []
  const order = [...byFile].sort((a, b) => b[1].best - a[1].best || (files[a[0]].path < files[b[0]].path ? -1 : 1))
  for (const [index, { definitions }] of order) {
    const file = files[index]
    // A member shown brings its class's line as a heading.
    const headings = new Set<Definition>()
    for (const definition of definitions) {
      if (!definition.parent) continue
      const container = file.definitions.find((other) => other.name === definition.parent && CONTAINER_KINDS.has(other.kind) && other.line <= definition.line)
      if (container && !definitions.has(container)) headings.add(container)
    }
    out.push(file.path)
    const lines = [...definitions, ...headings].sort((a, b) => a.line - b.line)
    const shownContainers = new Set(lines.filter((definition) => CONTAINER_KINDS.has(definition.kind)).map((definition) => definition.name))
    for (const definition of lines) {
      const indent = definition.parent && shownContainers.has(definition.parent) ? '    ' : '  '
      out.push(`${indent}${definition.line} ${definition.text}`)
    }
  }
  return { text: out.join('\n'), files: byFile.size, definitions: chosen.length }
}

/** How much each definition matters: what the ranking of files gives it through the names that use it. */
function scoreDefinitions(files: readonly IndexedFile[], terms: readonly string[], focus: readonly string[]): Map<Definition, number> {
  const count = files.length
  const definers = new Map<string, number[]>()
  files.forEach((file, index) => {
    const seen = new Set<string>()
    for (const definition of file.definitions) {
      if (definition.heading || seen.has(definition.name)) continue
      seen.add(definition.name)
      const list = definers.get(definition.name)
      if (list) list.push(index)
      else definers.set(definition.name, [index])
    }
  })

  // Edges: a file uses a name that other files define.
  const from: number[] = []
  const to: number[] = []
  const weight: number[] = []
  const names: string[] = []
  const out = new Float64Array(count)
  const favour = termWeights(files, terms)
  const namedKind = (kind: Definition['kind']) => NAMED_KINDS.has(kind) && (terms.includes(kind) || terms.includes(`${kind}s`))
  // A word in many paths (`src`) says little about which files the work is in.
  const pathMatches = new Map(terms.map((term) => [term, files.filter((file) => lower(file.path).includes(term)).length]))
  const pathWeight = (file: IndexedFile) => {
    let value = 0
    for (const term of terms) if (lower(file.path).includes(term)) value = Math.max(value, Math.min(1, 10 / (pathMatches.get(term) ?? 1)))
    return value
  }
  // How many files use each name: one that nearly every file uses (`value`, `name`) says little about which it means.
  const users = new Map<string, number>()
  for (const file of files) for (const name of file.names.keys()) if (definers.has(name)) users.set(name, (users.get(name) ?? 0) + 1)
  files.forEach((file, source) => {
    if (from.length >= MAX_EDGES) return
    for (const [name, uses] of file.names) {
      const defined = definers.get(name)
      if (!defined || defined.length > MAX_DEFINERS) continue
      let w = (Math.sqrt(uses) * Math.log((count + 1) / ((users.get(name) ?? 1) + 0.5))) / defined.length
      if (w <= 0) continue
      // `renderMap`, `player_data`: a name of several words is meant; `get` and `data` may be anything.
      if (name.length >= 8 && /[a-z][A-Z]|[a-zA-Z][_:.-][a-zA-Z]/.test(name)) w *= 5
      else if (name.length < 5) w *= 0.3
      w *= favour(name)
      if (name.startsWith('_')) w *= 0.1
      for (const target of defined) {
        if (target === source) continue
        from.push(source)
        to.push(target)
        weight.push(w)
        names.push(name)
        out[source] += w
      }
    }
  })

  // Where the ranking starts from: every file alike, or the files and words the work is about.
  const start = new Float64Array(count)
  let total = 0
  if (focus.length || terms.length) {
    files.forEach((file, index) => {
      let value = 0
      if (focus.some((entry) => inFolder(file.path, entry))) value += 1
      if (terms.length) {
        value += 0.5 * pathWeight(file)
        let best = 1
        for (const definition of file.definitions) best = Math.max(best, favour(definition.name))
        value += (best - 1) / 9
        if (file.definitions.some((definition) => namedKind(definition.kind))) value += 1
      }
      start[index] = value
      total += value
    })
  }
  if (total === 0) {
    start.fill(1 / Math.max(1, count))
  } else for (let index = 0; index < count; index++) start[index] /= total

  let rank = Float64Array.from(start)
  for (let round = 0; round < ROUNDS; round++) {
    const next = new Float64Array(count)
    let dangling = 0
    for (let index = 0; index < count; index++) if (out[index] === 0) dangling += rank[index]
    for (let edge = 0; edge < from.length; edge++) next[to[edge]] += (DAMPING * rank[from[edge]] * weight[edge]) / out[from[edge]]
    for (let index = 0; index < count; index++) next[index] += (1 - DAMPING + DAMPING * dangling) * start[index]
    rank = next
  }

  // A definition gets the share of each use of its name, and a little of its own file's rank.
  const byName = new Map<string, number>()
  for (let edge = 0; edge < from.length; edge++) {
    const key = `${to[edge]}\u0000${names[edge]}`
    byName.set(key, (byName.get(key) ?? 0) + (rank[from[edge]] * weight[edge]) / out[from[edge]])
  }
  const scores = new Map<Definition, number>()
  files.forEach((file, index) => {
    const focused = focus.some((entry) => inFolder(file.path, entry))
    const test = TEST_FILE.test(file.path)
    const named = terms.length ? 1 + 2 * pathWeight(file) : 1
    for (const definition of file.definitions) {
      if (definition.heading) continue
      let score = (byName.get(`${index}\u0000${definition.name}`) ?? 0) + rank[index] * 0.05
      score *= KIND_WEIGHT[definition.kind] ?? 1
      if (definition.private) score *= 0.3
      score *= favour(definition.name) * named
      // "the shop callback", "which events": a kind only FiveM's registrations have is named.
      if (namedKind(definition.kind)) score *= 30
      if (focused) score *= 3
      // A test's helpers are seldom what the work needs, unless it is about tests.
      if (test && !focused) score *= 0.2
      scores.set(definition, score)
    }
  })
  return scores
}

// ---------------------------------------------------------------------------
// One name, one file

export interface Found {
  path: string
  definition: Definition
}

/** Where a name is defined: exactly as written, or else in any case. */
export function definitionsOf(files: readonly IndexedFile[], name: string): Found[] {
  const exact: Found[] = []
  const loose: Found[] = []
  const key = lower(name)
  for (const file of files) {
    for (const definition of file.definitions) {
      if (definition.heading) continue
      if (definition.name === name) exact.push({ path: file.path, definition })
      else if (lower(definition.name) === key) loose.push({ path: file.path, definition })
    }
  }
  return exact.length ? exact : loose
}

/** The files that use a name, by how often, most first. */
export function usersOf(files: readonly IndexedFile[], name: string): { path: string; uses: number }[] {
  const users: { path: string; uses: number }[] = []
  for (const file of files) {
    const uses = file.names.get(name)
    if (uses) users.push({ path: file.path, uses })
  }
  return users.sort((a, b) => b.uses - a.uses || (a.path < b.path ? -1 : 1))
}

/** Every definition of one file, in line order, members under their class, within a budget. */
export function outline(file: IndexedFile, maxChars: number): { text: string; shown: number } {
  const lines: string[] = []
  let length = 0
  let shown = 0
  const containers = new Set(file.definitions.filter((definition) => CONTAINER_KINDS.has(definition.kind)).map((definition) => definition.name))
  for (const definition of file.definitions) {
    const line = `${definition.parent && containers.has(definition.parent) ? '  ' : ''}${definition.line} ${definition.text}`
    if (length + line.length + 1 > maxChars) break
    lines.push(line)
    length += line.length + 1
    shown++
  }
  return { text: lines.join('\n'), shown }
}

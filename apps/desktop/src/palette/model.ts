/**
 * What the command palette (Ctrl+K) and the message box's pickers find, and in what order. Pure, so the ranking is
 * unit tested; the components build the items from the registry, the sessions, the settings pages and the files.
 */

export type PaletteGroup = 'Recent' | 'Sessions' | 'Actions' | 'Settings'

export interface PaletteItem {
  /** Unique across groups: "command:file.newSession", "session:<id>", "settings:models". */
  id: string
  group: Exclude<PaletteGroup, 'Recent'>
  title: string
  /** Quiet text after the title: a session's project, a command's menu. */
  detail?: string
  /** More words that find it, such as "theme" for Appearance. */
  keywords?: string
  shortcut?: string
}

export interface PaletteSection<T extends PaletteItem> {
  group: PaletteGroup
  items: T[]
}

/** How many items the palette shows before the person types: recent picks and sessions. */
export const RECENT_SHOWN = 5
export const SESSIONS_SHOWN = 6
/** Sessions that match a query; there can be hundreds. */
export const SESSIONS_FOUND = 10
/** Picks remembered for the Recent group. */
export const RECENT_KEPT = 8

const isBoundary = (char: string | undefined) => char === undefined || /[\s/\\_.:,()[\]{}<>"'`|@$#+=-]/.test(char)

/** A text made ready for matching: lower case, no accents, single spaces, and which characters start a word. */
export interface Prepared {
  lower: string
  starts: boolean[]
}

/** Prepares a text once, for a list matched again at every key (the files of a folder). */
export function prepare(text: string): Prepared {
  const plain = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  const lower = plain.toLowerCase()
  // A capital after a small letter starts a word too (camelCase), when lower-casing kept the positions.
  const cased = lower.length === plain.length
  const starts: boolean[] = []
  for (let index = 0; index < lower.length; index++) {
    starts.push(index === 0 || isBoundary(lower[index - 1]) || (cased && /\p{Ll}/u.test(plain[index - 1]) && /\p{Lu}/u.test(plain[index])))
  }
  return { lower, starts }
}

/** Lower case, without accents, with single spaces. */
export function normalize(text: string): string {
  return prepare(text).lower
}

/**
 * The query's letters in order, each at its best place: word starts and runs count most, letters skipped cost a
 * little. -1 when the letters are not all there in order. Below every whole-word match by construction.
 */
function subsequence(query: string, text: string, starts: readonly boolean[]): number {
  const m = query.length
  const n = text.length
  if (m > n) return -1
  const bonus = (index: number) => 1 + (starts[index] ? 8 : 0)
  // previous[j]: the best score of the query so far with its latest letter at text[j].
  let previous = new Array<number>(n).fill(-Infinity)
  for (let j = 0; j < n; j++) if (text[j] === query[0]) previous[j] = bonus(j) - j * 0.1
  for (let i = 1; i < m; i++) {
    const current = new Array<number>(n).fill(-Infinity)
    // The best earlier placement at least two letters back, plus 0.1 per position, so a jump costs 0.1 a letter.
    let reach = -Infinity
    for (let j = 1; j < n; j++) {
      if (j >= 2) reach = Math.max(reach, previous[j - 2] + 0.1 * (j - 2))
      if (text[j] !== query[i]) continue
      const run = previous[j - 1] + 5
      const jump = reach - 0.1 * (j - 1)
      const base = Math.max(run, jump)
      if (base > -Infinity) current[j] = base + bonus(j)
    }
    previous = current
  }
  const top = Math.max(...previous)
  return top === -Infinity ? -1 : Math.min(480, 100 + top)
}

/**
 * How well `query` finds `text`: higher is better, -1 when it does not. The whole text first, then the start of
 * the text, the start of a word, anywhere, then the query's letters in order (initials and the like). A query of
 * several words finds a text that has every word, in any order.
 */
export function matchScore(query: string, text: string): number {
  return matchPrepared(normalize(query), prepare(text))
}

/** matchScore for a query already normalized and a text already prepared. */
export function matchPrepared(q: string, text: Prepared): number {
  if (!q) return 0
  const { lower: t, starts } = text
  if (!t) return -1
  if (t === q) return 1000
  if (t.startsWith(q)) return 900 - Math.min(50, t.length - q.length)
  const index = t.indexOf(q)
  if (index > 0) return (starts[index] ? 760 : 520) - Math.min(40, index)
  if (q.includes(' ')) {
    const words = q.split(' ')
    let total = 0
    for (const word of words) {
      const score = matchPrepared(word, text)
      if (score < 0) return -1
      total += score
    }
    return Math.round((total / words.length) * 0.9)
  }
  return subsequence(q, t, starts)
}

/** The item's best score: its title counts most, then its keywords, then its detail. */
export function itemScore(item: PaletteItem, query: string): number {
  const title = matchScore(query, item.title)
  const keywords = item.keywords ? matchScore(query, item.keywords) : -1
  const detail = item.detail ? matchScore(query, item.detail) : -1
  return Math.max(title, keywords >= 0 ? keywords * 0.8 : -1, detail >= 0 ? detail * 0.6 : -1)
}

const GROUP_ORDER: readonly PaletteItem['group'][] = ['Sessions', 'Actions', 'Settings']

/**
 * The palette's sections for a query. Before anything is typed: recent picks, the latest sessions, every action and
 * every settings page. With a query: what matches, best first, sections in the order of their best match; recent
 * picks get a small lift.
 */
export function rankPalette<T extends PaletteItem>(items: readonly T[], query: string, recent: readonly string[]): PaletteSection<T>[] {
  if (!normalize(query)) {
    const byId = new Map(items.map((item) => [item.id, item]))
    const recents = recent.flatMap((id) => (byId.has(id) ? [byId.get(id) as T] : [])).slice(0, RECENT_SHOWN)
    const shown = new Set(recents.map((item) => item.id))
    const sections: PaletteSection<T>[] = recents.length ? [{ group: 'Recent', items: recents }] : []
    for (const group of GROUP_ORDER) {
      const members = items.filter((item) => item.group === group && !shown.has(item.id))
      const capped = group === 'Sessions' ? members.slice(0, SESSIONS_SHOWN) : members
      if (capped.length) sections.push({ group, items: capped })
    }
    return sections
  }

  const lift = (id: string) => {
    const position = recent.indexOf(id)
    return position === -1 ? 0 : 30 - position * 3
  }
  const scored = items
    .map((item, order) => ({ item, order, score: itemScore(item, query) }))
    .filter((entry) => entry.score >= 0)
    .map((entry) => ({ ...entry, score: entry.score + lift(entry.item.id) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)

  const sections = new Map<PaletteItem['group'], { best: number; items: T[] }>()
  for (const { item, score } of scored) {
    const section = sections.get(item.group) ?? { best: score, items: [] }
    if (item.group === 'Sessions' && section.items.length >= SESSIONS_FOUND) continue
    section.items.push(item)
    sections.set(item.group, section)
  }
  return [...sections]
    .sort((a, b) => b[1].best - a[1].best || GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]))
    .map(([group, section]) => ({ group, items: section.items }))
}

/** The rows in keyboard order. */
export function flatten<T extends PaletteItem>(sections: readonly PaletteSection<T>[]): T[] {
  return sections.flatMap((section) => section.items)
}

/** Recent picks with `id` first, without repeats, at most RECENT_KEPT. */
export function remember(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((item) => item !== id)].slice(0, RECENT_KEPT)
}

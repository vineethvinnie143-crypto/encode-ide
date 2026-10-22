/**
 * Find in a session, as text: where a query is in the words on the page. Free of the DOM, so the rules are unit tested.
 * Case does not matter, and any run of white space matches any other, the way the page shows it: a line break in a
 * paragraph is a space on screen, and a query typed with one space finds two.
 */

/** At most this many matches are marked; past it the count reads "1 of 1000+". */
export const MAX_MATCHES = 1000

const SPACE_RUN = /\s+/g

/** Lower case, except a character whose lower case is longer (İ), so every position stays where it was. */
export function foldCase(text: string): string {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let folded = ''
  for (const char of text) {
    const low = char.toLowerCase()
    folded += low.length === char.length ? low : char
  }
  return folded
}

/** What a query looks for: folded, each run of white space one space. Empty when it holds nothing but space. */
export function foldQuery(query: string): string {
  return query.trim() ? foldCase(query.replace(SPACE_RUN, ' ')) : ''
}

/** Text as find compares it, and the way back from a position in it to the same place in the text it came from. */
export interface FoldedText {
  text: string
  original(index: number): number
}

export function foldText(text: string): FoldedText {
  // Where each run that lost characters ends in the folded text, and how many that run and the runs before it lost.
  const ends: number[] = []
  const lost: number[] = []
  let removed = 0
  const spaced = text.replace(SPACE_RUN, (run: string, offset: number) => {
    if (run.length > 1) {
      ends.push(offset - removed + 1)
      removed += run.length - 1
      lost.push(removed)
    }
    return ' '
  })
  return {
    text: foldCase(spaced),
    original(index) {
      let low = 0
      let high = ends.length
      while (low < high) {
        const mid = (low + high) >> 1
        if (ends[mid] <= index) low = mid + 1
        else high = mid
      }
      return index + (low > 0 ? lost[low - 1] : 0)
    },
  }
}

/**
 * The text find searches in a piece of the agent's markdown that is folded away: the source, and the source without
 * the marks that do not show (**, `, a link's address), so "the cache" finds "the **cache**" before the fold opens.
 */
export function markdownHaystack(source: string): string {
  const shown = source.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`#>|]+/g, '')
  return foldText(`${source}\u0000${shown}`).text
}

export interface TextPoint<N> {
  node: N
  offset: number
}

export interface TextMatch<N> {
  start: TextPoint<N>
  end: TextPoint<N>
}

/** One block of text in reading order, in the pieces it is made of (the text nodes of a paragraph), none of them empty. */
export interface TextBlock<N> {
  nodes: readonly N[]
  texts: readonly string[]
}

/** The piece an offset into the block falls in: for an end, the piece it ends, never the start of the next one. */
function pointAt<N>(block: TextBlock<N>, starts: readonly number[], offset: number, end: boolean): TextPoint<N> {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (end ? starts[mid] < offset : starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return { node: block.nodes[low], offset: offset - starts[low] }
}

/**
 * Every place `needle` (from foldQuery) is in the blocks, in order and without overlaps, up to `limit`. A match can
 * run across the pieces of one block (a word half in bold), never from one block into the next.
 */
export function findInBlocks<N>(blocks: Iterable<TextBlock<N>>, needle: string, limit = MAX_MATCHES): { matches: TextMatch<N>[]; capped: boolean } {
  const matches: TextMatch<N>[] = []
  if (!needle) return { matches, capped: false }
  for (const block of blocks) {
    const folded = foldText(block.texts.join(''))
    let from = folded.text.indexOf(needle)
    if (from < 0) continue
    const starts: number[] = []
    let length = 0
    for (const text of block.texts) {
      starts.push(length)
      length += text.length
    }
    while (from >= 0) {
      if (matches.length === limit) return { matches, capped: true }
      const start = folded.original(from)
      const end = folded.original(from + needle.length - 1) + 1
      matches.push({ start: pointAt(block, starts, start, false), end: pointAt(block, starts, end, true) })
      from = folded.text.indexOf(needle, from + needle.length)
    }
  }
  return { matches, capped: false }
}

/** "3 of 41", "No results", or "1 of 1000+" past the most find marks. */
export function countLabel(index: number, total: number, capped: boolean): string {
  if (!total) return 'No results'
  return `${index + 1} of ${total}${capped ? '+' : ''}`
}

/** The first of `count` items in order at or after a place, by a comparison of item `index` with it; `count` when none is. */
export function firstAtOrAfter(count: number, compare: (index: number) => number): number {
  let low = 0
  let high = count
  while (low < high) {
    const mid = (low + high) >> 1
    if (compare(mid) < 0) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * Keyboard movement shared by menus, tabs and segmented controls, kept free
 * of the DOM so it can be unit tested.
 */

export type Move = 'next' | 'prev' | 'first' | 'last'

/** The move a key asks for in a list laid out along `orientation`, or null. */
export function keyToMove(key: string, orientation: 'vertical' | 'horizontal'): Move | null {
  if (key === 'Home') return 'first'
  if (key === 'End') return 'last'
  if (orientation === 'vertical') {
    if (key === 'ArrowDown') return 'next'
    if (key === 'ArrowUp') return 'prev'
  } else {
    if (key === 'ArrowRight') return 'next'
    if (key === 'ArrowLeft') return 'prev'
  }
  return null
}

/**
 * The index a move lands on, skipping disabled items and wrapping at the
 * ends. -1 when every item is disabled or there are none.
 */
export function moveIndex(
  from: number,
  move: Move,
  count: number,
  isDisabled: (index: number) => boolean = () => false,
): number {
  if (count <= 0) return -1
  const step = move === 'next' || move === 'first' ? 1 : -1
  // From nothing active (-1), next starts at the top and prev at the bottom.
  const start = from < 0 || from >= count ? (step > 0 ? -1 : count) : from
  let index = move === 'first' ? -1 : move === 'last' ? count : start
  for (let tried = 0; tried < count; tried++) {
    index = (index + step + count) % count
    if (!isDisabled(index)) return index
  }
  return -1
}

/**
 * Typeahead: the first enabled item after `from` (wrapping) whose label
 * starts with `query`, ignoring case. -1 when nothing matches.
 */
export function typeaheadIndex(
  labels: readonly string[],
  query: string,
  from: number,
  isDisabled: (index: number) => boolean = () => false,
): number {
  const needle = query.trim().toLowerCase()
  if (!needle || !labels.length) return -1
  for (let offset = 1; offset <= labels.length; offset++) {
    const index = (from + offset + labels.length) % labels.length
    if (!isDisabled(index) && labels[index].toLowerCase().startsWith(needle)) return index
  }
  return -1
}

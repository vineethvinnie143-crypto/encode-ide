/**
 * Where a floating element (menu, tooltip, popover) goes next to its anchor:
 * on the preferred side when it fits, flipped when the other side has more
 * room, and always kept inside the window. Pure, for unit tests.
 */

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export type Side = 'top' | 'bottom' | 'left' | 'right'
export type Align = 'start' | 'center' | 'end'

export interface PlaceOptions {
  side?: Side
  align?: Align
  /** Space between the anchor and the floating element. */
  gap?: number
  /** Space kept free at the window's edges. */
  margin?: number
}

export interface Placement {
  left: number
  top: number
  side: Side
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

function room(side: Side, anchor: Rect, viewport: Size, gap: number, margin: number): number {
  switch (side) {
    case 'top':
      return anchor.top - gap - margin
    case 'bottom':
      return viewport.height - (anchor.top + anchor.height) - gap - margin
    case 'left':
      return anchor.left - gap - margin
    case 'right':
      return viewport.width - (anchor.left + anchor.width) - gap - margin
  }
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(max, Math.max(min, value))
}

export function place(anchor: Rect, size: Size, viewport: Size, options: PlaceOptions = {}): Placement {
  const { align = 'center', gap = 6, margin = 8 } = options
  let side = options.side ?? 'bottom'
  const vertical = side === 'top' || side === 'bottom'
  const needed = vertical ? size.height : size.width
  const here = room(side, anchor, viewport, gap, margin)
  const there = room(OPPOSITE[side], anchor, viewport, gap, margin)
  if (here < needed && there > here) side = OPPOSITE[side]

  let left: number
  let top: number
  if (side === 'top' || side === 'bottom') {
    top = side === 'bottom' ? anchor.top + anchor.height + gap : anchor.top - gap - size.height
    left =
      align === 'start'
        ? anchor.left
        : align === 'end'
          ? anchor.left + anchor.width - size.width
          : anchor.left + (anchor.width - size.width) / 2
  } else {
    left = side === 'right' ? anchor.left + anchor.width + gap : anchor.left - gap - size.width
    top =
      align === 'start'
        ? anchor.top
        : align === 'end'
          ? anchor.top + anchor.height - size.height
          : anchor.top + (anchor.height - size.height) / 2
  }

  return {
    left: Math.round(clamp(left, margin, viewport.width - margin - size.width)),
    top: Math.round(clamp(top, margin, viewport.height - margin - size.height)),
    side,
  }
}

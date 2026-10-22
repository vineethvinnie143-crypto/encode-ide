/**
 * The stroke, in grid units, that draws a line of the same weight on screen at any size: 1.5 px from
 * 16 px up, a little finer below, because a 12 px icon with a thick line closes its own gaps.
 */
export function weight(size: number | string): number {
  const px = Number(size)
  if (!Number.isFinite(px) || px <= 0) return 1.75
  const onScreen = px >= 16 ? 1.5 : px >= 13 ? 1.4 : 1.3
  return Math.round(((onScreen * 24) / px) * 100) / 100
}

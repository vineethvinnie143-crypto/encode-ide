/**
 * The arithmetic between what the model sees and what the screen is.
 *
 * A screenshot is sent smaller than the window when the window is big, so the model's coordinates are
 * pixels of the image. The backend turns them back into screen pixels with the capture they belong
 * to; the outline is printed in image pixels too, so the two always agree.
 */
import type { Box, Capture, Point } from './contract'

/** Models read about this many pixels well; more only costs tokens. */
export const MAX_IMAGE_EDGE = 1568
export const MAX_IMAGE_PIXELS = 1_150_000

export interface ImageFit {
  width: number
  height: number
  /** Image pixels per screen pixel. */
  scale: number
}

/** The size an image of `width` x `height` screen pixels is sent at: never larger than the screen, and within the budget. */
export function fitImage(width: number, height: number, maxEdge = MAX_IMAGE_EDGE, maxPixels = MAX_IMAGE_PIXELS): ImageFit {
  if (width <= 0 || height <= 0) return { width: 0, height: 0, scale: 1 }
  const scale = Math.min(1, maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)))
  if (scale >= 1) return { width, height, scale: 1 }
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale }
}

/** The largest a zoom enlarges what it shows (ADR 0121). */
export const MAX_ZOOM = 4

/**
 * The size a zoom of `width` x `height` screen pixels is sent at: as large as the budget allows, up to MAX_ZOOM times the
 * screen, so a small area is shown big enough to point into; smaller than the screen only when it is too big to send whole.
 */
export function fitZoom(width: number, height: number, maxEdge = MAX_IMAGE_EDGE, maxPixels = MAX_IMAGE_PIXELS): ImageFit {
  if (width <= 0 || height <= 0) return { width: 0, height: 0, scale: 1 }
  const scale = Math.min(MAX_ZOOM, maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale }
}

/** Where a point of the capture's image is on the screen. */
export function toScreen(point: Point, capture: Pick<Capture, 'box' | 'scale'>): Point {
  return [capture.box[0] + Math.round(point[0] / capture.scale), capture.box[1] + Math.round(point[1] / capture.scale)]
}

/** Where a point of the screen is in the capture's image. */
export function toImage(point: Point, capture: Pick<Capture, 'box' | 'scale'>): Point {
  return [Math.round((point[0] - capture.box[0]) * capture.scale), Math.round((point[1] - capture.box[1]) * capture.scale)]
}

/** A screen box in the capture's image, clipped to the image. */
export function boxToImage(box: Box, capture: Pick<Capture, 'box' | 'scale' | 'width' | 'height'>): Box {
  const left = Math.max(0, Math.round((box[0] - capture.box[0]) * capture.scale))
  const top = Math.max(0, Math.round((box[1] - capture.box[1]) * capture.scale))
  const right = Math.min(capture.width, Math.round((box[0] + box[2] - capture.box[0]) * capture.scale))
  const bottom = Math.min(capture.height, Math.round((box[1] + box[3] - capture.box[1]) * capture.scale))
  return [left, top, Math.max(0, right - left), Math.max(0, bottom - top)]
}

export function center(box: Box): Point {
  return [box[0] + Math.floor(box[2] / 2), box[1] + Math.floor(box[3] / 2)]
}

export function contains(box: Box, point: Point): boolean {
  return point[0] >= box[0] && point[0] < box[0] + box[2] && point[1] >= box[1] && point[1] < box[1] + box[3]
}

export function sameBox(a: Box, b: Box): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
}

/** Whether `point` is a pixel of the capture's image. */
export function insideImage(point: Point, capture: Pick<Capture, 'width' | 'height'>): boolean {
  return Number.isInteger(point[0]) && Number.isInteger(point[1]) && point[0] >= 0 && point[1] >= 0 && point[0] < capture.width && point[1] < capture.height
}

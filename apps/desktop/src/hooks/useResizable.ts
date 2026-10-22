import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

interface Options {
  initial: number
  min: number
  max: number
  axis: 'x' | 'y'
  invert?: boolean
  persistKey: string
  /** The size on screen, for a panel that CSS holds under the saved size: a drag then starts from what the user sees. */
  measure?: () => number | undefined
  /**
   * The panel itself. While the pointer moves its size is set on it directly, and the state (and the saved size)
   * change once, when the pointer is released: no component renders per move, so a drag follows the pointer.
   */
  element?: () => HTMLElement | null | undefined
}

/**
 * Pointer-driven panel sizing with clamped bounds and localStorage memory.
 * `invert` flips the delta for panels anchored to the right/bottom edge.
 */
export function useResizable({ initial, min, max, axis, invert = false, persistKey, measure, element }: Options) {
  const [size, setSizeState] = useState(() => {
    try {
      const raw = localStorage.getItem(persistKey)
      const parsed = raw ? Number(raw) : Number.NaN
      return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : initial
    } catch {
      return initial
    }
  })

  const sizeRef = useRef(size)
  sizeRef.current = size
  const measureRef = useRef(measure)
  measureRef.current = measure
  const elementRef = useRef(element)
  elementRef.current = element

  const setSize = useCallback(
    (value: number) => {
      const clamped = Math.min(max, Math.max(min, value))
      setSizeState(clamped)
      try {
        localStorage.setItem(persistKey, String(Math.round(clamped)))
      } catch {
        /* storage may be unavailable */
      }
    },
    [max, min, persistKey],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault()
      const startPos = axis === 'x' ? event.clientX : event.clientY
      const shown = measureRef.current?.()
      const startSize = shown !== undefined && Number.isFinite(shown) && shown > 0 ? shown : sizeRef.current

      const target = elementRef.current?.()
      const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
      handle?.setAttribute('data-dragging', '')
      let latest: number | undefined

      const move = (ev: PointerEvent) => {
        const delta = (axis === 'x' ? ev.clientX : ev.clientY) - startPos
        const wanted = startSize + (invert ? -delta : delta)
        if (!target) {
          setSize(wanted)
          return
        }
        latest = Math.min(max, Math.max(min, wanted))
        target.style[axis === 'x' ? 'width' : 'height'] = `${latest}px`
      }

      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        document.body.classList.remove('is-resizing')
        document.body.style.cursor = ''
        handle?.removeAttribute('data-dragging')
        if (latest !== undefined) setSize(latest)
      }

      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
      document.body.classList.add('is-resizing')
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    },
    [axis, invert, max, min, setSize],
  )

  return { size, onPointerDown }
}

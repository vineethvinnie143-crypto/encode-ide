import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

interface Options {
  initial: number
  min: number
  max: number
  axis: 'x' | 'y'
  invert?: boolean
  persistKey: string
}

/**
 * Pointer-driven panel sizing with clamped bounds and localStorage memory.
 * `invert` flips the delta for panels anchored to the right/bottom edge.
 */
export function useResizable({ initial, min, max, axis, invert = false, persistKey }: Options) {
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
      const startSize = sizeRef.current

      const move = (ev: PointerEvent) => {
        const delta = (axis === 'x' ? ev.clientX : ev.clientY) - startPos
        setSize(startSize + (invert ? -delta : delta))
      }

      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.classList.remove('is-resizing')
        document.body.style.cursor = ''
      }

      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      document.body.classList.add('is-resizing')
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    },
    [axis, invert, setSize],
  )

  return { size, onPointerDown }
}

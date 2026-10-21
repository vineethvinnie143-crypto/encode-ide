import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Kbd } from './Kbd'
import { place, type Side } from './place'
import { tooltipDelay } from './shortcut'

let lastClosedAt = 0

/**
 * A label, and optionally its shortcut, shown after 400 ms on hover or on
 * keyboard focus. Wraps one element; the wrapper itself has no box.
 */
export function Tooltip({
  label,
  shortcut,
  side = 'bottom',
  disabled,
  children,
}: {
  label: string
  shortcut?: string
  side?: Side
  disabled?: boolean
  children: ReactNode
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null)

  const show = () => {
    if (disabled) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(true), tooltipDelay(Date.now(), lastClosedAt))
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    setOpen((wasOpen) => {
      if (wasOpen) lastClosedAt = Date.now()
      return false
    })
    setSpot(null)
  }

  useLayoutEffect(() => {
    if (!open) return
    const target = anchor.current?.firstElementChild
    const box = tip.current
    if (!target || !box) return
    const rect = target.getBoundingClientRect()
    setSpot(
      place(
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        { width: box.offsetWidth, height: box.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        { side, gap: 6 },
      ),
    )
  }, [open, side])

  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    if (disabled) hide()
  }, [disabled])

  return (
    <span
      ref={anchor}
      className="ui-tooltip-anchor"
      onPointerEnter={show}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(event) => {
        if ((event.target as HTMLElement).matches(':focus-visible')) show()
      }}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) hide()
      }}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={tip}
            role="tooltip"
            className="ui-tooltip"
            style={spot ? { left: spot.left, top: spot.top } : { left: 0, top: 0, visibility: 'hidden' }}
          >
            <span>{label}</span>
            {shortcut && <Kbd keys={shortcut} />}
          </div>,
          document.body,
        )}
    </span>
  )
}

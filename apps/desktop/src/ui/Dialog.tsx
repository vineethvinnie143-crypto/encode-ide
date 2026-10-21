import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from './Button'
import { cx } from './cx'
import { X } from './icons'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A modal dialog: focus moves in when it opens, stays inside while it is
 * open and returns to where it was when it closes. Escape or a click on the
 * backdrop closes it.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  width = 520,
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  /** Actions, primary last so it sits on the right. */
  footer?: ReactNode
  width?: number
  className?: string
  children?: ReactNode
}) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const returnTo = document.activeElement as HTMLElement | null
    const node = panel.current
    // An element marked data-autofocus wins, then the first field or button in the body.
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? node?.querySelector<HTMLElement>(`.ui-dialog-body ${FOCUSABLE}`) ?? node
    first?.focus({ preventScroll: true })
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      returnTo?.focus?.({ preventScroll: true })
    }
  }, [open])

  if (!open) return null

  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !panel.current) return
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className="ui-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx('ui-dialog', className)}
        style={{ width }}
        onKeyDown={trapTab}
      >
        <header className="ui-dialog-head">
          <div>
            <h2 id={titleId} className="ui-dialog-title">
              {title}
            </h2>
            {description && <div className="ui-dialog-description">{description}</div>}
          </div>
          <IconButton label="Close" shortcut="Esc" size="md" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="ui-dialog-body">{children}</div>
        {footer && <footer className="ui-dialog-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

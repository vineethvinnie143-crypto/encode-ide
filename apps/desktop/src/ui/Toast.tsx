import type { ReactNode } from 'react'
import { cx } from './cx'
import { AlertTriangle, CheckCircle2, Info, X } from './icons'

export type ToastKind = 'info' | 'success' | 'error'

const ICONS = { info: Info, success: CheckCircle2, error: AlertTriangle }

/** One notice. Errors are announced at once; the rest wait for a pause. */
export function Toast({
  kind,
  children,
  action,
  onDismiss,
  onPointerEnter,
  onPointerLeave,
}: {
  kind: ToastKind
  children: ReactNode
  /** A button such as Undo or View. */
  action?: ReactNode
  onDismiss: () => void
  onPointerEnter?: () => void
  onPointerLeave?: () => void
}) {
  const Icon = ICONS[kind]
  return (
    <div
      className={cx('toast', `toast-${kind}`)}
      role={kind === 'error' ? 'alert' : 'status'}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <Icon size={16} className="toast-icon" />
      <span className="toast-text">{children}</span>
      {action}
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  )
}

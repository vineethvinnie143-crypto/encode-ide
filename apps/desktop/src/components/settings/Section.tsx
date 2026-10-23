import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from '../../ui/cx'

/** A titled card of settings rows. */
export function SettingsGroup({ title, description, children, className }: { title?: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('settings-group', className)}>
      {title && <h2 className="settings-group-title">{title}</h2>}
      {description && <p className="settings-group-description">{description}</p>}
      <div className="settings-card">{children}</div>
    </section>
  )
}

/** One setting: its name and what it does on the left, the control on the right. `id` is what the page's search scrolls to. */
export function SettingRow({
  id,
  label,
  help,
  htmlFor,
  children,
  below,
}: {
  id?: string
  label: ReactNode
  help?: ReactNode
  /** The control's id, so the label can be clicked. */
  htmlFor?: string
  children?: ReactNode
  /** Something under the row's text and control, full width: a note, a result. */
  below?: ReactNode
}) {
  return (
    <div className="settings-row" data-setting={id}>
      <div className="settings-row-text">
        {htmlFor ? (
          <label className="settings-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <div className="settings-row-label">{label}</div>
        )}
        {help && <div className="settings-row-help">{help}</div>}
      </div>
      {children !== undefined && <div className="settings-row-control">{children}</div>}
      {below && <div className="settings-row-below">{below}</div>}
    </div>
  )
}

/**
 * A text field that saves when you leave it or press Enter, as a setting page does, and goes back to what is saved on
 * Esc. It follows the saved value while you are not typing in it, and shows it again after a commit the setting did
 * not take (text where a number goes).
 */
export function CommitInput({
  value,
  onCommit,
  className,
  ...rest
}: {
  value: string
  onCommit: (value: string) => void
  className?: string
  id?: string
  placeholder?: string
  'aria-label'?: string
  disabled?: boolean
  type?: 'text' | 'number' | 'url'
  min?: number
  max?: number
  spellCheck?: boolean
  list?: string
}) {
  const [text, setText] = useState(value)
  const [commits, setCommits] = useState(0)
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setText(value)
  }, [value, commits])
  const commit = () => {
    editing.current = false
    if (text !== value) onCommit(text)
    setCommits((count) => count + 1)
  }
  return (
    <input
      {...rest}
      className={cx('text-input', className)}
      value={text}
      onFocus={() => (editing.current = true)}
      onChange={(event) => {
        editing.current = true
        setText(event.target.value)
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape' && text !== value) {
          // Esc undoes the edit; a second Esc, with nothing to undo, leaves the page.
          event.preventDefault()
          editing.current = false
          setText(value)
        }
      }}
    />
  )
}

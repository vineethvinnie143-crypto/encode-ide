import { useId, useState } from 'react'
import type { KeyStorage } from '@shared/types'
import { IconButton } from '../../ui/Button'
import { Eye, EyeOff } from '../../ui/icons'

/**
 * A field for an API key: hidden until asked, never spell-checked or remembered by the browser, and with the
 * truth about where the key goes once it is submitted.
 */
export function KeyField({
  value,
  onChange,
  onSubmit,
  placeholder,
  provider,
  storage,
  warning,
  label = 'API key',
  optional,
  autoFocus,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  /** Enter in the field. */
  onSubmit?: () => void
  placeholder?: string
  /** Who receives the key, for the line under the field. */
  provider: string
  storage?: KeyStorage
  /** A soft warning about what was typed. */
  warning?: string | null
  label?: string
  optional?: boolean
  autoFocus?: boolean
  disabled?: boolean
}) {
  const id = useId()
  const [shown, setShown] = useState(false)
  return (
    <div className="key-field">
      <label className="key-field-label" htmlFor={id}>
        {label}
        {optional && <span className="key-field-optional">optional</span>}
      </label>
      <div className="key-field-row">
        <input
          id={id}
          className="text-input"
          type={shown ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-autofocus={autoFocus ? true : undefined}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && value.trim() && onSubmit) {
              event.preventDefault()
              onSubmit()
            }
          }}
        />
        <IconButton label={shown ? 'Hide the key' : 'Show the key'} size="md" onClick={() => setShown((current) => !current)}>
          {shown ? <EyeOff size={15} /> : <Eye size={15} />}
        </IconButton>
      </div>
      {warning && <div className="key-field-note is-warn">{warning}</div>}
      <div className={storage?.mode === 'session' ? 'key-field-note is-warn' : 'key-field-note'}>
        {storage?.mode === 'session'
          ? `Kept in memory until eNCode closes and never written to disk. ${storage.reason}`
          : `Stored encrypted by your system keychain and sent only to ${provider}.`}
      </div>
    </div>
  )
}

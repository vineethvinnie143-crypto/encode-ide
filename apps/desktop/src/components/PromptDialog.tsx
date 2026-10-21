import { useEffect, useRef, useState } from 'react'
import { useUi } from '../stores/ui'

export default function PromptDialog() {
  const prompt = useUi((state) => state.prompt)
  const resolvePrompt = useUi((state) => state.resolvePrompt)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!prompt) return
    setValue(prompt.value)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [prompt])

  if (!prompt) return null

  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    resolvePrompt(trimmed)
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => resolvePrompt(null)}>
      <div className="prompt-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="prompt-title">{prompt.title}</div>
        <input
          ref={inputRef}
          className="text-input"
          value={value}
          placeholder={prompt.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
            if (event.key === 'Escape') resolvePrompt(null)
          }}
        />
        <div className="prompt-actions">
          <button className="btn ghost" onClick={() => resolvePrompt(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!value.trim()}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}

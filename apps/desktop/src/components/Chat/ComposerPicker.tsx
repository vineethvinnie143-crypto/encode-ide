import { useEffect, useRef, type ReactNode } from 'react'
import { cx } from '../../ui/cx'
import { BookOpen, FileText, Terminal } from '../../ui/icons'
import type { PickerKind, PickerOption } from './picker'

const LABELS: Record<PickerKind, string> = { slash: 'Commands', file: 'Files', skill: 'Skills' }

const ICONS: Record<PickerOption['kind'], ReactNode> = {
  command: <Terminal size={15} />,
  skill: <BookOpen size={15} />,
  file: <FileText size={15} />,
}

/**
 * The list above the message box while a `/`, `@` or `$` word is typed. The field keeps focus: arrows move, Enter
 * or Tab picks, Esc closes (the message box handles the keys and passes the result in).
 */
export function ComposerPicker({
  kind,
  options,
  index,
  listId,
  note,
  onPick,
  onHover,
}: {
  kind: PickerKind
  options: readonly PickerOption[]
  index: number
  listId: string
  /** A line under the list: what is loading, or why nothing is listed. */
  note?: string
  onPick: (option: PickerOption) => void
  onHover: (index: number) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector(`[data-row="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index, options])

  return (
    // A press on the list must not take focus from the field.
    <div className="composer-picker" onMouseDown={(event) => event.preventDefault()}>
      {options.length > 0 && (
        <div className="palette-list" id={listId} role="listbox" aria-label={LABELS[kind]} ref={list}>
          {options.map((option, row) => {
            const startsSkills = kind === 'slash' && option.kind === 'skill' && options[row - 1]?.kind !== 'skill'
            const cut = option.name.lastIndexOf('/')
            const name = option.kind === 'file' ? option.name.slice(cut + 1) : `${option.kind === 'command' ? '/' : '$'}${option.name}`
            const folder = option.kind === 'file' ? option.name.slice(0, Math.max(0, cut)) : ''
            return (
              <div key={option.id}>
                {startsSkills && (
                  <div className="palette-group" aria-hidden="true">
                    Skills
                  </div>
                )}
                <div
                  id={`${listId}-${row}`}
                  data-row={row}
                  role="option"
                  aria-selected={row === index}
                  className={cx('palette-row', row === index && 'is-active')}
                  onMouseMove={() => row !== index && onHover(row)}
                  onClick={() => onPick(option)}
                >
                  <span className="palette-icon">{ICONS[option.kind]}</span>
                  <span className={cx('palette-title', option.kind !== 'file' && 'picker-name')}>{name}</span>
                  {option.args && <span className="picker-args">{option.args}</span>}
                  {option.kind === 'file' ? folder && <span className="palette-detail">{folder}</span> : option.description && <span className="palette-detail">{option.description}</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {note && <div className="picker-note">{note}</div>}
    </div>
  )
}

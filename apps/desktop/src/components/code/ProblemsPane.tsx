import { useMemo, useState, type KeyboardEvent } from 'react'
import type { CodeDiagnostic } from '@shared/types'
import { allMarks, sourceOf, useProblems } from '../../editor/marks'
import { filterProblems, type Severity } from '../../editor/problems'
import { useEditor } from '../../stores/editor'
import { usePanels } from '../../stores/panels'
import { cx } from '../../ui/cx'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, Search, XCircle } from '../../ui/icons'

const SEVERITY_ICON = { error: XCircle, warning: AlertTriangle, info: Info, hint: Info } as const

const CHIPS: { key: Severity; label: string; one: string; icon: typeof XCircle }[] = [
  { key: 'errors', label: 'errors', one: 'error', icon: XCircle },
  { key: 'warnings', label: 'warnings', one: 'warning', icon: AlertTriangle },
  { key: 'others', label: 'notes', one: 'note', icon: Info },
]

/** Up and Down move between the rows of the list, as in a tree; Left closes a file, Right opens it. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>, toggle: (path: string, open: boolean) => void): void {
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.pp-file, .pp-row')]
  const index = rows.indexOf(document.activeElement as HTMLButtonElement)
  if (index < 0) return
  const go = (next: number) => {
    event.preventDefault()
    rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus()
  }
  if (event.key === 'ArrowDown') go(index + 1)
  else if (event.key === 'ArrowUp') go(index - 1)
  else if (event.key === 'Home') go(0)
  else if (event.key === 'End') go(rows.length - 1)
  else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && rows[index].dataset.path) {
    event.preventDefault()
    toggle(rows[index].dataset.path!, event.key === 'ArrowRight')
  }
}

/** The bottom panel's Problems: everything the language servers found in the folder's files, by file. */
export function ProblemsPane() {
  // A new count object with every report: the list reads the reports again when one comes.
  const counts = useProblems((state) => state.counts)
  const files = useMemo(() => allMarks(), [counts])
  const [filter, setFilter] = useState('')
  const [shown, setShown] = useState<Record<Severity, boolean>>({ errors: true, warnings: true, others: true })
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())

  const totals = useMemo(() => {
    const sum = { errors: 0, warnings: 0, others: 0 }
    for (const count of Object.values(counts)) {
      sum.errors += count.errors
      sum.warnings += count.warnings
      sum.others += count.others
    }
    return sum
  }, [counts])
  const groups = useMemo(() => filterProblems(files, shown, filter), [files, shown, filter])

  const toggle = (path: string, open?: boolean) =>
    setClosed((current) => {
      const next = new Set(current)
      if (open ?? next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const openProblem = (path: string, item: CodeDiagnostic) => {
    usePanels.getState().open('editor')
    void useEditor.getState().openAt(path, { start: { line: item.line, character: item.character }, end: { line: item.endLine, character: item.endCharacter } })
  }

  return (
    <div className="problems-pane">
      <div className="pp-bar">
        <label className="pp-filter">
          <Search size={13} aria-hidden="true" />
          <input value={filter} placeholder="Filter problems" aria-label="Filter problems" spellCheck={false} onChange={(event) => setFilter(event.target.value)} />
        </label>
        <div className="pp-chips" role="group" aria-label="Show">
          {CHIPS.map(({ key, label, one, icon: Icon }) => (
            <button
              key={key}
              type="button"
              className={cx('pp-chip', `is-${key}`, !shown[key] && 'is-off')}
              aria-pressed={shown[key]}
              aria-label={`${totals[key]} ${totals[key] === 1 ? one : label}`}
              title={`${shown[key] ? 'Hide' : 'Show'} ${label}`}
              onClick={() => setShown((current) => ({ ...current, [key]: !current[key] }))}
            >
              <Icon size={12} aria-hidden="true" />
              <span aria-hidden="true">{totals[key]}</span>
            </button>
          ))}
        </div>
      </div>
      {!files.length ? (
        <div className="panel-empty">
          <CheckCircle2 size={18} />
          <span>No problems. The language servers mark them in the files they check: the ones you open, and the ones the agent changes.</span>
        </div>
      ) : !groups.length ? (
        <div className="panel-empty">
          <Search size={18} />
          <span>No problems match.</span>
        </div>
      ) : (
        <div className="pp-list" role="list" aria-label="Problems" onKeyDown={(event) => moveFocus(event, (path, open) => toggle(path, open))}>
          {groups.map(({ path, items }) => {
            const open = !closed.has(path)
            const slash = path.lastIndexOf('/')
            return (
              <div key={path} role="listitem" className="pp-group">
                <button type="button" className="pp-file" data-path={path} aria-expanded={open} onClick={() => toggle(path)}>
                  {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                  <span className="pp-name">{path.slice(slash + 1)}</span>
                  {slash > 0 && <span className="pp-dir">{path.slice(0, slash)}</span>}
                  <span className="pp-count">{items.length}</span>
                </button>
                {open && (
                  <div role="list" className="pp-items">
                    {items.map((item, index) => {
                      const Icon = SEVERITY_ICON[item.severity]
                      const source = sourceOf(item)
                      const first = item.message.split('\n')[0]
                      return (
                        <button
                          key={`${item.line}:${item.character}:${index}`}
                          type="button"
                          role="listitem"
                          className={cx('pp-row', `is-${item.severity}`)}
                          title={item.message}
                          onClick={() => openProblem(path, item)}
                        >
                          <Icon size={13} className="pp-icon" aria-hidden="true" />
                          <span className="pp-message">{first}</span>
                          {source && <span className="pp-source">{source}</span>}
                          <span className="pp-at">
                            Ln {item.line + 1}, Col {item.character + 1}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}


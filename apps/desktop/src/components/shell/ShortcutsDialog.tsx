import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MAX_CHORDS, type Keybindings } from '@shared/keybindings'
import { commandRegistry } from '../../commands/app'
import { GROUPS } from '../../commands/commands'
import { addChord, assignChord, chordUse, filterSections, removeChords, resetChords, shortcutSections, type ShortcutRow } from '../../commands/keybindings'
import { chordOfEvent, formatChord, type Chord } from '../../commands/keys'
import { useShortcuts } from '../../commands/useShortcuts'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { Button, IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Dialog } from '../../ui/Dialog'
import { Lock, Plus, Undo2, X } from '../../ui/icons'
import { Kbd } from '../../ui/Kbd'
import { Tooltip } from '../../ui/Tooltip'

/** A row being given a shortcut: listening for the keys, or asking before it takes them from another command. */
type Editing =
  | { id: string; add: boolean; phase: 'listening'; shown: string; refused: string | null }
  | { id: string; add: boolean; phase: 'taking'; chord: Chord; from: string }

const keybindings = (): Keybindings => useSettings.getState().settings?.keybindings ?? {}
const save = (next: Keybindings) => useSettings.getState().save({ keybindings: next })

/** The modifiers down during a key event, as the start of a shortcut: "Ctrl+Shift". */
const heldKeys = (event: KeyboardEvent) =>
  [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Win'].filter(Boolean).join('+')

/** Ctrl+/ : every shortcut, searchable by name or key, and changed by pressing the new one. */
export function ShortcutsDialog() {
  const open = useUi((state) => state.shortcutsOpen)
  const [editing, setEditing] = useState(false)
  return (
    <Dialog
      open={open}
      onClose={() => useUi.getState().setShortcutsOpen(false)}
      title="Keyboard shortcuts"
      description="Click a shortcut to change it."
      width={600}
      className="shortcuts-dialog"
      escapeCloses={!editing}
    >
      <ShortcutList onEditing={setEditing} />
    </Dialog>
  )
}

function ShortcutList({ onEditing }: { onEditing: (editing: boolean) => void }) {
  useShortcuts()
  const custom = useSettings((state) => Object.keys(state.settings?.keybindings ?? {}).length > 0)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  /** The row last changed, listed until the search changes even when its new keys no longer match it. */
  const [kept, setKept] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  /** The row whose shortcut button takes the focus once the change shows. */
  const refocus = useRef<string | null>(null)

  const sections = filterSections(shortcutSections(commandRegistry, GROUPS), query, kept)

  useEffect(() => onEditing(editing !== null), [editing, onEditing])
  useEffect(() => () => onEditing(false), [onEditing])

  const stop = useCallback((id: string, focus: boolean) => {
    refocus.current = focus ? id : null
    setEditing(null)
  }, [])

  const change = useCallback((id: string, next: Keybindings) => {
    refocus.current = id
    void save(next).then((ok) => ok && setSaved(id))
  }, [])

  // While listening, every key is the new shortcut's: none reaches the dialog, the list or the app. Esc stops, and so
  // does a click anywhere but the row.
  useEffect(() => {
    if (!editing) return
    const { id, add } = editing
    const decide = (chord: Chord) => {
      const use = chordUse(commandRegistry, id, chord)
      if (use.kind === 'refused') setEditing({ id, add, phase: 'listening', shown: formatChord(chord), refused: use.reason })
      else if (use.kind === 'taken') setEditing({ id, add, phase: 'taking', chord, from: use.holder.id })
      else if (use.kind === 'same' && add) stop(id, true)
      else {
        stop(id, true)
        change(id, add ? addChord(commandRegistry, keybindings(), id, chord) : assignChord(commandRegistry, keybindings(), id, chord))
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (editing.phase === 'taking') {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        stop(id, true)
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      const chord = chordOfEvent(event)
      if (event.key === 'Escape' && !heldKeys(event)) stop(id, true)
      else if (chord) decide(chord)
      else setEditing({ id, add, phase: 'listening', shown: heldKeys(event), refused: null })
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (editing.phase !== 'listening') return
      event.preventDefault()
      event.stopPropagation()
      if (!editing.refused) setEditing({ ...editing, shown: heldKeys(event) })
    }
    const onPointerDown = (event: PointerEvent) => {
      const row = list.current?.querySelector('.shortcuts-row.is-editing')
      if (!(event.target instanceof Node) || !row?.contains(event.target)) stop(id, false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [editing, stop, change])

  // The focus follows the row: into the field that listens, onto the button that takes the shortcut, back to the row.
  const phase = editing?.phase
  const editingId = editing?.id
  useLayoutEffect(() => {
    if (!editingId) return
    const row = list.current?.querySelector<HTMLElement>(`[data-shortcut="${CSS.escape(editingId)}"]`)
    row?.querySelector<HTMLElement>(phase === 'taking' ? '.shortcuts-take .btn.primary' : '.shortcuts-recorder')?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  }, [phase, editingId])
  useLayoutEffect(() => {
    if (editing || !refocus.current) return
    const button = list.current?.querySelector<HTMLElement>(`[data-shortcut="${CSS.escape(refocus.current)}"] .shortcuts-keys`)
    if (!button) return
    refocus.current = null
    button.focus({ preventScroll: true })
  })

  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => setSaved(null), 1200)
    return () => clearTimeout(timer)
  }, [saved])

  const listen = (id: string, add: boolean) => {
    setKept(id)
    setEditing({ id, add, phase: 'listening', shown: '', refused: null })
  }
  const take = () => {
    if (editing?.phase !== 'taking') return
    const { id, add, chord } = editing
    stop(id, true)
    change(id, add ? addChord(commandRegistry, keybindings(), id, chord) : assignChord(commandRegistry, keybindings(), id, chord))
  }
  const resetAll = () => {
    const before = keybindings()
    void save({}).then((ok) => {
      if (ok) useUi.getState().notify('success', 'Every shortcut is back to the one eNCode ships with.', { label: 'Undo', run: () => void save(before) })
    })
  }

  return (
    <>
      <div className="shortcuts-bar">
        <input
          className="text-input shortcuts-filter"
          data-autofocus
          type="search"
          placeholder="Search by name or key"
          aria-label="Search shortcuts"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setKept(null)
          }}
        />
        <Button variant="ghost" icon={<Undo2 size={14} />} disabled={!custom} onClick={resetAll}>
          Reset all
        </Button>
      </div>
      <div ref={list} className="shortcuts-list">
        {sections.map((section) => (
          <section key={section.group}>
            <h3 className="shortcuts-group">{section.group}</h3>
            {section.rows.map((row) => (
              <ShortcutRowView
                key={row.id}
                row={row}
                editing={editing?.id === row.id ? editing : null}
                saved={saved === row.id}
                onListen={(add) => listen(row.id, add)}
                onTake={take}
                onCancel={() => stop(row.id, true)}
                onRemove={() => {
                  setKept(row.id)
                  change(row.id, removeChords(commandRegistry, keybindings(), row.id))
                }}
                onReset={() => {
                  setKept(row.id)
                  change(row.id, resetChords(commandRegistry, keybindings(), row.id))
                }}
              />
            ))}
          </section>
        ))}
        {!sections.length && <div className="shortcuts-empty">No shortcut matches “{query}”.</div>}
      </div>
    </>
  )
}

function Keys({ keys, range }: { keys: readonly string[]; range?: boolean }) {
  return (
    <>
      {keys.slice(0, 2).map((key, index) => (
        <span key={key} className="shortcuts-alt">
          {index > 0 && <span className="shortcuts-or">{range ? 'to' : 'or'}</span>}
          <Kbd keys={key} />
        </span>
      ))}
      {keys.length > 2 && <span className="shortcuts-or">+{keys.length - 2}</span>}
    </>
  )
}

function ShortcutRowView({
  row,
  editing,
  saved,
  onListen,
  onTake,
  onCancel,
  onRemove,
  onReset,
}: {
  row: ShortcutRow
  editing: Editing | null
  saved: boolean
  onListen: (add: boolean) => void
  onTake: () => void
  onCancel: () => void
  onRemove: () => void
  onReset: () => void
}) {
  const has = row.keys.length > 0
  const said = has ? row.keys.join(' or ') : 'no shortcut'
  const listening = editing?.phase === 'listening' ? editing : null
  const taking = editing?.phase === 'taking' ? editing : null

  return (
    <div className={cx('shortcuts-row', editing && 'is-editing', saved && 'is-saved', row.fixed && 'is-fixed')} data-shortcut={row.id}>
      <span className="shortcuts-title">
        {row.title}
        {row.changed && (
          <Tooltip label="Changed from the shortcut eNCode ships with">
            <span className="shortcuts-changed" role="img" aria-label="Changed" />
          </Tooltip>
        )}
      </span>

      {row.fixed ? (
        <Tooltip label={row.fixed}>
          <span className="shortcuts-keys">
            <Keys keys={row.keys} range={row.range} />
          </span>
        </Tooltip>
      ) : listening ? (
        <div
          className={cx('shortcuts-recorder', listening.refused && 'is-refused')}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          aria-label={listening.refused ?? (listening.add ? `Press another shortcut for ${row.title}` : `Press the new shortcut for ${row.title}`)}
        >
          {listening.shown ? <Kbd keys={listening.shown} /> : <span className="shortcuts-prompt">Press a shortcut</span>}
          {!listening.refused && <span className="shortcuts-caret" aria-hidden="true" />}
        </div>
      ) : (
        <Tooltip label={has ? 'Change shortcut' : 'Set a shortcut'}>
          <button type="button" className={cx('shortcuts-keys', !has && 'is-empty')} aria-label={`${row.title}: ${said}. Change`} onClick={() => onListen(false)}>
            {has ? <Keys keys={row.keys} /> : <span className="shortcuts-set">Set shortcut</span>}
          </button>
        </Tooltip>
      )}

      <span className="shortcuts-actions">
        {row.fixed ? (
          <Lock size={12} className="shortcuts-lock" aria-hidden="true" />
        ) : (
          !editing && (
            <>
              {has && row.keys.length < MAX_CHORDS && (
                <IconButton label="Add another shortcut" onClick={() => onListen(true)}>
                  <Plus size={13} />
                </IconButton>
              )}
              {row.changed && (
                <IconButton label="Reset to the shipped shortcut" onClick={onReset}>
                  <Undo2 size={13} />
                </IconButton>
              )}
              {has && (
                <IconButton label="Remove shortcut" onClick={onRemove}>
                  <X size={13} />
                </IconButton>
              )}
            </>
          )
        )}
      </span>

      {listening && (
        <div className={cx('shortcuts-note', listening.refused && 'is-refused')} aria-hidden="true">
          {listening.refused ?? 'Press the keys together. Esc cancels.'}
        </div>
      )}
      {taking && (
        <div className="shortcuts-take">
          <span className="shortcuts-take-text">
            <Kbd keys={formatChord(taking.chord)} />
            <span>
              is the shortcut for <strong>{commandRegistry.titleOf(taking.from)}</strong>.
            </span>
          </span>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={onTake}>
            Use it here
          </Button>
        </div>
      )}
    </div>
  )
}

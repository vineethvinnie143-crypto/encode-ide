import { useEffect, useRef, useState } from 'react'
import { activeTheme, resolveTheme, type Appearance } from '@shared/appearance'
import { ACCENT_COLORS, BUILT_IN_COLORS, MAX_THEMES, THEME_COLORS, contrastProblems, newTheme, type CustomTheme, type ThemeColor, type ThemeGroup } from '@shared/themes'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { applyAppearance } from '../../theme/appearance'
import { Button, IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { AlertTriangle, Check, Copy, FileUp, Plus, RotateCw, Trash2 } from '../../ui/icons'
import { Menu, type MenuEntry } from '../../ui/Menu'
import { SettingRow } from './Section'

/** How long the editor waits after the last colour change before it keeps the theme. */
const KEEP_AFTER_MS = 350
const GROUPS: readonly ThemeGroup[] = ['Surfaces', 'Text and lines', 'Accent and meaning', 'Code']

const themeId = () => `theme-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
const notify = (kind: 'success' | 'error', text: string) => useUi.getState().notify(kind, text)

/** A name not taken yet: "My theme", then "My theme 2". */
function freeName(themes: readonly CustomTheme[], wanted: string): string {
  const names = new Set(themes.map((theme) => theme.name))
  if (!names.has(wanted)) return wanted
  for (let count = 2; ; count++) if (!names.has(`${wanted} ${count}`)) return `${wanted} ${count}`
}

/** The current appearance from the store, so two changes in a row each build on the last. */
const latest = (fallback: Appearance): Appearance => useSettings.getState().settings?.appearance ?? fallback

/** Settings > Appearance > Colours: eNCode's own theme or one of yours, and the editor for yours. */
export function ThemeSettings({ appearance }: { appearance: Appearance }) {
  const save = useSettings((state) => state.save)
  const active = activeTheme(appearance)
  const full = appearance.themes.length >= MAX_THEMES

  const keep = (next: Partial<Appearance>) => void save({ appearance: { ...latest(appearance), ...next } })
  const choose = (id: string) => keep({ theme: id })

  const add = (theme: CustomTheme) => {
    const current = latest(appearance)
    keep({ themes: [...current.themes, theme], theme: theme.id })
  }

  const create = (base: 'dark' | 'light') => {
    const current = latest(appearance)
    add(newTheme(themeId(), freeName(current.themes, 'My theme'), base, ACCENT_COLORS[base][current.accent]))
  }

  const importTheme = async () => {
    try {
      const theme = await api.settings.importTheme(themeId())
      if (!theme) return
      add({ ...theme, name: freeName(latest(appearance).themes, theme.name) })
      notify('success', `Added ${theme.name}.`)
    } catch (error) {
      notify('error', errorText(error))
    }
  }

  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const newEntries = (): MenuEntry[] => [
    { id: 'dark', label: 'From the dark theme', onSelect: () => create('dark') },
    { id: 'light', label: 'From the light theme', onSelect: () => create('light') },
    { kind: 'separator', id: 'sep' },
    { id: 'import', label: 'From a file…', onSelect: () => void importTheme() },
  ]

  return (
    <>
      <SettingRow
        id="appearance.colors"
        label="Colours"
        help={active ? 'Your theme decides light or dark and the accent.' : 'eNCode’s own colours, in the mode and accent above. Make a theme of your own to choose every colour.'}
        below={
          <div className="theme-list" role="radiogroup" aria-label="Colours">
            <ThemeCard name="eNCode" colors={BUILT_IN_COLORS[resolveTheme(appearance.mode, systemDark)]} accent={ACCENT_COLORS[resolveTheme(appearance.mode, systemDark)][appearance.accent]} on={!active} onSelect={() => choose('')} />
            {appearance.themes.map((theme) => (
              <ThemeCard key={theme.id} name={theme.name} colors={theme.colors} accent={theme.colors.accent} on={active?.id === theme.id} onSelect={() => choose(theme.id)} id={theme.id} />
            ))}
            <Menu
              label="New theme"
              entries={newEntries}
              width={220}
              trigger={(props) => (
                <button type="button" className="theme-card theme-new" disabled={full} title={full ? `You can keep ${MAX_THEMES} themes; remove one first.` : undefined} {...props}>
                  <Plus size={16} aria-hidden="true" />
                  <span>New theme</span>
                </button>
              )}
            />
          </div>
        }
      />
      {active && <ThemeEditor key={active.id} appearance={appearance} theme={active} />}
    </>
  )
}

function ThemeCard({ id, name, colors, accent, on, onSelect }: { id?: string; name: string; colors: Readonly<Record<ThemeColor, string>>; accent: string; on: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={cx('theme-card', on && 'is-on')} data-theme-card={id ?? 'built-in'} onClick={onSelect}>
      <span className="theme-preview" style={{ background: colors.canvas, borderColor: colors.border }} aria-hidden="true">
        <span className="theme-preview-rail" style={{ background: colors.chrome }} />
        <span className="theme-preview-side" style={{ background: colors.sidebar }} />
        <span className="theme-preview-body">
          <span className="theme-preview-line" style={{ background: colors.text }} />
          <span className="theme-preview-line is-short" style={{ background: colors.text, opacity: 0.55 }} />
          <span className="theme-preview-card" style={{ background: colors.surface, borderColor: colors.border }}>
            <span className="theme-preview-dot" style={{ background: accent }} />
          </span>
        </span>
      </span>
      <span className="theme-card-name">
        {on && <Check size={12} aria-hidden="true" />}
        {name}
      </span>
    </button>
  )
}

function ThemeEditor({ appearance, theme }: { appearance: Appearance; theme: CustomTheme }) {
  const save = useSettings((state) => state.save)
  const [draft, setDraft] = useState(theme)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<CustomTheme | null>(null)

  const withTheme = (next: CustomTheme): Appearance => {
    const current = latest(appearance)
    return { ...current, themes: current.themes.map((candidate) => (candidate.id === next.id ? next : candidate)) }
  }
  const flush = () => {
    clearTimeout(timer.current)
    if (pending.current) void save({ appearance: withTheme(pending.current) })
    pending.current = null
  }
  useEffect(() => flush, [])

  /** Shown at once, kept once the colours stop changing. */
  const change = (next: CustomTheme) => {
    setDraft(next)
    applyAppearance(withTheme(next))
    pending.current = next
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, KEEP_AFTER_MS)
  }
  const setColor = (key: ThemeColor, value: string) => change({ ...draft, colors: { ...draft.colors, [key]: value.toLowerCase() } })

  const remove = async () => {
    const confirmed = await useUi.getState().askConfirm({ title: `Delete ${draft.name}?`, body: 'eNCode goes back to its own colours. Export the theme first to keep a copy.', confirmLabel: 'Delete the theme', danger: true })
    if (!confirmed) return
    clearTimeout(timer.current)
    pending.current = null
    const current = latest(appearance)
    void save({ appearance: { ...current, theme: '', themes: current.themes.filter((candidate) => candidate.id !== draft.id) } })
  }

  const duplicate = () => {
    flush()
    const current = latest(appearance)
    if (current.themes.length >= MAX_THEMES) return notify('error', `You can keep ${MAX_THEMES} themes; remove one first.`)
    const copy = { ...draft, id: themeId(), name: freeName(current.themes, `${draft.name} copy`) }
    void save({ appearance: { ...current, themes: [...current.themes, copy], theme: copy.id } })
  }

  const exportTheme = async () => {
    flush()
    try {
      const file = await api.settings.exportTheme(draft)
      if (file) notify('success', `Saved ${draft.name} to ${file}.`)
    } catch (error) {
      notify('error', errorText(error))
    }
  }

  const reset = () => change({ ...draft, colors: { ...BUILT_IN_COLORS[draft.base] } })
  const problems = contrastProblems(draft)

  return (
    <div className="settings-row settings-row-block theme-editor" data-setting="appearance.themeEditor">
      <div className="theme-editor-head">
        <input
          className="text-input theme-name"
          aria-label="Theme name"
          value={draft.name}
          maxLength={40}
          spellCheck={false}
          onChange={(event) => change({ ...draft, name: event.target.value })}
          onBlur={() => !draft.name.trim() && change({ ...draft, name: 'My theme' })}
        />
        <span className="theme-base">Built on the {draft.base} theme</span>
        <span className="settings-actions">
          <IconButton label="Start again from the built-in colours" size="sm" onClick={reset}>
            <RotateCw size={14} />
          </IconButton>
          <IconButton label="Duplicate" size="sm" onClick={duplicate}>
            <Copy size={14} />
          </IconButton>
          <IconButton label="Delete…" size="sm" onClick={() => void remove()}>
            <Trash2 size={14} />
          </IconButton>
        </span>
      </div>
      {problems.length > 0 && (
        <div className="theme-problems" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            Hard to read: {problems.map((problem) => `${problem.label.toLowerCase()} (${problem.ratio.toFixed(1)}:1)`).join(', ')}. Text reads well from 4.5:1.
          </span>
        </div>
      )}
      {GROUPS.map((group) => (
        <div key={group} className="theme-group">
          <div className="theme-group-title">{group}</div>
          <div className="theme-colors">
            {THEME_COLORS.filter((color) => color.group === group).map((color) => (
              <ColorField key={color.key} label={color.label} hint={color.hint} value={draft.colors[color.key]} onChange={(value) => setColor(color.key, value)} />
            ))}
          </div>
        </div>
      ))}
      <div className="theme-foot">
        <Button size="sm" variant="ghost" icon={<FileUp size={13} />} onClick={() => void exportTheme()}>
          Export to a file…
        </Button>
      </div>
    </div>
  )
}

/** A colour: the system's picker on the swatch, and its #rrggbb to type or paste. */
function ColorField({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (value: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => {
    const typed = text.trim().replace(/^([0-9a-f]{6})$/i, '#$1')
    if (/^#[0-9a-f]{6}$/i.test(typed)) onChange(typed)
    else setText(value)
  }
  return (
    <label className="theme-color" title={hint}>
      <input type="color" className="theme-swatch" value={value} aria-label={label} onChange={(event) => onChange(event.target.value)} />
      <span className="theme-color-label">{label}</span>
      <input
        className="text-input theme-hex"
        value={text}
        aria-label={`${label}, as #rrggbb`}
        spellCheck={false}
        maxLength={7}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
      />
    </label>
  )
}

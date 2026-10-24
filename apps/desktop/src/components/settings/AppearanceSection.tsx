import { useMemo, useRef, type KeyboardEvent } from 'react'
import {
  activeTheme,
  CODE_SIZES,
  FONT_ENCODE,
  FONT_SYSTEM,
  UI_SIZES,
  type Accent,
  type Appearance,
  type Contrast,
  type Density,
  type Motion,
  type ThemeMode,
} from '@shared/appearance'
import type { Settings } from '@shared/types'
import { useInstalledFonts } from '../../hooks/useInstalledFonts'
import { useSettings } from '../../stores/settings'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Monitor, Moon, Sun } from '../../ui/icons'
import { keyToMove, moveIndex } from '../../ui/nav'
import { Segmented, type SegmentedOption } from '../../ui/Segmented'
import { Select, type SelectOption } from '../../ui/Select'
import { SettingRow, SettingsGroup } from './Section'
import { ThemeSettings } from './ThemeSettings'

const MODES: SegmentedOption<ThemeMode>[] = [
  { value: 'system', label: 'System', icon: <Monitor size={14} /> },
  { value: 'light', label: 'Light', icon: <Sun size={14} /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={14} /> },
]

const ACCENT_OPTIONS: { value: Accent; label: string }[] = [
  { value: 'blue', label: 'Signal blue' },
  { value: 'cyan', label: 'Cyan' },
  { value: 'jade', label: 'Jade' },
  { value: 'amber', label: 'Amber' },
]

const CONTRASTS: SegmentedOption<Contrast>[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'high', label: 'High' },
]

const DENSITIES: SegmentedOption<Density>[] = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
]

const MOTIONS: SegmentedOption<Motion>[] = [
  { value: 'system', label: 'System' },
  { value: 'reduce', label: 'On' },
  { value: 'full', label: 'Off' },
]

const sizeOptions = (sizes: readonly number[]): SelectOption<string>[] => sizes.map((size) => ({ value: String(size), label: `${size} px` }))

/** The built-in choices, then every installed font; a font that is chosen but not in the list stays selectable. */
function fontOptions(builtIn: SelectOption<string>[], installed: readonly string[], chosen: string): SelectOption<string>[] {
  const named = installed.includes(chosen) || chosen === FONT_SYSTEM || chosen === FONT_ENCODE ? installed : [chosen, ...installed]
  return [...builtIn, ...named.map((family) => ({ value: family, label: family }))]
}

/** The accent as colour swatches: a radio group, so arrow keys move between them. */
function AccentPicker({ value, disabled, onChange }: { value: Accent; disabled?: boolean; onChange: (accent: Accent) => void }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = ACCENT_OPTIONS.findIndex((option) => option.value === value)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = keyToMove(event.key, 'horizontal') ?? keyToMove(event.key, 'vertical')
    if (!move) return
    event.preventDefault()
    const next = moveIndex(selected, move, ACCENT_OPTIONS.length)
    onChange(ACCENT_OPTIONS[next].value)
    buttons.current[next]?.focus()
  }
  return (
    <div className="accent-swatches" role="radiogroup" aria-label="Accent" aria-disabled={disabled || undefined} onKeyDown={disabled ? undefined : onKeyDown}>
      {ACCENT_OPTIONS.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => {
            buttons.current[index] = node
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={option.label}
          title={option.label}
          tabIndex={option.value === value ? 0 : -1}
          disabled={disabled}
          className={cx('accent-swatch', `accent-${option.value}`, option.value === value && 'is-on')}
          onClick={() => onChange(option.value)}
        />
      ))}
    </div>
  )
}

/** Settings > Appearance: each change shows and is kept at once. */
export function AppearanceSection({ settings }: { settings: Settings }) {
  const value = settings.appearance
  const save = useSettings((state) => state.save)
  // From the store, not this render: two changes in a row (arrow keys over the swatches) each build on the last.
  const set = <K extends keyof Appearance>(key: K, next: Appearance[K]) =>
    void save({ appearance: { ...(useSettings.getState().settings?.appearance ?? value), [key]: next } })
  const installed = useInstalledFonts()
  // A theme of your own sets light or dark and the accent itself.
  const custom = activeTheme(value)
  const modes = useMemo(() => MODES.map((mode) => ({ ...mode, disabled: Boolean(custom) })), [custom])
  const uiFonts = useMemo(
    () =>
      fontOptions(
        [
          { value: FONT_SYSTEM, label: 'System' },
          { value: FONT_ENCODE, label: 'eNCode (Inter)' },
        ],
        installed.fonts,
        value.uiFont,
      ),
    [installed.fonts, value.uiFont],
  )
  const codeFonts = useMemo(
    () =>
      fontOptions(
        [
          { value: FONT_SYSTEM, label: 'System (Consolas)' },
          { value: FONT_ENCODE, label: 'eNCode (JetBrains Mono)' },
        ],
        installed.fonts,
        value.codeFont,
      ),
    [installed.fonts, value.codeFont],
  )
  return (
    <>
      <SettingsGroup title="Theme">
        <SettingRow id="appearance.theme" label="Mode" help={custom ? `${custom.name} is ${custom.base}.` : "System follows Windows' light or dark setting."}>
          <Segmented label="Mode" value={custom ? custom.base : value.mode} options={modes} onChange={(mode) => set('mode', mode)} />
        </SettingRow>
        <SettingRow id="appearance.accent" label="Accent" help={custom ? `${custom.name} has its own accent; change it below.` : 'Links, focus rings, selection and the Send button.'}>
          <AccentPicker value={value.accent} disabled={Boolean(custom)} onChange={(accent) => set('accent', accent)} />
        </SettingRow>
        <SettingRow id="appearance.contrast" label="Contrast" help="High makes secondary text and borders stronger.">
          <Segmented label="Contrast" value={value.contrast} options={CONTRASTS} onChange={(contrast) => set('contrast', contrast)} />
        </SettingRow>
        <ThemeSettings appearance={value} />
      </SettingsGroup>

      <SettingsGroup title="Fonts">
        <SettingRow id="appearance.uiFont" label="Interface font" help="System is Windows' own font. eNCode is Inter.">
          <Select label="Interface font" value={value.uiFont} options={uiFonts} onChange={(font) => set('uiFont', font)} />
        </SettingRow>
        <SettingRow id="appearance.uiSize" label="Interface size" help="Text in the thread, the sidebar and menus; smaller text follows it. 14 is the default.">
          <Select label="Interface size" value={String(value.uiSize)} options={sizeOptions(UI_SIZES)} onChange={(size) => set('uiSize', Number(size))} />
        </SettingRow>
        <SettingRow id="appearance.codeFont" label="Code font" help="System is Consolas. eNCode is JetBrains Mono.">
          <Select label="Code font" value={value.codeFont} options={codeFonts} onChange={(font) => set('codeFont', font)} />
        </SettingRow>
        <SettingRow id="appearance.codeSize" label="Code size" help="Code in replies, diffs and tool output. 12 is the default.">
          <Select label="Code size" value={String(value.codeSize)} options={sizeOptions(CODE_SIZES)} onChange={(size) => set('codeSize', Number(size))} />
        </SettingRow>
        {installed.failed && (
          <SettingRow label="Installed fonts" help="Windows did not list them yet. Try again to choose any font on this PC.">
            <Button size="sm" onClick={installed.retry}>
              List installed fonts
            </Button>
          </SettingRow>
        )}
      </SettingsGroup>

      <SettingsGroup title="Layout and motion">
        <SettingRow id="appearance.density" label="Density" help="Compact fits more rows in lists and menus.">
          <Segmented label="Density" value={value.density} options={DENSITIES} onChange={(density) => set('density', density)} />
        </SettingRow>
        <SettingRow id="appearance.motion" label="Reduce motion" help="On replaces animation with instant changes. System follows Windows.">
          <Segmented label="Reduce motion" value={value.motion} options={MOTIONS} onChange={(motion) => set('motion', motion)} />
        </SettingRow>
      </SettingsGroup>
    </>
  )
}

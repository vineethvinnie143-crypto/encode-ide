import { useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import {
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
import { useInstalledFonts } from '../hooks/useInstalledFonts'
import { Button } from '../ui/Button'
import { cx } from '../ui/cx'
import { Monitor, Moon, Sun } from '../ui/icons'
import { keyToMove, moveIndex } from '../ui/nav'
import { Segmented, type SegmentedOption } from '../ui/Segmented'
import { Select, type SelectOption } from '../ui/Select'

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

function Row({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        <div className="settings-row-help">{help}</div>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

/** The accent as colour swatches: a radio group, so arrow keys move between them. */
function AccentPicker({ value, onChange }: { value: Accent; onChange: (accent: Accent) => void }) {
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
    <div className="accent-swatches" role="radiogroup" aria-label="Accent" onKeyDown={onKeyDown}>
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
          className={cx('accent-swatch', `accent-${option.value}`, option.value === value && 'is-on')}
          onClick={() => onChange(option.value)}
        />
      ))}
    </div>
  )
}

/** Settings › Appearance. Changes preview at once; Save keeps them, Cancel puts the old look back. */
export default function AppearanceSettings({
  value,
  onChange,
}: {
  value: Appearance
  onChange: (appearance: Appearance) => void
}) {
  const set = <K extends keyof Appearance>(key: K, next: Appearance[K]) => onChange({ ...value, [key]: next })
  const installed = useInstalledFonts()
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
    <div className="settings-appearance">
      <div className="section-title">Theme</div>
      <div className="settings-card">
        <Row label="Mode" help="System follows Windows' light or dark setting.">
          <Segmented label="Mode" value={value.mode} options={MODES} onChange={(mode) => set('mode', mode)} />
        </Row>
        <Row label="Accent" help="Links, focus rings, selection and the Send button.">
          <AccentPicker value={value.accent} onChange={(accent) => set('accent', accent)} />
        </Row>
        <Row label="Contrast" help="High makes secondary text and borders stronger.">
          <Segmented
            label="Contrast"
            value={value.contrast}
            options={CONTRASTS}
            onChange={(contrast) => set('contrast', contrast)}
          />
        </Row>
      </div>

      <div className="section-title">Fonts</div>
      <div className="settings-card">
        <Row label="Interface font" help="System is Windows' own font, the same as Codex. eNCode is Inter.">
          <Select label="Interface font" value={value.uiFont} options={uiFonts} onChange={(font) => set('uiFont', font)} />
        </Row>
        <Row label="Interface size" help="The size of text in the thread, the sidebar and menus; smaller text follows it. Codex uses 14.">
          <Select
            label="Interface size"
            value={String(value.uiSize)}
            options={sizeOptions(UI_SIZES)}
            onChange={(size) => set('uiSize', Number(size))}
          />
        </Row>
        <Row label="Code font" help="System is Consolas, the same as Codex. eNCode is JetBrains Mono.">
          <Select label="Code font" value={value.codeFont} options={codeFonts} onChange={(font) => set('codeFont', font)} />
        </Row>
        <Row label="Code size" help="Code in replies, diffs and tool output. Codex uses 12.">
          <Select
            label="Code size"
            value={String(value.codeSize)}
            options={sizeOptions(CODE_SIZES)}
            onChange={(size) => set('codeSize', Number(size))}
          />
        </Row>
        {installed.failed && (
          <Row label="Installed fonts" help="Windows did not list them yet. Try again to choose any font on this PC.">
            <Button size="sm" onClick={installed.retry}>
              List installed fonts
            </Button>
          </Row>
        )}
      </div>

      <div className="section-title">Layout and motion</div>
      <div className="settings-card">
        <Row label="Density" help="Compact fits more rows in lists and menus.">
          <Segmented
            label="Density"
            value={value.density}
            options={DENSITIES}
            onChange={(density) => set('density', density)}
          />
        </Row>
        <Row label="Reduce motion" help="On replaces animation with instant changes. System follows Windows.">
          <Segmented label="Reduce motion" value={value.motion} options={MOTIONS} onChange={(motion) => set('motion', motion)} />
        </Row>
      </div>
    </div>
  )
}

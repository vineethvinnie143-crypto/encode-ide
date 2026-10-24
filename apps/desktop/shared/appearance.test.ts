import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { newTheme } from './themes'
import {
  CAPTION_SYMBOL,
  DEFAULT_APPEARANCE,
  FONT_ENCODE,
  FONT_SYSTEM,
  appearanceFromParams,
  appearanceParams,
  codeFontStack,
  fontVariables,
  normalizeAppearance,
  normalizeFont,
  normalizeSize,
  resolveTheme,
  sameAppearance,
  uiFontStack,
  WINDOW_BACKGROUND,
  WINDOW_BORDER,
  type Appearance,
} from './appearance'

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('appearance', () => {
  it('resolves System from the operating system, and Light and Dark as themselves', () => {
    assert.equal(resolveTheme('system', true), 'dark')
    assert.equal(resolveTheme('system', false), 'light')
    assert.equal(resolveTheme('light', true), 'light')
    assert.equal(resolveTheme('dark', false), 'dark')
  })

  it('normalizes field by field against a base', () => {
    const base: Appearance = {
      mode: 'light',
      accent: 'amber',
      contrast: 'high',
      density: 'compact',
      motion: 'reduce',
      uiFont: FONT_ENCODE,
      codeFont: 'Cascadia Code',
      uiSize: 15,
      codeSize: 13,
      theme: '',
      themes: [],
    }
    assert.deepEqual(normalizeAppearance({ accent: 'cyan', motion: 'sideways' }, base), { ...base, accent: 'cyan' })
    assert.deepEqual(normalizeAppearance(undefined), DEFAULT_APPEARANCE)
    assert.deepEqual(normalizeAppearance('dark'), DEFAULT_APPEARANCE)
    assert.deepEqual(normalizeAppearance([]), DEFAULT_APPEARANCE)
  })

  it('never lets a value through that is not one of its choices', () => {
    const tricky = { mode: 'dark;color:red', accent: '__proto__', contrast: 'toString', density: 'constructor' }
    assert.deepEqual(normalizeAppearance(tricky), DEFAULT_APPEARANCE)
  })

  it('round-trips through page URL parameters', () => {
    const appearance: Appearance = {
      mode: 'system',
      accent: 'jade',
      contrast: 'high',
      density: 'compact',
      motion: 'full',
      uiFont: 'Segoe UI Variable',
      codeFont: FONT_ENCODE,
      uiSize: 16,
      codeSize: 11,
      theme: '',
      themes: [],
    }
    const params = new URLSearchParams(appearanceParams(appearance))
    assert.deepEqual(appearanceFromParams(params), appearance)
    // A theme of the person's own goes with it, and only the one in use.
    const mine = newTheme('theme-night', 'Night', 'dark', '#ff7a90')
    const themed = { ...appearance, theme: 'theme-night', themes: [newTheme('theme-day', 'Day', 'light'), mine] }
    assert.deepEqual(appearanceFromParams(new URLSearchParams(appearanceParams(themed))), { ...appearance, theme: 'theme-night', themes: [mine] })
    assert.deepEqual(appearanceFromParams(new URLSearchParams('theme=theme-night&themes=%5Bnot%20json')), DEFAULT_APPEARANCE, 'a broken theme is no theme')
    assert.deepEqual(appearanceFromParams(new URLSearchParams('mode=light&accent=pink')), {
      ...DEFAULT_APPEARANCE,
      mode: 'light',
    })
  })

  it('compares every field', () => {
    assert.equal(sameAppearance(DEFAULT_APPEARANCE, { ...DEFAULT_APPEARANCE }), true)
    for (const key of Object.keys(DEFAULT_APPEARANCE) as (keyof Appearance)[]) {
      const changed = { ...DEFAULT_APPEARANCE, [key]: 'other' } as Appearance
      assert.equal(sameAppearance(DEFAULT_APPEARANCE, changed), false, key)
    }
  })
})

describe('fonts', () => {
  it('defaults to Windows\' own fonts at Codex\'s sizes', () => {
    assert.equal(DEFAULT_APPEARANCE.uiFont, FONT_SYSTEM)
    assert.equal(DEFAULT_APPEARANCE.codeFont, FONT_SYSTEM)
    assert.equal(DEFAULT_APPEARANCE.uiSize, 14)
    assert.equal(DEFAULT_APPEARANCE.codeSize, 12)
  })

  it('takes the built-in choices and plausible family names, and nothing else', () => {
    assert.equal(normalizeFont(FONT_ENCODE, FONT_SYSTEM), FONT_ENCODE)
    assert.equal(normalizeFont('  Segoe UI Variable  ', FONT_SYSTEM), 'Segoe UI Variable')
    assert.equal(normalizeFont('Noto Sans CJK JP', FONT_SYSTEM), 'Noto Sans CJK JP')
    assert.equal(normalizeFont("Source Code Pro (Black)", FONT_SYSTEM), 'Source Code Pro (Black)')
    assert.equal(normalizeFont('Calibri Light & Co. 2', FONT_SYSTEM), 'Calibri Light & Co. 2')
    assert.equal(normalizeFont('Ubuntu Mono 日本語', FONT_SYSTEM), 'Ubuntu Mono 日本語')
    assert.equal(normalizeFont('System', FONT_ENCODE), 'System', 'the word System names a font; the built-in choices are not words')
    for (const bad of ['', '   ', 'x'.repeat(65), 'Arial"; } body { display: none', 'a\\b', 'a\nb', 'url(x)\\', '@evil', '<b>', 7, null, {}]) {
      assert.equal(normalizeFont(bad, 'Arial'), 'Arial', String(bad))
    }
  })

  it('takes whole sizes in range, as a number or as the text of one', () => {
    assert.equal(normalizeSize(15, [12, 13, 14, 15, 16], 14), 15)
    assert.equal(normalizeSize('13', [12, 13, 14, 15, 16], 14), 13)
    for (const bad of [11, 17, 14.5, '14.5', '', 'big', NaN, Infinity, null, undefined, [], '1e1']) {
      assert.equal(normalizeSize(bad, [12, 13, 14, 15, 16], 14), 14, String(bad))
    }
  })

  it('repairs fonts and sizes field by field', () => {
    const fixed = normalizeAppearance({ uiFont: 'bad;font', codeFont: FONT_ENCODE, uiSize: 99, codeSize: 13 })
    assert.equal(fixed.uiFont, FONT_SYSTEM)
    assert.equal(fixed.codeFont, FONT_ENCODE)
    assert.equal(fixed.uiSize, 14)
    assert.equal(fixed.codeSize, 13)
  })

  it('builds font lists that fall back to Windows\' fonts, with the family quoted', () => {
    assert.equal(uiFontStack(FONT_SYSTEM), "system-ui, 'Segoe UI', sans-serif")
    assert.ok(uiFontStack(FONT_ENCODE).startsWith("'Inter', system-ui"))
    assert.ok(uiFontStack('Segoe UI Variable').startsWith('"Segoe UI Variable", system-ui'))
    assert.ok(codeFontStack(FONT_SYSTEM).startsWith('Consolas,'))
    assert.ok(codeFontStack(FONT_ENCODE).startsWith("'JetBrains Mono', Consolas"))
    assert.ok(codeFontStack('Cascadia Code').startsWith('"Cascadia Code", Consolas'))
    assert.ok(codeFontStack('anything').endsWith('monospace'))
  })

  it('moves every size with the base size, and small text one pixel more in Windows\' font', () => {
    const system = fontVariables(DEFAULT_APPEARANCE)
    assert.equal(system['--ui-delta'], '0px')
    assert.equal(system['--ui-small'], '1px')
    assert.equal(system['--code-size'], '12px')
    const inter = fontVariables({ ...DEFAULT_APPEARANCE, uiFont: FONT_ENCODE, uiSize: 15, codeSize: 13 })
    assert.equal(inter['--ui-delta'], '1px')
    assert.equal(inter['--ui-small'], '1px', 'Inter gets the size change only')
    assert.equal(inter['--code-size'], '13px')
    const large = fontVariables({ ...DEFAULT_APPEARANCE, uiSize: 16 })
    assert.equal(large['--ui-delta'], '2px')
    assert.equal(large['--ui-small'], '3px')
    const custom = fontVariables({ ...DEFAULT_APPEARANCE, uiFont: 'Calibri', uiSize: 12 })
    assert.equal(custom['--ui-small'], '-2px', 'a font picked by name gets the size change only')
  })

  it('paints the window border in the chrome colour of each theme, so no accent line shows around the window', () => {
    const tokens = readFileSync('apps/desktop/src/theme/tokens.css', 'utf8')
    const chrome = (selector: string) => new RegExp(`${selector}\\s*\\{[^}]*--chrome:\\s*(#[0-9a-f]{6})`, 'i').exec(tokens)?.[1]
    for (const [theme, selector] of [['dark', ':root'], ['light', ":root\\[data-theme='light'\\]"]] as const) {
      assert.equal(WINDOW_BORDER[theme], chrome(selector)?.toLowerCase(), `${theme}: the border is the --chrome of tokens.css`)
      assert.equal(WINDOW_BORDER[theme], WINDOW_BACKGROUND[theme])
    }
  })

  it('draws the native window buttons in colours that read on the title bar', () => {
    for (const theme of ['dark', 'light'] as const) {
      assert.match(WINDOW_BACKGROUND[theme], /^#[0-9a-f]{6}$/)
      assert.match(CAPTION_SYMBOL[theme], /^#[0-9a-f]{6}$/)
      assert.ok(contrast(CAPTION_SYMBOL[theme], WINDOW_BACKGROUND[theme]) >= 7, `${theme}: the glyphs need 7:1 on the title bar`)
    }
  })
})

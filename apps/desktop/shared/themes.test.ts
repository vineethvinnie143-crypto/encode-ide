import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { ACCENT_COLORS, BUILT_IN_COLORS, MAX_THEMES, contrastProblems, contrastRatio, mix, newTheme, normalizeTheme, normalizeThemes, themeFile, themeFromFile, themeVariables, type ThemeColor } from './themes'

const tokens = readFileSync('apps/desktop/src/theme/tokens.css', 'utf8')
/** The value of a variable in the first block of tokens.css that `selector` opens. */
const token = (selector: string, name: string) => {
  const block = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(tokens)?.[1] ?? ''
  return new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(block)?.[1]?.toLowerCase()
}
const SELECTOR = { dark: ':root', light: ":root\\[data-theme='light'\\]" } as const
const VARIABLE: Record<ThemeColor, string> = {
  chrome: '--chrome',
  sidebar: '--sidebar',
  canvas: '--canvas',
  surface: '--surface-1',
  border: '--border',
  text: '--text-1',
  accent: '--accent',
  success: '--success',
  warning: '--warning',
  danger: '--danger',
  bubble: '--bubble',
  keyword: '--syn-keyword',
  function: '--syn-fn',
  string: '--syn-string',
  number: '--syn-number',
  type: '--syn-type',
  comment: '--syn-comment',
}

/** How far apart two colours are, the largest difference of a channel. */
const distance = (a: string, b: string) => Math.max(...[1, 3, 5].map((at) => Math.abs(Number.parseInt(a.slice(at, at + 2), 16) - Number.parseInt(b.slice(at, at + 2), 16))))

describe('colour themes of your own', () => {
  it('start from the built-in themes as tokens.css has them, accents included', () => {
    for (const base of ['dark', 'light'] as const) {
      for (const [key, name] of Object.entries(VARIABLE) as [ThemeColor, string][]) assert.equal(BUILT_IN_COLORS[base][key], token(SELECTOR[base], name), `${base} ${key}`)
      assert.equal(ACCENT_COLORS[base].mono, token(SELECTOR[base], '--accent'), `${base} mono`)
      for (const accent of ['blue', 'cyan', 'jade', 'amber'] as const) {
        const selector = base === 'dark' ? `:root\\[data-accent='${accent}'\\]` : `:root\\[data-theme='light'\\]\\[data-accent='${accent}'\\]`
        assert.equal(ACCENT_COLORS[base][accent], token(selector, '--accent'), `${base} ${accent}`)
      }
    }
  })

  it('work out the steps between their colours at the built-in theme’s distances', () => {
    for (const base of ['dark', 'light'] as const) {
      const vars = themeVariables(newTheme('theme-same', 'Same', base))
      for (const name of ['--border-subtle', '--border-strong']) assert.ok(distance(vars[name]!, token(SELECTOR[base], name)!) <= 6, `${base} ${name}: ${vars[name]} for ${token(SELECTOR[base], name)}`)
      // The built-in text steps are tinted; what must match is how they read on the background.
      for (const name of ['--text-2', '--text-3', '--text-disabled']) {
        const [mine, builtIn] = [contrastRatio(vars[name]!, vars['--canvas']!), contrastRatio(token(SELECTOR[base], name)!, vars['--canvas']!)]
        assert.ok(Math.abs(mine - builtIn) / builtIn < 0.1, `${base} ${name}: ${mine.toFixed(2)}:1 for ${builtIn.toFixed(2)}:1`)
      }
      if (base === 'dark') for (const name of ['--surface-2', '--surface-3']) assert.ok(distance(vars[name]!, token(SELECTOR.dark, name)!) <= 6, name)
      assert.deepEqual(contrastProblems(newTheme('theme-same', 'Same', base)), [], `${base}: the built-in colours read well`)
    }
  })

  it('give buttons a fill white text reads on, whatever the accent', () => {
    for (const accent of ['#f7be5c', '#ffff00', '#4edba0', '#2f5fe0']) {
      const vars = themeVariables(newTheme('theme-a', 'A', 'dark', accent))
      assert.equal(vars['--on-accent'], '#ffffff', accent)
      assert.ok(contrastRatio('#ffffff', vars['--accent-fill']!) >= 4.5, `${accent} -> ${vars['--accent-fill']}`)
    }
  })

  it('fill a silver accent toward white under black text, as the Mono buttons are, and a black one under white', () => {
    const silver = themeVariables(newTheme('theme-s', 'S', 'dark', '#d4d4d4'))
    assert.equal(silver['--on-accent'], '#0a0a0a')
    assert.ok(distance(silver['--accent-fill']!, token(SELECTOR.dark, '--accent-fill')!) <= 6, `${silver['--accent-fill']} for the built-in fill`)
    assert.ok(contrastRatio(silver['--on-accent']!, silver['--accent-fill']!) >= 4.5)
    const ink = themeVariables(newTheme('theme-k', 'K', 'light', '#111111'))
    assert.equal(ink['--on-accent'], '#ffffff')
    assert.equal(ink['--accent-fill'], '#111111')
    // A grey too dark for black text and with no hue is darkened for white text, as a colour is.
    const grey = themeVariables(newTheme('theme-g', 'G', 'dark', '#7a7a7a'))
    assert.equal(grey['--on-accent'], '#ffffff')
    assert.ok(contrastRatio('#ffffff', grey['--accent-fill']!) >= 4.5)
  })

  it('say what reads poorly', () => {
    const grey = newTheme('theme-grey', 'Grey', 'dark')
    grey.colors.text = '#2a2a2a'
    const problems = contrastProblems(grey).map((problem) => problem.label)
    assert.ok(problems.includes('Text on the background'), problems.join(', '))
  })

  it('take only a good id and base, mend bad colours from the base, and clean the name', () => {
    assert.equal(normalizeTheme({ id: 'mine', base: 'dark' }), null, 'an id must start with theme-')
    assert.equal(normalizeTheme({ id: 'theme-a', base: 'sepia' }), null)
    const mended = normalizeTheme({ id: 'theme-a', base: 'light', name: `  Sun\u202e set\u200b  `, colors: { canvas: '#FAFAFA', text: 'red', accent: '#12345', keyword: 'url(x)' } })!
    assert.equal(mended.name, 'Sun set', 'direction and zero-width characters are dropped')
    assert.equal(mended.colors.canvas, '#fafafa')
    assert.equal(mended.colors.text, BUILT_IN_COLORS.light.text)
    assert.equal(mended.colors.accent, BUILT_IN_COLORS.light.accent)
    assert.equal(mended.colors.keyword, BUILT_IN_COLORS.light.keyword)
    assert.equal(normalizeTheme({ id: 'theme-b', base: 'dark', name: '' })!.name, 'My theme')
    const many = Array.from({ length: MAX_THEMES + 3 }, (_, index) => newTheme(`theme-${index % (MAX_THEMES + 1)}`, 'x', 'dark'))
    assert.equal(normalizeThemes(many).length, MAX_THEMES)
    assert.deepEqual(normalizeThemes([newTheme('theme-a', 'A', 'dark'), newTheme('theme-a', 'B', 'dark')]).map((theme) => theme.name), ['A'], 'an id once')
    assert.deepEqual(normalizeThemes('nope'), [])
  })

  it('go to a file and come back under a new id, and refuse what is not a theme', () => {
    const night = newTheme('theme-night', 'Night shift', 'dark', '#ff7a90')
    const back = themeFromFile(themeFile(night), 'theme-copy')
    assert.deepEqual(back, { ...night, id: 'theme-copy' })
    assert.equal(JSON.parse(themeFile(night)).id, undefined, 'a file carries no id')
    assert.throws(() => themeFromFile('{', 'theme-x'), /not JSON/)
    assert.throws(() => themeFromFile('{"name":"x"}', 'theme-x'), /not an eNCode theme/)
    assert.throws(() => themeFromFile('{"eNCodeTheme":1,"base":"blue"}', 'theme-x'), /neither light nor dark/)
  })

  it('mixes colours on the way from one to the other', () => {
    assert.equal(mix('#000000', '#ffffff', 0.5), '#808080')
    assert.equal(mix('#102030', '#102030', 0.7), '#102030')
    assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21)
  })
})

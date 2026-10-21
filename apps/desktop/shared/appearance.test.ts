import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_APPEARANCE,
  appearanceFromParams,
  appearanceParams,
  normalizeAppearance,
  resolveTheme,
  sameAppearance,
  type Appearance,
} from './appearance'

describe('appearance', () => {
  it('resolves System from the operating system, and Light and Dark as themselves', () => {
    assert.equal(resolveTheme('system', true), 'dark')
    assert.equal(resolveTheme('system', false), 'light')
    assert.equal(resolveTheme('light', true), 'light')
    assert.equal(resolveTheme('dark', false), 'dark')
  })

  it('normalizes field by field against a base', () => {
    const base: Appearance = { mode: 'light', accent: 'amber', contrast: 'high', density: 'compact', motion: 'reduce' }
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
    const appearance: Appearance = { mode: 'system', accent: 'jade', contrast: 'high', density: 'compact', motion: 'full' }
    const params = new URLSearchParams(appearanceParams(appearance))
    assert.deepEqual(appearanceFromParams(params), appearance)
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

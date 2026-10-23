import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { flatten, itemScore, matchScore, normalize, rankPalette, remember, RECENT_KEPT, SESSIONS_FOUND, SESSIONS_SHOWN, type PaletteItem } from './model'

const action = (id: string, title: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({ id: `command:${id}`, group: 'Actions', title, ...extra })
const session = (index: number, title = `Session ${index}`): PaletteItem => ({ id: `session:${index}`, group: 'Sessions', title, detail: 'demo' })
const page = (id: string, title: string, keywords?: string): PaletteItem => ({ id: `settings:${id}`, group: 'Settings', title, ...(keywords ? { keywords } : {}) })

describe('how well a query finds a title', () => {
  it('ranks the whole title, then its start, a word start, the inside of a word, then letters in order', () => {
    const whole = matchScore('new session', 'New session')
    const start = matchScore('new', 'New session')
    const word = matchScore('session', 'New session')
    const inside = matchScore('ess', 'New session')
    const letters = matchScore('ns', 'New session')
    assert.equal(whole, 1000)
    assert.ok(whole > start && start > word && word > inside && inside > letters && letters > 0, JSON.stringify({ whole, start, word, inside, letters }))
    assert.equal(matchScore('xyz', 'New session'), -1)
    assert.equal(matchScore('nsx', 'New session'), -1)
  })

  it('prefers letters that start words, camelCase included', () => {
    assert.ok(matchScore('ts', 'Toggle sidebar') > matchScore('ts', 'Settings'))
    assert.ok(matchScore('rt', 'reviewTurn') > matchScore('rt', 'rebuilt'))
    assert.ok(matchScore('gtf', 'Go to file…') > matchScore('gtf', 'Gift'))
  })

  it('finds every word of a query in any order, and nothing when one word is missing', () => {
    assert.ok(matchScore('session new', 'New session') > 0)
    assert.equal(matchScore('session zebra', 'New session'), -1)
  })

  it('ignores case, accents and repeated spaces', () => {
    assert.equal(normalize('  Café   Crème '), 'cafe creme')
    assert.equal(matchScore('CAFE', 'café'), 1000)
    assert.equal(matchScore('', 'anything'), 0)
  })

  it('counts keywords below the title and the detail below both', () => {
    const appearance = page('appearance', 'Appearance', 'theme dark light font')
    assert.ok(itemScore(appearance, 'theme') > 0)
    assert.ok(itemScore(appearance, 'appear') > itemScore(appearance, 'theme'))
    const chat = session(1, 'Fix the login bug')
    assert.ok(itemScore(chat, 'demo') > 0, 'the project finds its sessions')
    assert.ok(itemScore(chat, 'login') > itemScore(chat, 'demo'))
  })
})

describe('the palette list', () => {
  const sessions = Array.from({ length: 14 }, (_, index) => session(index + 1))
  const actions = [action('file.newSession', 'New session', { shortcut: 'Ctrl+N' }), action('view.sidebar', 'Toggle sidebar'), action('app.settings', 'Settings…')]
  const pages = [page('models', 'Models', 'providers keys'), page('appearance', 'Appearance', 'theme dark light')]
  const awake = { ...page('general.keepAwake', 'Keep the computer awake while the agent works', 'sleep power'), searchOnly: true }
  const items = [...sessions, ...actions, ...pages, awake]

  it('shows recent picks, the latest sessions, then every action and settings page before anything is typed', () => {
    const sections = rankPalette(items, '', ['command:view.sidebar', 'session:3', 'gone:1'])
    assert.deepEqual(
      sections.map((section) => [section.group, section.items.length]),
      [
        ['Recent', 2],
        ['Sessions', SESSIONS_SHOWN],
        ['Actions', actions.length - 1],
        ['Settings', pages.length],
      ],
    )
    assert.deepEqual(
      sections[0].items.map((item) => item.id),
      ['command:view.sidebar', 'session:3'],
    )
    const ids = flatten(sections).map((item) => item.id)
    assert.equal(new Set(ids).size, ids.length, 'a recent pick is not listed twice')
    assert.equal(ids.includes('session:3'), true)
    assert.equal(ids.includes(awake.id), false, 'a single setting waits for a query')
  })

  it('finds a single setting by its words once something is typed', () => {
    assert.equal(flatten(rankPalette(items, 'sleep', []))[0].id, awake.id)
    assert.equal(flatten(rankPalette(items, 'keep awake', []))[0].id, awake.id)
  })

  it('lists matches best first, in sections ordered by their best match', () => {
    const sections = rankPalette(items, 'appear', [])
    assert.equal(sections[0].group, 'Settings')
    assert.equal(sections[0].items[0].id, 'settings:appearance')
    const found = rankPalette(items, 'new session', [])
    assert.equal(flatten(found)[0].id, 'command:file.newSession')
    assert.deepEqual(rankPalette(items, 'qqqq', []), [])
  })

  it('caps the sessions a query finds', () => {
    const sections = rankPalette(items, 'session', [])
    const found = sections.find((section) => section.group === 'Sessions')
    assert.equal(found?.items.length, SESSIONS_FOUND)
  })

  it('lifts a recent pick over an equal match', () => {
    const twins = [action('a', 'Open log'), action('b', 'Open log')]
    assert.equal(flatten(rankPalette(twins, 'open', []))[0].id, 'command:a')
    assert.equal(flatten(rankPalette(twins, 'open', ['command:b']))[0].id, 'command:b')
  })

  it('remembers picks newest first, once each, up to a limit', () => {
    let recent: string[] = []
    for (let index = 0; index < RECENT_KEPT + 3; index++) recent = remember(recent, `id:${index}`)
    recent = remember(recent, `id:${RECENT_KEPT}`)
    assert.equal(recent.length, RECENT_KEPT)
    assert.equal(recent[0], `id:${RECENT_KEPT}`)
    assert.equal(new Set(recent).size, recent.length)
  })
})

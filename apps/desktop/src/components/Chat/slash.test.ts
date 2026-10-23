import { answer } from '../../testing/bridge'
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import type { ModelProfile, Settings } from '@shared/types'
import { setActiveSessionId } from '../../stores/active'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { findSlash, SLASH_COMMANDS } from './picker'
import { effortOf, reviewKindOf, runSlash, SLASH_RUNNERS } from './slash'

const notes: string[] = []
useUi.setState({ notify: (_kind, text) => void notes.push(text) })
setActiveSessionId('session-1')

const run = (name: string, args = '') => {
  const command = findSlash(name)
  assert.ok(command, `no /${name}`)
  return runSlash(command, args)
}

describe('slash commands', () => {
  beforeEach(() => {
    notes.length = 0
  })

  it('each command in the list does something, and nothing else is listed', () => {
    assert.deepEqual(Object.keys(SLASH_RUNNERS).sort(), SLASH_COMMANDS.map((command) => command.name).sort())
  })

  it('say why there is nothing to undo, rewind or clear', async () => {
    await run('undo')
    await run('rewind')
    await run('goal', 'clear')
    assert.deepEqual(notes, ['No request in this session has changed files yet.', 'There is nothing to rewind yet.', 'This session has no goal.'])
  })

  it('open the status and the menus of the message box, by any of their names', async () => {
    await run('status')
    assert.equal(useUi.getState().statusOpen, true)
    await run('permissions')
    assert.equal(useUi.getState().menuRequest?.menu, 'policy')
    const before = useUi.getState().menuRequest?.id ?? 0
    await run('model')
    assert.deepEqual(useUi.getState().menuRequest, { menu: 'model', id: before + 1 })
    await run('shortcuts')
    assert.equal(useUi.getState().settingsOpen, true)
    assert.equal(useUi.getState().settingsSection, 'shortcuts', 'the shortcuts are a section of the Settings page')
  })
})

describe('/review', () => {
  beforeEach(() => {
    notes.length = 0
  })

  it('names a view of the Review tab as its menu does, or in the words people use', () => {
    const named = (words: string) => reviewKindOf(words)
    assert.equal(named('unstaged'), 'unstaged')
    assert.equal(named(' Staged '), 'staged')
    assert.equal(named('working  tree'), 'unstaged')
    assert.equal(named('branch'), 'branch')
    assert.equal(named('last commit'), 'commit')
    assert.equal(named('Last turn'), 'turn')
    for (const words of ['everything', 'pr', 'staged files']) assert.equal(named(words), undefined, words)
  })

  it('names the views for a word it does not know, and asks nothing', async () => {
    await run('review', 'everything')
    assert.deepEqual(notes, ['/review takes unstaged, staged, branch, commit or turn, not “everything”.'])
  })
})

describe('/effort', () => {
  const demo: ModelProfile = { id: 'demo', name: 'Demo (offline)', kind: 'demo', baseUrl: '', model: 'eNCode-demo' }
  const paid: ModelProfile = { id: 'p', name: 'Paid', kind: 'custom', baseUrl: 'https://api.example.test/v1', model: 'gpt-5-mini', hasApiKey: true }
  const settings = (patch: Partial<Settings>) => ({ profiles: [demo, paid], activeProfileId: 'p', roles: {}, efforts: {}, ...patch }) as Settings
  let saved: Partial<Settings>[] = []

  beforeEach(() => {
    notes.length = 0
    saved = []
    answer('settings.save', (patch) => {
      saved.push(patch as Partial<Settings>)
      return { ...useSettings.getState().settings, ...(patch as Partial<Settings>) }
    })
  })

  it('reads a level as written, by its name, or as the model\'s own choice', () => {
    assert.equal(effortOf('low'), 'low')
    assert.equal(effortOf(' MAX '), 'max')
    assert.equal(effortOf('xhigh'), 'xhigh')
    assert.equal(effortOf('Extra high'), 'xhigh')
    assert.equal(effortOf('x-high'), 'xhigh')
    for (const words of ['default', 'Model default', 'auto', 'reset']) assert.equal(effortOf(words), null, words)
    for (const words of ['turbo', 'minimal', 'high please', '']) assert.equal(effortOf(words), undefined, words)
  })

  it('sets the main role\'s effort, keeps the other roles\', and says what it did', async () => {
    useSettings.setState({ settings: settings({ efforts: { reviewer: 'low' } }) })
    await run('effort', 'extra high')
    assert.deepEqual(saved, [{ efforts: { reviewer: 'low', main: 'xhigh' } }])
    await run('effort', 'default')
    assert.deepEqual(useSettings.getState().settings?.efforts, { reviewer: 'low' })
    assert.deepEqual(notes, ['The model thinks at Extra high effort.', 'The model decides how hard to think.'])
  })

  it('names the levels for a word it does not know, and changes nothing', async () => {
    useSettings.setState({ settings: settings({ efforts: { main: 'high' } }) })
    await run('effort', 'turbo')
    assert.deepEqual(saved, [])
    assert.match(notes[0], /takes low, medium, high, xhigh, max or default, not “turbo”/)
  })

  it('opens the effort menu on its own, and says why not while the offline demo answers', async () => {
    useSettings.setState({ settings: settings({}) })
    const before = useUi.getState().menuRequest?.id ?? 0
    await run('effort')
    assert.deepEqual(useUi.getState().menuRequest, { menu: 'effort', id: before + 1 })
    useSettings.setState({ settings: settings({ activeProfileId: 'demo' }) })
    await run('effort')
    assert.equal(useUi.getState().menuRequest?.id, before + 1)
    assert.match(notes[0], /^Connect a model first\./)
  })
})

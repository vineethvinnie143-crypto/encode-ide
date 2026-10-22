import '../../testing/bridge'
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { setActiveSessionId } from '../../stores/active'
import { useUi } from '../../stores/ui'
import { findSlash, SLASH_COMMANDS } from './picker'
import { runSlash, SLASH_RUNNERS } from './slash'

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
    assert.equal(useUi.getState().shortcutsOpen, true)
  })
})

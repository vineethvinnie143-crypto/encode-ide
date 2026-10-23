import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shownPath } from './shown-path'

describe('a path in the chat', () => {
  it('is named from the folder the agent works in', () => {
    assert.equal(shownPath('/home/ana/app/src/main.ts', '/home/ana/app'), 'src/main.ts')
    assert.equal(shownPath('/home/ana/app/src/main.ts', '/home/ana/app/'), 'src/main.ts')
    assert.equal(shownPath('/home/ana/app', '/home/ana/app'), '.')
  })

  it('reads a Windows folder without regard to case or slashes', () => {
    assert.equal(shownPath('C:\\Users\\Ana\\App\\src\\main.ts', 'c:\\users\\ana\\app'), 'src/main.ts')
    assert.equal(shownPath('C:/Users/Ana/App/README.md', 'C:\\Users\\Ana\\App'), 'README.md')
  })

  it('stays as it is outside the folder, in a folder that only starts the same way, or with no folder', () => {
    assert.equal(shownPath('/home/ana/other/x.ts', '/home/ana/app'), '/home/ana/other/x.ts')
    assert.equal(shownPath('/home/ana/app-old/x.ts', '/home/ana/app'), '/home/ana/app-old/x.ts')
    assert.equal(shownPath('/home/Ana/app/x.ts', '/home/ana/app'), '/home/Ana/app/x.ts', 'case counts outside Windows')
    assert.equal(shownPath('src/x.ts', '/home/ana/app'), 'src/x.ts')
    assert.equal(shownPath('/home/ana/app/x.ts', null), '/home/ana/app/x.ts')
  })
})

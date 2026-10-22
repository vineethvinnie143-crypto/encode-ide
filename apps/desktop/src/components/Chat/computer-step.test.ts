import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TAKEN_OVER_DISPLAY } from '@encode/tools'
import { TAKEN_OVER, computerStep } from './computer-step'

describe('how a Computer step reads in the work log', () => {
  it('names what was done and where, from the line the tool keeps for people', () => {
    assert.deepEqual(computerStep({ action: 'left_click', element: 'e2' }, 'click e2 menuitem "File" in Notepad', 'done'), { label: 'Clicked', detail: 'menuitem "File" in Notepad' })
    assert.deepEqual(computerStep({ action: 'double_click', coordinate: [10, 20] }, 'click (10, 20) in Notepad', 'done'), { label: 'Double-clicked', detail: '(10, 20) in Notepad' })
    assert.deepEqual(computerStep({ action: 'type', text: 'hello' }, 'type "hello" into e4 edit "Text editor" in Notepad', 'done'), { label: 'Typed', detail: '"hello" into edit "Text editor" in Notepad' })
    assert.deepEqual(computerStep({ action: 'key', text: 'ctrl+s' }, 'key Ctrl+S in Notepad', 'done'), { label: 'Pressed', detail: 'Ctrl+S in Notepad' })
    assert.deepEqual(computerStep({ action: 'set_value', element: 'e4', text: 'x' }, 'set_value e4 edit "Name" to "x" in Notepad', 'done'), { label: 'Set the value of', detail: 'edit "Name" to "x" in Notepad' })
    assert.deepEqual(computerStep({ action: 'right_click', element: 'e9' }, 'click e9 button "Save" in Notepad', 'done'), { label: 'Right-clicked', detail: 'button "Save" in Notepad' })
    assert.equal(computerStep({ action: 'type', text: 'see e3 here' }, 'type "see e3 here" into e4 edit "Name" in Notepad', 'done').detail, '"see e3 here" into edit "Name" in Notepad', 'what was typed is left as it was')
  })

  it('names a look at a window by its title, and says how many windows were listed', () => {
    assert.deepEqual(computerStep({ action: 'screenshot', window: 'w1' }, 'Untitled - Notepad', 'done'), { label: 'Looked at', detail: 'Untitled - Notepad' })
    assert.deepEqual(computerStep({ action: 'focus', window: 'w2' }, 'Inbox - Mail', 'done'), { label: 'Switched to', detail: 'Inbox - Mail' })
    assert.deepEqual(computerStep({ action: 'windows' }, '3 windows', 'done'), { label: 'Looked at the windows', detail: '3 windows' })
    assert.deepEqual(computerStep({ action: 'zoom', region: [0, 0, 10, 10] }, 'zoom', 'done'), { label: 'Zoomed in', detail: '' })
    assert.deepEqual(computerStep({ action: 'find', text: 'Save', role: 'button' }, '2 found', 'done'), { label: 'Searched for', detail: '"Save" button · 2 found' })
    assert.deepEqual(computerStep({ action: 'wait', duration: 2 }, 'waited 2s', 'done'), { label: 'Waited', detail: '2s' })
    assert.deepEqual(computerStep({ action: 'wait', text: 'Saved' }, 'found', 'done'), { label: 'Waited', detail: '"Saved"' })
    assert.deepEqual(computerStep({ action: 'cursor_position' }, '(5, 6)', 'done'), { label: 'Read the pointer position', detail: '(5, 6)' })
  })

  it('describes a call that is still running or failed from what was asked, never from the long reason', () => {
    assert.deepEqual(computerStep({ action: 'left_click', element: 'e2' }, undefined, 'running'), { label: 'Clicked', detail: 'e2' })
    assert.deepEqual(computerStep({ action: 'left_click', coordinate: [3, 4] }, 'Another window is on top of (3, 4). Take a screenshot to see what is in the way.', 'error'), { label: 'Clicked', detail: '(3, 4)' })
    assert.deepEqual(computerStep({ action: 'type', text: 'x'.repeat(100) }, undefined, 'running').detail, `"${'x'.repeat(59)}…"`)
    assert.deepEqual(computerStep({ action: 'scroll', scroll_direction: 'down', scroll_amount: 5 }, undefined, 'waiting'), { label: 'Scrolled', detail: 'down 5' })
    assert.deepEqual(computerStep({ action: 'left_click_drag', start_element: 'e1', coordinate: [9, 9] }, undefined, 'running'), { label: 'Dragged', detail: 'from e1 to (9, 9)' })
    assert.deepEqual(computerStep({ action: 'find', text: 'Save' }, 'x', 'error'), { label: 'Searched for', detail: '"Save"' })
    assert.deepEqual(computerStep({ action: 'screenshot', window: 'w3' }, 'The window is gone.', 'error'), { label: 'Looked at', detail: 'w3' })
  })

  it('says when the person took over, and agrees with the tool about how it says so', () => {
    assert.equal(TAKEN_OVER, TAKEN_OVER_DISPLAY)
    assert.deepEqual(computerStep({ action: 'left_click', element: 'e2' }, TAKEN_OVER, 'error'), { label: 'You took over', detail: 'the agent stopped' })
    assert.equal(computerStep({ action: 'left_click', element: 'e2' }, TAKEN_OVER, 'done').label, 'Clicked', 'only a failed call can be a takeover')
  })

  it('copes with input a model made up', () => {
    assert.deepEqual(computerStep({}, undefined, 'running'), { label: 'Used the computer', detail: '' })
    assert.deepEqual(computerStep({ action: 'levitate' }, undefined, undefined), { label: 'Used the computer', detail: '' })
    assert.deepEqual(computerStep({ action: 7, text: {} }, 'x', 'done'), { label: 'Used the computer', detail: 'x' })
    assert.equal(computerStep({ action: 'type', text: 42 }, undefined, 'running').detail, '')
    assert.equal(computerStep({ action: 'left_click', coordinate: ['a', 'b'] }, undefined, 'running').detail, '')
  })
})

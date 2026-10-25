import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DesktopError } from '../contract'
import { asAct, asBox, asInfo, asLook, asPoint, asWindow, asWindows } from './validate'

const window = (patch: Record<string, unknown> = {}) => ({ id: 'w3', app: 'notepad.exe', label: 'Notepad', title: 'Untitled', pid: 4242, box: [10, 20, 800, 600], state: 'normal', foreground: true, ...patch })
const element = (patch: Record<string, unknown> = {}) => ({ ref: 'e7', role: 'button', name: 'Save', depth: 1, box: [1, 2, 3, 4], states: ['focused'], can: ['invoke'], ...patch })
const capture = (patch: Record<string, unknown> = {}) => ({ id: 's2', box: [10, 20, 800, 600], width: 800, height: 600, scale: 1, mediaType: 'image/png', masked: 0, ...patch })
const look = (patch: Record<string, unknown> = {}) => ({ window: window(), related: [], capture: capture(), changed: true, stable: true, ...patch })

/** The message of the error a check throws; it names where the helper's answer went wrong. */
function problem(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    assert.ok(error instanceof DesktopError, String(error))
    assert.equal(error.code, 'failed')
    return error.message
  }
  return assert.fail('The answer should have been refused.')
}

describe('what the helper says is checked', () => {
  it('accepts a window as the helper writes it, with or without a reason it is blocked', () => {
    assert.deepEqual(asWindow(window()), window())
    assert.equal(asWindow(window({ blocked: 'it runs as administrator' })).blocked, 'it runs as administrator')
    assert.equal('blocked' in asWindow(window({ blocked: null })), false)
    assert.equal(asWindows([window(), window({ id: 'w4' })]).length, 2)
  })

  it('names the field that is wrong', () => {
    assert.match(problem(() => asWindow(window({ id: 'window-3' }))), /window\.id/)
    assert.match(problem(() => asWindow(window({ state: 'hidden' }))), /window\.state/)
    assert.match(problem(() => asWindow(window({ pid: 1.5 }))), /window\.pid/)
    assert.match(problem(() => asWindow(window({ foreground: 'yes' }))), /window\.foreground/)
    assert.match(problem(() => asWindow(null)), /window/)
    assert.match(problem(() => asWindows([window(), { ...window(), box: [1, 2, 3] }])), /windows\[1\]\.box/)
    assert.match(problem(() => asWindows({})), /windows/)
  })

  it('takes boxes and points of whole numbers only', () => {
    assert.deepEqual(asBox([1, 2, 3, 4], 'b'), [1, 2, 3, 4])
    assert.deepEqual(asPoint([5, -6], 'p'), [5, -6])
    for (const bad of [[1, 2, 3], [1, 2, 3, 4, 5], [1, 2, 3, 0.5], [1, 2, 3, '4'], [1, 2, 3, NaN], 'box', null]) assert.throws(() => asBox(bad, 'b'), DesktopError)
    assert.throws(() => asPoint([1], 'p'), DesktopError)
  })

  it('accepts a look with its capture and outline', () => {
    const accepted = asLook(look({ outline: { elements: [element(), element({ ref: 'e8', value: 'text' })], total: 40, focused: 'e7' }, related: [window({ id: 'w4' })] }))
    assert.equal(accepted.outline?.elements.length, 2)
    assert.equal(accepted.outline?.elements[1].value, 'text')
    assert.equal(accepted.outline?.total, 40)
    assert.equal(accepted.outline?.focused, 'e7')
    assert.equal(accepted.related[0].id, 'w4')
    assert.equal(asLook(look()).outline, undefined)
    assert.equal(asLook(look({ capture: capture({ data: 'AAAA', mediaType: 'image/jpeg', scale: 0.5, width: 400, height: 300 }) })).capture.data, 'AAAA')
  })

  it('accepts a zoom enlarged up to four times, the marks counted and a grid (ADR 0121)', () => {
    const zoomed = asLook(look({ capture: capture({ scale: 3.25, marks: 12, grid: { step: 25, of: 's3' } }) })).capture
    assert.equal(zoomed.scale, 3.25)
    assert.equal(zoomed.marks, 12)
    assert.deepEqual(zoomed.grid, { step: 25, of: 's3' })
    const plain = asLook(look()).capture
    assert.equal(plain.marks, undefined)
    assert.equal(plain.grid, undefined)
  })

  it('refuses a look that would make a coordinate meaningless', () => {
    assert.match(problem(() => asLook(look({ capture: capture({ scale: 0 }) }))), /capture\.scale/)
    assert.match(problem(() => asLook(look({ capture: capture({ scale: 4.5 }) }))), /capture\.scale/)
    assert.match(problem(() => asLook(look({ capture: capture({ marks: -1 }) }))), /capture\.marks/)
    assert.match(problem(() => asLook(look({ capture: capture({ marks: 1.5 }) }))), /capture\.marks/)
    assert.match(problem(() => asLook(look({ capture: capture({ grid: { step: 0, of: 's1' } }) }))), /capture\.grid/)
    assert.match(problem(() => asLook(look({ capture: capture({ grid: { step: 10, of: 'w1' } }) }))), /capture\.grid/)
    assert.match(problem(() => asLook(look({ capture: capture({ grid: 10 }) }))), /capture\.grid/)
    assert.match(problem(() => asLook(look({ capture: capture({ scale: 'one' }) }))), /capture\.scale/)
    assert.match(problem(() => asLook(look({ capture: capture({ id: 'capture-1' }) }))), /capture\.id/)
    assert.match(problem(() => asLook(look({ capture: capture({ mediaType: 'image/gif' }) }))), /capture\.mediaType/)
    assert.match(problem(() => asLook(look({ capture: capture({ box: [0, 0, 10] }) }))), /capture\.box/)
    assert.match(problem(() => asLook(look({ outline: { elements: [element({ ref: 'element-7' })], total: 1 } }))), /outline\.elements\[0\]\.ref/)
    assert.match(problem(() => asLook(look({ outline: { elements: [element({ states: 'focused' })], total: 1 } }))), /states/)
    assert.match(problem(() => asLook(look({ changed: 1 }))), /look\.changed/)
    assert.match(problem(() => asLook(look({ outline: { elements: [], total: '0' } }))), /outline\.total/)
  })

  it('accepts what an input did, and a window that closed', () => {
    const done = { performed: [{ kind: 'click', via: 'invoke' }, { kind: 'click', via: 'mouse', detail: 'the mouse was used' }], look: look(), opened: [window({ id: 'w5' })], closed: ['w2'], cursor: [100, 200] }
    const accepted = asAct(done)
    assert.equal(accepted.performed[1].detail, 'the mouse was used')
    assert.equal(accepted.opened[0].id, 'w5')
    assert.deepEqual(accepted.closed, ['w2'])
    assert.deepEqual(accepted.cursor, [100, 200])
    assert.equal(asAct({ ...done, look: null }).look, null)
    assert.match(problem(() => asAct({ ...done, performed: [{ kind: 'teleport', via: 'mouse' }] })), /act\.performed\[0\]/)
    assert.match(problem(() => asAct({ ...done, performed: [{ kind: 'click', via: 'telepathy' }] })), /act\.performed\[0\]/)
    assert.match(problem(() => asAct({ ...done, closed: [3] })), /act\.closed\[0\]/)
    assert.match(problem(() => asAct({ ...done, cursor: [1] })), /act\.cursor/)
  })

  it('accepts what the pointer went to, by ref or by role and name alone (ADR 0121)', () => {
    const pointed = { performed: [{ kind: 'click', via: 'mouse', on: { ref: 'e31', role: 'button', name: 'Send' } }, { kind: 'move', via: 'mouse', on: { role: 'image', name: '' } }], look: null, opened: [], closed: [], cursor: [1, 2] }
    const accepted = asAct(pointed)
    assert.deepEqual(accepted.performed[0].on, { ref: 'e31', role: 'button', name: 'Send' })
    assert.deepEqual(accepted.performed[1].on, { role: 'image', name: '' })
    assert.match(problem(() => asAct({ ...pointed, performed: [{ kind: 'click', via: 'mouse', on: { ref: 'button-1', role: 'button', name: 'x' } }] })), /on\.ref/)
    assert.match(problem(() => asAct({ ...pointed, performed: [{ kind: 'click', via: 'mouse', on: { role: 'button' } }] })), /on\.name/)
    assert.match(problem(() => asAct({ ...pointed, performed: [{ kind: 'click', via: 'mouse', on: 'e1' }] })), /on/)
  })

  it('accepts the backend\'s description of the machine', () => {
    assert.deepEqual(asInfo({ platform: 'win32', version: '1', scale: 125, monitors: [[0, 0, 1920, 1080], [1920, 0, 1280, 1024]], watching: true }), {
      platform: 'win32',
      version: '1',
      scale: 125,
      monitors: [
        [0, 0, 1920, 1080],
        [1920, 0, 1280, 1024],
      ],
    })
    assert.match(problem(() => asInfo({ version: '1', scale: 1.25, monitors: [] })), /ready\.scale/)
    assert.match(problem(() => asInfo({ version: 1, scale: 100, monitors: [] })), /ready\.version/)
  })
})

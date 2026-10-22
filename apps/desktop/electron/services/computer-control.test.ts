import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ComputerControl, STOP_SHORTCUT, STOP_SHORTCUT_LABEL, type OverlayState } from './computer-control'

function control(options: { taken?: boolean; cancel?: (id: string) => Promise<void> } = {}) {
  const calls: string[] = []
  const states: OverlayState[] = []
  const held = new Map<string, () => void>()
  const cancelled: string[] = []
  const logs: string[] = []
  const subject = new ComputerControl({
    overlay: {
      show: (state) => (calls.push('show'), states.push(state)),
      update: (state) => (calls.push('update'), states.push(state)),
      hide: () => calls.push('hide'),
    },
    shortcuts: {
      register: (accelerator, handler) => {
        calls.push(`register ${accelerator}`)
        if (options.taken) return false
        held.set(accelerator, handler)
        return true
      },
      unregister: (accelerator) => {
        calls.push(`unregister ${accelerator}`)
        held.delete(accelerator)
      },
    },
    cancel: options.cancel ?? (async (id) => void cancelled.push(id)),
    log: (message) => logs.push(message),
  })
  return { subject, calls, states, held, cancelled, logs }
}

const using = { active: true, sessions: ['a'], waiting: false }
const idle = { active: false, sessions: [], waiting: false }

describe('what the person is given while the agent uses the computer', () => {
  it('shows the banner and takes the stop key when the agent starts, and gives both back when it ends', () => {
    const f = control()
    f.subject.setActivity(using)
    assert.deepEqual(f.calls, [`register ${STOP_SHORTCUT}`, 'show'])
    assert.deepEqual(f.states[0], { mode: 'using', shortcut: STOP_SHORTCUT_LABEL })
    f.subject.setActivity(idle)
    assert.deepEqual(f.calls.slice(2), [`unregister ${STOP_SHORTCUT}`, 'hide'])
    assert.equal(f.held.size, 0)
    f.subject.setActivity(idle)
    assert.equal(f.calls.length, 4, 'and does nothing when nothing changed')
  })

  it('updates the banner instead of showing it again, and says when the agent waits for the person', () => {
    const f = control()
    f.subject.setActivity(using)
    f.subject.setActivity({ ...using, waiting: true })
    f.subject.setActivity({ ...using, sessions: ['a', 'b'] })
    assert.deepEqual(f.calls, [`register ${STOP_SHORTCUT}`, 'show', 'update', 'update'])
    assert.deepEqual(f.states.map((state) => state.mode), ['using', 'waiting', 'using'])
  })

  it('stops every session that is using the computer, from the button and from the key', async () => {
    const f = control()
    f.subject.setActivity({ active: true, sessions: ['a', 'b'], waiting: false })
    f.held.get(STOP_SHORTCUT)!()
    await Promise.resolve()
    assert.deepEqual(f.cancelled, ['a', 'b'])
    assert.equal(f.states.at(-1)?.mode, 'stopping')
    f.subject.stop()
    await Promise.resolve()
    assert.deepEqual(f.cancelled, ['a', 'b', 'a', 'b'], 'asked again if the turn has not ended')
    f.subject.setActivity(idle)
    f.subject.setActivity(using)
    assert.equal(f.states.at(-1)?.mode, 'using', 'a new run does not start out stopping')
  })

  it('does nothing when asked to stop with nothing running', () => {
    const f = control()
    f.subject.stop()
    assert.deepEqual(f.cancelled, [])
    assert.deepEqual(f.calls, [])
  })

  it('shows the button without the key when another program holds the combination, and says so in the log', () => {
    const f = control({ taken: true })
    f.subject.setActivity(using)
    assert.deepEqual(f.states[0], { mode: 'using', shortcut: null })
    assert.match(f.logs.join('\n'), /taken by another program/)
    f.subject.setActivity(idle)
    assert.ok(!f.calls.some((call) => call.startsWith('unregister')), 'a combination it never held is not given back')
  })

  it('keeps going when a stop fails, and when the shortcut call throws', async () => {
    const f = control({ cancel: async () => Promise.reject(new Error('host is gone')) })
    f.subject.setActivity(using)
    f.subject.stop()
    await new Promise((resolve) => setImmediate(resolve))
    assert.match(f.logs.join('\n'), /could not stop a: host is gone/)

    const broken = new ComputerControl({
      overlay: { show() {}, update() {}, hide() {} },
      shortcuts: {
        register: () => {
          throw new Error('no desktop')
        },
        unregister() {},
      },
      cancel: async () => {},
      log: (message) => f.logs.push(message),
    })
    broken.setActivity(using)
    assert.match(f.logs.join('\n'), /could not take Control\+Alt\+Escape: no desktop/)
  })

  it('gives everything back when eNCode quits, and takes nothing again', () => {
    const f = control()
    f.subject.setActivity(using)
    f.subject.dispose()
    assert.deepEqual(f.calls.slice(2), [`unregister ${STOP_SHORTCUT}`, 'hide'])
    f.subject.setActivity({ ...using, sessions: ['late'] })
    f.subject.dispose()
    assert.equal(f.calls.length, 4, 'a late event from a window being closed shows no banner')
  })
})

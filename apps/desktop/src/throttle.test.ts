import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { throttle } from './throttle'

describe('throttle', () => {
  it('runs the first call at once and folds a burst into one more call at the end', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      let runs = 0
      const call = throttle(() => runs++, 250)
      call()
      assert.equal(runs, 1)
      call()
      call()
      call()
      assert.equal(runs, 1, 'the rest wait')
      mock.timers.tick(250)
      assert.equal(runs, 2, 'one call for the burst')
      mock.timers.tick(1000)
      assert.equal(runs, 2, 'and nothing more when nothing else came')
      call()
      assert.equal(runs, 3, 'a call after a quiet spell runs at once')
    } finally {
      mock.timers.reset()
    }
  })

  it('keeps the pace of one call per wait while calls keep coming', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      let runs = 0
      const call = throttle(() => runs++, 100)
      for (let elapsed = 0; elapsed < 1000; elapsed += 10) {
        call()
        mock.timers.tick(10)
      }
      assert.ok(runs >= 9 && runs <= 11, `${runs} runs in a second at 100 ms`)
    } finally {
      mock.timers.reset()
    }
  })

  it('drops the waiting call when cancelled', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      let runs = 0
      const call = throttle(() => runs++, 100)
      call()
      call()
      call.cancel()
      mock.timers.tick(500)
      assert.equal(runs, 1)
    } finally {
      mock.timers.reset()
    }
  })
})

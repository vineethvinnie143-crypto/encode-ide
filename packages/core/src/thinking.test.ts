import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { latestWords, THINKING_EVERY_MS, ThinkingTicker } from './thinking'
import type { ThinkingProgress } from './ui'

describe('latestWords', () => {
  it('gives the end of the thinking on one line, without the markup of its notes', () => {
    assert.equal(latestWords('**Checking the container**\n\nThe `docker ps` output shows\n  one stuck in Created.'), 'Checking the container The docker ps output shows one stuck in Created.')
  })

  it('starts the latest words at a word', () => {
    const long = `${'alpha beta gamma '.repeat(20)}and then the last thought here`
    const latest = latestWords(long)
    assert.ok(latest.length <= 160)
    assert.ok(latest.endsWith('and then the last thought here'))
    assert.match(latest, /^(alpha|beta|gamma) /)
  })

  it('is empty for thinking that is only space or markup', () => {
    assert.equal(latestWords(' \n** **\n'), '')
  })
})

describe('ThinkingTicker', () => {
  it('passes thinking on at once, then at most every interval, and says when the call is over', () => {
    let now = 1_000
    const sent: (ThinkingProgress | null)[] = []
    const ticker = new ThinkingTicker((progress) => sent.push(progress), () => now)
    ticker.add('Looking at ')
    ticker.add('the logs ')
    now += THINKING_EVERY_MS - 1
    ticker.add('first. ')
    assert.deepEqual(sent, [{ chars: 11, latest: 'Looking at' }])
    now += 1
    ticker.add('Then the config.')
    assert.deepEqual(sent.at(-1), { chars: 43, latest: 'Looking at the logs first. Then the config.' })
    // A thought longer than the line is shown by its end, marked as cut.
    now += THINKING_EVERY_MS
    ticker.add(' and more'.repeat(30))
    // deepEqual above narrowed the list's type to entries without `cut`.
    assert.equal((sent.at(-1) as ThinkingProgress | undefined)?.cut, true)
    ticker.end()
    assert.equal(sent.at(-1), null)
    assert.equal(sent.length, 4)
  })

  it('says nothing for a call that did not think', () => {
    const sent: (ThinkingProgress | null)[] = []
    const ticker = new ThinkingTicker((progress) => sent.push(progress))
    ticker.add('')
    ticker.end()
    assert.deepEqual(sent, [])
  })

  it('starts afresh after it ends', () => {
    let now = 0
    const sent: (ThinkingProgress | null)[] = []
    const ticker = new ThinkingTicker((progress) => sent.push(progress), () => now)
    ticker.add('One.')
    ticker.end()
    ticker.add('Two.')
    assert.deepEqual(sent, [{ chars: 4, latest: 'One.' }, null, { chars: 4, latest: 'Two.' }])
  })
})

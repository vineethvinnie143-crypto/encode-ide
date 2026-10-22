import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { reviewLine } from './review-text'

describe('what Auto review says about a step', () => {
  it('names the Reviewer, the verdict and the risk', () => {
    assert.equal(reviewLine({ by: 'reviewer', verdict: 'approved', risk: 'low', reason: 'It only runs the tests.' }), 'Approved by the Reviewer (low risk): It only runs the tests.')
    assert.equal(reviewLine({ by: 'reviewer', verdict: 'declined', risk: 'high', reason: 'Not part of the request.' }), 'Declined by the Reviewer (high risk): Not part of the request.')
  })

  it('says who left a question to the person', () => {
    assert.equal(reviewLine({ by: 'reviewer', verdict: 'asked', reason: 'It installs a new package.' }), 'The Reviewer leaves this to you: It installs a new package.')
    assert.equal(reviewLine({ by: 'floor', verdict: 'asked', reason: 'It force-pushes.' }), 'Auto review leaves this to you: It force-pushes.')
    // An approval card carries no verdict: the person is being asked.
    assert.equal(reviewLine({ by: 'floor', reason: 'It reaches the network.' }), 'Auto review leaves this to you: It reaches the network.')
  })

  it('leaves out what it was not given', () => {
    assert.equal(reviewLine({ by: 'reviewer', verdict: 'approved', reason: '  ' }), 'Approved by the Reviewer')
    assert.equal(reviewLine({ by: 'reviewer', verdict: 'asked', reason: '' }), 'The Reviewer leaves this to you')
  })
})

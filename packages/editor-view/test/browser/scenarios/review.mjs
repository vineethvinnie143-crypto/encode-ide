const baseline = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'].join('\n')
const edited = ['alpha', 'beta', 'GAMMA changed', 'delta', 'epsilon', 'eta', 'theta', 'iota', 'inserted one', 'inserted two', 'kappa'].join('\n')

/** The review state as a test sees it. */
const state = () => {
  const review = window.view.review
  return {
    hunks: review.hunks.map((hunk) => ({ removed: hunk.removed.length, added: hunk.toB - hunk.fromB })),
    zones: document.querySelectorAll('.enc-zone-removed').length,
    inserted: document.querySelectorAll('.enc-line-inserted').length,
    buttons: [...document.querySelectorAll('.enc-hunk-action')].map((el) => el.dataset.action),
    text: window.view.state.doc.toString(),
  }
}

export const review = [
  {
    name: 'review: shows hunks with removed lines, Keep moves a hunk into the baseline and Undo restores it',
    async run({ mount, ev, page, assert, shot, settle, text }) {
      await mount({ text: edited, path: 'a.txt', height: 420 })
      await ev((base) => window.view.review.start(base), baseline)
      await settle()
      await shot('review')
      let now = await ev(state)
      assert.deepEqual(now.hunks, [
        { removed: 1, added: 1 },
        { removed: 1, added: 0 },
        { removed: 0, added: 2 },
      ])
      assert.equal(now.zones, 2, 'a zone for each hunk with removed lines')
      assert.equal(now.inserted, 3, 'added lines are tinted')
      assert.equal(now.buttons.length, 6, 'Keep and Undo for each hunk')
      // The removed line sits above the changed one and pushes the rest down.
      const geometry = await ev(() => {
        const lines = [...document.querySelectorAll('.enc-line')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
        const zone = document.querySelector('.enc-zone-removed').getBoundingClientRect()
        const third = lines[2].getBoundingClientRect()
        const second = lines[1].getBoundingClientRect()
        return { zoneTop: zone.top, zoneBottom: zone.bottom, secondBottom: second.bottom, thirdTop: third.top, zoneText: document.querySelector('.enc-zone-removed').textContent }
      })
      assert.ok(Math.abs(geometry.zoneTop - geometry.secondBottom) < 1, 'the zone starts where line 2 ends')
      assert.ok(Math.abs(geometry.zoneBottom - geometry.thirdTop) < 1, 'and ends where line 3 starts')
      assert.match(geometry.zoneText, /gamma/)

      // Keep the first hunk: it becomes part of the baseline.
      await ev(() => document.querySelector('.enc-hunk-action-keep').click())
      await settle()
      now = await ev(state)
      assert.equal(now.hunks.length, 2)
      assert.equal(now.zones, 1)
      assert.equal(now.text, edited, 'keeping does not touch the document')

      // Undo the first remaining hunk: the deleted line returns.
      await ev(() => document.querySelector('.enc-hunk-action-undo').click())
      await settle()
      now = await ev(state)
      assert.equal(now.hunks.length, 1)
      assert.ok(now.text.includes('\nzeta\n'), 'the removed line is back')
      await page.key('z', { ctrl: true })
      await settle()
      now = await ev(state)
      assert.equal(now.hunks.length, 2, 'one undo takes the restored line out again')
      assert.ok(!now.text.includes('zeta'))
    },
  },
  {
    name: 'review: keeps up with edits, navigates between hunks, and Keep all / Undo all',
    async run({ mount, ev, page, press, assert, settle, text }) {
      await mount({ text: edited, path: 'a.txt', height: 420 })
      await ev((base) => window.view.review.start(base), baseline)
      await settle()
      // Edits change the hunks after a short delay.
      await press('End', { ctrl: true })
      await page.insertText('!')
      await new Promise((resolve) => setTimeout(resolve, 200))
      let now = await ev(state)
      assert.equal(now.hunks.length, 3)
      // The last hunk now also covers the line that was edited.
      assert.deepEqual(now.hunks[2], { removed: 1, added: 3 })
      // F-keys go through commands: next and previous change.
      await press('Home', { ctrl: true })
      await ev(() => window.view.runCommand('reviewNextChange'))
      await settle()
      const lineOfCursor = () => window.view.state.doc.lineAt(window.view.state.selection.main.head).number
      assert.equal(await ev(lineOfCursor), 3)
      await ev(() => window.view.runCommand('reviewNextChange'))
      assert.equal(await ev(lineOfCursor), 6)
      await ev(() => window.view.runCommand('reviewPreviousChange'))
      assert.equal(await ev(lineOfCursor), 3)
      // Undo all puts the whole baseline back, as one step.
      await ev(() => window.view.runCommand('reviewRejectAll'))
      await settle()
      now = await ev(state)
      assert.equal(now.text, baseline)
      assert.equal(now.hunks.length, 0)
      await page.key('z', { ctrl: true })
      await settle()
      now = await ev(state)
      assert.equal(now.text, `${edited}!`)
      assert.equal(now.hunks.length, 3)
      await ev(() => window.view.runCommand('reviewAcceptAll'))
      await settle()
      now = await ev(state)
      assert.equal(now.hunks.length, 0)
      assert.equal(now.zones, 0)
      assert.equal(now.inserted, 0)
      await ev(() => window.view.review.stop())
    },
  },
]

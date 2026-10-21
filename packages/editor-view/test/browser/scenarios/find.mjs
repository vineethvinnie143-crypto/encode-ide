const words = Array.from({ length: 60 }, (_, index) => `item ${index + 1}: alpha beta ${index % 5 === 0 ? 'needle' : 'hay'}`).join('\n')

const count = () => document.querySelector('.enc-find-count')?.textContent
const marks = () => ({
  all: document.querySelectorAll('.enc-mark-find').length,
  active: document.querySelectorAll('.enc-mark-find-active').length,
})

export const find = [
  {
    name: 'find: opens with Ctrl+F, selects matches as you type, steps with Enter, closes with Escape',
    async run({ mount, ev, page, type, press, selection, assert, shot, settle }) {
      await mount({ text: words, path: 'a.txt' })
      await press('f', { ctrl: true })
      assert.equal(await ev(() => !!document.querySelector('.enc-find')), true, 'the find box is open')
      assert.equal(await ev(() => document.activeElement?.className), 'enc-find-input')
      assert.equal(await ev(() => window.view.root.classList.contains('enc-find-open')), true)
      await type('needle')
      await new Promise((resolve) => setTimeout(resolve, 60))
      assert.equal(await ev(count), '1 of 12')
      const first = (await selection())[0]
      assert.equal(first[1] - first[0], 6)
      assert.equal(await ev(() => window.view.state.sliceDoc(window.view.state.selection.main.from, window.view.state.selection.main.to)), 'needle')
      const found = await ev(marks)
      assert.ok(found.all >= 3, `${found.all} matches highlighted on screen`)
      assert.equal(found.active, 1)
      await shot('find')
      await press('Enter')
      assert.equal(await ev(count), '2 of 12')
      await press('Enter', { shift: true })
      assert.equal(await ev(count), '1 of 12')
      // Stepping past the last match wraps round.
      for (let n = 0; n < 12; n++) await press('Enter')
      assert.equal(await ev(count), '1 of 12')
      // Match case: "Needle" no longer matches.
      await press('a', { ctrl: true })
      await type('Needle')
      await new Promise((resolve) => setTimeout(resolve, 60))
      assert.equal(await ev(count), '1 of 12')
      await press('c', { alt: true })
      await new Promise((resolve) => setTimeout(resolve, 60))
      assert.equal(await ev(count), 'No results')
      assert.equal(await ev(() => document.querySelector('.enc-find-option[aria-pressed=true]')?.textContent), 'Aa')
      await press('Escape')
      assert.equal(await ev(() => !!document.querySelector('.enc-find')), false, 'Escape closes the find box')
      assert.equal(await ev(() => window.view.hasFocus), true, 'and gives the focus back')
      assert.equal(await ev(() => document.querySelectorAll('.enc-mark-find').length), 0)
    },
  },
  {
    name: 'find: seeds from the selection, and an invalid pattern is reported',
    async run({ mount, ev, page, type, press, assert, settle }) {
      await mount({ text: 'foo bar foo baz foo', path: 'a.txt' })
      await press('Home')
      await press('ArrowRight', { shift: true })
      await press('ArrowRight', { shift: true })
      await press('ArrowRight', { shift: true })
      await press('f', { ctrl: true })
      assert.equal(await ev(() => document.querySelector('.enc-find-input').value), 'foo')
      await new Promise((resolve) => setTimeout(resolve, 60))
      assert.equal(await ev(count), '1 of 3')
      await press('r', { alt: true })
      await press('a', { ctrl: true })
      await type('(')
      await new Promise((resolve) => setTimeout(resolve, 60))
      assert.equal(await ev(count), 'Invalid pattern')
      assert.equal(await ev(() => document.querySelector('.enc-find').dataset.state), 'error')
      await press('a', { ctrl: true })
      await type('ba[rz]')
      await new Promise((resolve) => setTimeout(resolve, 60))
      assert.equal(await ev(count), '1 of 2')
    },
  },
  {
    name: 'find: replace and replace all, undone in one step',
    async run({ mount, ev, page, type, press, text, assert }) {
      await mount({ text: 'one two one\ntwo one two', path: 'a.txt' })
      await press('h', { ctrl: true })
      assert.equal(await ev(() => !!document.querySelector('.enc-find-replace-row')), true)
      assert.equal(await ev(() => getComputedStyle(document.querySelector('.enc-find-replace-row')).display !== 'none'), true, 'the replace row is shown')
      await type('one')
      await press('Tab')
      assert.equal(await ev(() => document.activeElement?.classList.contains('enc-replace-input')), true)
      await type('1')
      await press('Enter')
      assert.equal(await text(), '1 two one\ntwo one two')
      await press('Enter', { ctrl: true, alt: true })
      assert.equal(await text(), '1 two 1\ntwo 1 two')
      await press('Escape')
      await press('z', { ctrl: true })
      assert.equal(await text(), '1 two one\ntwo one two')
    },
  },
  {
    name: 'find: counts without stalling on a large document',
    async run({ mount, ev, press, type, page, assert }) {
      await ev(() => {
        const text = Array.from({ length: 200000 }, (_, index) => `row ${index} lorem ipsum dolor`).join('\n')
        window.harness.mount({ text, path: 'a.txt' })
      })
      await page.frames(3)
      await press('f', { ctrl: true })
      const started = Date.now()
      await type('ipsum')
      let label = ''
      for (let attempt = 0; attempt < 100 && !/10000\+|of|found/.test(label); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        label = await ev(count)
      }
      assert.match(label, /10000\+/)
      assert.ok(Date.now() - started < 4000, `counting took ${Date.now() - started} ms`)
    },
  },
]

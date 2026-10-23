const doc = 'alpha beta\ngamma delta\nx\n    indented line\nlast'

export const pointer = [
  {
    name: 'click puts the caret under the pointer',
    async run({ mount, at, page, selection, assert }) {
      await mount({ text: doc, path: 'a.txt', focus: false })
      let p = await at(2, 3)
      await page.click(p.x, p.y)
      await page.frames(2)
      assert.deepEqual(await selection(), [[14, 14]])
      assert.equal(await page.eval(() => window.view.hasFocus), true, 'the click focuses the editor')
      // Right of the end of a line.
      p = await at(1, 40)
      await page.click(p.x, p.y)
      await page.frames(2)
      assert.deepEqual(await selection(), [[10, 10]])
      // Below the last line.
      p = await at(1, 0)
      await page.click(p.x, p.y + 300)
      await page.frames(2)
      assert.deepEqual(await selection(), [[doc.length, doc.length]])
      // Just left of the first column.
      p = await at(2, 0)
      await page.click(p.x - 8, p.y)
      await page.frames(2)
      assert.deepEqual(await selection(), [[11, 11]])
    },
  },
  {
    name: 'double click selects a word and triple click a line',
    async run({ mount, at, page, selection, assert }) {
      await mount({ text: doc, path: 'a.txt', focus: false })
      let p = await at(2, 8)
      await page.click(p.x, p.y, { count: 2 })
      await page.frames(2)
      assert.deepEqual(await selection(), [[17, 22]])
      await page.click(p.x, p.y, { count: 3 })
      await page.frames(2)
      assert.deepEqual(await selection(), [[11, 23]])
      // A double click and a drag extend by words.
      p = await at(1, 2)
      const q = await at(2, 8)
      await page.mouse('mouseMoved', p.x, p.y)
      await page.mouse('mousePressed', p.x, p.y, { count: 1 })
      await page.mouse('mouseReleased', p.x, p.y, { count: 1 })
      await page.mouse('mousePressed', p.x, p.y, { count: 2 })
      await page.mouse('mouseMoved', q.x, q.y, { buttons: 1 })
      await page.mouse('mouseReleased', q.x, q.y, { count: 2 })
      await page.frames(2)
      assert.deepEqual(await selection(), [[0, 22]])
    },
  },
  {
    name: 'drag selects, shift+click extends, alt+click adds a cursor',
    async run({ mount, at, page, selection, assert, shot }) {
      await mount({ text: doc, path: 'a.txt', focus: false })
      const a = await at(1, 2)
      const b = await at(2, 5)
      await page.drag(a, b)
      await page.frames(2)
      assert.deepEqual(await selection(), [[2, 16]])
      await shot('drag')
      const c = await at(4, 10)
      await page.click(c.x, c.y, { shift: true })
      await page.frames(2)
      assert.deepEqual(await selection(), [[2, 23 + 2 + 10]].map(([from, to]) => [from, to - 0]))
      const d = await at(5, 2)
      await page.click(d.x, d.y)
      const e = await at(1, 1)
      await page.click(e.x, e.y, { alt: true })
      await page.frames(2)
      const ranges = await selection()
      assert.equal(ranges.length, 2)
      assert.deepEqual(ranges.map(([from]) => from).sort((x, y) => x - y), [1, doc.length - 2])
      // Alt+click on a cursor removes it again.
      await page.click(e.x, e.y, { alt: true })
      await page.frames(2)
      assert.equal((await selection()).length, 1)
    },
  },
  {
    name: 'clicking in the gutter selects lines',
    async run({ mount, page, selection, assert, ev }) {
      await mount({ text: doc, path: 'a.txt', focus: false })
      const g = await ev(() => {
        const rect = document.querySelector('.enc-gutter').getBoundingClientRect()
        const scroller = window.view.scroller.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, top: scroller.top, lineHeight: window.view.metrics.lineHeight }
      })
      await page.click(g.x, g.top + g.lineHeight * 1.5)
      await page.frames(2)
      assert.deepEqual(await selection(), [[11, 23]])
      await page.drag({ x: g.x, y: g.top + g.lineHeight * 1.5 }, { x: g.x, y: g.top + g.lineHeight * 3.5 })
      await page.frames(2)
      const [[anchor, head]] = await selection()
      assert.equal(anchor, 11)
      assert.ok(head >= 25 && head <= 44, `head ${head}`)
    },
  },
  {
    name: 'dragging past the bottom scrolls',
    async run({ mount, page, ev, selection, assert }) {
      const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join('\n')
      await mount({ text: lines, path: 'a.txt', focus: false, height: 300 })
      const g = await ev(() => {
        const rect = window.view.scroller.getBoundingClientRect()
        return { left: rect.left + 120, top: rect.top, bottom: rect.bottom }
      })
      await page.mouse('mouseMoved', g.left, g.top + 20)
      await page.mouse('mousePressed', g.left, g.top + 20)
      await page.mouse('mouseMoved', g.left, g.bottom + 40, { buttons: 1 })
      await new Promise((resolve) => setTimeout(resolve, 600))
      await page.mouse('mouseReleased', g.left, g.bottom + 40)
      await page.frames(2)
      const scrolled = await ev(() => window.view.scroller.scrollTop)
      assert.ok(scrolled > 200, `scrolled by ${scrolled}`)
      const [[anchor, head]] = await selection()
      // The head follows the pointer, which sits just below the last visible line.
      const last = await ev(() => window.view.state.doc.lineAt(window.view.state.selection.main.head).number - window.view.viewportLines.last)
      assert.ok(anchor < 20 && Math.abs(last) <= 4, `selection ${anchor}..${head}, ${last} lines from the bottom`)
    },
  },
  {
    name: 'a click on a scrollbar scrolls and leaves the focus and the caret in the editor',
    async run({ mount, page, ev, selection, settle, assert }) {
      const lines = Array.from({ length: 300 }, (_, index) => `line ${index + 1} ${'x'.repeat(index % 7 === 0 ? 300 : 10)}`).join('\n')
      await mount({ text: lines, path: 'a.txt', width: 600, height: 300 })
      const before = await selection()
      const r = await ev(() => {
        const scroller = window.view.scroller
        const rect = scroller.getBoundingClientRect()
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, cw: scroller.clientWidth, ch: scroller.clientHeight }
      })
      assert.ok(r.cw < r.width && r.ch < r.height, 'both scrollbars show')
      // The horizontal track, right of its thumb, and the vertical track, below its thumb.
      await page.click(r.left + r.cw - 20, r.top + (r.ch + r.height) / 2)
      await page.click(r.left + (r.cw + r.width) / 2, r.top + r.ch - 20)
      await settle(4)
      const after = await ev(() => ({ left: window.view.scroller.scrollLeft, top: window.view.scroller.scrollTop, focused: document.activeElement === window.view.textarea }))
      assert.ok(after.left > 0 && after.top > 0, `scrolled to ${after.left}, ${after.top}`)
      assert.ok(after.focused, 'the editor keeps the focus')
      assert.deepEqual(await selection(), before)
    },
  },
]

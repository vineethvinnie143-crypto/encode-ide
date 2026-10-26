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
  {
    name: 'the breakpoint column: a click or a right click there names the line and leaves the selection, and its marks are drawn',
    async run({ mount, page, selection, assert, shot }) {
      const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')
      await mount({ text: lines, path: 'a.js', focus: false, config: { breakpoints: true } })
      await page.eval(() => {
        window.events = { clicks: [], menus: [] }
        window.view.on('gutterClick', (event) => window.events.clicks.push(event))
        window.view.on('contextmenu', (event) => window.events.menus.push(event))
      })
      const spot = (line, dx) =>
        page.eval(
          ({ line, dx }) => {
            const gutter = document.querySelector('.enc-gutter').getBoundingClientRect()
            const row = [...document.querySelectorAll('.enc-gutter-num')].find((el) => el.textContent === String(line)).getBoundingClientRect()
            return { x: gutter.left + dx, y: row.top + row.height / 2 }
          },
          { line, dx },
        )
      const width = () => page.eval(() => document.querySelector('.enc-gutter').getBoundingClientRect().width)
      const wide = await width()

      let p = await spot(3, 6)
      await page.click(p.x, p.y)
      await page.frames(2)
      p = await spot(5, 12)
      await page.click(p.x, p.y, { shift: true })
      await page.frames(2)
      const { clicks } = await page.eval(() => window.events)
      assert.deepEqual(clicks, [
        { line: 3, modifiers: { shift: false, alt: false, mod: false } },
        { line: 5, modifiers: { shift: true, alt: false, mod: false } },
      ])
      assert.deepEqual(await selection(), [[0, 0]], 'a click in the column selects nothing')

      p = await spot(7, 6)
      await page.mouse('mouseMoved', p.x, p.y)
      await page.mouse('mousePressed', p.x, p.y, { button: 'right', count: 1 })
      await page.mouse('mouseReleased', p.x, p.y, { button: 'right', count: 1 })
      await page.frames(2)
      const { menus } = await page.eval(() => window.events)
      assert.equal(menus.length, 1)
      assert.equal(menus[0].line, 7)
      assert.equal(menus[0].pos, await page.eval(() => window.view.state.doc.line(7).from))
      assert.deepEqual(await selection(), [[0, 0]], 'nor does a right click there')

      // A mark of the host is a layer of the number's background; the paused frame's is drawn over it.
      await page.eval(() => {
        const doc = window.view.state.doc
        window.view.setSource('bp', window.enc.DecorationSet.of(doc, { gutter: [{ line: 3, className: 'enc-bp' }, { line: 9, className: 'enc-bp-log' }] }))
        window.view.setSource('frame', window.enc.DecorationSet.of(doc, { gutter: [{ line: 9, className: 'enc-frame-top' }], lines: [{ line: 9, className: 'enc-line-paused' }] }))
      })
      await page.frames(2)
      const marks = await page.eval(() =>
        Object.fromEntries(
          [...document.querySelectorAll('.enc-gutter-num')]
            .filter((el) => ['2', '3', '9'].includes(el.textContent))
            .map((el) => [el.textContent, getComputedStyle(el).backgroundImage.split('url(').length - 1]),
        ),
      )
      assert.deepEqual(marks, { 2: 0, 3: 1, 9: 1 }, 'a dot on line 3; on line 9 the arrow, with the log point in it')
      await shot('breakpoints')

      // Off, the column goes, and a click on a number selects its line as before.
      await page.eval(() => window.view.setOptions({ breakpoints: false }))
      await page.frames(2)
      assert.equal(Math.round(wide - (await width())), 16, 'the column is 16 px wide')
      p = await spot(3, 6)
      await page.click(p.x, p.y)
      await page.frames(2)
      assert.equal((await page.eval(() => window.events)).clicks.length, 2)
      assert.notDeepEqual(await selection(), [[0, 0]])
    },
  },
]

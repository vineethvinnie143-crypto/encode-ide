/** Line n of the generated documents reads "line n". The gutter, the text and the position on screen must agree everywhere. */
function checkAligned(assert, view, label, atEnd = false) {
  // The last lines can scroll up the editor, so only two stay on screen at the very end.
  assert.ok(view.numbers.length >= (atEnd ? 2 : 5), `${label}: ${view.numbers.length} numbers on screen`)
  assert.equal(view.numbers.length, view.lines.length, `${label}: numbers and lines`)
  for (let index = 0; index < view.numbers.length; index++) {
    const { n, y } = view.numbers[index]
    assert.equal(view.lines[index].text, `line ${n}`, `${label}: text beside number ${n}`)
    assert.ok(Math.abs(view.lines[index].y - y) < 0.5, `${label}: line ${n} is at ${view.lines[index].y} but its number at ${y}`)
    if (index) assert.equal(n, view.numbers[index - 1].n + 1, `${label}: numbers run on`)
  }
  assert.ok(view.rendered < 200, `${label}: ${view.rendered} lines in the DOM`)
  assert.ok(view.nodes < 3000, `${label}: ${view.nodes} elements`)
}

const mountLines = (count) => {
  const text = Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')
  const started = performance.now()
  window.harness.mount({ text, path: 'a.txt', height: 400 })
  window.view.flush()
  return performance.now() - started
}

export const scale = [
  {
    name: '100000 lines: a window of lines follows the scroll offset',
    async run({ ev, settle, visible, assert, press, selection, page }) {
      const ms = await ev(mountLines, 100000)
      assert.ok(ms < 3000, `mounting took ${ms} ms`)
      await settle()
      let view = await visible()
      assert.equal(view.numbers[0].n, 1)
      checkAligned(assert, view, 'top')
      assert.equal(view.scrollHeight, 100000 * view.lineHeight + 400 - 2 * view.lineHeight)
      for (const scrollTop of [20, 777_777, 1_234_567]) {
        await ev((top) => void (window.view.scroller.scrollTop = top), scrollTop)
        await settle()
        view = await visible()
        checkAligned(assert, view, `scrollTop ${scrollTop}`)
        const expected = Math.floor(view.scrollTop / view.lineHeight) + 1
        assert.ok(Math.abs(view.numbers[0].n - expected) <= 1, `first line ${view.numbers[0].n}, expected ${expected}`)
      }
      // A jump over the whole document draws the new place at once.
      await ev(() => window.view.scroller.scrollTo(0, window.view.scroller.scrollHeight))
      await settle()
      view = await visible()
      checkAligned(assert, view, 'bottom', true)
      assert.ok(view.numbers.some((item) => item.n === 100000), 'the last line is reachable')
      await press('Home', { ctrl: true })
      assert.deepEqual(await selection(), [[0, 0]])
      view = await visible()
      assert.equal(view.numbers[0].n, 1)
      await press('End', { ctrl: true })
      const length = await ev(() => window.view.state.doc.length)
      assert.deepEqual(await selection(), [[length, length]])
      view = await visible()
      assert.ok(view.numbers.some((item) => item.n === 100000), 'Ctrl+End shows the last line')
      await press('PageUp')
      const lineNow = await ev(() => window.view.state.doc.lineAt(window.view.state.selection.main.head).number)
      assert.ok(lineNow < 100000 - 5 && lineNow > 100000 - 40, `page up moved to line ${lineNow}`)
    },
  },
  {
    name: '1500000 lines: the scroll range is scaled and every offset maps to the right lines',
    async run({ ev, settle, visible, assert, page, press, selection, at, geom }) {
      const ms = await ev(mountLines, 1_500_000)
      assert.ok(ms < 8000, `mounting took ${ms} ms`)
      await settle()
      let view = await visible()
      checkAligned(assert, view, 'top')
      assert.ok(view.scrollHeight <= 8_000_100, `scroll height ${view.scrollHeight}`)
      const total = 1_500_000 * view.lineHeight + (view.height - 2 * view.lineHeight)
      const maxScroll = view.scrollHeight - view.height
      for (const fraction of [0.001, 0.25, 0.5, 0.9, 1]) {
        const scrollTop = Math.floor(maxScroll * fraction)
        await ev((top) => void (window.view.scroller.scrollTop = top), scrollTop)
        await settle()
        view = await visible()
        checkAligned(assert, view, `fraction ${fraction}`, fraction === 1)
        const docTop = (view.scrollTop / maxScroll) * (total - view.height)
        const expected = Math.floor(docTop / view.lineHeight) + 1
        assert.ok(Math.abs(view.numbers[0].n - expected) <= 1, `fraction ${fraction}: first line ${view.numbers[0].n}, expected about ${expected}`)
      }
      view = await visible()
      assert.ok(view.numbers.some((item) => item.n === 1_500_000), 'the last line is reachable at the end of the scroll range')

      // The wheel moves the text by what it was turned by, not by the scale factor.
      await ev(() => void (window.view.scroller.scrollTop = 4_000_000))
      await settle()
      const before = (await visible()).numbers[0]
      await page.wheel(300, 200, 100)
      await settle(4)
      const after = (await visible()).numbers[0]
      const moved = (after.n - before.n) * view.lineHeight + (before.y - after.y)
      assert.ok(Math.abs(moved - 100) <= 1.5, `a wheel step of 100 moved the text by ${moved}`)

      // A click lands on the line under the pointer.
      const g = await geom()
      const target = (await visible()).numbers[5]
      await page.click(g.left + g.paddingX + 10, g.top + target.y + g.lineHeight / 2)
      await settle()
      const line = await ev(() => window.view.state.doc.lineAt(window.view.state.selection.main.head).number)
      assert.equal(line, target.n)

      // Typing at the caret keeps it on screen, and Ctrl+End reveals the end.
      await press('End', { ctrl: true })
      view = await visible()
      assert.ok(view.numbers.some((item) => item.n === 1_500_000), 'Ctrl+End shows the last line')
      await press('Home', { ctrl: true })
      view = await visible()
      assert.equal(view.numbers[0].n, 1)
      checkAligned(assert, view, 'after Ctrl+Home')

      // Select all: the rectangles drawn stay few.
      await press('a', { ctrl: true })
      const rects = await ev(() => document.querySelectorAll('.enc-selection-rect').length)
      assert.ok(rects > 0 && rects < 200, `${rects} selection rectangles`)
      const [[anchor, head]] = await selection()
      assert.equal(anchor, 0)
      assert.ok(head > 10_000_000)
    },
  },
]

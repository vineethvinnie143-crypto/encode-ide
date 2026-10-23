const nested = () => {
  const lines = ['class Shape {', '  area() {']
  for (let index = 0; index < 60; index++) lines.push(`    step(${index})`)
  lines.push('  }', '  describe() {')
  for (let index = 0; index < 60; index++) lines.push(`    say(${index})`)
  lines.push('  }', '}', 'after()')
  return lines.join('\n')
}

export const structure = [
  {
    name: 'sticky scroll: the blocks the top line is in stay pinned, pushed up as they end, and a click goes to one',
    async run({ mount, ev, assert, settle, page, selection, shot }) {
      await mount({ text: nested(), path: 'a.ts', height: 400, config: { stickyScroll: true } })
      const pinned = () =>
        ev(() =>
          [...document.querySelectorAll('.enc-sticky:not([hidden]) .enc-sticky-row')].map((row) => ({
            n: Number(row.querySelector('.enc-sticky-num').textContent),
            text: row.querySelector('.enc-sticky-text').textContent,
            top: parseFloat(row.style.top),
          })),
        )
      assert.deepEqual(await pinned(), [], 'nothing pinned at the top of the file')
      const lh = await ev(() => window.view.metrics.lineHeight)
      // Scroll so line 20 (inside area()) is at the top.
      await ev((h) => (window.view.scroller.scrollTop = 19 * h), lh)
      await settle()
      assert.deepEqual(
        (await pinned()).map((row) => [row.n, row.text]),
        [
          [1, 'class Shape {'],
          [2, '  area() {'],
        ],
      )
      await shot('sticky')
      // Near the end of area(): its line is pushed up as the block's last line leaves.
      await ev((h) => (window.view.scroller.scrollTop = 60.5 * h), lh)
      await settle()
      const pushed = await pinned()
      assert.equal(pushed[1]?.n, 2)
      assert.ok(pushed[1].top < lh, `pushed up (${pushed[1].top})`)
      // Inside describe(): the second pinned line is now describe().
      await ev((h) => (window.view.scroller.scrollTop = 80 * h), lh)
      await settle()
      assert.deepEqual(
        (await pinned()).map((row) => row.n),
        [1, 64],
      )
      // A click on the pinned describe() line puts the cursor on it.
      const box = await ev(() => {
        const rect = document.querySelectorAll('.enc-sticky-row')[1].getBoundingClientRect()
        return { x: rect.left + 200, y: rect.top + rect.height / 2 }
      })
      await page.click(box.x, box.y)
      await settle()
      const line64 = await ev(() => window.view.state.doc.line(64).from + 2)
      assert.deepEqual(await selection(), [[line64, line64]])
      // Turned off, nothing is pinned.
      await ev(() => window.view.setOptions({ stickyScroll: false }))
      await settle()
      assert.deepEqual(await pinned(), [])
    },
  },
  {
    name: 'bracket colours: brackets take a colour by depth, strings and comments are left alone, a stray closer stands out',
    async run({ mount, ev, assert, settle, typeKeys }) {
      await mount({ text: 'f(a, [b, {c: "(("}])\n// ( not here\n)', path: 'a.ts', config: { bracketColors: true } })
      await settle()
      const brackets = () =>
        ev(() =>
          [...document.querySelectorAll('.enc-line')]
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
            .map((line) => [...line.querySelectorAll('[class*="enc-bracket-"]')].map((span) => `${span.textContent}${span.className.match(/enc-bracket-(\w+)/)[1]}`).join(' ')),
        )
      assert.deepEqual(await brackets(), ['(1 [2 {3 }3 ]2 )1', '', ')stray'])
      // Typing an opener above moves every depth below it.
      await ev(() => window.view.select(0))
      await typeKeys('[')
      await settle()
      const after = await brackets()
      assert.equal(after[0].split(' ')[0], '[1')
      await ev(() => window.view.setOptions({ bracketColors: false }))
      await settle()
      assert.deepEqual(await brackets(), ['', '', ''])
    },
  },
  {
    name: 'minimap: drawn beside the text, the slider follows the scroll, a click on it scrolls there',
    async run({ mount, ev, assert, settle, page, shot }) {
      const text = Array.from({ length: 2000 }, (_, index) => (index % 7 === 0 ? `function f${index}() {` : `  call(${index}, "text")`)).join('\n')
      await mount({ text, path: 'a.ts', width: 900, height: 400, config: { minimap: true } })
      await settle()
      const map = () =>
        ev(() => {
          const el = document.querySelector('.enc-minimap')
          if (!el || el.hidden) return null
          const box = el.getBoundingClientRect()
          const slider = el.querySelector('.enc-minimap-slider').getBoundingClientRect()
          const canvas = el.querySelector('canvas')
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, Math.min(canvas.height, 40)).data
          let inked = 0
          for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) inked++
          return { left: box.left, top: box.top, width: box.width, height: box.height, sliderTop: slider.top - box.top, sliderHeight: slider.height, inked }
        })
      const first = await map()
      assert.ok(first, 'the minimap shows')
      assert.ok(first.inked > 100, 'the text is drawn')
      assert.equal(Math.round(first.sliderTop), 0)
      const textRight = await ev(() => {
        const content = document.querySelector('.enc-scroller').getBoundingClientRect()
        return content.right
      })
      assert.ok(first.left + first.width <= textRight, 'it sits inside the editor, left of the scrollbar')
      await shot('minimap')
      // Scrolling moves the slider.
      await ev(() => (window.view.scroller.scrollTop = 4000))
      await settle()
      const scrolled = await map()
      assert.ok(scrolled.sliderTop > first.sliderTop, 'the slider moved down')
      // A click low on the map scrolls the editor there.
      const before = await ev(() => window.view.scroller.scrollTop)
      await page.click(first.left + 20, first.top + first.height - 10)
      await settle()
      assert.ok((await ev(() => window.view.scroller.scrollTop)) > before, 'the click scrolled down')
      // Too narrow for the text and the map: it steps aside.
      await mount({ text, path: 'a.ts', width: 420, height: 300, config: { minimap: true } })
      await settle()
      assert.equal(await map(), null)
    },
  },
]

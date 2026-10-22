const lines = (count) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')

/** What an application does with one editor and many documents, and with the element the editor sits in. */
export const host = [
  {
    name: 'switching documents restores each one\'s scroll position, also into a taller document',
    async run({ mount, ev, settle, assert }) {
      await mount({ text: 'short\ndocument', path: 'a.txt', height: 300 })
      await ev((text) => {
        window.__short = window.view.state
        window.__long = window.enc.EditorState.create({ doc: text, language: window.enc.languageForPath('long.txt') })
      }, lines(5000))
      await ev(() => window.view.setState(window.__long, { top: 4000, left: 0 }))
      // Until it has been drawn, the view still answers with the position it was asked for.
      assert.deepEqual(await ev(() => window.view.saveScroll()), { top: 4000, left: 0 })
      await settle(3)
      const first = await ev(() => window.view.viewportLines.first)
      const lineHeight = await ev(() => window.view.metrics.lineHeight)
      assert.ok(Math.abs(first - (Math.floor(4000 / lineHeight) + 1)) <= 1, `first line on screen is ${first}`)
      assert.equal(await ev(() => window.view.scroller.scrollTop), 4000)

      await ev(() => window.view.setState(window.__short))
      await settle(3)
      assert.equal(await ev(() => window.view.scroller.scrollTop), 0)
      await ev(() => window.view.setState(window.__long, { top: 2500, left: 0 }))
      await settle(3)
      assert.equal(await ev(() => window.view.scroller.scrollTop), 2500)
      assert.ok((await ev(() => window.view.renderedLineCount)) < 200)
    },
  },
  {
    name: 'an editor created in a hidden container draws, with the right metrics, once it is shown',
    async run({ mount, ev, settle, lineTexts, assert }) {
      await ev(() => void (document.getElementById('host').style.display = 'none'))
      await mount({ text: lines(300), path: 'a.txt', height: 300, focus: false })
      await ev(() => window.view.scrollToLine(120, false))
      assert.deepEqual(await lineTexts(), [], 'nothing is drawn while the container has no size')
      await ev(() => void (document.getElementById('host').style.display = ''))
      await settle(4)
      const metrics = await ev(() => window.view.metrics)
      assert.ok(metrics.charWidth > 4 && metrics.lineHeight >= 14, JSON.stringify(metrics))
      const texts = await lineTexts()
      assert.ok(texts.length >= 10, `${texts.length} lines drawn`)
      assert.ok(texts.includes('line 120'), 'the line that was asked for is on screen')
      const geometry = await ev(() => {
        const first = document.querySelector('.enc-line').getBoundingClientRect()
        return { left: first.left, content: document.querySelector('.enc-content').getBoundingClientRect().left }
      })
      assert.ok(Math.abs(geometry.left - geometry.content) < 1.5, JSON.stringify(geometry))
    },
  },
  {
    name: 'carets, selections and clicks stay on the glyphs at fractional display scaling',
    async run({ mount, ev, page, settle, assert }) {
      const line = Array.from({ length: 240 }, (_, index) => 'abcdefghij'[index % 10]).join('')
      try {
        for (const scale of [1.25, 1.5, 1.75, 2.5]) {
          await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: scale, mobile: false })
          await mount({ text: `${line}\nshort\n${line}`, path: 'a.txt', width: 900, height: 300 })
          await settle(4)
          // Where the browser put the boundary before column `col` of the first line, from the text itself.
          const glyphs = () => {
            const el = [...document.querySelectorAll('.enc-line')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]
            const at = (col) => {
              const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
              let rest = col
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (rest <= node.data.length) {
                  const range = document.createRange()
                  range.setStart(node, rest)
                  range.setEnd(node, rest)
                  return range.getBoundingClientRect().left
                }
                rest -= node.data.length
              }
              return NaN
            }
            return { at, top: el.getBoundingClientRect().top + 4 }
          }
          const carets = await ev((source) => {
            const { at } = new Function(`return (${source})()`)()
            return [0, 1, 37, 120, 239, 240].map((col) => ({ col, view: window.view.coordsAtPos(col).left, dom: at(col) }))
          }, glyphs.toString())
          for (const item of carets) {
            assert.ok(Math.abs(item.view - item.dom) <= 1, `${scale}x: column ${item.col} is at ${item.view}, the glyphs are at ${item.dom}`)
          }

          // A selection that makes the view scroll sideways still follows the glyphs.
          await ev(() => window.view.select(10, 200))
          await settle(4)
          const selected = await ev((source) => {
            const { at } = new Function(`return (${source})()`)()
            const rects = [...document.querySelectorAll('.enc-selection-rect')]
              .filter((el) => el.getClientRects().length)
              .map((el) => el.getBoundingClientRect())
              .sort((a, b) => a.top - b.top)
            return { rect: rects.length ? { left: rects[0].left, right: rects[0].right } : null, from: at(10), to: at(200), scrollLeft: window.view.scroller.scrollLeft }
          }, glyphs.toString())
          assert.ok(selected.scrollLeft > 0, `${scale}x: the view scrolled to the end of the selection`)
          assert.ok(selected.rect, `${scale}x: the selection is drawn`)
          assert.ok(
            Math.abs(selected.rect.left - selected.from) <= 1 && Math.abs(selected.rect.right - selected.to) <= 1,
            `${scale}x: selection ${selected.rect.left}-${selected.rect.right}, glyphs ${selected.from}-${selected.to}`,
          )

          // A click just right of a boundary puts the cursor after the glyph before it.
          const target = await ev((source) => {
            const { at, top } = new Function(`return (${source})()`)()
            return { x: at(150), y: top }
          }, glyphs.toString())
          await page.click(target.x + 1.5, target.y)
          await settle(2)
          const head = await ev(() => window.view.state.selection.main.head)
          assert.equal(head, 150, `${scale}x: a click just right of the boundary before column 150 landed on ${head}`)
        }
      } finally {
        await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
      }
    },
  },
]

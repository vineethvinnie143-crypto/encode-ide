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
]

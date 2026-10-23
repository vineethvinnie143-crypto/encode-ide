const sample = (lines) => Array.from({ length: lines }, (_, index) => `const value${index + 1} = ${index + 1} // line ${index + 1}`).join('\n')

/** The main cursor's box in client coordinates. */
const cursorBox = () => {
  const el = document.querySelector('.enc-cursor-main') ?? document.querySelector('.enc-cursor')
  if (!el) return null
  const rect = el.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

export const basic = [
  {
    name: 'a listener that fails is reported, and the others still hear the transaction',
    async run({ mount, ev, type, assert, page }) {
      await mount({ text: 'hello', path: 'a.txt' })
      await ev(() => {
        window.heard = []
        window.view.on('transaction', () => window.heard.push('first'))
        window.view.on('transaction', () => {
          throw new Error('a faulty feature')
        })
        window.view.on('transaction', (tr) => window.heard.push(tr.state.doc.toString()))
      })
      await type('a')
      await type('b')
      assert.deepEqual(await ev(() => window.heard), ['first', 'ahello', 'first', 'abhello'])
      assert.equal(await ev(() => window.view.state.doc.toString()), 'abhello')
      // Still an error of the page, as one thrown anywhere else is.
      assert.equal(page.errors.length, 2, page.errors.join('\n'))
      assert.ok(page.errors.every((error) => error.includes('a faulty feature')), page.errors.join('\n'))
      page.errors.length = 0
    },
  },
  {
    name: 'renders the first lines',
    async run({ mount, ev, lineTexts, assert, shot }) {
      await mount({ text: sample(100), path: 'a.ts' })
      const lines = await lineTexts()
      assert.equal(lines[0], 'const value1 = 1 // line 1')
      assert.ok(lines.length >= 20 && lines.length < 100, `rendered ${lines.length} lines`)
      const metrics = await ev(() => window.view.metrics)
      assert.ok(metrics.charWidth > 4 && metrics.lineHeight >= 14, JSON.stringify(metrics))
      await shot('render')
    },
  },
  {
    name: 'draws the caret where typing happens',
    async run({ mount, ev, type, text, selection, assert, shot }) {
      await mount({ text: 'hello\nworld', path: 'a.txt' })
      assert.equal(await ev(() => window.view.hasFocus), true, 'the editor has focus')
      await type('abc')
      assert.equal(await text(), 'abchello\nworld')
      assert.deepEqual(await selection(), [[3, 3]])
      const box = await ev(cursorBox)
      assert.ok(box, 'a caret is drawn')
      const expected = await ev(() => {
        const content = document.querySelector('.enc-content').getBoundingClientRect()
        const { charWidth, paddingX } = window.view.metrics
        return content.left + paddingX + 3 * charWidth
      })
      assert.ok(Math.abs(box.left - expected) < 1.5, `caret at ${box.left}, expected ${expected}`)
      await shot('typing')
    },
  },
  {
    name: 'moves with the arrow keys and edits',
    async run({ mount, press, text, selection, assert }) {
      await mount({ text: 'one\ntwo\nthree', path: 'a.txt' })
      await press('ArrowDown')
      await press('ArrowRight')
      await press('ArrowRight')
      assert.deepEqual(await selection(), [[6, 6]])
      await press('End')
      assert.deepEqual(await selection(), [[7, 7]])
      await press('ArrowDown', { shift: true })
      // The goal column of the line moves with the selection.
      assert.deepEqual(await selection(), [[7, 11]])
      await press('Backspace')
      assert.equal(await text(), 'one\ntwoee')
      await press('Enter')
      assert.equal(await text(), 'one\ntwo\nee')
      await press('z', { ctrl: true })
      assert.equal(await text(), 'one\ntwoee')
    },
  },
]

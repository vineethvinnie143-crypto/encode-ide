/** The ghost text drawn now, from the DOM: the first line's label and box, and the rows below it. */
const drawn = (ev) =>
  ev(() => {
    const inline = document.querySelector('.enc-inlay-ghost')
    const box = inline?.getBoundingClientRect()
    const rows = [...document.querySelectorAll('.enc-ghost-line')].map((row) => ({ text: row.textContent, top: row.getBoundingClientRect().top, height: row.getBoundingClientRect().height }))
    return { label: inline?.dataset.label ?? null, left: box?.left ?? null, right: box?.right ?? null, rows }
  })

const near = (assert, a, b, what) => assert.ok(Math.abs(a - b) < 0.75, `${what}: ${a} vs ${b}`)

export const ghost = [
  {
    name: 'ghost text: a suggestion drawn faded at the cursor without being text, its other lines as rows below, gone with any edit',
    async run({ mount, ev, assert, settle, lineTexts, type, shot }) {
      await mount({ text: 'function add(a, b) {\n\n}\nconst x = add(1, 2)', path: 'a.ts' })
      const lineTop = (n) =>
        ev((line) => {
          const els = [...document.querySelectorAll('.enc-line')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
          return els[line - 1].getBoundingClientRect().top
        }, n)

      // One line at the end of line 4: drawn after the caret, the text unchanged.
      const end = await ev(() => window.view.state.doc.length)
      await ev((pos) => window.view.select(pos), end)
      await ev((pos) => window.view.setGhostText({ pos, text: ' // three' }), end)
      await settle()
      let shown = await drawn(ev)
      assert.equal(shown.label, ' // three')
      assert.deepEqual(shown.rows, [])
      assert.deepEqual(await lineTexts(), ['function add(a, b) {', '', '}', 'const x = add(1, 2)'])
      near(assert, await ev((pos) => window.view.coordsAtPos(pos).left, end), shown.left, 'the caret is before the ghost text')
      assert.ok(shown.right - shown.left > 30, 'the ghost text takes room')
      assert.deepEqual(await ev(() => window.view.ghostText), { pos: end, text: ' // three' })
      assert.equal(await ev(() => window.view.state.doc.toString().includes('three')), false)

      // Several lines in the empty body: the first line inline, the others as rows, the lines after pushed down.
      const lineHeight = await ev(() => window.view.metrics.lineHeight)
      const before = await lineTop(3)
      const body = await ev(() => window.view.state.doc.line(2).from)
      await ev((pos) => window.view.select(pos), body)
      await ev((pos) => window.view.setGhostText({ pos, text: '  const sum = a + b\n  return sum' }), body)
      await settle()
      shown = await drawn(ev)
      assert.equal(shown.label, '  const sum = a + b')
      assert.deepEqual(shown.rows.map((row) => row.text), ['  return sum'])
      near(assert, shown.rows[0].height, lineHeight, 'a row is a line high')
      near(assert, (await lineTop(3)) - before, lineHeight, 'the closing brace moved down one row')
      near(assert, shown.rows[0].top, (await lineTop(2)) + lineHeight, 'the row is right below the line')
      await shot('ghost-text')

      // The same suggestion again changes nothing; another replaces it.
      await ev((pos) => window.view.setGhostText({ pos, text: '  const sum = a + b\n  return sum' }), body)
      await ev((pos) => window.view.setGhostText({ pos, text: '  return a + b' }), body)
      await settle()
      shown = await drawn(ev)
      assert.equal(shown.label, '  return a + b')
      assert.deepEqual(shown.rows, [])
      near(assert, await lineTop(3), before, 'the rows went with it')

      // Any edit takes it away: its owner sets it again for the text as it is.
      await type(' ')
      await settle()
      assert.equal((await drawn(ev)).label, null)
      assert.equal(await ev(() => window.view.ghostText), null)

      // A suggestion starting with a new line draws nothing in the line, only rows.
      const eol = await ev(() => window.view.state.doc.line(1).to)
      await ev((pos) => window.view.setGhostText({ pos, text: '\n  return a + b' }), eol)
      await settle()
      shown = await drawn(ev)
      assert.equal(shown.label, null)
      assert.deepEqual(shown.rows.map((row) => row.text), ['  return a + b'])

      // Null, another document, a place past the end and a read-only document show none.
      await ev(() => window.view.setGhostText(null))
      await settle()
      assert.deepEqual(await drawn(ev), { label: null, left: null, right: null, rows: [] })
      await ev((pos) => window.view.setGhostText({ pos, text: 'x\ny' }), eol)
      await ev(() => window.view.setState(window.enc.EditorState.create({ doc: 'other' })))
      await settle()
      assert.deepEqual((await drawn(ev)).rows, [])
      assert.equal(await ev(() => window.view.ghostText), null)
      await ev(() => window.view.setGhostText({ pos: 99, text: 'x' }))
      assert.equal(await ev(() => window.view.ghostText), null)
      await ev(() => window.view.setState(window.enc.EditorState.create({ doc: 'read only', readOnly: true })))
      await ev(() => window.view.setGhostText({ pos: 9, text: ' here' }))
      await settle()
      assert.equal((await drawn(ev)).label, null)
    },
  },
]

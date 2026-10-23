/** The hints of line 1, from the DOM: label, kind classes and box. */
const inlays = (ev) =>
  ev(() => {
    const first = [...document.querySelectorAll('.enc-line')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]
    return [...first.querySelectorAll('.enc-inlay')].map((el) => {
      const box = el.getBoundingClientRect()
      return { label: el.dataset.label, className: el.className, left: box.left, right: box.right, mid: (box.top + box.bottom) / 2 }
    })
  })

const near = (assert, a, b, what) => assert.ok(Math.abs(a - b) < 0.75, `${what}: ${a} vs ${b}`)

export const hints = [
  {
    name: 'inlay hints: drawn among the text without being part of it, the caret beside them, a click on one at its column, edits moving them',
    async run({ mount, ev, assert, settle, page, selection, lineTexts, type, shot }) {
      await mount({ text: 'let count = add(1, 2)\nlet b = 3', path: 'a.ts' })
      await ev(() =>
        window.view.setInlayHints([
          { line: 1, col: 9, label: ': number', kind: 'type' },
          { line: 1, col: 16, label: 'x:', kind: 'parameter', paddingRight: true },
          { line: 1, col: 19, label: 'y:', kind: 'parameter', paddingRight: true },
          // Not on any line, or past its end: left out.
          { line: 9, col: 0, label: 'gone' },
          { line: 2, col: 99, label: 'gone' },
        ]),
      )
      await settle()
      const drawn = await inlays(ev)
      assert.deepEqual(
        drawn.map((hint) => [hint.label, hint.className]),
        [
          [': number', 'enc-inlay enc-inlay-type'],
          ['x:', 'enc-inlay enc-inlay-parameter enc-inlay-pr'],
          ['y:', 'enc-inlay enc-inlay-parameter enc-inlay-pr'],
        ],
      )
      // The line's text is the document's: a hint is no text.
      assert.deepEqual(await lineTexts(), ['let count = add(1, 2)', 'let b = 3'])
      assert.ok(drawn[0].right - drawn[0].left > 20, 'the hint takes room')
      await shot('inlay-hints')

      // The caret at a type's hint stays with the name before it; at a parameter's, it goes after it, by the argument.
      const caretX = (pos) => ev((p) => window.view.coordsAtPos(p).left, pos)
      near(assert, await caretX(9), drawn[0].left, 'caret at the type hint')
      near(assert, await caretX(16), drawn[1].right, 'caret at the parameter hint')
      assert.ok((await caretX(10)) > drawn[0].right, 'the next column is past the hint')

      // A click on a hint puts the caret at its column; one on the text after it, in the text.
      await page.click((drawn[0].left + drawn[0].right) / 2, drawn[0].mid)
      await settle()
      assert.deepEqual(await selection(), [[9, 9]])
      await page.click(drawn[1].left + 2, drawn[1].mid)
      await settle()
      assert.deepEqual(await selection(), [[16, 16]])
      const one = await ev(() => window.view.coordsAtPos(16).left + 2)
      await page.click(one, drawn[1].mid)
      await settle()
      assert.deepEqual(await selection(), [[16, 16]], 'just inside the 1 is before it')

      // Typing where a type's hint is moves it along with the text after it; the other line keeps its hints.
      await ev(() => window.view.select(9))
      await type('s')
      await settle()
      const moved = await inlays(ev)
      assert.deepEqual(moved.map((hint) => hint.label), [': number', 'x:', 'y:'])
      near(assert, await caretX(10), moved[0].left, 'the hint follows the typed s')
      assert.equal(await ev(() => window.view.inlaysOf(1).map((hint) => hint.from).join(',')), '10,17,20')
      // Typing elsewhere on the line moves only what is after it.
      await ev(() => window.view.select(0))
      await type('x')
      await settle()
      assert.equal(await ev(() => window.view.inlaysOf(1).map((hint) => hint.from).join(',')), '11,18,21')

      // Removed, and another document has none.
      await ev(() => window.view.setInlayHints(null))
      await settle()
      assert.equal((await inlays(ev)).length, 0)
      await ev(() => window.view.setInlayHints([{ line: 1, col: 1, label: 'h' }]))
      await settle()
      await ev(() => window.view.setState(window.enc.EditorState.create({ doc: 'other' })))
      await settle()
      assert.equal(await ev(() => document.querySelectorAll('.enc-inlay').length), 0)
    },
  },
  {
    name: 'semantic tokens: names drawn as the server says over the highlighter, deprecated struck through, an edit dropping only what it touches',
    async run({ mount, ev, assert, settle, type }) {
      await mount({ text: 'const shape = make(box)\nshape.draw()\nold(shape)', path: 'a.ts' })
      const classOf = (line, text) =>
        ev(
          (n, word) => {
            const el = [...document.querySelectorAll('.enc-line')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[n - 1]
            return [...el.querySelectorAll('span')].find((span) => span.textContent === word)?.className ?? null
          },
          line,
          text,
        )
      const before = await classOf(1, 'make')
      const shapeBefore = await classOf(1, 'shape')
      await ev(() => {
        const T = window.enc.T
        window.view.setSemanticTokens([
          { line: 1, from: 6, to: 11, kind: T.variable },
          { line: 1, from: 14, to: 18, kind: T.type },
          { line: 1, from: 19, to: 22, kind: T.constant },
          { line: 2, from: 6, to: 10, kind: T.property },
          { line: 3, from: 0, to: 3, kind: T.function, deprecated: true },
          // Overlapping the one before it, or off its line: left out.
          { line: 3, from: 1, to: 2, kind: T.keyword },
          { line: 7, from: 0, to: 2, kind: T.keyword },
        ])
      })
      await settle()
      assert.equal(await classOf(1, 'shape'), 'tok-variable')
      assert.equal(await classOf(1, 'make'), 'tok-type', `over the highlighter's ${before}`)
      assert.equal(await classOf(1, 'box'), 'tok-constant')
      assert.equal(await classOf(2, 'draw'), 'tok-property')
      assert.equal(await classOf(3, 'old'), 'tok-function enc-deprecated')
      assert.equal(await ev(() => getComputedStyle(document.querySelector('.enc-deprecated')).textDecorationLine), 'line-through')

      // Typing inside `make` drops that token alone; the rest of the line keeps its own, moved.
      await ev(() => window.view.select(16))
      await type('X')
      await settle()
      assert.notEqual(await classOf(1, 'maXke'), 'tok-type')
      assert.equal(await classOf(1, 'shape'), 'tok-variable')
      assert.equal(await classOf(1, 'box'), 'tok-constant')
      assert.equal(await classOf(2, 'draw'), 'tok-property')
      // A line added above moves the rest down with their tokens.
      await ev(() => window.view.dispatch({ changes: { from: 0, insert: '\n' } }))
      await settle()
      assert.equal(await classOf(4, 'old'), 'tok-function enc-deprecated')

      // Bracket colours still apply over them.
      await ev(() => window.view.setOptions({ bracketColors: true }))
      await settle()
      assert.match(await classOf(4, '('), /enc-bracket-1/)
      assert.equal(await classOf(4, 'old'), 'tok-function enc-deprecated')

      // Removed: the highlighter's colours again.
      await ev(() => window.view.setSemanticTokens(null))
      await settle()
      assert.equal(await classOf(2, 'shape'), shapeBefore)
      assert.notEqual(await classOf(4, 'old'), 'tok-function enc-deprecated')
    },
  },
]

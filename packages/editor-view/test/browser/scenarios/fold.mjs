const SOURCE = [
  'function a() {', // 1
  '  if (x) {', // 2
  '    one()', // 3
  '    two()', // 4
  '  }', // 5
  '  three()', // 6
  '}', // 7
  '// #region tail', // 8
  'const z = 1', // 9
  '// #endregion', // 10
  'end()', // 11
].join('\n')

export const fold = [
  {
    name: 'folding: Ctrl+Shift+[ hides the block, arrows step over it, the marker and the chevron open it',
    async run({ mount, ev, press, page, assert, visible, selection, text, shot, settle }) {
      await mount({ text: SOURCE, path: 'a.ts' })
      const numbers = async () => (await visible()).numbers.map((entry) => entry.n)
      assert.deepEqual(await numbers(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
      // The cursor on line 3: the innermost block it is in folds, and the cursor goes to that block's first line.
      await ev(() => window.view.select(window.view.state.doc.line(3).from + 4))
      await press('[', { ctrl: true, shift: true })
      assert.deepEqual(await numbers(), [1, 2, 5, 6, 7, 8, 9, 10, 11])
      const line2 = await ev(() => window.view.state.doc.line(2).to)
      assert.deepEqual(await selection(), [[line2, line2]], 'the cursor left the hidden lines for the end of the first one')
      assert.deepEqual(await ev(() => window.view.folding.folded), [{ start: 2, end: 4 }])
      // Again: the next block out folds too.
      await press('[', { ctrl: true, shift: true })
      assert.deepEqual(await numbers(), [1, 7, 8, 9, 10, 11])
      await shot('fold-folded')
      // The arrow keys step over the folded block.
      await press('ArrowDown')
      assert.equal(await ev(() => window.view.state.doc.lineAt(window.view.state.selection.main.head).number), 7)
      await press('ArrowUp')
      assert.equal(await ev(() => window.view.state.doc.lineAt(window.view.state.selection.main.head).number), 1)
      // Ctrl+Shift+] on the first line opens the outer block; the inner one stays folded.
      await press(']', { ctrl: true, shift: true })
      assert.deepEqual(await numbers(), [1, 2, 5, 6, 7, 8, 9, 10, 11])
      // The marker after line 2 opens the inner one.
      const pill = await ev(() => {
        const el = document.querySelector('.enc-fold-pill')
        if (!el || el.style.display === 'none') return null
        const box = el.getBoundingClientRect()
        return { x: box.left + box.width / 2, y: box.top + box.height / 2, line: el.dataset.line }
      })
      assert.equal(pill?.line, '2')
      await page.click(pill.x, pill.y)
      await settle()
      assert.deepEqual(await numbers(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
      // The chevron in the gutter's last column folds the region.
      const chevron = await ev(() => {
        const gutter = document.querySelector('.enc-gutter').getBoundingClientRect()
        const row = [...document.querySelectorAll('.enc-gutter-num')].find((el) => el.textContent === '8').getBoundingClientRect()
        return { x: gutter.right - 8, y: row.top + row.height / 2 }
      })
      await page.click(chevron.x, chevron.y)
      await settle()
      assert.deepEqual(await numbers(), [1, 2, 3, 4, 5, 6, 7, 8, 11], 'a region folds to its end marker')
      assert.equal(await text(), SOURCE, 'folding never edits')
    },
  },
  {
    name: 'folding: an edit inside a fold or a search reaching into it opens it; typing after the first line keeps it',
    async run({ mount, ev, press, assert, visible, typeKeys }) {
      await mount({ text: SOURCE, path: 'a.ts' })
      const numbers = async () => (await visible()).numbers.map((entry) => entry.n)
      await ev(() => window.view.folding.restore([{ start: 1, end: 6 }]))
      await ev(() => window.view.flush())
      assert.deepEqual(await numbers(), [1, 7, 8, 9, 10, 11])
      // Typing at the end of the first line leaves the block folded.
      await ev(() => window.view.select(window.view.state.doc.line(1).to))
      await typeKeys(' ')
      assert.deepEqual(await numbers(), [1, 7, 8, 9, 10, 11])
      // An edit below the block moves it with the text.
      await ev(() => window.view.dispatch({ changes: { from: 0, insert: '// top\n' } }))
      await ev(() => window.view.flush())
      assert.deepEqual(await ev(() => window.view.folding.folded), [{ start: 2, end: 7 }])
      // A cursor put inside it (a search result, Go to line) opens it.
      await ev(() => window.view.select(window.view.state.doc.line(4).from))
      await ev(() => window.view.flush())
      assert.deepEqual(await ev(() => window.view.folding.folded), [])
      // An edit inside a fold opens it too.
      await ev(() => window.view.folding.restore([{ start: 2, end: 7 }]))
      await ev(() => window.view.dispatch({ changes: { from: window.view.state.doc.line(5).from, insert: 'x' } }))
      assert.deepEqual(await ev(() => window.view.folding.folded), [])
      // Fold all and unfold all.
      await press('[', { ctrl: true, alt: true })
      assert.ok((await ev(() => window.view.folding.folded.length)) >= 3, 'every block folded')
      await press(']', { ctrl: true, alt: true })
      assert.deepEqual(await ev(() => window.view.folding.folded), [])
    },
  },
  {
    name: 'folding: ranges from a language server replace the ones from the text, and a fold of 100,000 lines draws at once',
    async run({ mount, ev, assert, visible, settle }) {
      const body = Array.from({ length: 100_000 }, (_, index) => `  line(${index})`).join('\n')
      await mount({ text: `function big() {\n${body}\n}\nafter()`, path: 'a.ts' })
      await ev(() => window.view.folding.setRanges([{ start: 1, end: 100_001 }]))
      const took = await ev(() => {
        const started = performance.now()
        window.view.folding.fold(1)
        window.view.flush()
        return performance.now() - started
      })
      await settle()
      const shown = await visible()
      assert.deepEqual(
        shown.numbers.map((entry) => entry.n),
        [1, 100_002, 100_003],
      )
      assert.ok(took < 200, `folding took ${Math.round(took)} ms`)
      assert.ok(shown.rendered < 10, `only the lines that show are drawn (${shown.rendered})`)
    },
  },
]

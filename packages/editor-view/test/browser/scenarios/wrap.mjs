/**
 * Word wrap: long lines drawn as rows that fit the text area, and the caret, clicks, selections and keys that move by
 * row. Each check reads what the browser drew, not only the view's own bookkeeping.
 */

const words = (count, word = 'word') => Array.from({ length: count }, (_, index) => `${word}${index}`).join(' ')

/** The rows drawn for line `n`: their text and their boxes, from the DOM. */
const rowsOf = (n) => {
  const view = window.view
  const number = [...document.querySelectorAll('.enc-gutter-num')].find((el) => el.textContent === String(n))
  if (!number) return null
  const top = number.getBoundingClientRect().top
  const line = [...document.querySelectorAll('.enc-lines .enc-line')].find((el) => Math.abs(el.getBoundingClientRect().top - top) < 1)
  if (!line) return null
  const rows = [...line.querySelectorAll('.enc-row')]
  const range = document.createRange()
  const box = (el) => {
    range.selectNodeContents(el)
    const rect = range.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: el.getBoundingClientRect().top }
  }
  const content = document.querySelector('.enc-content').getBoundingClientRect()
  return {
    rows: rows.map((el) => ({ text: el.textContent, ...box(el) })),
    height: line.getBoundingClientRect().height,
    lineHeight: view.metrics.lineHeight,
    textLeft: content.left + view.metrics.paddingX,
  }
}

/** The main caret's box. */
const caret = () => {
  const el = document.querySelector('.enc-cursor-main') ?? document.querySelector('.enc-cursor')
  if (!el) return null
  const rect = el.getBoundingClientRect()
  return { left: rect.left, top: rect.top }
}

/** The breaks of line `n` as the view drew them. */
const breaksOf = (n) => {
  const view = window.view
  const wrap = view.wrapOf(view.state.doc.line(n))
  return { breaks: [...wrap.breaks], indent: wrap.indent }
}

export const wrap = [
  {
    name: 'word wrap draws a long line as rows that fit the text area, and nothing scrolls sideways',
    async run({ mount, ev, assert, shot }) {
      const long = words(60)
      await mount({ text: `short\n${long}\nend`, path: 'a.txt', config: { wordWrap: 'on' } })
      const drawn = await ev(rowsOf, 2)
      const { breaks } = await ev(breaksOf, 2)
      assert.ok(breaks.length >= 3, `${breaks.length + 1} rows`)
      assert.equal(drawn.rows.length, breaks.length + 1)
      assert.equal(drawn.rows.map((row) => row.text).join(''), long, 'the rows hold the whole line, in order')
      assert.equal(drawn.height, drawn.rows.length * drawn.lineHeight)
      // Each row starts a word: a break comes after a space.
      for (const at of breaks) assert.equal(long[at - 1], ' ', `a break at ${at}`)
      // The text area's right edge, less its padding.
      const edge = await ev(() => document.querySelector('.enc-content').getBoundingClientRect().left + window.view.textAreaWidth - window.view.metrics.paddingX)
      for (const row of drawn.rows) assert.ok(row.right <= edge + 1, `a row ends at ${row.right}, past ${edge}`)
      // Rows stack: each a line height below the one before, and the next line below the last row.
      drawn.rows.forEach((row, index) => assert.ok(Math.abs(row.top - (drawn.rows[0].top + index * drawn.lineHeight)) < 1))
      const after = await ev(() => [...document.querySelectorAll('.enc-gutter-num')].find((el) => el.textContent === '3').getBoundingClientRect().top)
      assert.ok(Math.abs(after - (drawn.rows[0].top + drawn.rows.length * drawn.lineHeight)) < 1, 'line 3 starts below the last row')
      const sideways = await ev(() => ({ scroll: window.view.scroller.scrollWidth, client: window.view.scroller.clientWidth }))
      assert.ok(sideways.scroll <= sideways.client, `scroll width ${sideways.scroll} > ${sideways.client}`)
      await shot('wrap-rows')
    },
  },
  {
    name: 'rows after the first are indented as the line is, and tabs reach the tab stops of their row',
    async run({ mount, ev, assert }) {
      const text = `    ${words(50)}\n\t${words(40, 'tab')}`
      await mount({ text, path: 'a.txt', config: { wordWrap: 'on' } })
      for (const [n, indent] of [
        [1, 4],
        [2, 4],
      ]) {
        const drawn = await ev(rowsOf, n)
        const { charWidth } = await ev(() => window.view.metrics)
        assert.ok(drawn.rows.length > 1)
        assert.equal((await ev(breaksOf, n)).indent, indent)
        for (const row of drawn.rows.slice(1)) {
          assert.ok(Math.abs(row.left - (drawn.textLeft + indent * charWidth)) < 1.5, `line ${n}: a row starts at ${row.left}, not ${drawn.textLeft + indent * charWidth}`)
        }
      }
      // Without the indent the rows start at the text's left edge.
      await ev(() => window.view.setOptions({ wrapIndent: false }))
      await ev(() => window.view.flush())
      const flat = await ev(rowsOf, 1)
      for (const row of flat.rows.slice(1)) assert.ok(Math.abs(row.left - flat.textLeft) < 1.5)
    },
  },
  {
    name: 'the caret and clicks follow the rows, and the end of a row is told from the start of the next',
    async run({ mount, ev, assert, page, settle }) {
      const long = words(60)
      await mount({ text: `${long}\nnext`, path: 'a.txt', config: { wordWrap: 'on' } })
      const { breaks } = await ev(breaksOf, 1)
      const metrics = await ev(() => window.view.metrics)
      const rows = (await ev(rowsOf, 1)).rows
      // A click in the second row, three characters in.
      await page.click(rows[1].left + metrics.charWidth * 3 + 1, rows[1].top + metrics.lineHeight / 2)
      await settle()
      assert.deepEqual(await ev(() => window.view.state.selection.ranges.map((range) => [range.anchor, range.head])), [[breaks[0] + 3, breaks[0] + 3]])
      let box = await ev(caret)
      assert.ok(Math.abs(box.top - rows[1].top) < 1, 'the caret is drawn in the second row')
      assert.ok(Math.abs(box.left - (rows[1].left + metrics.charWidth * 3)) < 1.5)
      // Past the end of the first row: the caret at its end, not at the start of the next.
      await page.click(rows[0].right + 3, rows[0].top + metrics.lineHeight / 2)
      await settle()
      const main = await ev(() => ({ head: window.view.state.selection.main.head, assoc: window.view.state.selection.main.assoc }))
      assert.deepEqual(main, { head: breaks[0], assoc: -1 })
      box = await ev(caret)
      assert.ok(Math.abs(box.top - rows[0].top) < 1, 'the caret stays on the first row')
      assert.ok(Math.abs(box.left - rows[0].right) < 1.5, `the caret at ${box.left}, the row ends at ${rows[0].right}`)
      // The same place, at the start of the second row.
      await page.click(rows[1].left - 1, rows[1].top + metrics.lineHeight / 2)
      await settle()
      assert.deepEqual(await ev(() => window.view.state.selection.main.head), breaks[0])
      box = await ev(caret)
      assert.ok(Math.abs(box.top - rows[1].top) < 1, 'the caret is at the start of the second row')
      // Typing there goes in at the break and the rows follow.
      await page.insertText('X')
      await settle()
      assert.ok((await ev(() => window.view.state.doc.line(1).text)).includes(' X'))
    },
  },
  {
    name: 'a selection across rows is drawn row by row, out to the edge rows wrap at',
    async run({ mount, ev, assert, shot }) {
      const long = words(60)
      await mount({ text: `${long}\nnext`, path: 'a.txt', config: { wordWrap: 'on' } })
      const { breaks } = await ev(breaksOf, 1)
      await ev((from, to) => window.view.select(from, to), 5, breaks[1] + 4)
      await ev(() => window.view.flush())
      const rects = await ev(() =>
        [...document.querySelectorAll('.enc-selection .enc-rect')]
          .filter((el) => el.style.display !== 'none')
          .map((el) => {
            const rect = el.getBoundingClientRect()
            return { left: rect.left, right: rect.right, top: rect.top }
          })
          .sort((a, b) => a.top - b.top),
      )
      const rows = (await ev(rowsOf, 1)).rows
      const metrics = await ev(() => window.view.metrics)
      assert.equal(rects.length, 3, JSON.stringify(rects))
      rects.forEach((rect, index) => assert.ok(Math.abs(rect.top - rows[index].top) < 1, `rect ${index} on row ${index}`))
      assert.ok(Math.abs(rects[0].left - (rows[0].left + 5 * metrics.charWidth)) < 1.5)
      // Rows the selection runs on from reach the edge rows wrap at, or past it the spaces a row keeps at its end (which
      // of the rows keeps such spaces depends on the font and the width); the last ends where the selection does.
      const edge = rows[0].left + (await ev(() => window.view.wrapping.spec.width)) * metrics.charWidth
      for (const index of [0, 1]) {
        const expected = Math.max(edge, rows[index].right)
        assert.ok(Math.abs(rects[index].right - expected) < 1, `rect ${index} ends at ${rects[index].right}, not ${expected}`)
      }
      assert.ok(Math.abs(rects[2].right - (rows[2].left + 4 * metrics.charWidth)) < 1.5)
      await shot('wrap-selection')
    },
  },
  {
    name: 'arrows move by row to the same column, and Home and End go to the row edge first',
    async run({ mount, ev, assert, press }) {
      const long = `  ${words(80)}`
      await mount({ text: `${long}\nlast line`, path: 'a.txt', config: { wordWrap: 'on' } })
      const { breaks, indent } = await ev(breaksOf, 1)
      assert.equal(indent, 2)
      const head = () => ev(() => ({ head: window.view.state.selection.main.head, assoc: window.view.state.selection.main.assoc ?? 1 }))
      await ev(() => window.view.select(8))
      await press('ArrowDown')
      // Column 8 of the line is column 8 of the next row, whose text starts after its two columns of indent.
      assert.deepEqual(await head(), { head: breaks[0] + 6, assoc: 1 })
      await press('ArrowDown')
      assert.deepEqual(await head(), { head: breaks[1] + 6, assoc: 1 })
      await press('ArrowUp')
      await press('ArrowUp')
      assert.deepEqual(await head(), { head: 8, assoc: 1 })
      // End: the end of the row, then of the line; Home: the row's start, then the line's first character, then its start.
      await press('ArrowDown')
      await press('End')
      assert.deepEqual(await head(), { head: breaks[1], assoc: -1 })
      await press('End')
      assert.deepEqual(await head(), { head: long.length, assoc: 1 })
      await ev((pos) => window.view.select(pos), breaks[1] + 3)
      await press('Home')
      assert.deepEqual(await head(), { head: breaks[1], assoc: 1 })
      await press('Home')
      assert.deepEqual(await head(), { head: 2, assoc: 1 })
      await press('Home')
      assert.deepEqual(await head(), { head: 0, assoc: 1 })
      // Shift and an arrow select a row.
      await ev(() => window.view.select(4))
      await press('ArrowDown', { shift: true })
      assert.deepEqual(await ev(() => [window.view.state.selection.main.anchor, window.view.state.selection.main.head]), [4, breaks[0] + 2])
      // From the last row of the line, down to the next line.
      await ev((pos) => window.view.select(pos), long.length - 1)
      await press('ArrowDown')
      assert.equal(await ev(() => window.view.state.doc.lineAt(window.view.state.selection.main.head).number), 2)
    },
  },
  {
    name: 'a narrower editor wraps again with the text at the top of the view kept in place',
    async run({ mount, ev, assert }) {
      const lines = Array.from({ length: 200 }, (_, index) => `${index} ${words(14 + (index % 9), `w${index}x`)}`).join('\n')
      await mount({ text: lines, path: 'a.txt', config: { wordWrap: 'on' }, height: 300 })
      // The view starts partway into line 120.
      await ev(() => {
        const view = window.view
        view.scrollToDocY(view.lineTop(120) + view.metrics.lineHeight)
        view.flush()
      })
      const topText = () =>
        ev(() => {
          const view = window.view
          const box = view.scroller.getBoundingClientRect()
          return view.posAtCoords(box.left + view.gutterWidthPx + view.metrics.paddingX + 1, box.top + 1)
        })
      const start = await topText()
      const startLine = await ev((pos) => window.view.state.doc.lineAt(pos).number, start)
      assert.equal(startLine, 120)
      for (const width of [520, 380, 900]) {
        await ev((w) => {
          document.getElementById('host').style.width = `${w}px`
        }, width)
        await ev(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await ev(() => window.view.flush())
        const now = await topText()
        // The row now at the top is the one the text first at the top went into: it starts at or before it, less than
        // a row before, however many times the width changed (so the top does not creep back a row at a time).
        const columns = await ev(() => Math.floor(window.view.textAreaWidth / window.view.metrics.charWidth))
        assert.equal(await ev((pos) => window.view.state.doc.lineAt(pos).number, now), startLine, `at ${width}px the top line is still the same`)
        assert.ok(now <= start && start - now < columns, `at ${width}px the top row starts at ${now}, the text first at the top is at ${start}`)
      }
    },
  },
  {
    name: 'turning wrapping on and off keeps the text at the top of the view',
    async run({ mount, ev, assert }) {
      const lines = Array.from({ length: 150 }, (_, index) => `line ${index} ${words(index % 3 === 0 ? 30 : 4)}`).join('\n')
      await mount({ text: lines, path: 'a.txt' })
      await ev(() => {
        const view = window.view
        view.scrollToDocY(view.lineTop(90))
        view.flush()
      })
      const topLine = () => ev(() => window.view.lineAtDocY(window.view.scrollTopInDoc))
      assert.equal(await topLine(), 90)
      await ev(() => {
        window.view.setOptions({ wordWrap: 'on' })
        window.view.flush()
      })
      assert.equal(await topLine(), 90)
      assert.ok(await ev(() => window.view.wrapped))
      await ev(() => {
        window.view.setOptions({ wordWrap: 'off' })
        window.view.flush()
      })
      assert.equal(await topLine(), 90)
      assert.ok(!(await ev(() => window.view.wrapped)))
    },
  },
  {
    name: 'a line of a million characters wraps, and only the rows near the view are drawn',
    async run({ mount, ev, assert }) {
      const text = await ev(() => {
        window.__long = Array.from({ length: 200_000 }, (_, index) => `w${index % 10_000}`).join(' ').slice(0, 1_000_000)
        return window.__long.length
      })
      assert.equal(text, 1_000_000)
      const opened = await ev(() => {
        const started = performance.now()
        window.harness.mount({ text: `first\n${window.__long}\nlast`, path: 'a.txt', config: { wordWrap: 'on' } })
        window.view.flush()
        return performance.now() - started
      })
      assert.ok(opened < 1500, `opened in ${Math.round(opened)} ms`)
      const counts = () => ev(() => ({ rows: document.querySelectorAll('.enc-row').length, nodes: document.querySelectorAll('*').length }))
      let drawn = await counts()
      assert.ok(drawn.rows > 0 && drawn.rows <= 400, `${drawn.rows} rows drawn`)
      // Scrolled to the middle of the line: the rows there are drawn, and the text is that of the line.
      const middle = await ev(() => {
        const view = window.view
        view.scrollToDocY((view.lineTop(2) + view.lineBottom(2)) / 2)
        view.flush()
        const box = view.scroller.getBoundingClientRect()
        const pos = view.posAtCoords(box.left + view.gutterWidthPx + view.metrics.paddingX + 1, box.top + box.height / 2)
        return { pos, line: view.state.doc.lineAt(pos).number }
      })
      assert.equal(middle.line, 2)
      assert.ok(middle.pos > 300_000 && middle.pos < 700_000, `the middle is at ${middle.pos}`)
      drawn = await counts()
      assert.ok(drawn.rows <= 400, `${drawn.rows} rows drawn`)
      // The end of the line, with Ctrl+End and typing.
      const typed = await ev(() => {
        const view = window.view
        const end = view.state.doc.line(2).to
        view.select(end)
        view.scrollToPos(end)
        view.flush()
        const started = performance.now()
        view.dispatch({ changes: { from: end, insert: ' tail' }, selection: window.enc.EditorSelection.cursor(end + 5), origin: 'input.type', scrollIntoView: true })
        view.flush()
        const took = performance.now() - started
        const caret = document.querySelector('.enc-cursor-main').getBoundingClientRect()
        const box = view.scroller.getBoundingClientRect()
        return { took, inView: caret.top >= box.top && caret.bottom <= box.bottom }
      })
      assert.ok(typed.inView, 'the caret at the end of the line is in view')
      assert.ok(typed.took < 150, `typing took ${Math.round(typed.took)} ms`)
    },
  },
  {
    name: 'spaces and tabs are marked as asked: all, at the boundary, at the end, or in a selection',
    async run({ mount, ev, assert, shot }) {
      const text = '  two  spaces\there one end  \nplain line'
      await mount({ text, path: 'a.txt', config: { renderWhitespace: 'all' } })
      const marks = () =>
        ev(() =>
          [...document.querySelectorAll('.enc-line .enc-ws')]
            .filter((el) => el.closest('.enc-line'))
            .map((el) => `${el.classList.contains('enc-ws-tab') ? 'tab' : 'space'}:${el.textContent.length}`),
        )
      // Every run, the single spaces between words of the second line too.
      assert.deepEqual(await marks(), ['space:2', 'space:2', 'tab:1', 'space:1', 'space:1', 'space:2', 'space:1'])
      // The text is unchanged: a click still lands on the right character.
      assert.equal(await ev(() => document.querySelector('.enc-line').textContent), text.split('\n')[0])
      await shot('whitespace-all')
      await ev(() => window.view.setOptions({ renderWhitespace: 'boundary' }))
      await ev(() => window.view.flush())
      assert.deepEqual(await marks(), ['space:2', 'space:2', 'tab:1', 'space:2'])
      await ev(() => window.view.setOptions({ renderWhitespace: 'trailing' }))
      await ev(() => window.view.flush())
      assert.deepEqual(await marks(), ['space:2'])
      await ev(() => window.view.setOptions({ renderWhitespace: 'selection' }))
      await ev(() => window.view.flush())
      assert.deepEqual(await marks(), [])
      await ev(() => window.view.select(0, 7))
      await ev(() => window.view.flush())
      assert.deepEqual(await marks(), ['space:2', 'space:2'])
      await ev(() => window.view.setOptions({ renderWhitespace: 'none' }))
      await ev(() => window.view.flush())
      assert.deepEqual(await marks(), [])
    },
  },
]

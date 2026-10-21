/** A string from code points, so this file holds no hidden or bidirectional characters. */
const ch = (...points) => String.fromCodePoint(...points)

/** Offsets in each line at a boundary between characters, as the view computes x for them and as a click would resolve them. */
function geometry(lines) {
  const view = window.view
  const doc = view.state.doc
  const out = []
  for (let n = 1; n <= doc.lineCount; n++) {
    const line = doc.line(n)
    const starts = []
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    for (const part of segmenter.segment(line.text)) starts.push(part.index)
    starts.push(line.text.length)
    const xs = starts.map((offset) => view.xOf(line, offset))
    const back = xs.map((x) => view.offsetAtX(line, x))
    out.push({ n, text: line.text, starts, xs, back })
  }
  return out
}

/** The left edge of every character cell as the browser laid it out, from DOM ranges over the drawn line. */
function domEdges(lineNumber) {
  const view = window.view
  const els = [...document.querySelectorAll('.enc-line')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
  const el = els[lineNumber - 1]
  const base = el.getBoundingClientRect().left
  const edges = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (let index = 0; index < node.data.length; index++) {
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      edges.push(range.getBoundingClientRect().left - base)
    }
  }
  return edges
}

export const text = [
  {
    name: 'positions: x of an offset and the offset at an x agree for every kind of text',
    async run({ mount, ev, assert, shot }) {
      const lines = [
        '\tif (x) {\t// tabs',
        'plain ascii text 0123456789',
        `caf${ch(0xe9)} ${ch(0x4e2d, 0x6587)} ab ${ch(0x1f600)} z`,
        `${ch(0x65, 0x301, 0x65, 0x301)} combining`,
        `bidi ${ch(0x202e)} marks ${ch(0x200b)} zero width ${ch(0)} nul`,
        `tags ${ch(0xe0068, 0xe0069)} and a filler ${ch(0x3164)} between`,
        `${ch(0x65e5, 0x672c, 0x8a9e, 0x306e, 0x30c6, 0x30ad, 0x30b9, 0x30c8)} and latin`,
        '',
        '    indented',
      ]
      await mount({ text: lines.join('\n'), path: 'a.ts', width: 700, height: 300 })
      await shot('positions')
      const result = await ev(geometry)
      for (const line of result) {
        for (let index = 1; index < line.xs.length; index++) {
          assert.ok(line.xs[index] >= line.xs[index - 1] - 0.01, `line ${line.n}: x decreases at ${line.starts[index]} (${line.xs[index - 1]} -> ${line.xs[index]})`)
        }
        for (let index = 0; index < line.starts.length; index++) {
          assert.equal(line.back[index], line.starts[index], `line ${line.n}: x ${line.xs[index]} of offset ${line.starts[index]} resolves to ${line.back[index]}`)
        }
      }
      // Plain text sits exactly where the font puts it.
      const metrics = await ev(() => window.view.metrics)
      for (const number of [2, 8]) {
        const edges = await ev(domEdges, number)
        const line = result[number - 1]
        for (let index = 0; index < edges.length; index++) {
          const expected = metrics.paddingX + index * metrics.charWidth
          assert.ok(Math.abs(edges[index] - expected) < 0.6, `line ${number}: character ${index} drawn at ${edges[index]}, expected ${expected}`)
          assert.ok(Math.abs(line.xs[index] - expected) < 0.6, `line ${number}: x of ${index} is ${line.xs[index]}, expected ${expected}`)
        }
      }
      // A tab advances to the next stop of the tab size.
      const tab = result[0]
      const tabSize = 4
      assert.ok(Math.abs(tab.xs[1] - (metrics.paddingX + tabSize * metrics.charWidth)) < 0.6, `tab ends at ${tab.xs[1]}`)
      // Wide and combining characters: the next character starts after them.
      const cjk = result[2]
      assert.ok(cjk.xs[6] - cjk.xs[5] > metrics.charWidth * 1.5, 'a CJK character is wider than a cell')
    },
  },
  {
    name: 'control and bidirectional characters are drawn as visible markers',
    async run({ mount, ev, assert, shot, text }) {
      const doc = `a${ch(0x202e)}b${ch(0x200b)}c${ch(0)}d${ch(0x2028)}e${ch(0x3164)}f${ch(0xe0068, 0xe0069)}g`
      await mount({ text: doc, path: 'a.txt', width: 500, height: 120 })
      await shot('controls')
      const markers = await ev(() => [...document.querySelectorAll('.enc-ctrl')].map((el) => el.getAttribute('data-label')))
      assert.deepEqual(markers, ['U+202E', 'U+200B', 'U+0000', 'U+2028', 'U+3164', 'U+E0068', 'U+E0069'])
      assert.equal(await text(), doc)
      // Nothing the markers stand for is in the page: a bidi control there would still reorder what follows.
      const drawn = await ev(() => [...document.querySelectorAll('.enc-line')].map((el) => el.textContent).join(''))
      assert.ok(!/[\u0000\u2028\u202e\u200b\u3164]/u.test(drawn) && !drawn.includes(String.fromCodePoint(0xe0068)), 'the characters themselves never reach the DOM')
      // The caret can still be put after the marked character with the arrow keys.
      const before = await ev(() => window.view.layerCoords(1).x)
      const after = await ev(() => window.view.layerCoords(2).x)
      assert.ok(after - before >= 8, `the marker is ${after - before} px wide`)
    },
  },
  {
    name: 'IME composition shows in place and commits as one edit',
    async run({ mount, ev, page, assert, text, selection, settle, shot }) {
      await mount({ text: 'ab', path: 'a.txt' })
      await page.key('End', { ctrl: false })
      await ev(() => {
        window.events = []
        for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) window.view.textarea.addEventListener(type, () => window.events.push(type))
      })
      await page.ime(ch(0x306b))
      await settle()
      assert.equal(await ev(() => window.view.input.composing), true)
      assert.equal(await ev(() => window.view.root.classList.contains('enc-composing')), true)
      assert.equal(await text(), 'ab', 'the document is untouched while composing')
      await page.ime(ch(0x65e5, 0x672c))
      await settle()
      await shot('ime')
      await page.insertText(ch(0x65e5, 0x672c))
      await settle()
      assert.equal(await text(), `ab${ch(0x65e5, 0x672c)}`)
      assert.deepEqual(await selection(), [[4, 4]])
      assert.equal(await ev(() => window.view.input.composing), false)
      assert.equal(await ev(() => window.view.textarea.value), '')
      // One undo takes the whole composition back.
      await page.key('z', { ctrl: true })
      await settle()
      assert.equal(await text(), 'ab')
    },
  },
  {
    name: 'copy, cut and paste go through the clipboard line by line',
    async run({ mount, ev, page, assert, text, selection, settle }) {
      await mount({ text: 'one\ntwo\nthree', path: 'a.txt' })
      await ev(() => {
        window.copied = []
        document.addEventListener('copy', (event) => window.copied.push(event.clipboardData.getData('text/plain')))
        document.addEventListener('cut', (event) => window.copied.push(event.clipboardData.getData('text/plain')))
      })
      // Copy with nothing selected copies the line.
      await page.key('ArrowDown')
      await page.command('copy')
      await settle()
      assert.deepEqual(await ev(() => window.copied), ['two\n'])
      // Cut with a selection.
      await page.key('ArrowRight', { shift: true })
      await page.key('ArrowRight', { shift: true })
      await page.command('cut')
      await settle()
      assert.equal(await text(), 'one\no\nthree')
      assert.deepEqual((await ev(() => window.copied)).slice(1), ['tw'])
      // Paste what was cut at the end of the first line.
      await page.key('ArrowUp')
      await page.key('End')
      await page.command('paste')
      await settle()
      assert.equal(await text(), 'onetw\no\nthree')
      await page.key('z', { ctrl: true })
      await settle()
      assert.equal(await text(), 'one\no\nthree')
    },
  },
  {
    name: 'a very long line is drawn in pieces around the viewport',
    async run({ mount, ev, page, assert, settle, selection }) {
      const long = Array.from({ length: 30000 }, (_, index) => `w${index}`).join(' ')
      await mount({ text: `short\n${long}\nafter`, path: 'a.txt', width: 700, height: 200 })
      const first = await ev(() => [...document.querySelectorAll('.enc-line')].map((el) => el.textContent.length))
      assert.ok(first[1] < 12000, `the line has ${first[1]} characters in the DOM`)
      assert.ok(first[1] > 700 / 8, 'and enough to fill the view')
      const width = await ev(() => document.querySelector('.enc-sizer').getBoundingClientRect().width)
      assert.ok(width > long.length * 7, `the scrollable width is ${width}`)
      // Scroll far to the right: the piece that is drawn is the one that belongs there.
      await ev(() => void (window.view.scroller.scrollLeft = 900_000))
      await settle(3)
      const piece = await ev(() => {
        const el = [...document.querySelectorAll('.enc-line')][1]
        const rect = window.view.scroller.getBoundingClientRect()
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        const range = document.createRange()
        let at = null
        for (let node = walker.nextNode(); node && !at; node = walker.nextNode()) {
          for (let index = 0; index < node.data.length; index++) {
            range.setStart(node, index)
            range.setEnd(node, index + 1)
            const box = range.getBoundingClientRect()
            if (box.left >= rect.left + 100) {
              at = { text: node.data.slice(index, index + 12), x: box.left - rect.left }
              break
            }
          }
        }
        return { at, scrollLeft: window.view.scroller.scrollLeft, charWidth: window.view.metrics.charWidth }
      })
      assert.ok(piece.at, 'text is drawn at the scrolled position')
      const column = Math.round((piece.scrollLeft + piece.at.x - 100 - 12 - 0) / piece.charWidth)
      assert.ok(Math.abs(long.indexOf(piece.at.text) - column) < 40, `text "${piece.at.text}" is at column ${long.indexOf(piece.at.text)} but drawn at about column ${column}`)
      // The end of the line can be reached with the keyboard.
      await page.key('ArrowDown')
      await page.key('End')
      await settle(3)
      const [[head]] = await selection()
      assert.equal(head, 'short\n'.length + long.length)
      const visible = await ev(() => window.view.isVisible(window.view.state.selection.main.head))
      assert.equal(visible, true, 'the end of the long line is on screen')
      const scrollLeft = await ev(() => window.view.scroller.scrollLeft)
      assert.ok(scrollLeft > 100_000, `scrolled to ${scrollLeft}`)
    },
  },
  {
    name: 'follows its container when it is resized and when the state is replaced',
    async run({ mount, ev, assert, settle, lineTexts }) {
      const text = Array.from({ length: 200 }, (_, index) => `row ${index + 1}`).join('\n')
      await mount({ text, path: 'a.txt', height: 200 })
      const small = (await lineTexts()).length
      await ev(() => void (document.getElementById('host').style.height = '640px'))
      await settle(4)
      const large = (await lineTexts()).length
      assert.ok(large > small + 10, `${small} lines at 200 px, ${large} at 640 px`)
      const bottom = await ev(() => {
        const last = [...document.querySelectorAll('.enc-line')].pop().getBoundingClientRect().bottom
        return last - window.view.scroller.getBoundingClientRect().top
      })
      assert.ok(bottom >= 640, `lines reach ${bottom} px`)
      await ev(() => void (window.view.scroller.scrollTop = 1500))
      await settle()
      await ev(() => window.view.setState(window.enc.EditorState.create({ doc: 'fresh\nstate', language: window.enc.languageForPath('a.md') })))
      await settle(3)
      assert.deepEqual(await lineTexts(), ['fresh', 'state'])
      assert.equal(await ev(() => window.view.scroller.scrollTop), 0)
    },
  },
  {
    name: 'a read-only editor moves and selects but does not edit',
    async run({ mount, page, assert, text, selection, settle, ev }) {
      await mount({ text: 'fixed text', path: 'a.txt', readOnly: true })
      await page.insertText('x')
      await page.key('Backspace')
      await page.key('ArrowRight')
      await page.key('ArrowRight', { shift: true })
      await settle()
      assert.equal(await text(), 'fixed text')
      assert.deepEqual(await selection(), [[1, 2]])
      assert.equal(await ev(() => window.view.root.classList.contains('enc-readonly')), true)
    },
  },
  {
    name: 'revealing a position far to the right on a line that was never drawn widens the scroll area',
    async run({ mount, ev, assert, settle }) {
      // More lines than the view scans for the longest one, so the width is only known for lines that were drawn.
      const target = await ev(() => {
        const lines = Array.from({ length: 60000 }, (_, index) => (index === 39999 ? `${'x'.repeat(2900)}needle${'y'.repeat(100)}` : `line ${index + 1}`))
        const text = lines.join('\n')
        window.harness.mount({ text, path: 'a.txt', width: 600, height: 300 })
        return text.indexOf('needle')
      })
      await settle()
      await ev((pos) => window.view.select(pos, pos + 6), target)
      await settle(4)
      const result = await ev(() => ({
        visible: window.view.isVisible(window.view.state.selection.main.head),
        scrollLeft: window.view.scroller.scrollLeft,
        charWidth: window.view.metrics.charWidth,
        line: window.view.state.doc.lineAt(window.view.state.selection.main.head).number,
      }))
      assert.equal(result.line, 40000)
      assert.equal(result.visible, true)
      assert.ok(result.scrollLeft > 2900 * result.charWidth - 600, `scrolled to ${result.scrollLeft}`)
      const box = await ev(() => {
        const rect = document.querySelector('.enc-selection-rect')?.getBoundingClientRect()
        const view = window.view.scroller.getBoundingClientRect()
        return rect && { left: rect.left - view.left, right: rect.right - view.left, width: view.width }
      })
      assert.ok(box && box.left > 0 && box.right < box.width, `the selection is drawn inside the view: ${JSON.stringify(box)}`)
    },
  },
  {
    name: 'a resize is drawn in the same frame',
    async run({ mount, ev, assert, settle }) {
      const text = Array.from({ length: 300 }, (_, index) => `row ${index + 1}`).join('\n')
      await mount({ text, path: 'a.txt', height: 160 })
      const counts = await ev(async () => {
        const host = document.getElementById('host')
        const before = window.view.renderedLineCount
        host.style.height = '700px'
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        return { before, after: window.view.renderedLineCount, lines: [...document.querySelectorAll('.enc-line')].length }
      })
      assert.ok(counts.after > counts.before + 10, JSON.stringify(counts))
      // Showing an editor that was hidden: drawn before the first paint.
      const shown = await ev(async (doc) => {
        const host = document.getElementById('host')
        host.style.display = 'none'
        window.harness.mount({ text: doc, path: 'a.txt', height: 300 })
        host.style.display = 'block'
        await new Promise((resolve) => requestAnimationFrame(resolve))
        return window.view.renderedLineCount
      }, text)
      assert.ok(shown > 10, `${shown} lines after the first frame`)
    },
  },
]

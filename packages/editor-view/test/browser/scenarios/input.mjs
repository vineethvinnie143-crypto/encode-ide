/** Windows input and display: screen scales, assistive technology and right-to-left text. */

const PAGE = { width: 1100, height: 760, mobile: false }

export const input = [
  {
    name: 'at 125% and 150% every line starts on a device pixel, and a change of scale measures again',
    async run({ mount, ev, page, assert, settle }) {
      try {
        await mount({ text: Array.from({ length: 40 }, (_, index) => `line ${index + 1} [x]`).join('\n'), path: 'a.txt' })
        // A line height that is not a whole number of pixels at 125%.
        await ev(() => window.view.root.style.setProperty('--enc-editor-line-height', '19px'))
        await settle(3)
        assert.equal(await ev(() => window.view.metrics.lineHeight), 19)
        for (const scale of [1.25, 1.5, 1.75, 1]) {
          await page.send('Emulation.setDeviceMetricsOverride', { ...PAGE, deviceScaleFactor: scale })
          // The page is told of the new scale when the browser gets to it, which on Windows can be some frames later.
          const deadline = Date.now() + 3000
          do await settle(2)
          while (Date.now() < deadline && !(await ev((s) => { const d = window.view.metrics.lineHeight * s; return Math.abs(d - Math.round(d)) < 1e-6 }, scale)))
          const seen = await ev(() => {
            const view = window.view
            const lines = [...document.querySelectorAll('.enc-line')].slice(0, 20).map((el) => el.getBoundingClientRect().top)
            return { ratio: devicePixelRatio, lineHeight: view.metrics.lineHeight, measuredAt: view.measuredRatio, lines }
          })
          assert.equal(seen.ratio, scale)
          const device = seen.lineHeight * scale
          assert.ok(Math.abs(device - Math.round(device)) < 1e-6, `at ${scale} a line is ${device} device pixels (measured at ${seen.measuredAt})`)
          assert.ok(Math.abs(seen.lineHeight - 19) <= 0.5 / scale + 1e-9, `at ${scale} the line height ${seen.lineHeight} stays near 19`)
          // Each line's own top, not a sum of heights: off a pixel by no more than the layout's 1/64 of a CSS pixel.
          for (const top of seen.lines) {
            const offset = (top - seen.lines[0]) * scale
            assert.ok(Math.abs(offset - Math.round(offset)) < 0.05, `at ${scale} a line starts ${offset} device pixels down`)
          }
        }
        assert.equal(await ev(() => window.view.metrics.lineHeight), 19)
      } finally {
        await page.send('Emulation.setDeviceMetricsOverride', { ...PAGE, deviceScaleFactor: 1 })
      }
    },
  },
  {
    name: 'a change of font size or line height measures the text again',
    async run({ mount, ev, page, assert, settle }) {
      await mount({ text: 'abcdefghij\nsecond', path: 'a.txt' })
      const before = await ev(() => ({ ...window.view.metrics }))
      await ev(() => {
        window.view.root.style.setProperty('--enc-editor-font-size', '20px')
        window.view.root.style.setProperty('--enc-editor-line-height', '30px')
      })
      await settle(4)
      const after = await ev(() => ({ ...window.view.metrics }))
      assert.ok(after.charWidth > before.charWidth * 1.4, `characters grew from ${before.charWidth} to ${after.charWidth}`)
      assert.equal(after.lineHeight, 30)
      // The caret and a click agree with the larger text.
      await page.key('End')
      await settle()
      const caret = await ev(() => {
        const range = document.createRange()
        range.selectNodeContents(document.querySelector('.enc-line'))
        return { cursor: document.querySelector('.enc-cursor-main').getBoundingClientRect().left, end: range.getBoundingClientRect().right }
      })
      assert.ok(Math.abs(caret.cursor - caret.end) < 2, `the caret at ${caret.cursor} is at the text's end ${caret.end}`)
      const second = await ev(() => document.querySelectorAll('.enc-line')[1].getBoundingClientRect().top - document.querySelectorAll('.enc-line')[0].getBoundingClientRect().top)
      assert.equal(second, 30)
    },
  },
  {
    name: 'for a screen reader the textarea holds the lines around the cursor, with the selection, and typing in it edits',
    async run({ mount, ev, page, assert, text, selection, settle }) {
      const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
      await mount({ text: lines.join('\n'), path: 'a.txt', config: { screenReader: true } })
      const field = () => ev(() => {
        const t = window.view.textarea
        return { value: t.value, start: t.selectionStart, end: t.selectionEnd, direction: t.selectionDirection }
      })
      // The first page of ten lines, the caret at the start.
      let seen = await field()
      assert.equal(seen.value, lines.slice(0, 10).join('\n'))
      assert.deepEqual([seen.start, seen.end], [0, 0])
      // Arrows move the caret in it, at once (before a frame is drawn).
      await page.key('ArrowDown')
      await page.key('End')
      seen = await field()
      assert.deepEqual([seen.start, seen.end], [13, 13])
      // A selection made backwards is selected backwards in it.
      await page.key('ArrowLeft', { shift: true })
      await page.key('ArrowLeft', { shift: true })
      seen = await field()
      assert.deepEqual([seen.start, seen.end, seen.direction], [11, 13, 'backward'])
      // Typing replaces the selection, through the textarea as a screen reader user's keyboard does.
      await page.insertText('X')
      await settle()
      assert.equal(await text(), lines.join('\n').replace('line 2', 'lineX'))
      seen = await field()
      assert.equal(seen.value.split('\n')[1], 'lineX')
      assert.deepEqual([seen.start, seen.end], [12, 12])
      // Backspace goes through the editor's commands; the textarea follows.
      await page.key('Backspace')
      seen = await field()
      assert.equal(seen.value.split('\n')[1], 'line')
      // The eleventh line is on the next page.
      await ev(() => window.view.dispatch({ selection: window.enc.SelectionRange.cursor(window.view.state.doc.line(12).from + 2) }))
      seen = await field()
      assert.equal(seen.value, (await text()).split('\n').slice(10, 20).join('\n'))
      assert.deepEqual([seen.start, seen.end], [10, 10])
      // A selection the screen reader makes (a braille display's routing key) becomes the editor's.
      await ev(() => window.view.textarea.setSelectionRange(3, 7, 'forward'))
      await settle(3)
      const from = await ev(() => window.view.state.doc.line(11).from)
      assert.deepEqual(await selection(), [[from + 3, from + 7]])
      // An input method composes in place and commits once.
      await ev(() => window.view.dispatch({ selection: window.enc.SelectionRange.cursor(window.view.state.doc.line(11).to) }))
      await page.ime('ka')
      await settle()
      assert.equal(await ev(() => document.querySelector('.enc-inlay-compose')?.dataset.label), 'ka')
      await page.insertText(String.fromCodePoint(0x304b))
      await settle()
      assert.equal((await text()).split('\n')[10], `line 11${String.fromCodePoint(0x304b)}`)
      seen = await field()
      assert.equal(seen.value.split('\n')[0], `line 11${String.fromCodePoint(0x304b)}`)
      assert.equal(seen.start, 8)
      // Paste.
      await ev(() => {
        const data = new DataTransfer()
        data.setData('text/plain', 'P')
        window.view.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      })
      assert.equal((await field()).value.split('\n')[0], `line 11${String.fromCodePoint(0x304b)}P`)
      // Turned off, the textarea is empty again and typing still works.
      await ev(() => window.view.setOptions({ screenReader: false }))
      assert.equal((await field()).value, '')
      await page.insertText('Q')
      await settle()
      assert.equal((await field()).value, '')
      assert.ok((await text()).includes(`line 11${String.fromCodePoint(0x304b)}PQ`))
    },
  },
  {
    name: 'a selection longer than the textarea takes keeps the part around the cursor, whole characters only',
    async run({ mount, ev, page, assert }) {
      const long = String.fromCodePoint(0x1f600).repeat(30_000)
      await mount({ text: `a\n${long}\nb`, path: 'a.txt', config: { screenReader: true } })
      await page.key('a', { ctrl: true })
      const seen = await ev(() => ({ length: window.view.textarea.value.length, start: window.view.textarea.selectionStart, end: window.view.textarea.selectionEnd, first: window.view.textarea.value.charCodeAt(0), last: window.view.textarea.value.charCodeAt(window.view.textarea.value.length - 1) }))
      assert.ok(seen.length <= 20_000, `${seen.length} characters`)
      assert.ok(!(seen.first >= 0xdc00 && seen.first <= 0xdfff), 'it does not start inside a character')
      assert.ok(!(seen.last >= 0xd800 && seen.last <= 0xdbff), 'nor end inside one')
      assert.equal(seen.end, seen.length)
    },
  },
  {
    name: 'a screen reader is told about folds and cursors, and Ctrl+M makes Tab move the focus',
    async run({ mount, ev, page, assert, text, settle }) {
      await mount({ text: 'function a() {\n  return 1\n}\nlet x = 1\nlet y = 1', path: 'a.ts' })
      const said = async () => {
        await new Promise((resolve) => setTimeout(resolve, 120))
        return ev(() => document.querySelector('.enc-announce').textContent)
      }
      const live = await ev(() => {
        const el = document.querySelector('.enc-announce')
        return [el.getAttribute('aria-live'), el.getBoundingClientRect().width]
      })
      assert.deepEqual(live, ['polite', 1])
      await page.key('[', { ctrl: true, shift: true })
      assert.equal(await said(), 'Folded.')
      await page.key(']', { ctrl: true, shift: true })
      assert.equal(await said(), 'Unfolded.')
      await ev(() => window.view.dispatch({ selection: window.enc.SelectionRange.cursor(window.view.state.doc.line(4).from) }))
      await page.key('ArrowDown', { ctrl: true, alt: true })
      assert.equal(await said(), '2 cursors.')
      await page.key('Escape')
      // Read-only: typing is refused out loud.
      await ev(() => window.view.dispatch({ config: { readOnly: true } }))
      await page.insertText('z')
      assert.equal(await said(), 'The editor is read-only.')
      await ev(() => window.view.dispatch({ config: { readOnly: false } }))
      // Ctrl+M: Tab leaves the editor; again: Tab indents.
      await ev(() => {
        const after = document.createElement('button')
        after.id = 'after'
        after.textContent = 'after'
        document.body.append(after)
      })
      await page.key('m', { ctrl: true })
      assert.equal(await said(), 'Tab now moves the focus.')
      const before = await text()
      await page.key('Tab', { keyCode: 9 })
      await settle()
      assert.equal(await text(), before)
      assert.equal(await ev(() => document.activeElement.id), 'after')
      await ev(() => window.view.focus())
      await page.key('m', { ctrl: true })
      assert.equal(await said(), 'Tab now inserts a tab.')
      await page.key('Tab', { keyCode: 9 })
      await settle()
      assert.notEqual(await text(), before)
      assert.equal(await ev(() => document.activeElement === window.view.textarea), true)
    },
  },
  {
    name: 'in a Windows contrast theme the selection, the caret and matches are drawn in system colours',
    async run({ mount, ev, page, assert, settle, shot }) {
      try {
        await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
        await mount({ text: 'const value = 1\nconst other = value', path: 'a.ts' })
        await settle()
        const caret = await ev(() => getComputedStyle(document.querySelector('.enc-cursor-main')).backgroundColor)
        assert.notEqual(caret, 'rgba(0, 0, 0, 0)')
        await ev(() => window.view.dispatch({ selection: new window.enc.SelectionRange(6, 11) }))
        await page.key('f', { ctrl: true })
        await page.insertText('value')
        await settle(4)
        await shot('forced-colors')
        const styles = await ev(() => {
          const pick = (selector) => {
            const el = document.querySelector(selector)
            if (!el) return null
            const style = getComputedStyle(el)
            return { outline: style.outlineStyle, adjust: style.forcedColorAdjust, background: style.backgroundColor }
          }
          return { forced: matchMedia('(forced-colors: active)').matches, selection: pick('.enc-selection-rect'), match: pick('.enc-mark-find') }
        })
        assert.equal(styles.forced, true)
        assert.equal(styles.selection.outline, 'solid')
        assert.equal(styles.selection.adjust, 'none')
        assert.ok(styles.match.outline === 'solid' || styles.match.outline === 'dashed', `a match is outlined (${styles.match.outline})`)
      } finally {
        await page.send('Emulation.setEmulatedMedia', { features: [] })
      }
    },
  },
  {
    name: 'right-to-left text stays in stored order unless asked, and then reads in its own order only inside strings and comments',
    async run({ mount, ev, page, assert, settle, selection, shot }) {
      const shalom = String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)
      const rlo = String.fromCodePoint(0x202e)
      const text = `const s = "${shalom}" + x // ${shalom}\nlet t = "a${rlo}b" + y`
      await mount({ text, path: 'a.ts', worker: false })
      await settle(4)
      // The x of each character of line `line` (0-based), drawn.
      const boxes = (line) => ev((line) => {
        const el = document.querySelectorAll('.enc-line')[line]
        const out = []
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        const base = el.getBoundingClientRect().left
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          for (let index = 0; index < node.data.length; index++) {
            const range = document.createRange()
            range.setStart(node, index)
            range.setEnd(node, index + 1)
            const box = range.getBoundingClientRect()
            out.push({ char: node.data[index], left: box.left - base, right: box.right - base })
          }
        }
        return out
      }, line)
      const order = (list) => list.filter((box) => box.char === shalom[0] || box.char === shalom[3]).slice(0, 2)
      // Off: stored order everywhere, nothing isolated.
      assert.equal(await ev(() => document.querySelectorAll('.enc-bidi').length), 0)
      let [first, last] = order(await boxes(0))
      assert.ok(first.left < last.left, 'stored order: the first letter is on the left')
      await ev(() => window.view.setOptions({ bidi: true }))
      await settle(4)
      await shot('bidi')
      assert.equal(await ev(() => document.querySelectorAll('.enc-line')[0].querySelectorAll('.enc-bidi').length), 2, 'the string and the comment')
      ;[first, last] = order(await boxes(0))
      assert.ok(first.left > last.left, 'reading order: the first letter is on the right')
      const line0 = await boxes(0)
      // The code around stays where it was: "+ x" after the string, in stored order.
      const plus = line0.find((box) => box.char === '+')
      const quoteEnd = line0.filter((box) => box.char === '"')[1]
      assert.ok(plus.left > quoteEnd.left, 'the code after the string stays after it')
      // A bidi control is still a marker and does not reorder: b is right of a.
      const line1 = await boxes(1)
      assert.ok(line1.find((box) => box.char === 'b').left > line1.find((box) => box.char === 'a').left)
      assert.equal(await ev(() => document.querySelectorAll('.enc-line')[1].querySelectorAll('.enc-ctrl').length), 1)
      assert.equal(await ev(() => document.querySelectorAll('.enc-line')[1].querySelectorAll('.enc-bidi').length), 0, 'no right-to-left letters there')
      // The caret before the first Hebrew letter is at that letter's right edge, the one after the last at its left.
      const at = text.indexOf(shalom)
      const caretX = async (pos) => {
        await ev((pos) => window.view.dispatch({ selection: window.enc.SelectionRange.cursor(pos) }), pos)
        await settle()
        return ev(() => {
          const line = document.querySelectorAll('.enc-line')[0].getBoundingClientRect().left
          return document.querySelector('.enc-cursor-main').getBoundingClientRect().left - line
        })
      }
      assert.ok(Math.abs((await caretX(at)) - first.right) < 1.5, 'before the first letter: its right edge')
      assert.ok(Math.abs((await caretX(at + 4)) - last.left) < 1.5, 'after the last: its left edge')
      // A click on the left half of the last letter (drawn leftmost) puts the caret after it.
      const point = await ev((x) => {
        const line = document.querySelectorAll('.enc-line')[0].getBoundingClientRect()
        return { x: line.left + x, y: line.top + line.height / 2 }
      }, last.left + 1)
      await page.mouse('mousePressed', point.x, point.y)
      await page.mouse('mouseReleased', point.x, point.y)
      await settle()
      assert.deepEqual(await selection(), [[at + 4, at + 4]])
      // Past the line's right edge is its end, though the end of right-to-left text is drawn left of it.
      await page.mouse('mousePressed', point.x + 600, point.y)
      await page.mouse('mouseReleased', point.x + 600, point.y)
      await settle()
      assert.deepEqual(await selection(), [[text.indexOf('\n'), text.indexOf('\n')]])
      // Selecting the middle two letters marks them where they are drawn: between the first and the last.
      await ev((at) => window.view.dispatch({ selection: new window.enc.SelectionRange(at + 1, at + 3) }), at)
      await settle()
      const rects = await ev(() => {
        const line = document.querySelectorAll('.enc-line')[0].getBoundingClientRect().left
        return [...document.querySelectorAll('.enc-selection-rect')].map((el) => {
          const box = el.getBoundingClientRect()
          return [box.left - line, box.right - line]
        })
      })
      assert.equal(rects.length, 1)
      assert.ok(rects[0][0] >= last.right - 1 && rects[0][1] <= first.left + 1, `the selection ${rects[0]} is between ${last.right} and ${first.left}`)
      // Typing Hebrew at the end of the word goes on reading leftwards.
      await ev((at) => window.view.dispatch({ selection: window.enc.SelectionRange.cursor(at + 4) }), at)
      await page.insertText(String.fromCodePoint(0x5d0))
      await settle()
      const now = await boxes(0)
      const typed = now.find((box) => box.char === String.fromCodePoint(0x5d0))
      const before = now.find((box) => box.char === shalom[3])
      const ended = await caretX(at + 5)
      assert.ok(typed.right <= before.left + 1, 'the new letter is drawn left of the one before it')
      assert.ok(Math.abs(ended - typed.left) < 1.5, 'and the caret after it at its left')
    },
  },
  {
    name: 'right-to-left prose reads in its own order in Markdown, and in a wrapped line',
    async run({ mount, ev, assert, settle }) {
      const word = String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)
      const prose = Array.from({ length: 30 }, () => word).join(' ')
      await mount({ text: `# ${word}\n\n${prose}\n\n\`${word}\``, path: 'a.md', width: 420, config: { bidi: true, wordWrap: 'on' } })
      await settle(4)
      const seen = await ev(() => {
        const lines = [...document.querySelectorAll('.enc-line')]
        return lines.map((el) => ({ rows: el.querySelectorAll('.enc-row').length, isolates: el.querySelectorAll('.enc-bidi').length }))
      })
      assert.ok(seen[0].isolates >= 1, 'the heading')
      assert.ok(seen[2].rows > 1, 'the paragraph wraps')
      assert.ok(seen[2].isolates >= seen[2].rows, 'each row reads in its own order')
      assert.equal(seen[4].isolates, 0, 'inline code stays in stored order')
      // The caret goes to the end of the wrapped paragraph and is drawn on its last row.
      await ev(() => window.view.dispatch({ selection: window.enc.SelectionRange.cursor(window.view.state.doc.line(3).to) }))
      await settle()
      const caret = await ev(() => {
        const row = [...document.querySelectorAll('.enc-line')[2].querySelectorAll('.enc-row')].pop().getBoundingClientRect()
        const box = document.querySelector('.enc-cursor-main').getBoundingClientRect()
        return { top: box.top - row.top, left: box.left - row.left, width: row.width }
      })
      assert.ok(Math.abs(caret.top) < 1, 'on the last row')
      assert.ok(caret.left >= 0 && caret.left <= caret.width, 'inside it')
    },
  },
]

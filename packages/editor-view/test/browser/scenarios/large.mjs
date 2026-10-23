import fs from 'node:fs'

/**
 * Large documents, measured. The 100 MB scenario times what a person does in a large file (open it, jump and scroll
 * through it, type, undo, search, copy everything) and fails when a step takes longer than its limit below. The limits
 * hold on the slowest machine the tests run on (a shared CI runner); what each step took is printed, and written to
 * ENCODE_MEASURES when that names a file.
 */

/** The most each step may take, in milliseconds. */
const LIMITS = {
  /** Build the document from its text and draw the first screen. */
  open: 3000,
  /** The worst jump to a far place (a click in the scroll bar), drawn. */
  jump: 100,
  /** The worst scroll by a wheel turn, drawn. */
  scroll: 50,
  /** A keystroke in the middle of the file, drawn: typical, and worst. */
  typeMedian: 25,
  typeWorst: 100,
  undo: 100,
  /** A search that reads to the end of the file without finding anything. */
  search: 1500,
  /** Find, from the find box: the jump to a match at the end of the file. */
  find: 1500,
  /** The whole text as one string, as Select all and Copy need it. */
  copy: 1500,
  /** The highlighting worker reads every line, from the moment the file opened. */
  highlight: 60_000,
  /** Script time on the page's own thread while the worker reads. */
  highlightPage: 1000,
  /** A keystroke in a line of ten million characters (a minified file), drawn: typical, and worst. */
  longTypeMedian: 30,
  longTypeWorst: 150,
  /** The caret moved by a key, and to the line's end, in that line. */
  longMove: 50,
  /** A click on the text far into that line, drawn. */
  longClick: 50,
  /** The same file wrapped at 40 columns: open, the worst far jump and wheel turn, a keystroke (typical, worst). */
  wrapOpen: 3000,
  wrapJump: 100,
  wrapScroll: 50,
  wrapTypeMedian: 25,
  wrapTypeWorst: 100,
  /** Every line's rows known, broken while the editor is idle, from the moment the file opened. */
  wrapSettle: 15_000,
}

/**
 * About `bytes` of JavaScript in blocks of seven lines; block n names n, so any line can be told from its number. Each
 * block starts in the tokenizer's start state, so its colours can be checked by tokenizing that block alone.
 */
const generate = (bytes) => {
  const lines = []
  let size = 0
  for (let n = 0; size < bytes; n++) {
    const block = [
      `export function handler${n}(input, options = {}) {`,
      `  const value = input.items.map((item) => item.price * 1.2) // tax ${n}`,
      `  if (!options.quiet) console.log(\`handled \${value.length} items\`, '${n}')`,
      `  /* a block comment about ${n} */`,
      `  return { id: ${n}, total: value.reduce((a, b) => a + b, 0), name: "item-${n}" }`,
      '}',
      '',
    ]
    for (const line of block) {
      lines.push(line)
      size += line.length + 1
    }
  }
  return lines.join('\n')
}

const measures = {}

function within(assert, name, ms) {
  measures[name] = Math.round(ms * 10) / 10
  assert.ok(ms <= LIMITS[name], `${name} took ${Math.round(ms)} ms; the limit is ${LIMITS[name]} ms`)
}

function report(label) {
  console.log(`       ${label}: ${Object.entries(measures).map(([name, ms]) => `${name} ${ms}`).join(', ')}`)
  const file = process.env.ENCODE_MEASURES
  if (file) fs.appendFileSync(file, `${JSON.stringify({ scenario: label, limits: LIMITS, measures })}\n`)
}

/** Script time on the page's own thread so far, in milliseconds. */
async function scriptTime(page) {
  const { metrics } = await page.send('Performance.getMetrics')
  return metrics.find((metric) => metric.name === 'ScriptDuration').value * 1000
}

/** Mounts `window.__text` in the page, as the app's editor shows a file: every display option on, the worker on. */
const mountLarge = (path, options) => {
  const { EditorState, EditorView, languageForPath } = window.enc
  const host = document.getElementById('host')
  window.view?.destroy()
  host.replaceChildren()
  host.style.width = '800px'
  host.style.height = '400px'
  const started = performance.now()
  const state = EditorState.create({ doc: window.__text, language: languageForPath(path) })
  const view = new EditorView({ state, parent: host, bracketColors: true, minimap: true, stickyScroll: true, highlighting: window.harness.highlighting(), ...options })
  view.flush()
  window.view = view
  window.__opened = started
  return performance.now() - started
}

/** Waits in the page until the highlighter knows every line's state; the time since the file opened. */
const untilHighlighted = () =>
  new Promise((resolve) => {
    const check = () => {
      if (window.view.highlightDone) resolve(performance.now() - window.__opened)
      else setTimeout(check, 20)
    }
    check()
  })

/** Whether the lines in the DOM show the document's text for their numbers. */
const linesMatch = () => {
  const view = window.view
  const els = [...document.querySelectorAll('.enc-lines .enc-line')]
  const numbers = [...document.querySelectorAll('.enc-gutter-num')].map((el) => Number(el.textContent))
  if (!els.length || numbers.length < 5) return `only ${els.length} lines drawn`
  const first = Math.min(...numbers)
  const texts = els.map((el) => el.textContent)
  for (let n = first; n < first + 5; n++) if (!texts.includes(view.state.doc.line(n).text)) return `line ${n} is not drawn as "${view.state.doc.line(n).text}"`
  return null
}

export const large = [
  {
    name: '100 MB of code: opens, scrolls, types, searches and colours within the measured limits',
    timeout: 180_000,
    async run({ ev, assert, page, settle }) {
      await page.send('Performance.enable')
      const size = await ev((source) => {
        window.__text = new Function(`return ${source}`)()(100 * 1024 * 1024)
        return { chars: window.__text.length }
      }, generate.toString())
      assert.ok(size.chars >= 100 * 1024 * 1024)

      // Opened and left alone: the worker reads every line while the page's thread only stores what comes back.
      within(assert, 'open', await ev(mountLarge, 'big.js', {}))
      const lineCount = await ev(() => window.view.state.doc.lineCount)
      assert.ok(lineCount > 2_000_000, `${lineCount} lines`)
      assert.equal(await ev(linesMatch), null)
      const startScript = await scriptTime(page)
      within(assert, 'highlight', await ev(untilHighlighted))
      within(assert, 'highlightPage', (await scriptTime(page)) - startScript)
      const colours = await ev(() => {
        const view = window.view
        const { Highlighter, Text, languageForPath } = window.enc
        const doc = view.state.doc
        // The kind of each character; the view's own tokens also carry bracket colours above the kind's bits.
        const kinds = (tokens, length) => {
          const out = []
          for (let index = 0; index < tokens.length; index += 2) {
            const end = index + 2 < tokens.length ? tokens[index + 2] : length
            for (let at = tokens[index]; at < end; at++) out.push(tokens[index + 1] & 0xff)
          }
          return out.join(',')
        }
        const wrong = []
        for (const block of [3, 150_000, Math.floor(doc.lineCount / 7) - 2]) {
          const first = block * 7 + 1
          const fresh = new Highlighter(languageForPath('big.js').tokenizer, Text.of(doc.lineTexts(first, first + 6)))
          for (let index = 0; index < 7; index++) {
            const length = doc.line(first + index).text.length
            const got = view.lineTokens(first + index)
            if (!got.exact) wrong.push(`line ${first + index} is not exact`)
            else if (kinds(got.tokens, length) !== kinds(fresh.line(index + 1).tokens, length)) wrong.push(`line ${first + index} is coloured otherwise`)
          }
        }
        return wrong
      })
      assert.deepEqual(colours, [])

      // Opened again and used at once, while the worker is still reading.
      await ev(mountLarge, 'big.js', {})

      // Far jumps, as a click in the scroll bar makes them, each drawn at once from what is known or guessed.
      const jumps = await ev(() => {
        const view = window.view
        const out = []
        for (const fraction of [0.5, 0.9, 0.25, 1, 0.75, 0.05]) {
          const started = performance.now()
          view.scroller.scrollTop = (view.scroller.scrollHeight - view.scroller.clientHeight) * fraction
          view.flush()
          out.push(performance.now() - started)
        }
        return out
      })
      within(assert, 'jump', Math.max(...jumps))
      await settle()
      assert.equal(await ev(linesMatch), null)

      // Wheel-sized steps through the middle.
      const steps = await ev(() => {
        const view = window.view
        view.scroller.scrollTop = (view.scroller.scrollHeight - view.scroller.clientHeight) * 0.6
        view.flush()
        const out = []
        for (let step = 0; step < 30; step++) {
          const started = performance.now()
          view.scroller.scrollTop += 120
          view.flush()
          out.push(performance.now() - started)
        }
        return out
      })
      within(assert, 'scroll', Math.max(...steps))
      assert.equal(await ev(linesMatch), null)

      // Typing in the middle of the file, a character at a time, each drawn; then undoing it.
      const typing = await ev(() => {
        const view = window.view
        const { EditorSelection } = window.enc
        const line = view.state.doc.line(Math.floor(view.state.doc.lineCount / 2))
        view.select(line.to)
        view.flush()
        const out = []
        for (const char of 'const typed = 42;') {
          const started = performance.now()
          const pos = view.state.selection.main.head
          view.dispatch({ changes: { from: pos, insert: char }, selection: EditorSelection.cursor(pos + 1), origin: 'input.type', scrollIntoView: true })
          view.flush()
          out.push(performance.now() - started)
        }
        const typed = view.state.doc.lineAt(view.state.selection.main.head).text.endsWith('const typed = 42;')
        const started = performance.now()
        view.runCommand('undo')
        view.flush()
        const undo = performance.now() - started
        return { out: out.sort((a, b) => a - b), typed, undo, back: view.state.doc.line(line.number).text === line.text }
      })
      assert.ok(typing.typed, 'the typed text is in the line')
      assert.ok(typing.back, 'undo took it out again')
      within(assert, 'typeMedian', typing.out[Math.floor(typing.out.length / 2)])
      within(assert, 'typeWorst', typing.out[typing.out.length - 1])
      within(assert, 'undo', typing.undo)

      // Searching: a miss reads the whole file; the find box jumps to the last block's function.
      const search = await ev(() => {
        const view = window.view
        const { compileSearch, findNext } = window.enc
        let started = performance.now()
        const missed = findNext(view.state.doc, compileSearch({ search: 'never written anywhere' }), 0)
        const miss = performance.now() - started
        const last = Math.floor(view.state.doc.lineCount / 7) - 1
        view.select(0)
        view.flush()
        view.find.open(false)
        started = performance.now()
        view.find.setQuery({ search: `handler${last}(` })
        view.flush()
        const find = performance.now() - started
        const head = view.state.selection.main
        const found = view.state.doc.sliceString(head.from, head.to)
        const shown = [...document.querySelectorAll('.enc-gutter-num')].some((el) => Number(el.textContent) === view.state.doc.lineAt(head.from).number)
        view.find.close()
        return { missed, miss, find, found, expected: `handler${last}(`, shown }
      })
      assert.equal(search.missed, null)
      assert.equal(search.found, search.expected)
      assert.ok(search.shown, 'the match is on screen')
      within(assert, 'search', search.miss)
      within(assert, 'find', search.find)

      within(
        assert,
        'copy',
        await ev(() => {
          const started = performance.now()
          const text = window.view.state.sliceDoc()
          return text.length > 0 ? performance.now() - started : Infinity
        }),
      )

      measures.heapMB = await ev(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6))
      report('100 MB')
      await ev(() => {
        window.view.destroy()
        window.__text = null
      })
    },
  },
  {
    name: '100 MB of code wrapped at 40 columns: opens, jumps, scrolls and types within the measured limits, the top held still as rows settle',
    timeout: 180_000,
    async run({ ev, assert, settle }) {
      for (const key of Object.keys(measures)) delete measures[key]
      await ev((source) => {
        window.__text = new Function(`return ${source}`)()(100 * 1024 * 1024)
      }, generate.toString())
      within(assert, 'wrapOpen', await ev(mountLarge, 'big.js', { wordWrap: 'column', wrapColumn: 40 }))
      const shown = () =>
        ev(() => {
          const view = window.view
          const wrapped = [...document.querySelectorAll('.enc-lines .enc-line')].filter((el) => el.querySelectorAll('.enc-row').length > 1)
          return { wrapped: wrapped.length, sideways: view.scroller.scrollWidth > view.scroller.clientWidth }
        })
      assert.ok(await ev(() => window.view.wrapped))
      assert.equal(await ev(linesMatch), null)
      let drawn = await shown()
      assert.ok(drawn.wrapped > 0 && !drawn.sideways, `${drawn.wrapped} lines drawn as rows; sideways ${drawn.sideways}`)

      // Far jumps, each drawn at once from the rows known or guessed.
      const jumps = await ev(() => {
        const view = window.view
        const out = []
        for (const fraction of [0.5, 0.9, 0.25, 1, 0.75, 0.05]) {
          const started = performance.now()
          view.scroller.scrollTop = (view.scroller.scrollHeight - view.scroller.clientHeight) * fraction
          view.flush()
          out.push(performance.now() - started)
        }
        return out
      })
      within(assert, 'wrapJump', Math.max(...jumps))
      await settle()
      assert.equal(await ev(linesMatch), null)

      // Wheel-sized steps through the middle.
      const steps = await ev(() => {
        const view = window.view
        view.scroller.scrollTop = (view.scroller.scrollHeight - view.scroller.clientHeight) * 0.6
        view.flush()
        const out = []
        for (let step = 0; step < 30; step++) {
          const started = performance.now()
          view.scroller.scrollTop += 120
          view.flush()
          out.push(performance.now() - started)
        }
        return out
      })
      within(assert, 'wrapScroll', Math.max(...steps))
      assert.equal(await ev(linesMatch), null)

      // Typing at the end of a line that wraps, in the middle of the file; the caret stays in view.
      const typing = await ev(() => {
        const view = window.view
        const { EditorSelection } = window.enc
        const middle = Math.floor(view.state.doc.lineCount / 14) * 7 + 3
        const line = view.state.doc.line(middle)
        view.dispatch({ selection: EditorSelection.cursor(line.to), scrollIntoView: true })
        view.flush()
        const out = []
        for (const char of ' + typed.length;') {
          const started = performance.now()
          const pos = view.state.selection.main.head
          view.dispatch({ changes: { from: pos, insert: char }, selection: EditorSelection.cursor(pos + 1), origin: 'input.type', scrollIntoView: true })
          view.flush()
          out.push(performance.now() - started)
        }
        const caret = view.coordsAtPos(view.state.selection.main.head)
        const box = view.scroller.getBoundingClientRect()
        return {
          out: out.sort((a, b) => a - b),
          typed: view.state.doc.line(middle).text.endsWith(' + typed.length;'),
          inView: caret.top >= box.top && caret.bottom <= box.bottom,
        }
      })
      assert.ok(typing.typed, 'the typed text is in the line')
      assert.ok(typing.inView, 'the caret is in view')
      within(assert, 'wrapTypeMedian', typing.out[Math.floor(typing.out.length / 2)])
      within(assert, 'wrapTypeWorst', typing.out[typing.out.length - 1])

      // Left alone: the rows still guessed are broken in idle time, and the line at the top of the view stays there.
      const top = () => ev(() => ({ line: window.view.lineAtDocY(window.view.scrollTopInDoc), done: window.view.wrapDone }))
      const before = await top()
      const settled = await ev(
        () =>
          new Promise((resolve) => {
            const check = () => {
              if (window.view.wrapDone) resolve(performance.now() - window.__opened)
              else setTimeout(check, 50)
            }
            check()
          }),
      )
      within(assert, 'wrapSettle', settled)
      await settle()
      const after = await top()
      assert.ok(after.done)
      assert.equal(after.line, before.line, 'the top line stayed while rows settled')
      assert.equal(await ev(linesMatch), null)

      // The end of the file, by key, is on screen once the rows near it are known.
      const end = await ev(() => {
        const view = window.view
        view.runCommand('cursorDocEnd')
        view.flush()
        const numbers = [...document.querySelectorAll('.enc-gutter-num')].map((el) => Number(el.textContent))
        return { last: view.state.doc.lineCount, shown: numbers.includes(view.state.doc.lineCount) }
      })
      assert.ok(end.shown, `line ${end.last} is on screen`)
      drawn = await shown()
      assert.ok(!drawn.sideways)

      measures.heapMB = await ev(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6))
      report('100 MB wrapped')
      await ev(() => {
        window.view.destroy()
        window.__text = null
      })
    },
  },
  {
    name: 'a line of ten million characters: typing, moving the caret and clicking in it stay within the measured limits',
    timeout: 120_000,
    async run({ ev, assert }) {
      for (const key of Object.keys(measures)) delete measures[key]
      await ev((repeat) => {
        // One line of minified JSON, then a short one.
        window.__text = `[${'{"key":"value","n":12345,"list":[1,2,3]},'.repeat(repeat)}{}]\nlast`
      }, 250_000)
      assert.ok((await ev(() => window.__text.length)) > 10_000_000)
      await ev(mountLarge, 'min.json', { minimap: true })
      const result = await ev(() => {
        const view = window.view
        const { EditorSelection } = window.enc
        const line = view.state.doc.line(1)
        const type = (at) => {
          view.select(at)
          view.flush()
          const out = []
          for (const char of '"typed":1,') {
            const started = performance.now()
            const pos = view.state.selection.main.head
            view.dispatch({ changes: { from: pos, insert: char }, selection: EditorSelection.cursor(pos + 1), origin: 'input.type', scrollIntoView: true })
            view.flush()
            out.push(performance.now() - started)
          }
          return out
        }
        const typing = [...type(line.from + Math.floor((line.to - line.from) / 2)), ...type(view.state.doc.line(1).to - 2)].sort((a, b) => a - b)
        view.focus()
        const moves = []
        for (const command of ['cursorCharLeft', 'cursorCharRight', 'cursorWordLeft', 'cursorLineStart', 'cursorLineEnd']) {
          const started = performance.now()
          view.runCommand(command)
          view.flush()
          moves.push(performance.now() - started)
        }
        const atEnd = view.state.selection.main.head === view.state.doc.line(1).to
        // The line is wider than a browser lets an element be: its end is drawn, and the caret there is in sight.
        const scroller = view.scroller.getBoundingClientRect()
        const caret = document.querySelector('.enc-cursor')?.getBoundingClientRect()
        const caretInSight = !!caret && caret.left >= scroller.left && caret.right <= scroller.right
        const drawnText = () => [...document.querySelectorAll('.enc-lines .enc-line')].map((el) => el.textContent).find((text) => text.length > 500) ?? ''
        const endDrawn = drawnText().endsWith('"typed":1,}]')
        view.scroller.scrollLeft = 0
        view.render()
        const startDrawn = drawnText().startsWith('[{"key"')
        view.scroller.scrollLeft = view.scroller.scrollWidth
        view.render()
        const endAgain = drawnText().endsWith('"typed":1,}]')
        // A click on the text on screen, far into the line.
        const box = [...document.querySelectorAll('.enc-lines .enc-line')][0].getBoundingClientRect()
        const started = performance.now()
        const pos = view.posAtCoords(scroller.left + scroller.width / 2, box.top + box.height / 2)
        view.select(pos)
        view.flush()
        const click = performance.now() - started
        const clicked = pos > view.state.doc.line(1).to - 1000
        // Everything selected: the part of the selection in sight is drawn across the text area.
        view.runCommand('selectAll')
        view.flush()
        view.scroller.scrollLeft = view.scroller.scrollWidth / 2
        view.render()
        const shown = [...document.querySelectorAll('.enc-selection-rect')].map((el) => el.getBoundingClientRect())
        const selectionInSight = view.scrollLeftInDoc > 10_000_000 && shown.some((box) => box.left <= scroller.left + 100 && box.right >= scroller.right - 100)
        return {
          typing,
          moves,
          atEnd,
          caretInSight,
          endDrawn,
          startDrawn,
          endAgain,
          selectionInSight,
          click,
          clicked,
          typed: view.state.doc.line(1).text.split('"typed":1,').length - 1,
        }
      })
      measures.longTypeMedian = result.typing[Math.floor(result.typing.length / 2)]
      measures.longTypeWorst = result.typing[result.typing.length - 1]
      measures.longMove = Math.max(...result.moves)
      measures.longClick = result.click
      report('10 MB line')
      assert.equal(result.typed, 2, 'both runs of typing are in the line')
      assert.ok(result.atEnd, 'the caret went to the line end')
      assert.deepEqual(
        { caretInSight: result.caretInSight, endDrawn: result.endDrawn, startDrawn: result.startDrawn, endAgain: result.endAgain, selectionInSight: result.selectionInSight },
        { caretInSight: true, endDrawn: true, startDrawn: true, endAgain: true, selectionInSight: true },
        'both ends of the line can be scrolled to and are drawn',
      )
      assert.ok(result.clicked, 'the click landed in the part of the line on screen')
      for (const name of ['longTypeMedian', 'longTypeWorst', 'longMove', 'longClick']) within(assert, name, measures[name])
      await ev(() => {
        window.view.destroy()
        window.__text = null
      })
    },
  },
  {
    name: 'a line far past what is known shows a guess at once, and its true colours once the worker reaches it',
    timeout: 120_000,
    async run({ ev, assert }) {
      await ev(() => {
        // A comment opened on the first line and closed 300,000 lines on: every line between is a comment.
        const lines = Array.from({ length: 400_000 }, (_, index) => `let value${index} = ${index}`)
        lines[0] = '/* opened here'
        lines[300_000] = 'closed here */ let after = 1'
        window.__text = lines.join('\n')
      })
      await ev(mountLarge, 'far.ts', { minimap: false })
      const before = await ev(() => {
        const view = window.view
        view.scrollToPos(view.state.doc.line(200_000).from, true)
        view.flush()
        const el = [...document.querySelectorAll('.enc-line')].find((line) => line.textContent === 'let value199999 = 199999')
        return { drawn: Boolean(el), comment: Boolean(el?.querySelector('.tok-comment')), exact: view.lineTokens(200_000).exact }
      })
      assert.ok(before.drawn)
      assert.equal(before.exact, false, 'drawn from a guess')
      assert.equal(before.comment, false, 'the guess does not know about the comment above')
      await ev(untilHighlighted)
      const after = await ev(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const el = [...document.querySelectorAll('.enc-line')].find((line) => line.textContent === 'let value199999 = 199999')
                resolve({ comment: Boolean(el?.querySelector('.tok-comment')) && !el.querySelector('.tok-keyword'), exact: window.view.lineTokens(200_000).exact })
              }),
            )
          }),
      )
      assert.deepEqual(after, { comment: true, exact: true })
      // An edit at the top that closes the comment: the worker reads on from there and the far line is code again.
      await ev(() => window.view.dispatch({ changes: { from: 2, insert: '*/' } }))
      await ev(untilHighlighted)
      const edited = await ev(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const el = [...document.querySelectorAll('.enc-line')].find((line) => line.textContent === 'let value199999 = 199999')
                resolve(Boolean(el?.querySelector('.tok-keyword')))
              }),
            ),
          ),
      )
      assert.ok(edited, 'the far line is drawn as code after the comment was closed above it')
      await ev(() => (window.__text = null))
    },
  },
  {
    name: 'when the highlighting worker fails the view colours the document itself',
    async run({ ev, assert }) {
      await ev(() => {
        window.__text = Array.from({ length: 60_000 }, (_, index) => `const v${index} = "${index}"`).join('\n')
      })
      await ev(mountLarge, 'fail.ts', { minimap: false })
      const result = await ev(() => {
        window.harness.highlighting().close()
        return new Promise((resolve) => {
          const started = performance.now()
          const check = () => {
            if (window.view.highlightDone || performance.now() - started > 30_000) resolve(window.view.highlightDone)
            else setTimeout(check, 20)
          }
          check()
        })
      })
      assert.equal(result, true)
      await ev(() => (window.__text = null))
    },
  },
]

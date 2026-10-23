/**
 * The view under random use: keys, typing, input methods, clicks, drags, wheel scrolling, folding, several cursors,
 * undo and redo, a resize, in a document with tabs, wide characters, emoji, accents, a long line and right-to-left
 * text, with word wrap off and on. After every step what the browser drew is checked against the document: every
 * line in the DOM holds its line's text, in order, below the one before; the gutter numbers its lines; the editor's
 * state keeps its invariants; the screen reader's field holds the text around the cursor; nothing threw.
 *
 * Seeded and the same every run. ENCODE_MONKEY_STEPS runs more steps, ENCODE_MONKEY_SEED other ones: a failure says
 * the seed and the step, and what was done up to it.
 */

/** mulberry32. */
function prng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const u = (...codes) => String.fromCodePoint(...codes)
const accent = `e${u(0x301)}`
const family = [0x1f468, 0x1f469, 0x1f467].map((code) => u(code)).join(u(0x200d))
const han = u(0x6f22, 0x5b57)
const kana = u(0x306b, 0x307b, 0x3093)
const hangul = u(0xd55c, 0xad6d)
const smile = u(0x1f600)
// Hebrew: "peace", "world" and "note".
const shalom = u(0x5e9, 0x5dc, 0x5d5, 0x5dd)
const olam = u(0x5e2, 0x5d5, 0x5dc, 0x5dd)
const note = u(0x5d4, 0x5e2, 0x5e8, 0x5d4)
const DOC = [
  'export function greet(name: string) {',
  '\tconst text = `hello ${name}` // greeting',
  '  if (name.length > 3) {',
  `    return "caf${accent} ${han} ${smile} ${family}"`,
  '  }',
  `  const note = '${shalom} ${olam}' // ${note}`,
  `  const long = "${'word '.repeat(120).trim()}"`,
  '  return text',
  '}',
  '',
  'for (const item of [1, 2, 3]) console.log(item)',
  ...Array.from({ length: 40 }, (_, index) => `line ${index}\t= ${index * 7} ${index % 5 === 0 ? '// five' : ''}`),
].join('\n')

const KEYS = [
  ['ArrowLeft'], ['ArrowRight'], ['ArrowUp'], ['ArrowDown'], ['Home'], ['End'], ['PageDown'], ['PageUp'],
  ['ArrowLeft', { shift: true }], ['ArrowRight', { shift: true }], ['ArrowDown', { shift: true }], ['End', { shift: true }],
  ['ArrowRight', { ctrl: true }], ['ArrowLeft', { ctrl: true, shift: true }], ['Backspace'], ['Delete'], ['Backspace', { ctrl: true }],
  ['Enter'], ['Tab'], ['Tab', { shift: true }], ['z', { ctrl: true }], ['y', { ctrl: true }], ['z', { ctrl: true, shift: true }],
  ['d', { ctrl: true }], ['Escape'], ['/', { ctrl: true }], ['ArrowUp', { alt: true }], ['ArrowDown', { alt: true }],
  ['ArrowDown', { alt: true, shift: true }], ['[', { ctrl: true, shift: true }], [']', { ctrl: true, shift: true }],
  ['a', { ctrl: true }], ['Home', { ctrl: true }], ['End', { ctrl: true }], ['ArrowDown', { ctrl: true, alt: true }], ['l', { ctrl: true }],
]
const TYPED = `ab(){}[]"'\`;. =x${u(0x6f22, 0xe9, 0x5e9)}`

/** What the page must show; empty when all is well. */
function problemsOnPage() {
  // The text a line's DOM stands for: a marker as the character it marks, hints and a composition left out.
  const drawnText = (node) => {
    let out = ''
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += child.data
      else if (child.classList.contains('enc-inlay')) continue
      else if (child.classList.contains('enc-ctrl')) {
        const char = String.fromCodePoint(parseInt(child.dataset.label.slice(2), 16))
        out += child.textContent.length === char.length ? char : `<marker ${child.dataset.label} of ${child.textContent.length}>`
      } else out += drawnText(child)
    }
    return out
  }
  const view = window.view
  const { state } = view
  const doc = state.doc
  const problems = window.enc.editorProblems(state)
  const els = [...view.lineEls.values()].sort((a, b) => a.line - b.line)
  if (!els.length) problems.push('no line is drawn')
  let lastTop = -Infinity
  for (const el of els) {
    if (el.line < 1 || el.line > doc.lineCount) {
      problems.push(`line ${el.line} is drawn but the document has ${doc.lineCount}`)
      continue
    }
    const text = doc.line(el.line).text
    if (el.text !== text) problems.push(`line ${el.line} was drawn from old text ${JSON.stringify(el.text.slice(0, 40))}`)
    if (!el.dom.isConnected) continue
    // The text in the DOM is the line's (or the part of a long line drawn), the composition aside.
    const drawn = drawnText(el.dom)
    const expected = text.slice(el.from, el.to)
    if (drawn !== expected) {
      problems.push(`line ${el.line} shows ${JSON.stringify(drawn.slice(0, 60))} for ${JSON.stringify(expected.slice(0, 60))}`)
    }
    const top = el.dom.getBoundingClientRect().top
    if (el.dom.style.display !== 'none' && top < lastTop - 0.5) problems.push(`line ${el.line} is drawn above the line before it`)
    if (el.dom.style.display !== 'none') lastTop = top
    if (el.number?.isConnected && el.number.textContent !== String(el.line)) problems.push(`line ${el.line} is numbered ${el.number.textContent}`)
  }
  const main = state.selection.main
  const head = view.coordsAtPos(main.head)
  if (!Number.isFinite(head.left) || !Number.isFinite(head.top)) problems.push(`the caret at ${main.head} has no place`)
  // The screen reader's field holds the document around the main cursor.
  const mirror = view.input.mirror
  if (view.options.screenReader && !view.input.composing) {
    if (!mirror) problems.push('the screen reader mode is on and its field is empty')
    else {
      const end = mirror.from + mirror.text.length
      const at = doc.sliceString(mirror.from, end)
      if (view.textarea.value !== mirror.text || at !== mirror.text) {
        problems.push(
          `the screen reader's field holds ${JSON.stringify(view.textarea.value.slice(0, 80))} (meant to hold ${JSON.stringify(mirror.text.slice(0, 80))}), ` +
            `the document at ${mirror.from} is ${JSON.stringify(at.slice(0, 80))}`,
        )
      }
      if (main.head < mirror.from || main.head > end) problems.push(`the screen reader's field (${mirror.from} to ${end}) leaves out the cursor at ${main.head}`)
    }
  }
  if (!Number.isFinite(view.scroller.scrollTop) || view.scroller.scrollTop < 0) problems.push(`the scroll offset is ${view.scroller.scrollTop}`)
  return problems
}

/** Waits until a scroll or a resize has finished: nothing moves for two frames in a row (at most a second). */
async function steady() {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
  const where = () => {
    const { scroller, root } = window.view
    return `${scroller.scrollTop},${scroller.scrollLeft},${root.getBoundingClientRect().width},${scroller.scrollHeight}`
  }
  let last = where()
  let still = 0
  for (let n = 0; n < 60 && still < 2; n++) {
    await frame()
    const now = where()
    still = now === last ? still + 1 : 0
    last = now
  }
}

/** Random use of a mounted editor, `steps` of it, checked after each. */
async function useAtRandom(context, seed, steps) {
  const { page, ev, settle } = context
  const random = prng(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const done = []
  const box = () =>
    ev(() => {
      const rect = window.view.scroller.getBoundingClientRect()
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    })
  // The clipboard is the system's and outlives the page: it starts with the first line, copied, every run.
  await page.command('copy')
  await settle(1)
  // The history's clock moves with the steps rather than the wall, so the same steps make the same undo steps.
  await ev(() => {
    window.monkeyTime = 1_000_000
    window.enc.setHistoryClock(() => window.monkeyTime)
  })
  for (let step = 1; step <= steps; step++) {
    // A quick run of keys now and then, otherwise a pause.
    const pause = random() < 0.4 ? 30 + Math.floor(random() * 170) : 600 + Math.floor(random() * 2400)
    await ev((ms) => void (window.monkeyTime += ms), pause)
    const roll = random()
    let action
    if (roll < 0.42) {
      const [key, options] = pick(KEYS)
      action = `press ${key} ${JSON.stringify(options ?? {})}`
      await page.key(key, options ?? {})
    } else if (roll < 0.6) {
      const char = pick([...TYPED])
      action = `type ${JSON.stringify(char)}`
      await page.key(char, { text: char })
    } else if (roll < 0.66) {
      const text = pick(['hello ', '\n\tx', smile, `${accent}${accent}`, shalom])
      action = `insert ${JSON.stringify(text)}`
      await page.insertText(text)
    } else if (roll < 0.7) {
      const text = pick([han, kana, hangul])
      action = `compose ${text}`
      await page.ime(text.slice(0, 1))
      await settle(1)
      await page.ime(text)
      await settle(1)
      if (random() < 0.7) await page.insertText(text)
      else {
        action += ' (click)'
        const rect = await box()
        await page.click(rect.left + 60, rect.top + 30)
      }
    } else if (roll < 0.82) {
      const rect = await box()
      const x = rect.left + 50 + random() * (rect.width - 70)
      const y = rect.top + 4 + random() * (rect.height - 8)
      const options = random() < 0.2 ? { shift: true } : random() < 0.15 ? { alt: true } : random() < 0.1 ? { count: 2 } : {}
      action = `click ${Math.round(x)},${Math.round(y)} ${JSON.stringify(options)}`
      await page.click(x, y, options)
    } else if (roll < 0.87) {
      const rect = await box()
      const from = { x: rect.left + 60 + random() * (rect.width - 80), y: rect.top + 6 + random() * (rect.height - 12) }
      const to = { x: rect.left + 60 + random() * (rect.width - 80), y: rect.top + 6 + random() * (rect.height - 12) }
      action = `drag ${JSON.stringify(from)} to ${JSON.stringify(to)}`
      await page.drag(from, to)
    } else if (roll < 0.93) {
      const rect = await box()
      const delta = (random() - 0.4) * 900
      action = `wheel ${Math.round(delta)}`
      await page.wheel(rect.left + rect.width / 2, rect.top + rect.height / 2, delta, random() < 0.2 ? delta / 3 : 0)
    } else if (roll < 0.96) {
      const width = 380 + Math.floor(random() * 520)
      action = `resize to ${width}`
      await ev((w) => {
        document.getElementById('host').style.width = `${w}px`
      }, width)
    } else {
      action = 'copy, then paste'
      await page.command('copy')
      await settle(1)
      await page.command('paste')
    }
    done.push(action)
    await settle(2)
    await ev(steady)
    const problems = await ev(problemsOnPage)
    // The focus stays in the editor, but for Escape and then Tab, which is how the keyboard leaves it.
    const left = /^press Escape/.test(done[done.length - 2] ?? '') && /^press Tab/.test(action)
    if (!(await ev(() => document.activeElement === window.view.textarea))) {
      if (left) await ev(() => window.view.focus())
      else problems.push('the editor lost the focus')
    }
    if (page.errors.length) problems.push(...page.errors.map((error) => `the page threw: ${error}`))
    if (problems.length) {
      throw new Error(`Seed ${seed}, step ${step} (${action}):\n  ${problems.slice(0, 6).join('\n  ')}\nSteps: ${done.slice(-25).join(' | ')}`)
    }
  }
}

const STEPS = Number(process.env.ENCODE_MONKEY_STEPS) || 160
const SEED = Number(process.env.ENCODE_MONKEY_SEED) || 0x5eed

export const monkey = [
  {
    name: 'random use: keys, typing, input methods, clicks, drags, scrolling and resizing keep the drawn text and the state right',
    timeout: Math.max(120_000, STEPS * 1500),
    async run(context) {
      await context.mount({ text: DOC, path: 'monkey.ts', width: 760, height: 360 })
      await useAtRandom(context, SEED, STEPS)
    },
  },
  {
    name: 'random use with word wrap, right-to-left reading order, every space shown and the screen reader mode on',
    timeout: Math.max(120_000, STEPS * 1500),
    async run(context) {
      await context.mount({
        text: DOC,
        path: 'monkey.ts',
        width: 620,
        height: 360,
        config: { wordWrap: 'on', bidi: true, renderWhitespace: 'all', screenReader: true },
      })
      await useAtRandom(context, SEED + 1, STEPS)
    },
  },
]

/**
 * Runs the editor view in a real browser.
 *
 *   node test/browser/run.mjs [filter]      scenarios whose name contains the filter
 *
 * ENCODE_BROWSER names the browser to use (any Chromium-based one),
 * ENCODE_SHOTS a folder to write screenshots to, and ENCODE_MEASURES a file
 * the large-file scenarios write their timings to. The page and its bundle are
 * built into a temporary folder and removed afterwards.
 */
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from './cdp.mjs'
import { scenarios } from './scenarios.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const filters = process.argv.slice(2)
const shots = process.env.ENCODE_SHOTS
if (shots) fs.mkdirSync(shots, { recursive: true })

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-editor-view-'))
let failed = 0
let page
let server
try {
  await build({
    absWorkingDir: here,
    entryPoints: [path.join(here, 'entry.ts'), path.join(here, 'worker.ts')],
    outdir: out,
    bundle: true,
    platform: 'browser',
    target: 'chrome120',
    format: 'iife',
    sourcemap: 'inline',
    logLevel: 'warning',
  })
  fs.copyFileSync(path.join(here, 'page.html'), path.join(out, 'page.html'))
  // Served from a real origin, as the app's renderer is, so the page can start its highlighting worker.
  server = await serve(out)
  page = await launch({ width: 1100, height: 760 })
  const url = `http://127.0.0.1:${server.address().port}/page.html`

  const selected = scenarios.filter((scenario) => !filters.length || filters.some((filter) => scenario.name.includes(filter)))
  if (!selected.length) throw new Error(`No scenario matches: ${filters.join(', ')}`)
  for (const scenario of selected) {
    await page.goto(url)
    page.errors.length = 0
    const started = performance.now()
    const context = makeContext(page)
    const limit = scenario.timeout ?? 60_000
    try {
      await Promise.race([
        scenario.run(context),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${limit / 1000} s`)), limit)),
      ])
      if (page.errors.length) throw new Error(`The page reported errors:\n  ${page.errors.join('\n  ')}`)
      console.log(`  ok   ${scenario.name} (${Math.round(performance.now() - started)} ms)`)
    } catch (error) {
      failed++
      console.log(`  FAIL ${scenario.name}\n${String(error?.stack ?? error).replace(/^/gm, '       ')}`)
      if (shots) await page.screenshot(path.join(shots, `fail-${scenario.name.replace(/\W+/g, '-')}.png`)).catch(() => {})
    }
  }
  console.log(failed ? `\n${failed} of ${selected.length} scenarios failed` : `\n${selected.length} scenarios passed`)
} finally {
  await page?.close()
  server?.close()
  fs.rmSync(out, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)

/** Serves the files of `root` on a free port of 127.0.0.1. */
function serve(root) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
  const server = http.createServer((request, response) => {
    const name = path.basename(new URL(request.url, 'http://localhost').pathname)
    const file = path.join(root, name)
    if (!name || !fs.existsSync(file)) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': types[path.extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    fs.createReadStream(file).pipe(response)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function makeContext(page) {
  const context = {
    page,
    assert,
    /** Mounts an editor with these options and waits until it has drawn. */
    async mount(options = {}) {
      await page.eval((o) => void window.harness.mount(o), options)
      await page.frames(3)
    },
    /** Runs a function in the page; `view` is the editor. */
    ev: (fn, ...args) => page.eval(fn, ...args),
    async settle(frames = 3) {
      await page.frames(frames)
    },
    async shot(name, clip) {
      if (shots) await page.screenshot(path.join(shots, `${name}.png`), clip)
    },
    /** The document text. */
    text: () => page.eval(() => window.view.state.doc.toString()),
    /** The selection as [anchor, head] pairs. */
    selection: () => page.eval(() => window.view.state.selection.ranges.map((range) => [range.anchor, range.head])),
    /** Where things are, from the DOM rather than the view's own bookkeeping. */
    geom: () =>
      page.eval(() => {
        const view = window.view
        const content = document.querySelector('.enc-content').getBoundingClientRect()
        const scroller = view.scroller.getBoundingClientRect()
        return { left: content.left, top: scroller.top, scrollTop: view.scroller.scrollTop, ...view.metrics }
      }),
    /** Client coordinates just right of the boundary before `col` (0-based) on `line` (1-based), for a document scrolled to the top. */
    async at(line, col) {
      const g = await context.geom()
      return { x: g.left + g.paddingX + col * g.charWidth + 1, y: g.top + (line - 1) * g.lineHeight - g.scrollTop + g.lineHeight / 2 }
    },
    /** The lines on screen, from the DOM: gutter number, line text and distance below the top of the editor. */
    visible: () =>
      page.eval(() => {
        const view = window.view
        const top = view.scroller.getBoundingClientRect().top
        const height = view.scroller.clientHeight
        const place = (el) => el.getBoundingClientRect().top - top
        const numbers = [...document.querySelectorAll('.enc-gutter-num')].map((el) => ({ n: Number(el.textContent), y: place(el) }))
        const lines = [...document.querySelectorAll('.enc-line')].map((el) => ({ text: el.textContent, y: place(el) }))
        const onScreen = (item) => item.y > -view.metrics.lineHeight && item.y < height
        const shown = numbers.filter(onScreen).sort((a, b) => a.y - b.y)
        return {
          scrollTop: view.scroller.scrollTop,
          scrollHeight: view.scroller.scrollHeight,
          height,
          lineHeight: view.metrics.lineHeight,
          numbers: shown,
          lines: lines.filter(onScreen).sort((a, b) => a.y - b.y),
          rendered: view.renderedLineCount,
          nodes: document.querySelectorAll('*').length,
        }
      }),
    /** The text of the lines in the DOM, in order. */
    lineTexts: () =>
      page.eval(() =>
        [...document.querySelectorAll('.enc-line')]
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
          .map((el) => el.textContent),
      ),
    /** Client coordinates of a position in the document (the middle of its line). */
    pointAt: (pos, dx = 0) =>
      page.eval(
        (position, offset) => {
          const coords = window.view.coordsAtPos(position)
          return { x: coords.left + offset, y: (coords.top + coords.bottom) / 2 }
        },
        pos,
        dx,
      ),
    async type(text) {
      await page.insertText(text)
      await page.frames(2)
    },
    /** Types text one key at a time, as a keyboard does: each character is its own input, so brackets close and so on. */
    async typeKeys(text) {
      for (const char of text) {
        if (char === '\n') await page.key('Enter')
        else await page.key(char, { text: char })
      }
      await page.frames(2)
    },
    async press(key, options) {
      await page.key(key, options)
      await page.frames(2)
    },
  }
  return context
}

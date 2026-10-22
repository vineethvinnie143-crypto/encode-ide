import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import type { OverlayState } from './computer-control'
import { OVERLAY_HEIGHT, OVERLAY_MARGIN, OVERLAY_MAX_WIDTH, OVERLAY_MIN_WIDTH, OVERLAY_TEXT, overlayBounds, overlayPage, overlayUrl } from './computer-overlay-page'

const scriptOf = (page: string): string => {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  assert.equal(scripts.length, 1, 'the page holds one script')
  return scripts[0][1]
}

/** Just enough of a page for the banner's script to run against. */
function run(states: OverlayState[], width = 300) {
  const element = (tag: string) => ({ tag, textContent: '', hidden: false, disabled: false, listeners: {} as Record<string, () => void>, addEventListener(type: string, listener: () => void) { this.listeners[type] = listener }, getBoundingClientRect: () => ({ width }) })
  const elements = { pill: element('div'), text: element('span'), hint: element('span'), stop: element('button') }
  const body = { attributes: {} as Record<string, string>, setAttribute(name: string, value: string) { this.attributes[name] = value } }
  const calls: string[] = []
  let draw: ((state: OverlayState) => void) | undefined
  const sizes: number[] = []
  const window = {
    encodeOverlay: {
      stop: () => calls.push('stop'),
      ready: () => calls.push('ready'),
      size: (value: number) => sizes.push(value),
      onState: (callback: (state: OverlayState) => void) => {
        draw = callback
      },
    },
  }
  const document = { body, getElementById: (id: string) => elements[id as keyof typeof elements] }
  vm.runInNewContext(scriptOf(overlayPage()), { window, document, Math })
  const frames = states.map((state) => {
    draw!(state)
    return { text: elements.text.textContent, hint: elements.hint.textContent, hintHidden: elements.hint.hidden, stopDisabled: elements.stop.disabled, mode: body.attributes['data-mode'] }
  })
  elements.stop.listeners.click()
  return { frames, calls, sizes }
}

describe('the banner page', () => {
  it('lets exactly its own script run, and reaches nothing else', () => {
    const page = overlayPage()
    const hash = createHash('sha256').update(scriptOf(page), 'utf8').digest('base64')
    const policy = /Content-Security-Policy" content="([^"]+)"/.exec(page)?.[1]
    assert.equal(policy, `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'`)
    assert.doesNotMatch(page, /\b(?:src|href|action)=|https?:|@import|url\(/i, 'it loads nothing')
    assert.doesNotMatch(page, /\son[a-z]+=/i, 'and has no inline handlers')
  })

  it('is a data address that carries the page whole', () => {
    const url = overlayUrl()
    assert.ok(url.startsWith('data:text/html;charset=utf-8,'))
    assert.equal(decodeURIComponent(url.slice(url.indexOf(',') + 1)), overlayPage())
  })

  it('draws what it is sent, and reports how wide it is each time', () => {
    const { frames, calls, sizes } = run(
      [
        { mode: 'using', shortcut: 'Ctrl+Alt+Esc' },
        { mode: 'waiting', shortcut: 'Ctrl+Alt+Esc' },
        { mode: 'stopping', shortcut: null },
      ],
      312.2,
    )
    assert.deepEqual(frames, [
      { text: OVERLAY_TEXT.using, hint: 'Ctrl+Alt+Esc', hintHidden: false, stopDisabled: false, mode: 'using' },
      { text: OVERLAY_TEXT.waiting, hint: 'Ctrl+Alt+Esc', hintHidden: false, stopDisabled: false, mode: 'waiting' },
      { text: OVERLAY_TEXT.stopping, hint: '', hintHidden: true, stopDisabled: true, mode: 'stopping' },
    ])
    assert.deepEqual(sizes, [313, 313, 313])
    assert.deepEqual(calls, ['ready', 'stop'], 'it says it is ready once, and Stop is passed on')
  })

  it('says something sensible for a mode it does not know', () => {
    const { frames } = run([{ mode: 'dancing', shortcut: null } as unknown as OverlayState])
    assert.equal(frames[0].text, OVERLAY_TEXT.using)
  })

  it('has words for every state', () => {
    assert.deepEqual(Object.keys(OVERLAY_TEXT).sort(), ['stopping', 'using', 'waiting'])
    for (const text of Object.values(OVERLAY_TEXT)) assert.ok(text.length > 0 && text.length < 40)
  })
})

describe('where the banner goes', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1040 }

  it('is centred at the bottom of the work area, clear of the taskbar', () => {
    const bounds = overlayBounds(screen, 300)
    assert.deepEqual(bounds, { x: 809, y: 1040 - OVERLAY_HEIGHT - OVERLAY_MARGIN, width: 302, height: OVERLAY_HEIGHT })
    assert.equal(bounds.x + bounds.width / 2, 960)
  })

  it('follows a work area that does not start at the origin', () => {
    const second = { x: -1280, y: 120, width: 1280, height: 960 }
    const bounds = overlayBounds(second, 300)
    assert.equal(bounds.x, -1280 + (1280 - 302) / 2)
    assert.equal(bounds.y, 120 + 960 - OVERLAY_HEIGHT - OVERLAY_MARGIN)
  })

  it('keeps the width between what reads well and what a long word could stretch it to', () => {
    assert.equal(overlayBounds(screen, 10).width, OVERLAY_MIN_WIDTH + 2)
    assert.equal(overlayBounds(screen, 99_999).width, OVERLAY_MAX_WIDTH + 2)
    assert.equal(overlayBounds(screen, Number.NaN).width, OVERLAY_MIN_WIDTH + 2)
    assert.equal(overlayBounds(screen, Number.POSITIVE_INFINITY).width, OVERLAY_MIN_WIDTH + 2)
  })

  it('never goes wider than the screen', () => {
    const narrow = { x: 100, y: 0, width: 160, height: 600 }
    const bounds = overlayBounds(narrow, 400)
    assert.equal(bounds.width, 160)
    assert.equal(bounds.x, 100)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_CLOSED,
  activateBottom,
  activeKind,
  activateSide,
  activateSideAt,
  closeBottom,
  closeSide,
  cycleLayout,
  defaultPanels,
  nextTitle,
  normalizePanels,
  openBottom,
  openSide,
  reopenSide,
  setLayout,
  stepSide,
  toggleBottom,
  toggleFull,
  toggleHidden,
  visitSide,
  type PanelsState,
} from './model'

let counter = 0
const id = () => `t${++counter}`
const kinds = (state: PanelsState) => state.side.tabs.map((tab) => tab.kind)
const titles = (state: PanelsState) => state.side.tabs.map((tab) => tab.title)

describe('side panel tabs', () => {
  it('starts with Files', () => {
    const state = defaultPanels()
    assert.deepEqual(kinds(state), ['files'])
    assert.equal(state.side.layout, 'split')
    assert.equal(state.bottom.open, false)
  })

  it('shows the tab that exists once instead of adding another', () => {
    let state = openSide(defaultPanels(), 'editor', id())
    const editor = state.side.activeId
    state = openSide(state, 'files', id())
    assert.equal(state.side.activeId, 'files')
    state = openSide(state, 'editor', id())
    assert.equal(state.side.activeId, editor)
    assert.deepEqual(kinds(state), ['files', 'editor'])
  })

  it('adds a terminal or a browser each time, numbering terminals', () => {
    let state = defaultPanels()
    state = openSide(state, 'terminal', id())
    state = openSide(state, 'terminal', id())
    state = openSide(state, 'browser', id())
    state = openSide(state, 'browser', id())
    assert.deepEqual(titles(state), ['Files', 'Terminal', 'Terminal 2', 'Browser', 'Browser 2'])
    assert.equal(nextTitle([], 'terminal'), 'Terminal')
  })

  it('turns a New tab page into whatever you choose on it', () => {
    let state = openSide(defaultPanels(), 'new', 'page')
    assert.deepEqual(kinds(state), ['files', 'new'])
    state = openSide(state, 'terminal', id())
    assert.deepEqual(kinds(state), ['files', 'terminal'])
    assert.equal(state.side.activeId, 'page', 'the page keeps its place and its id')
  })

  it('brings a hidden panel back when something opens in it', () => {
    let state = setLayout(defaultPanels(), 'hidden')
    state = openSide(state, 'trajectory', id())
    assert.equal(state.side.layout, 'split')
    state = setLayout(state, 'full')
    assert.equal(openSide(state, 'editor', id()).side.layout, 'full', 'full width stays full')
  })

  it('ignores kinds that only belong to the bottom panel, and stops at a limit', () => {
    const base = defaultPanels()
    assert.equal(openSide(base, 'jobs', id()), base)
    let state = defaultPanels()
    for (let n = 0; n < 40; n++) state = openSide(state, 'terminal', id())
    assert.equal(state.side.tabs.length, 20)
  })

  it('picks the neighbour when the active tab closes', () => {
    let state = defaultPanels()
    for (const kind of ['editor', 'terminal', 'browser'] as const) state = openSide(state, kind, kind)
    state = activateSide(state, 'terminal')
    state = closeSide(state, 'terminal')
    assert.equal(state.side.activeId, 'browser', 'the tab that took its place')
    state = closeSide(state, 'browser')
    assert.equal(state.side.activeId, 'editor', 'the last one falls back to the left')
    state = activateSide(state, 'files')
    state = closeSide(state, 'editor')
    assert.equal(state.side.activeId, 'files', 'closing a tab in the background keeps the active one')
  })

  it('hides the panel when the last tab closes', () => {
    const state = closeSide(defaultPanels(), 'files')
    assert.deepEqual(state.side.tabs, [])
    assert.equal(state.side.activeId, null)
    assert.equal(state.side.layout, 'hidden')
  })

  it('tells which kind of tab is in front', () => {
    let state = openSide(defaultPanels(), 'terminal', 'term')
    assert.equal(activeKind(state.side), 'terminal')
    state = closeSide(closeSide(state, 'term'), 'files')
    assert.equal(activeKind(state.side), null)
  })

  it('reopens closed tabs, newest first, and does not remember an empty New tab', () => {
    let state = defaultPanels()
    state = openSide(state, 'terminal', 'term')
    state = openSide(state, 'new', 'page')
    state = closeSide(state, 'page')
    state = closeSide(state, 'term')
    state = closeSide(state, 'files')
    assert.deepEqual(state.side.closed.map((tab) => tab.kind), ['files', 'terminal'])
    state = reopenSide(state, 'a')
    assert.deepEqual(kinds(state), ['files'])
    assert.equal(state.side.layout, 'split', 'reopening brings the panel back')
    state = reopenSide(state, 'b')
    assert.deepEqual(kinds(state), ['files', 'terminal'])
    assert.equal(reopenSide(state, 'c'), state)
  })

  it('remembers a bounded number of closed tabs', () => {
    let state = defaultPanels()
    for (let n = 0; n < MAX_CLOSED + 5; n++) {
      state = openSide(state, 'terminal', `x${n}`)
      state = closeSide(state, `x${n}`)
    }
    assert.equal(state.side.closed.length, MAX_CLOSED)
  })

  it('moves between tabs by step and by number', () => {
    let state = defaultPanels()
    for (const kind of ['editor', 'terminal'] as const) state = openSide(state, kind, kind)
    state = activateSide(state, 'files')
    assert.equal(stepSide(state, -1).side.activeId, 'terminal', 'wraps to the end')
    assert.equal(stepSide(stepSide(state, 1), 1).side.activeId, 'terminal')
    assert.equal(stepSide(activateSide(state, 'terminal'), 1).side.activeId, 'files', 'wraps to the start')
    assert.equal(activateSideAt(state, 1).side.activeId, 'editor')
    assert.equal(activateSideAt(state, 8), state)
    assert.equal(stepSide(defaultPanels(), 1).side.activeId, 'files', 'one tab has nowhere to go')
  })

  it('gives a Browser tab the page it went to and the site as its title', () => {
    let state = openSide(defaultPanels(), 'browser', 'web')
    state = visitSide(state, 'web', 'https://example.com/docs', '  example.com  ')
    assert.equal(state.side.tabs[1].title, 'example.com')
    assert.equal(state.side.tabs[1].url, 'https://example.com/docs')
    assert.equal(visitSide(state, 'web', 'https://example.com/docs', '   ').side.tabs[1].title, 'example.com', 'a blank title keeps the old one')
    assert.equal(visitSide(state, 'web', 'https://example.com/docs', 'x'.repeat(100)).side.tabs[1].title.length, 60)
  })

  it('only takes web addresses, and only for a Browser tab', () => {
    const state = openSide(defaultPanels(), 'browser', 'web')
    assert.equal(visitSide(state, 'web', 'javascript:alert(1)', 'x'), state)
    assert.equal(visitSide(state, 'web', 'file:///c:/secrets.txt', 'x'), state)
    assert.equal(visitSide(state, 'web', `https://example.com/${'a'.repeat(3000)}`, 'x'), state)
    assert.equal(visitSide(state, 'files', 'https://example.com', 'x').side.tabs[0].url, undefined, 'Files has no page')
  })

  it('brings a closed Browser tab back on its page', () => {
    let state = openSide(defaultPanels(), 'browser', 'web')
    state = visitSide(state, 'web', 'https://example.com/docs', 'example.com')
    state = closeSide(state, 'web')
    state = reopenSide(state, 'again')
    const tab = state.side.tabs.find((item) => item.kind === 'browser')
    assert.equal(tab?.url, 'https://example.com/docs')
    assert.equal(tab?.title, 'example.com')
    assert.equal(state.side.activeId, 'again')
  })
})

describe('layouts', () => {
  it('cycles split, full, hidden', () => {
    assert.equal(cycleLayout('split'), 'full')
    assert.equal(cycleLayout('full'), 'hidden')
    assert.equal(cycleLayout('hidden'), 'split')
  })

  it('toggles hidden and full width', () => {
    assert.equal(toggleHidden('split'), 'hidden')
    assert.equal(toggleHidden('full'), 'hidden')
    assert.equal(toggleHidden('hidden'), 'split')
    assert.equal(toggleFull('split'), 'full')
    assert.equal(toggleFull('full'), 'split')
    assert.equal(toggleFull('hidden'), 'full')
  })
})

describe('bottom panel', () => {
  it('opens with a terminal, and Ctrl+J hides and shows it again', () => {
    let state = toggleBottom(defaultPanels(), 'bt')
    assert.equal(state.bottom.open, true)
    assert.deepEqual(state.bottom.tabs.map((tab) => tab.kind), ['terminal'])
    state = toggleBottom(state, 'other')
    assert.equal(state.bottom.open, false)
    state = toggleBottom(state, 'other')
    assert.equal(state.bottom.open, true)
    assert.equal(state.bottom.tabs.length, 1, 'the terminal is kept, not replaced')
  })

  it('shows the terminal that is there, and puts Jobs beside it', () => {
    let state = openBottom(defaultPanels(), 'terminal', 'a')
    state = openBottom(state, 'terminal', 'b')
    assert.equal(state.bottom.tabs.length, 1)
    state = openBottom(state, 'jobs', 'j')
    assert.deepEqual(state.bottom.tabs.map((tab) => tab.kind), ['terminal', 'jobs'])
    assert.equal(state.bottom.activeId, 'j')
    state = openBottom(state, 'jobs', 'again')
    assert.equal(state.bottom.tabs.length, 2, 'Jobs exists once')
    state = openBottom(state, 'terminal', 'd')
    assert.equal(state.bottom.activeId, 'a', 'the terminal comes forward')
    assert.equal(openBottom(state, 'files', 'x'), state)
  })

  it('hides itself when the last tab closes', () => {
    let state = openBottom(defaultPanels(), 'terminal', 'a')
    state = openBottom(state, 'jobs', 'b')
    state = closeBottom(state, 'b')
    assert.equal(state.bottom.activeId, 'a')
    assert.equal(state.bottom.open, true)
    state = closeBottom(state, 'a')
    assert.equal(state.bottom.open, false)
    assert.equal(state.bottom.activeId, null)
    assert.equal(activateBottom(state, 'zzz'), state)
  })
})

describe('saved panels', () => {
  it('repairs what was saved: unknown kinds, repeats and a missing active tab', () => {
    const saved = {
      side: {
        layout: 'full',
        activeId: 'gone',
        tabs: [
          { id: 'a', kind: 'files', title: 'Files' },
          { id: 'a', kind: 'editor', title: 'Repeat id' },
          { id: 'b', kind: 'files', title: 'Second Files' },
          { id: 'c', kind: 'jobs', title: 'Not a side tab' },
          { id: 'd', kind: 'evil<script>', title: 'x' },
          { id: 'e', kind: 'terminal', title: '' },
          'junk',
        ],
      },
      bottom: { open: true, activeId: 'z', tabs: [{ id: 'z', kind: 'terminal', title: 'Terminal' }, { id: 'y', kind: 'browser', title: 'no' }] },
    }
    const state = normalizePanels(saved)
    assert.deepEqual(state.side.tabs.map((tab) => [tab.id, tab.kind, tab.title]), [
      ['a', 'files', 'Files'],
      ['e', 'terminal', 'Terminal'],
    ])
    assert.equal(state.side.activeId, 'a')
    assert.equal(state.side.layout, 'full')
    assert.deepEqual(state.bottom.tabs.map((tab) => tab.kind), ['terminal'])
    assert.equal(state.bottom.open, true)
  })

  it('keeps a Browser tab on its web page, and drops anything else it was given', () => {
    const state = normalizePanels({
      side: {
        tabs: [
          { id: 'a', kind: 'browser', title: 'example.com', url: 'https://example.com/' },
          { id: 'b', kind: 'browser', title: 'bad', url: 'javascript:alert(1)' },
          { id: 'c', kind: 'terminal', title: 'Terminal', url: 'https://example.com/' },
        ],
      },
    })
    assert.deepEqual(state.side.tabs.map((tab) => tab.url), ['https://example.com/', undefined, undefined])
  })

  it('falls back to the default for nothing, and keeps an emptied panel hidden', () => {
    assert.deepEqual(normalizePanels(undefined), defaultPanels())
    assert.deepEqual(normalizePanels('junk'), defaultPanels())
    const empty = normalizePanels({ side: { tabs: [], layout: 'split' }, bottom: { open: true, tabs: [] } })
    assert.equal(empty.side.layout, 'hidden')
    assert.equal(empty.bottom.open, false)
  })
})

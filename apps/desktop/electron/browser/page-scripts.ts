/**
 * What the agent's tab runs in its page, in an isolated world of its own: the page's scripts share the document with
 * it but not its variables, so they can neither read the refs nor replace the functions. Each script is a string with
 * its arguments written in as JSON, and answers with plain data.
 *
 * Refs (e12) are kept in the isolated world for the document's lifetime and numbered from a counter the main process
 * keeps for the tab, so a ref is never used twice in a tab: a ref from a page that has gone is stale, not another
 * element.
 */

/** The isolated world eNCode's scripts run in; any number above the ones Electron uses itself. */
export const AGENT_WORLD = 7_311

/** How many elements an outline lists; the rest are counted. */
export const MAX_ELEMENTS = 150
/** How much of the page's text an answer carries; the tool cuts it shorter for the model. */
export const MAX_PAGE_TEXT = 6_000

const COMMON = String.raw`
  const state = (window.__encodeAgent ??= { refs: new Map(), ids: new WeakMap() })
  const clean = (value, max = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  const element = (ref) => {
    const found = state.refs.get(ref)?.deref()
    return found && found.isConnected ? found : null
  }
  const TEXT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'number', 'password', 'date', 'datetime-local', 'month', 'time', 'week', '']
  const isPassword = (node) => node instanceof HTMLInputElement && node.type === 'password'
  const isTextField = (node) =>
    (node instanceof HTMLInputElement && TEXT_TYPES.includes(node.type)) || node instanceof HTMLTextAreaElement || node.isContentEditable
`

/** The outline: what can be acted on, by ref, and the page's text. */
export function outlineScript(next: number): string {
  return String.raw`(() => {
  ${COMMON}
  let next = ${JSON.stringify(next)}
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select', 'summary', '[contenteditable=""]', '[contenteditable="true"]',
    ...['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'textbox',
      'searchbox', 'combobox', 'slider', 'spinbutton', 'treeitem'].map((role) => '[role="' + role + '"]'),
  ].join(', ')
  const GENERIC = '[onclick], [tabindex]:not([tabindex="-1"])'
  const INSIDE = 'a[href], button, summary, [role="button"], [role="link"], [role="option"], [role="menuitem"], [role="tab"]'

  // The document and the open shadow roots in it, in document order.
  const all = (root, selector, out = []) => {
    for (const node of root.querySelectorAll('*')) {
      if (node.matches(selector)) out.push(node)
      if (node.shadowRoot) all(node.shadowRoot, selector, out)
    }
    return out
  }
  const shown = (node) => {
    const box = node.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) return false
    const style = getComputedStyle(node)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (Number(style.opacity) === 0 && !(node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type))) return false
    return !node.closest('[aria-hidden="true"], [inert]')
  }
  const roleOf = (node) => {
    const explicit = node.getAttribute('role')
    if (explicit) return explicit.split(/\s+/)[0]
    const tag = node.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return node.multiple ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const roles = { checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button', reset: 'button', image: 'button', search: 'searchbox', number: 'spinbutton', file: 'file', color: 'color', password: 'password' }
      return roles[node.type] ?? 'textbox'
    }
    if (node.isContentEditable) return 'textbox'
    return 'button'
  }
  const field = (node) => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement
  const nameOf = (node) => {
    const label = node.getAttribute('aria-label')
    if (clean(label)) return clean(label)
    const by = node.getAttribute('aria-labelledby')
    if (by) {
      const text = by.split(/\s+/).map((id) => node.getRootNode().getElementById?.(id)?.textContent ?? document.getElementById(id)?.textContent ?? '').join(' ')
      if (clean(text)) return clean(text)
    }
    if (node.labels?.length) {
      const text = [...node.labels].map((item) => item.innerText || item.textContent).join(' ')
      if (clean(text)) return clean(text)
    }
    if (node instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(node.type)) return clean(node.value) || node.type
    if (!field(node)) {
      const text = clean(node.innerText ?? node.textContent)
      if (text) return text
    }
    return clean(node.getAttribute('placeholder') || node.getAttribute('alt') || node.querySelector?.('img[alt]')?.getAttribute('alt') || node.getAttribute('title') || node.getAttribute('name') || '')
  }
  const valueOf = (node) => {
    if (isPassword(node)) return undefined
    if (node instanceof HTMLSelectElement) return clean([...node.selectedOptions].map((option) => option.label).join(', '))
    if (node instanceof HTMLInputElement) return ['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(node.type) ? undefined : clean(node.value)
    if (node instanceof HTMLTextAreaElement) return clean(node.value)
    if (node.isContentEditable) return clean(node.innerText)
    const now = node.getAttribute('aria-valuenow')
    return now === null ? undefined : clean(node.getAttribute('aria-valuetext') || now)
  }
  const statesOf = (node) => {
    const states = []
    const aria = (name) => node.getAttribute('aria-' + name)
    if (node.checked === true || aria('checked') === 'true' || aria('pressed') === 'true') states.push('checked')
    if (node.disabled === true || aria('disabled') === 'true') states.push('disabled')
    if (aria('expanded') === 'true') states.push('expanded')
    if (aria('expanded') === 'false') states.push('collapsed')
    if (node === document.activeElement || node.shadowRoot?.activeElement) states.push('focused')
    if (node.required === true || aria('required') === 'true') states.push('required')
    if (aria('selected') === 'true' || node.selected === true) states.push('selected')
    if (aria('invalid') === 'true') states.push('invalid')
    if (node.readOnly === true || aria('readonly') === 'true') states.push('read-only')
    return states
  }

  const candidates = all(document, SELECTOR + ', ' + GENERIC).filter((node) => {
    if (!node.matches(SELECTOR) && node.parentElement?.closest(INSIDE)) return false
    return shown(node)
  })
  // The ones on screen, and near it, first; then the rest in page order.
  const reach = innerHeight * 1.5
  const near = (node) => {
    const box = node.getBoundingClientRect()
    return box.bottom > -reach && box.top < innerHeight + reach
  }
  const picked = new Set([...candidates.filter(near), ...candidates].slice(0, ${MAX_ELEMENTS}))
  const elements = []
  for (const node of candidates) {
    if (!picked.has(node)) continue
    let ref = state.ids.get(node)
    if (!ref) {
      ref = 'e' + next++
      state.ids.set(node, ref)
    }
    state.refs.set(ref, new WeakRef(node))
    const entry = { ref, role: roleOf(node), name: nameOf(node) }
    const value = valueOf(node)
    if (value) entry.value = value
    const states = statesOf(node)
    if (states.length) entry.states = states
    elements.push(entry)
  }
  const text = (document.body?.innerText ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, ${MAX_PAGE_TEXT})
  return { elements, more: candidates.length - elements.length, text, next, title: document.title, width: innerWidth }
})()`
}

export type RefAction =
  /** Brings it into view and says where its middle is, and whether a click there reaches it. */
  | { type: 'point' }
  /** A click from the page's side, for an element a click at its middle does not reach. */
  | { type: 'click' }
  /** Focuses a field and selects what is in it, so typing replaces it. */
  | { type: 'focus' }
  /** What a field holds now. */
  | { type: 'value' }
  /** Sets a field the way typing would, for a field that typing did not reach. */
  | { type: 'fill'; text: string }
  | { type: 'select'; value: string }
  | { type: 'scroll'; by: number }

export type RefAnswer =
  | { error: 'stale' | 'password' | 'not-editable' | 'not-a-list' | 'no-option'; options?: string[] }
  | { x: number; y: number; hit: boolean }
  | { value: string }
  | { chosen: string }
  | { done: true }

/** One action on the element of a ref. */
export function refScript(ref: string, action: RefAction): string {
  return String.raw`(() => {
  ${COMMON}
  const action = ${JSON.stringify(action)}
  const node = element(${JSON.stringify(ref)})
  if (!node) return { error: 'stale' }
  switch (action.type) {
    case 'point': {
      const before = node.getBoundingClientRect()
      if (before.top < 0 || before.bottom > innerHeight || before.left < 0 || before.right > innerWidth) node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const box = node.getBoundingClientRect()
      const x = Math.round(box.left + Math.min(box.width / 2, Math.max(box.width - 2, 1)))
      const y = Math.round(box.top + box.height / 2)
      const root = node.getRootNode()
      const hitAt = (root.elementFromPoint ? root : document).elementFromPoint(x, y)
      const hit = !!hitAt && (hitAt === node || node.contains(hitAt) || [...(node.labels ?? [])].some((label) => label.contains(hitAt)))
      return { x, y, hit }
    }
    case 'click':
      node.click()
      return { done: true }
    case 'focus': {
      if (isPassword(node)) return { error: 'password' }
      if (!isTextField(node) || node.disabled || node.readOnly) return { error: 'not-editable' }
      node.scrollIntoView({ block: 'center', behavior: 'instant' })
      node.focus()
      if (node.isContentEditable) {
        const range = document.createRange()
        range.selectNodeContents(node)
        getSelection().removeAllRanges()
        getSelection().addRange(range)
      } else {
        try { node.select() } catch {}
      }
      return { done: true }
    }
    case 'value':
      return { value: node.isContentEditable ? node.innerText : String(node.value ?? '') }
    case 'fill': {
      if (isPassword(node)) return { error: 'password' }
      if (node.isContentEditable) {
        node.textContent = action.text
      } else {
        const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, action.text)
      }
      node.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
      return { done: true }
    }
    case 'select': {
      if (!(node instanceof HTMLSelectElement)) return { error: 'not-a-list' }
      const wanted = action.value.trim().toLowerCase()
      const options = [...node.options]
      const option = options.find((item) => item.value === action.value) ?? options.find((item) => item.label.trim().toLowerCase() === wanted) ?? options.find((item) => item.label.trim().toLowerCase().includes(wanted))
      if (!option) return { error: 'no-option', options: options.slice(0, 30).map((item) => clean(item.label, 60)) }
      node.value = option.value
      option.selected = true
      node.dispatchEvent(new Event('input', { bubbles: true }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
      return { chosen: clean(option.label, 60) }
    }
    case 'scroll':
      node.scrollBy({ top: action.by * Math.max(node.clientHeight, 100), behavior: 'instant' })
      return { done: true }
  }
  return { error: 'stale' }
})()`
}

/** Scrolls the page by screens (negative goes up). */
export function scrollPageScript(by: number): string {
  return `(() => { scrollBy({ top: ${JSON.stringify(by)} * innerHeight * 0.85, behavior: 'instant' }); return true })()`
}

/** Whether the page's text holds `text` yet. */
export function hasTextScript(text: string): string {
  return `(() => (document.body?.innerText ?? '').includes(${JSON.stringify(text)}))()`
}

/**
 * Put in front of every page of the agent's tab, in the page's own world, before its scripts: alert, confirm and prompt
 * would stop the page until someone answers them. Here they answer at once (OK, yes, nothing) and say so in the console,
 * so the agent reads what was asked.
 */
export const DIALOGS_SCRIPT = String.raw`(() => {
  const say = (kind, message, answer) => console.warn('[eNCode] The page showed a ' + kind + ' dialog: ' + JSON.stringify(String(message ?? '').slice(0, 300)) + ', answered ' + answer + '.')
  window.alert = (message) => { say('alert', message, 'OK') }
  window.confirm = (message) => { say('confirm', message, 'OK'); return true }
  window.prompt = (message) => { say('prompt', message, 'with nothing'); return null }
})()`

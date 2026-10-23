/**
 * HTML read into elements with their tags, attributes and offsets, closing elements the way browsers do where the
 * standard lets an end tag be left out (`<li>`, `<p>`, `<td>`...), and noting what is left open or closes nothing
 * (ADR 0085). Not a full HTML5 tree builder: enough for checks, completion, symbols and folding.
 */

export interface Attribute {
  name: string
  start: number
  end: number
  /** The value as written, quotes and all, and where it is. */
  value?: { text: string; start: number; end: number }
}

export interface Element {
  name: string
  start: number
  /** Just past the start tag's `>`, or where it stopped. */
  startTagEnd: number
  endTagStart: number | null
  end: number
  attributes: Attribute[]
  children: Element[]
  parent: Element | null
  selfClosing: boolean
  /** Inside `<svg>` or `<math>`, where other names hold. */
  foreign: boolean
}

export interface HtmlDocument {
  roots: Element[]
  comments: { start: number; end: number }[]
  /** The text of each `<style>`, by offset. */
  styles: { start: number; end: number }[]
  problems: { start: number; end: number; message: string; severity: 1 | 2 }[]
}

export const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen', 'command', 'basefont', 'bgsound', 'frame', 'image', 'isindex', 'nextid'])
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext'])
/** Elements whose end tag the standard lets be left out. */
const OPTIONAL_END = new Set(['html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'rb', 'rt', 'rp', 'rtc'])
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'table', 'ul'])
/** An element that opening `key` closes when it is the open one. */
const CLOSED_BY: Record<string, string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  option: ['option'],
  optgroup: ['option', 'optgroup'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  thead: ['tbody', 'tfoot', 'tr', 'td', 'th'],
  tbody: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
  tfoot: ['thead', 'tbody', 'tr', 'td', 'th'],
  rt: ['rt', 'rp'],
  rp: ['rt', 'rp'],
}

const NAME = /[A-Za-z][\w:.-]*/y
const MAX_DEPTH = 512

export function parseHtml(text: string): HtmlDocument {
  const roots: Element[] = []
  const comments: HtmlDocument['comments'] = []
  const styles: HtmlDocument['styles'] = []
  const problems: HtmlDocument['problems'] = []
  const stack: Element[] = []
  const length = text.length
  let index = 0

  const close = (element: Element, end: number) => {
    element.end = end
  }
  const unclosed = (element: Element) => {
    if (!OPTIONAL_END.has(element.name) && !element.foreign) problems.push({ start: element.start, end: element.startTagEnd, message: `<${element.name}> is not closed.`, severity: 2 })
  }

  while (index < length) {
    const lt = text.indexOf('<', index)
    if (lt < 0) break
    index = lt
    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4)
      const stop = end < 0 ? length : end + 3
      if (end < 0) problems.push({ start: index, end: index + 4, message: 'This comment is not closed.', severity: 1 })
      comments.push({ start: index, end: stop })
      index = stop
      continue
    }
    if (text[index + 1] === '!' || text[index + 1] === '?') {
      const end = text.indexOf('>', index)
      index = end < 0 ? length : end + 1
      continue
    }
    if (text[index + 1] === '/') {
      NAME.lastIndex = index + 2
      const match = NAME.exec(text)
      const gt = text.indexOf('>', index)
      const stop = gt < 0 ? length : gt + 1
      if (!match) {
        index = index + 2
        continue
      }
      const name = match[0].toLowerCase()
      const at = stack.map((element) => element.name).lastIndexOf(name)
      if (at < 0) {
        problems.push({ start: index, end: stop, message: VOID.has(name) ? `<${name}> takes no end tag.` : `</${name}> closes no open element.`, severity: 2 })
      } else {
        while (stack.length > at + 1) {
          const open = stack.pop()!
          unclosed(open)
          close(open, index)
        }
        const element = stack.pop()!
        element.endTagStart = index
        close(element, stop)
      }
      index = stop
      continue
    }
    NAME.lastIndex = index + 1
    const match = NAME.exec(text)
    if (!match) {
      index++
      continue
    }
    const parent = stack.at(-1) ?? null
    const foreign = Boolean(parent?.foreign) || /^(svg|math)$/i.test(match[0])
    const name = foreign ? match[0] : match[0].toLowerCase()
    // The ends the standard implies before this element.
    if (!foreign) {
      for (;;) {
        const open = stack.at(-1)
        if (!open) break
        if ((open.name === 'p' && CLOSES_P.has(name)) || CLOSED_BY[name]?.includes(open.name)) {
          stack.pop()
          close(open, index)
          continue
        }
        break
      }
    }
    const element: Element = { name, start: index, startTagEnd: index, endTagStart: null, end: index, attributes: [], children: [], parent: stack.at(-1) ?? null, selfClosing: false, foreign }
    // Attributes, to the tag's end.
    let at = NAME.lastIndex
    let ended = false
    while (at < length) {
      const char = text[at]!
      if (/\s/.test(char)) {
        at++
        continue
      }
      if (char === '>') {
        at++
        ended = true
        break
      }
      if (char === '/' && text[at + 1] === '>') {
        element.selfClosing = true
        at += 2
        ended = true
        break
      }
      if (char === '<') break
      const nameStart = at
      while (at < length && !/[\s=>/<"']/.test(text[at]!)) at++
      if (at === nameStart) {
        at++
        continue
      }
      const attribute: Attribute = { name: text.slice(nameStart, at), start: nameStart, end: at }
      let look = at
      while (look < length && /\s/.test(text[look]!)) look++
      if (text[look] === '=') {
        look++
        while (look < length && /\s/.test(text[look]!)) look++
        const quote = text[look]
        let valueEnd = look
        if (quote === '"' || quote === "'") {
          const closeAt = text.indexOf(quote, look + 1)
          valueEnd = closeAt < 0 ? length : closeAt + 1
          if (closeAt < 0) problems.push({ start: look, end: Math.min(length, look + 1), message: 'This attribute value is not closed.', severity: 1 })
        } else {
          while (valueEnd < length && !/[\s>]/.test(text[valueEnd]!)) valueEnd++
        }
        attribute.value = { text: text.slice(look, valueEnd), start: look, end: valueEnd }
        attribute.end = valueEnd
        at = valueEnd
      }
      element.attributes.push(attribute)
    }
    element.startTagEnd = at
    if (!ended) problems.push({ start: element.start, end: Math.min(at, element.start + name.length + 1), message: `The <${name}> tag is not closed with >.`, severity: 1 })
    ;(element.parent ? element.parent.children : roots).push(element)
    index = at
    if (VOID.has(name) && !foreign) {
      close(element, at)
      continue
    }
    if (element.selfClosing) {
      if (!foreign && !name.includes('-')) problems.push({ start: element.start, end: at, message: `<${name}/> does not close it in HTML; write <${name}></${name}>.`, severity: 2 })
      else {
        close(element, at)
        continue
      }
    }
    if (RAW_TEXT.has(name) && !foreign) {
      const closing = new RegExp(`</${name}\\s*>`, 'ig')
      closing.lastIndex = at
      const found = closing.exec(text)
      const contentEnd = found ? found.index : length
      if (name === 'style') styles.push({ start: at, end: contentEnd })
      if (found) {
        element.endTagStart = found.index
        close(element, found.index + found[0].length)
        index = found.index + found[0].length
      } else {
        unclosed(element)
        close(element, length)
        index = length
      }
      continue
    }
    if (stack.length >= MAX_DEPTH) {
      problems.push({ start: element.start, end: at, message: 'This is nested too deeply to read.', severity: 2 })
      close(element, at)
      continue
    }
    stack.push(element)
  }
  while (stack.length) {
    const open = stack.pop()!
    unclosed(open)
    close(open, length)
  }
  return { roots, comments, styles, problems }
}

/** Every element, depth first. */
export function* elements(nodes: readonly Element[]): Generator<Element> {
  for (const node of nodes) {
    yield node
    yield* elements(node.children)
  }
}

/** The innermost element whose span holds an offset. */
export function elementAt(nodes: readonly Element[], offset: number): Element | null {
  let found: Element | null = null
  let level = nodes
  for (;;) {
    const next = level.find((node) => offset >= node.start && offset <= node.end && !(node.end === offset && node.endTagStart !== null))
    if (!next) return found
    found = next
    level = next.children
  }
}

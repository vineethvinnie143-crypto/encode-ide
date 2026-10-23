/**
 * HTML: problems (elements left open, end tags that close nothing, unknown or obsolete elements, repeated attributes
 * and ids, images with no alt text), completion of elements, end tags, attributes, their values and character
 * references, hovers on elements, symbols and folding (ADR 0085). The CSS in `<style>` gets the CSS service, through a
 * copy of the document with everything else blanked, so offsets are the same.
 */
import { CssService } from '../css/service'
import { HTML_ATTRIBUTE_VALUES, HTML_ELEMENTS, HTML_GLOBAL_ATTRIBUTES } from '../data/html-data'
import { closest, Document, ItemKind, Severity, SymbolKind, type CompletionItem, type Diagnostic, type DocumentSymbol, type FoldingRange, type Hover, type Position } from '../text'
import { elementAt, elements, parseHtml, type Element, type HtmlDocument } from './parser'

const elementTable = new Map(HTML_ELEMENTS.map(([name, attributes, flags]) => [name, { attributes, flags }]))
const EVENTS = ['onabort', 'onblur', 'onchange', 'onclick', 'oncontextmenu', 'ondblclick', 'ondrag', 'ondragend', 'ondragstart', 'ondrop', 'onerror', 'onfocus', 'oninput', 'oninvalid', 'onkeydown', 'onkeyup', 'onload', 'onmousedown', 'onmouseenter', 'onmouseleave', 'onmousemove', 'onmouseout', 'onmouseover', 'onmouseup', 'onpointerdown', 'onpointermove', 'onpointerup', 'onreset', 'onresize', 'onscroll', 'onselect', 'onsubmit', 'ontoggle', 'onwheel']
const ARIA = ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'aria-expanded', 'aria-controls', 'aria-current', 'aria-disabled', 'aria-live', 'aria-pressed', 'aria-selected', 'aria-checked', 'aria-haspopup', 'aria-modal', 'aria-busy', 'aria-invalid', 'aria-required', 'role']
const ENTITIES: [string, string][] = [['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', 'no-break space'], ['copy', '©'], ['reg', '®'], ['trade', '™'], ['hellip', '…'], ['mdash', '—'], ['ndash', '–'], ['laquo', '«'], ['raquo', '»'], ['euro', '€'], ['pound', '£'], ['times', '×'], ['divide', '÷'], ['larr', '←'], ['rarr', '→'], ['uarr', '↑'], ['darr', '↓'], ['bull', '•'], ['middot', '·'], ['deg', '°']]

export class HtmlService {
  private readonly parsed = new Map<string, { version: number; text: string; html: HtmlDocument }>()

  constructor(private readonly css: CssService) {}

  parse(doc: Document): HtmlDocument {
    const cached = this.parsed.get(doc.uri)
    if (cached && cached.version === doc.version && cached.text === doc.text) return cached.html
    const html = parseHtml(doc.text)
    this.parsed.set(doc.uri, { version: doc.version, text: doc.text, html })
    return html
  }

  forget(uri: string): void {
    this.parsed.delete(uri)
    this.css.forget(`${uri}#style`)
  }

  /** The document with only its `<style>` text left, at the same offsets, as CSS. */
  private styleDocument(doc: Document, html: HtmlDocument): Document | null {
    if (!html.styles.length) return null
    const text = doc.text
    let masked = ''
    let at = 0
    for (const style of html.styles) {
      masked += text.slice(at, style.start).replace(/[^\r\n]/g, ' ')
      masked += text.slice(style.start, style.end)
      at = style.end
    }
    masked += text.slice(at).replace(/[^\r\n]/g, ' ')
    return new Document(`${doc.uri}#style`, 'css', doc.version, masked)
  }

  private inStyle(html: HtmlDocument, offset: number): boolean {
    return html.styles.some((style) => offset >= style.start && offset <= style.end)
  }

  diagnostics(doc: Document): Diagnostic[] {
    const html = this.parse(doc)
    const out: Diagnostic[] = html.problems.map((problem) => ({ range: doc.range(problem.start, problem.end), severity: problem.severity, message: problem.message, source: 'html' }))
    const warn = (start: number, end: number, message: string, severity: number = Severity.Warning, tags?: number[]) => out.push({ range: doc.range(start, end), severity, message, source: 'html', ...(tags ? { tags } : {}) })
    const ids = new Map<string, number>()
    for (const element of elements(html.roots)) {
      const nameEnd = element.start + 1 + element.name.length
      if (!element.foreign && !element.name.includes('-')) {
        const known = elementTable.get(element.name)
        if (!known) {
          const near = closest(element.name, elementTable.keys())
          warn(element.start + 1, nameEnd, `Unknown element <${element.name}>.${near ? ` Did you mean <${near}>?` : ''}`)
        } else if (known.flags & 2) {
          warn(element.start + 1, nameEnd, `<${element.name}> is obsolete.`, Severity.Warning, [2])
        }
      }
      const seen = new Set<string>()
      for (const attribute of element.attributes) {
        const lower = attribute.name.toLowerCase()
        if (seen.has(lower)) warn(attribute.start, attribute.end, `${attribute.name} is already on this element; the first one is used.`)
        seen.add(lower)
        if (lower === 'id' && attribute.value) {
          const id = attribute.value.text.replace(/^["']|["']$/g, '')
          if (id && !/[{}<%$]/.test(id)) {
            if (ids.has(id)) warn(attribute.value.start, attribute.value.end, `The id ${JSON.stringify(id)} is already used on this page.`)
            else ids.set(id, attribute.value.start)
          }
        }
      }
      if (element.name === 'img' && !seen.has('alt') && !element.foreign) warn(element.start + 1, nameEnd, 'This image has no alt text for screen readers; use alt="" for one that is only decoration.', Severity.Information)
    }
    const styles = this.styleDocument(doc, html)
    if (styles) out.push(...this.css.diagnostics(styles))
    return out
  }

  completion(doc: Document, position: Position): CompletionItem[] {
    const html = this.parse(doc)
    const offset = doc.offsetAt(position)
    if (this.inStyle(html, offset)) {
      const styles = this.styleDocument(doc, html)
      return styles ? this.css.completion(styles, position) : []
    }
    const text = doc.text
    let start = offset
    while (start > 0 && /[\w:-]/.test(text[start - 1]!)) start--
    const range = doc.range(start, offset)
    const items: CompletionItem[] = []
    const add = (item: Omit<CompletionItem, 'range'>) => items.push({ ...item, range })
    const before = text[start - 1] ?? ''

    if (before === '&' || /&[\w]*$/.test(text.slice(Math.max(0, offset - 12), offset))) {
      const amp = text.lastIndexOf('&', offset)
      for (const [name, shows] of ENTITIES) items.push({ label: `&${name};`, kind: ItemKind.Constant, detail: shows, filterText: `&${name}`, range: doc.range(amp, offset) })
      return items
    }
    if (before === '<') {
      for (const [name, , flags] of HTML_ELEMENTS) if (!(flags & 2)) add({ label: name, kind: ItemKind.Property })
      return items
    }
    if (before === '/' && text[start - 2] === '<') {
      const open = elementAt(html.roots, start - 2)
      let element: Element | null = open && open.start < start - 2 ? open : (open?.parent ?? null)
      while (element && element.endTagStart !== null && element.endTagStart < start - 2) element = element.parent
      if (element) add({ label: element.name, kind: ItemKind.Property, insertText: `${element.name}>` })
      return items
    }
    // Inside a start tag: an attribute's name, or its value.
    const tag = startTagAt(html, offset, text)
    if (!tag) return items
    const value = tag.attributes.find((attribute) => attribute.value && offset > attribute.value.start && offset <= attribute.value.end && /^["']/.test(attribute.value.text) && !(offset === attribute.value.end && attribute.value.text.length > 1 && attribute.value.text.endsWith(attribute.value.text[0]!)))
    if (value) {
      const lower = value.name.toLowerCase()
      const options = HTML_ATTRIBUTE_VALUES[`${tag.name}/${lower}`] ?? HTML_ATTRIBUTE_VALUES[`*/${lower}`] ?? []
      let valueStart = offset
      while (valueStart > value.value!.start + 1 && /[^\s"']/.test(text[valueStart - 1]!)) valueStart--
      for (const option of options) items.push({ label: option, kind: ItemKind.Value, range: doc.range(valueStart, offset) })
      return items
    }
    if (/[\s"']$/.test(text.slice(0, start)) || before === '') {
      const present = new Set(tag.attributes.map((attribute) => attribute.name.toLowerCase()))
      const own = elementTable.get(tag.name)?.attributes ?? []
      const offer = (name: string, sort: string) => {
        if (present.has(name)) return
        present.add(name)
        const hasValues = HTML_ATTRIBUTE_VALUES[`${tag.name}/${name}`] ?? HTML_ATTRIBUTE_VALUES[`*/${name}`]
        add({ label: name, kind: ItemKind.Field, insertText: `${name}="$1"`, insertTextFormat: 2, sortText: `${sort}${name}`, ...(hasValues ? { detail: hasValues.slice(0, 6).join(' | ') } : {}) })
      }
      for (const name of own) offer(name, 'a')
      for (const name of HTML_GLOBAL_ATTRIBUTES) offer(name, 'b')
      for (const name of ARIA) offer(name, 'c')
      for (const name of EVENTS) offer(name, 'd')
    }
    return items
  }

  hover(doc: Document, position: Position): Hover | null {
    const html = this.parse(doc)
    const offset = doc.offsetAt(position)
    if (this.inStyle(html, offset)) {
      const styles = this.styleDocument(doc, html)
      return styles ? this.css.hover(styles, position) : null
    }
    const element = elementAt(html.roots, offset)
    if (!element || element.foreign) return null
    const inStart = offset > element.start && offset <= element.start + 1 + element.name.length
    const inEnd = element.endTagStart !== null && offset > element.endTagStart + 1 && offset <= element.endTagStart + 2 + element.name.length
    if (!inStart && !inEnd) return null
    const known = elementTable.get(element.name)
    if (!known) return null
    const notes = [`**<${element.name}>**`]
    if (known.flags & 1) notes.push('Void: it takes no content and no end tag.')
    if (known.flags & 2) notes.push('Obsolete: the HTML standard no longer has it.')
    if (known.attributes.length) notes.push(`Its own attributes: ${known.attributes.map((name) => `\`${name}\``).join(', ')}`)
    const start = inStart ? element.start + 1 : element.endTagStart! + 2
    return { contents: { kind: 'markdown', value: notes.join('\n\n') }, range: doc.range(start, start + element.name.length) }
  }

  symbols(doc: Document): DocumentSymbol[] {
    const html = this.parse(doc)
    let count = 0
    const make = (nodes: readonly Element[]): DocumentSymbol[] =>
      nodes.flatMap((element) => {
        if (++count > 5000) return []
        const id = element.attributes.find((attribute) => attribute.name.toLowerCase() === 'id')?.value?.text.replace(/^["']|["']$/g, '')
        const classes = element.attributes.find((attribute) => attribute.name.toLowerCase() === 'class')?.value?.text.replace(/^["']|["']$/g, '').trim().split(/\s+/).filter(Boolean).slice(0, 3)
        const name = `${element.name}${id ? `#${id}` : ''}${classes?.length ? `.${classes.join('.')}` : ''}`
        return [{ name, kind: SymbolKind.Field, range: doc.range(element.start, element.end), selectionRange: doc.range(element.start, element.startTagEnd), children: make(element.children) }]
      })
    return make(html.roots)
  }

  folding(doc: Document): FoldingRange[] {
    const html = this.parse(doc)
    const ranges: FoldingRange[] = []
    for (const element of elements(html.roots)) {
      const start = doc.positionAt(element.start).line
      const end = doc.positionAt(element.endTagStart ?? element.end).line - (element.endTagStart !== null ? 1 : 0)
      if (end > start) ranges.push({ startLine: start, endLine: end })
    }
    for (const comment of html.comments) {
      const start = doc.positionAt(comment.start).line
      const end = doc.positionAt(comment.end).line
      if (end > start) ranges.push({ startLine: start, endLine: end, kind: 'comment' })
    }
    const styles = this.styleDocument(doc, html)
    if (styles) ranges.push(...this.css.folding(styles))
    return ranges.sort((a, b) => a.startLine - b.startLine)
  }
}

/** The element whose start tag holds an offset (past its name). */
function startTagAt(html: HtmlDocument, offset: number, text: string): Element | null {
  let found: Element | null = null
  for (const element of elements(html.roots)) {
    if (element.start > offset) break
    const closed = text[element.startTagEnd - 1] === '>'
    if (offset > element.start + element.name.length && (offset < element.startTagEnd || (!closed && offset <= element.startTagEnd))) found = element
  }
  return found
}

/**
 * HTML to readable Markdown-like text for the model: headings, links with
 * absolute addresses, lists, code blocks and paragraphs survive; scripts,
 * styles and markup do not. When a page marks its main content (<main> or
 * <article>), only that is kept, which drops navigation and footers.
 */

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'head', 'title', 'object', 'select'])
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'form', 'table', 'tr', 'ul', 'ol', 'dl', 'dt', 'dd',
  'blockquote', 'figure', 'figcaption', 'details', 'summary', 'hr', 'address', 'fieldset',
])
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'base', 'col', 'embed', 'param', 'track'])

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', copy: '(c)', reg: '(R)', trade: '(TM)',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', bull: '*', middot: '.', laquo: '<<', raquo: '>>', times: 'x', deg: ' degrees',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attributes)
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : undefined
}

function absolute(href: string, base: string | undefined): string {
  try {
    return base ? new URL(href, base).href : href
  } catch {
    return href
  }
}

/** The inside of the page's <main> or largest <article>, when it has one. */
function mainContent(html: string): string {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)
  if (main && main[1].trim().length > 200) return main[1]
  let best = ''
  for (const match of html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) if (match[1].length > best.length) best = match[1]
  return best.trim().length > 200 ? best : html
}

export function pageTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : ''
  return title || undefined
}

export function htmlToText(html: string, baseUrl?: string): string {
  const source = mainContent(html)
  const out: string[] = []
  let skipDepth = 0
  let skipTag = ''
  let preDepth = 0
  const lists: { ordered: boolean; index: number }[] = []
  const links: { href: string; raw: string; start: number }[] = []

  const newline = (count = 1) => {
    const text = out.join('')
    const trailing = /\n*$/.exec(text)![0].length
    if (text.length && trailing < count) out.push('\n'.repeat(count - trailing))
  }

  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?)>|([^<]+)|</gi
  for (const match of source.matchAll(tokens)) {
    const [whole, closing, rawName, attributes = '', , text] = match
    if (text !== undefined || (whole === '<' && !rawName)) {
      if (skipDepth) continue
      const value = decodeEntities(text ?? whole)
      out.push(preDepth ? value : value.replace(/\s+/g, ' '))
      continue
    }
    if (!rawName) continue
    const name = rawName.toLowerCase()

    if (skipDepth) {
      if (name === skipTag) skipDepth += closing ? -1 : 1
      continue
    }
    if (SKIP.has(name)) {
      if (!closing && !VOID.has(name) && !whole.endsWith('/>')) {
        skipDepth = 1
        skipTag = name
      }
      continue
    }

    if (closing) {
      if (/^h[1-6]$/.test(name)) newline(2)
      else if (name === 'pre') {
        preDepth = Math.max(0, preDepth - 1)
        newline()
        out.push('```')
        newline(2)
      } else if (name === 'code' && !preDepth) out.push('`')
      else if (name === 'a') {
        const link = links.pop()
        if (link) {
          const label = out.slice(link.start).join('').trim()
          out.splice(link.start)
          const bare = !link.href || /^(javascript|data):/i.test(link.href) || label === link.href || label === link.raw
          out.push(label && !bare ? `[${label}](${link.href})` : label || link.href)
        }
      } else if (name === 'ul' || name === 'ol') {
        lists.pop()
        newline(lists.length ? 1 : 2)
      } else if (name === 'li') newline()
      else if (name === 'td' || name === 'th') out.push(' | ')
      else if (BLOCK.has(name)) newline(2)
      else if (name === 'strong' || name === 'b') out.push('**')
      else if (name === 'em' || name === 'i') out.push('*')
      continue
    }

    switch (name) {
      case 'br':
        out.push('\n')
        break
      case 'hr':
        newline(2)
        out.push('---')
        newline(2)
        break
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        newline(2)
        out.push(`${'#'.repeat(Number(name[1]))} `)
        break
      case 'pre':
        newline(2)
        out.push('```\n')
        preDepth++
        break
      case 'code':
        if (!preDepth) out.push('`')
        break
      case 'a': {
        const raw = attribute(attributes, 'href') ?? ''
        links.push({ href: absolute(raw, baseUrl), raw, start: out.length })
        break
      }
      case 'img': {
        const alt = attribute(attributes, 'alt')?.trim()
        if (alt) out.push(`[image: ${alt}]`)
        break
      }
      case 'ul':
      case 'ol':
        newline(lists.length ? 1 : 2)
        lists.push({ ordered: name === 'ol', index: 0 })
        break
      case 'li': {
        newline()
        const list = lists.at(-1)
        const indent = '  '.repeat(Math.max(0, lists.length - 1))
        out.push(list?.ordered ? `${indent}${++list.index}. ` : `${indent}- `)
        break
      }
      case 'strong':
      case 'b':
        out.push('**')
        break
      case 'em':
      case 'i':
        out.push('*')
        break
      case 'blockquote':
        newline(2)
        out.push('> ')
        break
      default:
        if (BLOCK.has(name)) newline(name === 'tr' ? 1 : 2)
    }
  }

  // Tidy the prose; leave code blocks exactly as they were.
  const tidy = (part: string) =>
    part
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+(.*)$/, (whole, rest: string) => (/^[-*\d]/.test(rest) ? whole : rest)))
      .join('\n')
      .replace(/\*\*\s*\*\*/g, '')
  return out
    .join('')
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) => (index % 2 ? part : tidy(part)))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

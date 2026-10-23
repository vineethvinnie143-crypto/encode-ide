/**
 * Hand-written markdown renderer for agent output. Everything is escaped first
 * and only a safe allow-list of tags and link protocols is emitted, so the
 * result can be injected as HTML without a sanitizer dependency.
 */

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function safeHref(raw: string): string | null {
  const value = raw.trim()
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return value
  return null
}

function renderInline(text: string): string {
  let output = escapeHtml(text)
  output = output.replace(/`([^`]+)`/g, (_match, code: string) => `<code>${code}</code>`)
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  output = output.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  output = output.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    const safe = safeHref(href)
    return safe ? `<a href="${safe}" target="_blank" rel="noreferrer">${label}</a>` : match
  })
  return output
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-')
}

/**
 * The markdown as its top-level blocks, each one HTML element (a paragraph, a heading, a list, a table, a code
 * block...). A streamed answer grows at its end, so the blocks before the last stay the same from one piece to
 * the next, and a page that keeps them as they are (Chat/Markdown.tsx) redraws only the end.
 */
export interface MarkdownOptions {
  /** Draws a fenced code block itself (its text and fence language as written), instead of the block with a Copy button. */
  codeBlock?: (code: string, language: string) => string
}

export function renderMarkdownBlocks(source: string, options: MarkdownOptions = {}): string[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    // Fenced code blocks
    const fence = /^\s*```(\w*)\s*$/.exec(line)
    if (fence) {
      const language = fence[1]
      const body: string[] = []
      index++
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index])
        index++
      }
      index++ // consume closing fence
      if (options.codeBlock) {
        html.push(options.codeBlock(body.join('\n'), language))
        continue
      }
      const className = language ? ` class="language-${escapeHtml(language)}"` : ''
      // A header with the language and a Copy button; the page wires the button up (see Chat/Markdown.tsx).
      html.push(
        `<div class="code-block"><div class="code-head" data-find-skip><span class="code-lang">${escapeHtml(language || 'text')}</span>` +
          `<button type="button" class="code-copy">Copy</button></div>` +
          `<pre><code${className}>${escapeHtml(body.join('\n'))}</code></pre></div>`,
      )
      continue
    }

    // Blank line
    if (!line.trim()) {
      index++
      continue
    }

    // Horizontal rule
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html.push('<hr />')
      index++
      continue
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      index++
      continue
    }

    // Table (GFM)
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const head = splitRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitRow(lines[index]))
        index++
      }
      const headHtml = head.map((cell) => `<th>${renderInline(cell)}</th>`).join('')
      const bodyHtml = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
        .join('')
      html.push(`<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`)
      continue
    }

    // Blockquote
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''))
        index++
      }
      html.push(`<blockquote>${body.map((part) => renderInline(part)).join('<br />')}</blockquote>`)
      continue
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ''))
        index++
      }
      html.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`)
      continue
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''))
        index++
      }
      html.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ol>`)
      continue
    }

    // Paragraph (consecutive plain lines join with a space, like markdown)
    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*```/.test(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*>/.test(lines[index]) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index])
      index++
    }
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`)
  }

  return html
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  return renderMarkdownBlocks(source, options).join('')
}

export { escapeHtml }

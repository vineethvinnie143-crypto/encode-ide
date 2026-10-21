/**
 * A small ANSI terminal screen buffer. It understands the subset of control
 * sequences that real CLIs actually use (SGR colours, erase, cursor moves,
 * carriage returns for progress output) and renders to HTML without any
 * terminal-emulator dependency.
 */

export interface CellStyle {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

interface Cell {
  ch: string
  style: CellStyle
}

interface Line {
  cells: Cell[]
}

const ANSI_16 = [
  '#1b1f27', '#ff6b6b', '#3ddc97', '#f7c96b', '#7cc6ff', '#d29bff', '#5fe0d0', '#c9d1dc',
  '#5b6675', '#ff8f8f', '#6ff0b8', '#ffe08a', '#a4dbff', '#e3b8ff', '#9bf3e8', '#eef3f9',
]

function rgb(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`
}

function color256(index: number): string {
  if (index < 16) return ANSI_16[index]
  if (index < 232) {
    const value = index - 16
    const r = Math.floor(value / 36)
    const g = Math.floor((value % 36) / 6)
    const b = value % 6
    const component = (n: number) => (n === 0 ? 0 : 55 + n * 40)
    return rgb(component(r), component(g), component(b))
  }
  const gray = 8 + (index - 232) * 10
  return rgb(gray, gray, gray)
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function styleKey(style: CellStyle): string {
  return `${style.fg ?? ''}|${style.bg ?? ''}|${style.bold ? 1 : 0}${style.dim ? 1 : 0}${style.italic ? 1 : 0}${style.underline ? 1 : 0}`
}

function styleToCss(style: CellStyle): string {
  const parts: string[] = []
  if (style.fg) parts.push(`color:${style.fg}`)
  if (style.bg) parts.push(`background:${style.bg}`)
  if (style.bold) parts.push('font-weight:600')
  if (style.dim) parts.push('opacity:.65')
  if (style.italic) parts.push('font-style:italic')
  if (style.underline) parts.push('text-decoration:underline')
  return parts.join(';')
}

export class TerminalBuffer {
  private lines: Line[] = [{ cells: [] }]
  private cursorLine = 0
  private cursorCol = 0
  private style: CellStyle = {}
  private savedCursor = { line: 0, col: 0 }
  private readonly maxLines = 6000

  write(text: string): void {
    for (let index = 0; index < text.length; index++) {
      const char = text[index]
      if (char === '\x1b') {
        const next = this.consumeEscape(text, index)
        index = next
        continue
      }
      if (char === '\n') {
        this.cursorLine++
        this.cursorCol = 0
        this.ensureLine(this.cursorLine)
        continue
      }
      if (char === '\r') {
        this.cursorCol = 0
        continue
      }
      if (char === '\b') {
        this.cursorCol = Math.max(0, this.cursorCol - 1)
        continue
      }
      if (char === '\t') {
        const spaces = 4 - (this.cursorCol % 4)
        for (let i = 0; i < spaces; i++) this.put(' ')
        continue
      }
      if (char === '\x07' || char.charCodeAt(0) < 32) continue
      this.put(char)
    }
    this.trimHistory()
  }

  clear(): void {
    this.lines = [{ cells: [] }]
    this.cursorLine = 0
    this.cursorCol = 0
    this.style = {}
  }

  toHtml(maxLines = 2500): string {
    const start = Math.max(0, this.lines.length - maxLines)
    const output: string[] = []
    for (let lineIndex = start; lineIndex < this.lines.length; lineIndex++) {
      const cells = this.lines[lineIndex].cells
      let html = '<div class="term-line">'
      let runText = ''
      let runStyle: CellStyle | null = null

      const flush = () => {
        if (!runText) return
        const css = runStyle ? styleToCss(runStyle) : ''
        html += css ? `<span style="${css}">${escapeHtml(runText)}</span>` : escapeHtml(runText)
        runText = ''
      }

      for (const cell of cells) {
        if (runStyle && styleKey(runStyle) === styleKey(cell.style)) {
          runText += cell.ch
        } else {
          flush()
          runStyle = cell.style
          runText = cell.ch
        }
      }
      flush()
      html += '</div>'
      output.push(html)
    }
    return output.join('')
  }

  toText(): string {
    return this.lines.map((line) => line.cells.map((cell) => cell.ch).join('')).join('\n')
  }

  private trimHistory(): void {
    if (this.lines.length <= this.maxLines) return
    const remove = this.lines.length - this.maxLines
    this.lines.splice(0, remove)
    this.cursorLine = Math.max(0, this.cursorLine - remove)
  }

  private ensureLine(index: number): void {
    while (this.lines.length <= index) this.lines.push({ cells: [] })
  }

  private put(char: string): void {
    const line = this.lines[this.cursorLine] ?? (this.lines[this.cursorLine] = { cells: [] })
    while (line.cells.length < this.cursorCol) line.cells.push({ ch: ' ', style: {} })
    line.cells[this.cursorCol] = { ch: char, style: { ...this.style } }
    this.cursorCol++
  }

  private consumeEscape(text: string, index: number): number {
    const next = text[index + 1]
    if (next === '[') {
      let cursor = index + 2
      let params = ''
      while (cursor < text.length && /[0-9;?]/.test(text[cursor])) {
        params += text[cursor]
        cursor++
      }
      if (cursor >= text.length) return text.length - 1
      this.applyCsi(params, text[cursor])
      return cursor
    }
    if (next === ']') {
      let cursor = index + 2
      while (cursor < text.length && text[cursor] !== '\x07') {
        if (text[cursor] === '\x1b' && text[cursor + 1] === '\\') return cursor + 1
        cursor++
      }
      return cursor
    }
    return Math.min(index + 1, text.length - 1)
  }

  private applyCsi(paramsText: string, final: string): void {
    const params = paramsText
      .split(';')
      .filter((part) => part.length > 0)
      .map((part) => Number(part) || 0)
    const first = params[0] ?? 0

    switch (final) {
      case 'm':
        this.applySgr(params.length ? params : [0])
        return
      case 'K':
        this.eraseLine(first)
        return
      case 'J':
        this.eraseScreen(first)
        return
      case 'H':
      case 'f':
        this.cursorLine = Math.max(0, (params[0] ?? 1) - 1)
        this.cursorCol = Math.max(0, (params[1] ?? 1) - 1)
        return
      case 'A':
        this.cursorLine = Math.max(0, this.cursorLine - (first || 1))
        return
      case 'B':
        this.cursorLine += first || 1
        this.ensureLine(this.cursorLine)
        return
      case 'C':
        this.cursorCol += first || 1
        return
      case 'D':
        this.cursorCol = Math.max(0, this.cursorCol - (first || 1))
        return
      case 'G':
        this.cursorCol = Math.max(0, (first || 1) - 1)
        return
      case 'd':
        this.cursorLine = Math.max(0, (first || 1) - 1)
        this.ensureLine(this.cursorLine)
        return
      case 'E':
        this.cursorLine += first || 1
        this.cursorCol = 0
        this.ensureLine(this.cursorLine)
        return
      case 'F':
        this.cursorLine = Math.max(0, this.cursorLine - (first || 1))
        this.cursorCol = 0
        return
      case 's':
        this.savedCursor = { line: this.cursorLine, col: this.cursorCol }
        return
      case 'u':
        this.cursorLine = this.savedCursor.line
        this.cursorCol = this.savedCursor.col
        return
      default:
        return
    }
  }

  private applySgr(params: number[]): void {
    for (let index = 0; index < params.length; index++) {
      const value = params[index]
      if (value === 0) this.style = {}
      else if (value === 1) this.style.bold = true
      else if (value === 2) this.style.dim = true
      else if (value === 3) this.style.italic = true
      else if (value === 4) this.style.underline = true
      else if (value === 22) {
        this.style.bold = false
        this.style.dim = false
      } else if (value === 23) this.style.italic = false
      else if (value === 24) this.style.underline = false
      else if (value >= 30 && value <= 37) this.style.fg = ANSI_16[value - 30]
      else if (value === 39) delete this.style.fg
      else if (value >= 40 && value <= 47) this.style.bg = ANSI_16[value - 40]
      else if (value === 49) delete this.style.bg
      else if (value >= 90 && value <= 97) this.style.fg = ANSI_16[value - 90 + 8]
      else if (value >= 100 && value <= 107) this.style.bg = ANSI_16[value - 100 + 8]
      else if (value === 38 || value === 48) {
        const target = value === 38 ? 'fg' : 'bg'
        const mode = params[index + 1]
        if (mode === 5 && params[index + 2] !== undefined) {
          this.style[target] = color256(params[index + 2])
          index += 2
        } else if (mode === 2 && params[index + 4] !== undefined) {
          this.style[target] = rgb(params[index + 2], params[index + 3], params[index + 4])
          index += 4
        }
      }
    }
  }

  private eraseLine(mode: number): void {
    const line = this.lines[this.cursorLine]
    if (!line) return
    if (mode === 0) line.cells = line.cells.slice(0, this.cursorCol)
    else if (mode === 1) {
      for (let index = 0; index <= this.cursorCol && index < line.cells.length; index++) {
        line.cells[index] = { ch: ' ', style: {} }
      }
    } else {
      line.cells = []
    }
  }

  private eraseScreen(mode: number): void {
    if (mode === 0) {
      this.eraseLine(0)
      this.lines = this.lines.slice(0, this.cursorLine + 1)
    } else if (mode === 1) {
      for (let index = 0; index < this.cursorLine; index++) this.lines[index] = { cells: [] }
      this.eraseLine(1)
    } else {
      this.lines = [{ cells: [] }]
      this.cursorLine = 0
      this.cursorCol = 0
    }
  }
}

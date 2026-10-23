import { EditorSelection, SelectionRange, copyText, cutText, insertTyped, paste, type ClipboardText, type EditorState } from '@encode/editor'
import { stringWidth } from '@encode/text'
import type { EditorView } from './view'

/**
 * The last copy made from any editor on this page, its line breaks as `\n`. The clipboard holds only text, so when
 * what is pasted is that text again, this says it was whole lines and what each cursor gave.
 */
let lastCopy: ClipboardText | null = null

const lf = (text: string): string => text.replace(/\r\n?/g, '\n')

/** For a screen reader the textarea holds the lines around the cursor, in pages of this many, so moving in a page reads as moving in a text. */
const PAGE_LINES = 10
/** At most this much of the document, around the cursor, is in the textarea. */
const MIRROR_LIMIT = 20_000

/** The part of the document in the textarea for a screen reader: its text from `from`, and the selection in it. */
interface Mirror {
  text: string
  from: number
  start: number
  end: number
}

/** `pos` kept between `from` and `to`, and off the middle of a surrogate pair. */
function within(doc: EditorState['doc'], pos: number, from: number, to: number): number {
  let at = Math.min(to, Math.max(from, pos))
  if (at > from && at < to) {
    const code = doc.sliceString(at, at + 1).charCodeAt(0)
    if (code >= 0xdc00 && code <= 0xdfff) at--
  }
  return at
}

/** What goes on the clipboard: the copy with the document's own line breaks, so a Windows file copies as Windows text. */
function clipboardText(state: EditorState, copy: ClipboardText): string {
  lastCopy = copy
  return state.config.lineSeparator === '\r\n' ? copy.text.replace(/\n/g, '\r\n') : copy.text
}

/**
 * Keyboard, text and clipboard input, through a hidden textarea that sits at
 * the caret. Typed text arrives as input events, so dead keys, AltGr, the
 * emoji picker and voice typing all work; shortcuts are matched on keydown.
 * An input method composes in the textarea, which stays invisible over the
 * composition: the view draws the composition in place at every cursor (the
 * caret after it), moving the text after it along.
 *
 * With a screen reader the textarea is not empty: it holds the lines around
 * the main cursor with the selection in them, kept up to date as the state
 * changes, so the screen reader reads the character, word or line the cursor
 * moves over and what is selected. What is typed is then what changed between
 * that text and the textarea's, and a selection the screen reader makes in it
 * (braille routing keys) becomes the editor's.
 */
export class InputHandler {
  composing = false
  /** Escape was the last key: Tab, the editor's indent key, now leaves the editor instead, so the keyboard is never trapped. */
  private escaped = false
  /** What the textarea holds for a screen reader; null while it holds only what is being typed. */
  private mirror: Mirror | null = null

  constructor(private readonly view: EditorView) {
    const textarea = view.textarea
    view.listen(textarea, 'keydown', (event) => this.keydown(event))
    view.listen(textarea, 'input', (event) => this.input(event as InputEvent))
    view.listen(textarea, 'compositionstart', () => this.compositionStart())
    view.listen(textarea, 'compositionupdate', () => this.compositionUpdate())
    view.listen(textarea, 'compositionend', (event) => this.compositionEnd(event))
    view.listen(textarea, 'copy', (event) => this.copy(event))
    view.listen(textarea, 'cut', (event) => this.cut(event))
    view.listen(textarea, 'paste', (event) => this.paste(event))
    // A click or a drag in the editor disarms Escape, as any other key does: Tab after it indents again.
    view.listen(view.root, 'mousedown', () => (this.escaped = false))
    view.listen(view.root, 'dragover', (event) => this.dragOver(event))
    view.listen(view.root, 'drop', (event) => this.drop(event))
    const selected = (): void => this.textareaSelected()
    document.addEventListener('selectionchange', selected)
    view.addDisposer(() => document.removeEventListener('selectionchange', selected))
  }

  reset(): void {
    this.composing = false
    this.view.textarea.value = ''
    this.mirror = null
    this.view.textarea.style.width = ''
    this.view.root.classList.remove('enc-composing')
    this.view.setComposition(null)
    this.syncMirror()
  }

  /**
   * Puts the lines around the main cursor in the textarea for a screen reader, with the selection, when they are not
   * there already; takes them out when there is none. Not while an input method composes in it.
   */
  syncMirror(): void {
    const view = this.view
    const textarea = view.textarea
    if (this.composing) return
    if (!view.options.screenReader) {
      if (this.mirror) {
        this.mirror = null
        textarea.value = ''
      }
      return
    }
    const { doc, selection } = view.state
    const main = selection.main
    const first = doc.lineAt(main.from).number
    const last = doc.lineAt(main.to).number
    const pageStart = Math.floor((first - 1) / PAGE_LINES) * PAGE_LINES + 1
    const pageEnd = Math.min(doc.lineCount, Math.max(last, pageStart + PAGE_LINES - 1))
    let from = doc.line(pageStart).from
    let to = doc.line(pageEnd).to
    if (to - from > MIRROR_LIMIT) {
      // A long line or a large selection: the part around the cursor's head.
      from = within(doc, Math.max(from, Math.min(main.head - MIRROR_LIMIT / 2, to - MIRROR_LIMIT)), from, to)
      to = within(doc, from + MIRROR_LIMIT, from, to)
    }
    const text = doc.sliceString(from, to)
    const start = within(doc, main.from, from, to) - from
    const end = within(doc, main.to, from, to) - from
    this.mirror = { text, from, start, end }
    if (textarea.value !== text) textarea.value = text
    const direction = main.head < main.anchor ? 'backward' : 'forward'
    if (textarea.selectionStart !== start || textarea.selectionEnd !== end || textarea.selectionDirection !== direction) {
      textarea.setSelectionRange(start, end, direction)
    }
  }

  /** A screen reader (or the system) moved the selection in the textarea: the editor's selection follows. */
  private textareaSelected(): void {
    const mirror = this.mirror
    const textarea = this.view.textarea
    if (!mirror || this.composing || document.activeElement !== textarea || textarea.value !== mirror.text) return
    const { selectionStart: start, selectionEnd: end, selectionDirection: direction } = textarea
    if (start === mirror.start && end === mirror.end) return
    const [anchor, head] = direction === 'backward' ? [end, start] : [start, end]
    this.view.dispatch({ selection: EditorSelection.create([new SelectionRange(mirror.from + anchor, mirror.from + head)]), origin: 'select', scrollIntoView: true })
  }

  /** What is being composed: the textarea's text, or with a screen reader what took the selection's place in it. */
  private composedText(): string {
    const value = this.view.textarea.value
    const mirror = this.mirror
    if (!mirror) return value
    const tail = mirror.text.length - mirror.end
    return value.length >= mirror.start + tail ? value.slice(mirror.start, value.length - tail) : ''
  }

  /** Ends a composition with what has been composed so far, as moving the caret elsewhere should. */
  commitComposition(): void {
    if (!this.composing) return
    // The browser commits a composition when its field loses the focus, and fires compositionend.
    const textarea = this.view.textarea
    textarea.blur()
    textarea.focus({ preventScroll: true })
    if (this.composing) this.compositionEnd(new CompositionEvent('compositionend', { data: this.composedText() }))
  }

  private keydown(event: KeyboardEvent): void {
    if (this.composing || event.isComposing) return
    if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey
    if (this.escaped && event.key === 'Tab' && plain) {
      this.escaped = false
      return
    }
    this.escaped = event.key === 'Escape' && plain && !event.shiftKey
    // Tab moves the focus, as in a form, while that is turned on (Ctrl+M); it still goes to a snippet's next stop.
    const tabFocus = this.view.options.tabMovesFocus && event.key === 'Tab' && plain
    for (const name of this.view.keymap.lookup(event)) {
      if (tabFocus && (name === 'insertTab' || name === 'indentLess')) continue
      if (this.view.runCommand(name)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }
    // Tab and Shift+Tab are the editor's even when they change nothing (Shift+Tab on a line with no indent), so the
    // focus never jumps out on its own; Escape first, or Ctrl+M, is the way out. A read-only editor lets them go.
    if (event.key === 'Tab' && plain && !tabFocus && !this.view.state.config.readOnly) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  private input(event: InputEvent): void {
    // Composed text with no compositionstart before it (the focus came back to the editor while an input method was
    // open): the composition is taken up from here, so it is drawn and committed like any other.
    if (event.isComposing && !this.composing) this.compositionStart()
    if (this.composing) {
      this.showComposition()
      return
    }
    const mirror = this.mirror
    if (mirror) {
      this.mirrorChanged(mirror)
      return
    }
    const text = this.view.textarea.value
    this.view.textarea.value = ''
    if (text) this.insert(text)
  }

  /**
   * With a screen reader: what changed between the text put in the textarea and what it holds now. Text that took the
   * selection's place is typed, with the editor's conveniences; any other change (a screen reader's own editing) is
   * made as it is. Then the textarea holds the document again.
   */
  private mirrorChanged(mirror: Mirror): void {
    const value = this.view.textarea.value
    const head = mirror.text.slice(0, mirror.start)
    const tail = mirror.text.slice(mirror.end)
    if (value.length >= head.length + tail.length && value.startsWith(head) && value.endsWith(tail)) {
      const typed = value.slice(head.length, value.length - tail.length)
      if (typed) this.insert(typed)
    } else {
      let prefix = 0
      const most = Math.min(value.length, mirror.text.length)
      while (prefix < most && value.charCodeAt(prefix) === mirror.text.charCodeAt(prefix)) prefix++
      let suffix = 0
      while (suffix < most - prefix && value.charCodeAt(value.length - 1 - suffix) === mirror.text.charCodeAt(mirror.text.length - 1 - suffix)) suffix++
      const insert = value.slice(prefix, value.length - suffix).replace(/\r\n?/g, '\n')
      if (!this.view.state.config.readOnly) {
        const from = mirror.from + prefix
        this.view.dispatch({ changes: { from, to: mirror.from + mirror.text.length - suffix, insert }, selection: SelectionRange.cursor(from + insert.length), origin: 'input.type', scrollIntoView: true })
      }
    }
    this.syncMirror()
  }

  /** Text typed or inserted by the system, with the editor's typing conveniences. */
  insert(text: string): void {
    const tr = insertTyped(this.view.state, text.replace(/\r\n?/g, '\n'))
    if (tr) this.view.dispatch(tr)
    else if (this.view.state.config.readOnly) this.view.announce('The editor is read-only.')
  }

  private compositionStart(): void {
    const state = this.view.state
    // Composing from here on, so the textarea a screen reader reads is left alone while the input method works in it.
    this.composing = true
    // What is selected is replaced by what is composed, so it goes first, as typing over it would take it.
    const selected = state.selection.ranges.filter((range) => !range.empty)
    if (selected.length && !state.config.readOnly) {
      this.view.dispatch({ changes: selected.map((range) => ({ from: range.from, to: range.to })), origin: 'input.type', scrollIntoView: true })
    }
    this.view.root.classList.add('enc-composing')
    this.positionTextarea()
    this.showComposition()
  }

  private compositionUpdate(): void {
    this.showComposition()
  }

  private compositionEnd(event: CompositionEvent): void {
    if (!this.composing) return
    this.composing = false
    this.view.root.classList.remove('enc-composing')
    this.view.setComposition(null)
    const text = event.data || this.composedText()
    this.view.textarea.value = ''
    this.mirror = null
    this.view.textarea.style.width = ''
    if (text) this.insert(text)
    this.syncMirror()
    this.view.requestRender()
  }

  /** The composition so far, drawn in place; the textarea over it is as wide, so the input method's window follows its end. */
  private showComposition(): void {
    const composed = this.composedText()
    this.sizeComposition(composed)
    this.view.setComposition(composed)
  }

  /** While composing, the textarea is as wide as the text being composed. */
  private sizeComposition(composed: string): void {
    const { charWidth } = this.view.metrics
    const width = stringWidth(composed, this.view.state.config.tabSize)
    this.view.textarea.style.width = `${Math.max(2, Math.ceil(width * charWidth) + 2)}px`
  }

  /** Ctrl+C and Ctrl+Insert. */
  private copy(event: ClipboardEvent): void {
    if (!event.clipboardData) return
    event.clipboardData.setData('text/plain', clipboardText(this.view.state, copyText(this.view.state)))
    event.preventDefault()
  }

  /** Ctrl+X and Shift+Delete. */
  private cut(event: ClipboardEvent): void {
    if (!event.clipboardData) return
    const { clipboard, transaction } = cutText(this.view.state)
    event.clipboardData.setData('text/plain', clipboardText(this.view.state, clipboard))
    event.preventDefault()
    if (transaction) this.view.dispatch(transaction)
  }

  /** Ctrl+V and Shift+Insert. */
  private paste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text/plain')
    event.preventDefault()
    if (!text) return
    const copy = lastCopy && lastCopy.text === lf(text) ? lastCopy : null
    const tr = paste(this.view.state, text, copy?.linewise ?? false, copy?.pieces)
    if (tr) this.view.dispatch(tr)
  }

  private dragOver(event: DragEvent): void {
    if (this.view.state.config.readOnly) return
    if (event.dataTransfer?.types.includes('text/plain') && !event.dataTransfer.types.includes('Files')) event.preventDefault()
  }

  private drop(event: DragEvent): void {
    if (this.view.state.config.readOnly) return
    const text = event.dataTransfer?.getData('text/plain')
    if (!text || event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    const pos = this.view.posAtCoords(event.clientX, event.clientY)
    const normalized = text.replace(/\r\n?/g, '\n')
    this.view.dispatch({
      changes: { from: pos, insert: normalized },
      selection: new SelectionRange(pos, pos + normalized.length),
      origin: 'input.paste',
      scrollIntoView: true,
    })
    this.view.focus()
  }

  /**
   * Puts the textarea at the main caret, so an input method's window opens beside the text being typed; while it
   * composes, over the composition drawn in place, so the window follows the composition's end.
   */
  positionTextarea(): void {
    const view = this.view
    const { head, assoc } = view.state.selection.main
    const { x, y } = (this.composing && view.compositionCoords()) || view.layerCoords(head, assoc)
    const style = view.textarea.style
    style.left = `${x}px`
    style.top = `${y}px`
    style.height = `${view.metrics.lineHeight}px`
  }
}

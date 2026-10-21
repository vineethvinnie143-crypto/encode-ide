import { SelectionRange, copyText, cutText, insertTyped, paste } from '@encode/editor'
import { stringWidth } from '@encode/text'
import type { EditorView } from './view'

/**
 * Keyboard, text and clipboard input, through a hidden textarea that sits at
 * the caret. Typed text arrives as input events, so dead keys, AltGr, the
 * emoji picker and voice typing all work; shortcuts are matched on keydown;
 * an input method's composition is shown in the textarea itself until it is
 * committed.
 */
export class InputHandler {
  composing = false
  /** The text of the last copy made from cursors without a selection: pasting it again puts whole lines above the cursor. */
  private linewise: string | null = null

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
    view.listen(view.root, 'dragover', (event) => this.dragOver(event))
    view.listen(view.root, 'drop', (event) => this.drop(event))
  }

  reset(): void {
    this.composing = false
    this.view.textarea.value = ''
    this.view.root.classList.remove('enc-composing')
  }

  private keydown(event: KeyboardEvent): void {
    if (this.composing || event.isComposing) return
    for (const name of this.view.keymap.lookup(event)) {
      if (this.view.runCommand(name)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }
  }

  private input(event: InputEvent): void {
    if (this.composing || event.isComposing) {
      this.sizeComposition()
      return
    }
    const text = this.view.textarea.value
    this.view.textarea.value = ''
    if (text) this.insert(text)
  }

  /** Text typed or inserted by the system, with the editor's typing conveniences. */
  insert(text: string): void {
    const tr = insertTyped(this.view.state, text.replace(/\r\n?/g, '\n'))
    if (tr) this.view.dispatch(tr)
  }

  private compositionStart(): void {
    this.composing = true
    this.view.root.classList.add('enc-composing')
    this.positionTextarea()
    this.sizeComposition()
  }

  private compositionUpdate(): void {
    this.sizeComposition()
    this.view.requestRender()
  }

  private compositionEnd(event: CompositionEvent): void {
    if (!this.composing) return
    this.composing = false
    this.view.root.classList.remove('enc-composing')
    const text = event.data || this.view.textarea.value
    this.view.textarea.value = ''
    const textarea = this.view.textarea
    textarea.style.width = ''
    if (text) this.insert(text)
    this.view.requestRender()
  }

  /** While composing, the textarea shows the text being composed, as wide as it is. */
  private sizeComposition(): void {
    const { charWidth } = this.view.metrics
    const width = stringWidth(this.view.textarea.value, this.view.state.config.tabSize)
    this.view.textarea.style.width = `${Math.max(2, Math.ceil(width * charWidth) + 2)}px`
  }

  private copy(event: ClipboardEvent): void {
    const { text, linewise } = copyText(this.view.state)
    if (!event.clipboardData) return
    event.clipboardData.setData('text/plain', text)
    this.linewise = linewise ? text : null
    event.preventDefault()
  }

  private cut(event: ClipboardEvent): void {
    const { clipboard, transaction } = cutText(this.view.state)
    if (!event.clipboardData) return
    event.clipboardData.setData('text/plain', clipboard.text)
    this.linewise = clipboard.linewise ? clipboard.text : null
    event.preventDefault()
    if (transaction) this.view.dispatch(transaction)
  }

  private paste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text/plain')
    event.preventDefault()
    if (!text) return
    const tr = paste(this.view.state, text, text === this.linewise)
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

  /** Puts the textarea at the main caret, so an input method's window opens beside the text being typed. */
  positionTextarea(): void {
    const view = this.view
    const head = view.state.selection.main.head
    const { x, y } = view.layerCoords(head)
    const style = view.textarea.style
    style.left = `${x}px`
    style.top = `${y}px`
    style.height = `${view.metrics.lineHeight}px`
  }
}

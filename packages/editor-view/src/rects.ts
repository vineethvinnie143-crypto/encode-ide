/**
 * A pool of absolutely positioned rectangles for one layer (selections,
 * marks, line backgrounds). A draw pass asks for as many as it needs; the
 * rest are hidden, and an element is only written when its numbers change.
 */
export class RectPool {
  private readonly items: { el: HTMLDivElement; box: Float64Array; hidden: boolean }[] = []
  private used = 0
  private previous = 0

  constructor(
    private readonly parent: HTMLElement,
    private readonly base: string,
  ) {}

  begin(): void {
    this.previous = Math.max(this.previous, this.used)
    this.used = 0
  }

  rect(className: string, left: number, top: number, width: number, height: number): HTMLDivElement {
    let item = this.items[this.used]
    if (!item) {
      const el = document.createElement('div')
      item = { el, box: new Float64Array([NaN, NaN, NaN, NaN]), hidden: false }
      this.items.push(item)
      this.parent.append(el)
    }
    this.used++
    const { el, box } = item
    const name = className ? `${this.base} ${className}` : this.base
    if (el.className !== name) el.className = name
    if (item.hidden) {
      el.style.display = ''
      item.hidden = false
    }
    if (box[0] !== left) el.style.left = `${(box[0] = left)}px`
    if (box[1] !== top) el.style.top = `${(box[1] = top)}px`
    if (box[2] !== width) el.style.width = `${(box[2] = width)}px`
    if (box[3] !== height) el.style.height = `${(box[3] = height)}px`
    return el
  }

  end(): void {
    for (let index = this.used; index < this.previous; index++) {
      const item = this.items[index]
      if (!item.hidden) {
        item.el.style.display = 'none'
        // Whatever the spare was drawn as no longer applies.
        item.el.className = this.base
        item.hidden = true
      }
    }
    // Keep a bounded number of idle elements.
    if (this.items.length > this.used + 64) {
      for (const item of this.items.splice(this.used + 64)) item.el.remove()
    }
    this.previous = this.used
  }
}

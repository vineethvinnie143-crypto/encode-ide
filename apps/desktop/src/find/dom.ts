/**
 * Find in the thread, on the page: the thread's text read in blocks the way it is laid out, its matches as ranges
 * marked with the CSS Custom Highlight API (nothing is added to the page, so a streamed answer and React's own nodes
 * are left alone), and the match in view scrolled to. The marks follow the thread while it changes.
 */
import { REVEAL_EVENT } from './hooks'
import { findInBlocks, firstAtOrAfter, type TextBlock } from './text'

const MARKS = 'enc-find'
const CURRENT = 'enc-find-current'

/** Elements whose text is not read: hidden, drawn, typed into, or marked as controls around the content. */
const SKIP = '[hidden], [aria-hidden="true"], [data-find-skip], svg, style, script, textarea, input, select'

/**
 * The thread's text in blocks: the text nodes of one paragraph, cell, row label or code block together, in reading
 * order. A block starts at any element that is not laid out inline (a flex item is a block of its own, as on screen)
 * and at a line break. Text that is hidden or not shown is left out.
 */
export function textBlocks(root: Element): TextBlock<Text>[] {
  const view = root.ownerDocument.defaultView
  const displays = new Map<Element, string>()
  const displayOf = (element: Element): string => {
    let display = displays.get(element)
    if (display === undefined) {
      display = view?.getComputedStyle(element).display ?? 'block'
      displays.set(element, display)
    }
    return display
  }
  const ownerOf = (element: Element | null): Element => {
    for (let current = element; current && current !== root; current = current.parentElement) {
      const display = displayOf(current)
      if (display !== 'inline' && display !== 'contents') return current
    }
    return root
  }

  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return (node as Text).data ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
      const element = node as Element
      if (element.tagName === 'BR') return NodeFilter.FILTER_ACCEPT
      return element.matches(SKIP) || displayOf(element) === 'none' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
    },
  })

  const blocks: (TextBlock<Text> & { owner: Element; nodes: Text[]; texts: string[] })[] = []
  let block: (typeof blocks)[number] | undefined
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType !== Node.TEXT_NODE) {
      block = undefined
      continue
    }
    const text = node as Text
    const owner = ownerOf(text.parentElement)
    if (block?.owner !== owner) {
      block = { owner, nodes: [], texts: [] }
      blocks.push(block)
    }
    block.nodes.push(text)
    block.texts.push(text.data)
  }
  return blocks
}

const registry = (): HighlightRegistry | undefined => (typeof CSS === 'undefined' ? undefined : CSS.highlights)

/** A search to keep the marks right waits at least this long after the thread changes, and longer when it is slow. */
const KEEP_MS = 150

/**
 * One find bar's search of the thread `root`, which scrolls in `scroller`. `report` hears the match in view and the
 * count after every search; `inset` is how much of the top of the scroller the bar covers.
 */
export class ThreadFinder {
  private ranges: Range[] = []
  private current = -1
  private capped = false
  private needle = ''
  private frame = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  /** A search for a new needle is waiting for the next frame, and the step asked for meanwhile. */
  private fresh = false
  private pendingStep: 1 | -1 | 0 = 0
  /** How long the last search took, in ms. */
  private cost = 0
  private readonly observer: MutationObserver

  constructor(
    private readonly root: HTMLElement,
    private readonly scroller: HTMLElement,
    private readonly report: (index: number, total: number, capped: boolean) => void,
    private readonly inset: () => number,
  ) {
    this.observer = new MutationObserver(() => {
      if (this.needle) this.keep()
    })
    this.observer.observe(root, { childList: true, subtree: true, characterData: true })
  }

  /** Searches for a new needle on the next frame, once React has drawn the folds that open for it. */
  search(needle: string): void {
    this.needle = needle
    this.fresh = true
    this.pendingStep = 0
    clearTimeout(this.timer)
    this.timer = undefined
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.run())
  }

  /** Moves to the next or the previous match, round from the last to the first, and scrolls to it. */
  step(direction: 1 | -1): void {
    if (this.fresh) {
      this.pendingStep = direction
      return
    }
    const count = this.ranges.length
    if (!count) return
    this.current = this.current < 0 ? (direction === 1 ? 0 : count - 1) : (this.current + direction + count) % count
    this.paint()
    this.bringIntoView()
    this.report(this.current, count, this.capped)
  }

  /** Opens for good the folds around the match in view: the bar is closing on it. */
  revealCurrent(): void {
    this.ranges[this.current]?.startContainer.dispatchEvent(new Event(REVEAL_EVENT, { bubbles: true }))
  }

  dispose(): void {
    this.observer.disconnect()
    cancelAnimationFrame(this.frame)
    clearTimeout(this.timer)
    this.ranges = []
    this.current = -1
    registry()?.delete(MARKS)
    registry()?.delete(CURRENT)
  }

  /** The thread changed (a streamed answer, a new step, another session): search again soon, keeping the match in view. */
  private keep(): void {
    if (this.fresh || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.run()
    }, Math.max(KEEP_MS, this.cost * 4))
  }

  private run(): void {
    const fresh = this.fresh
    this.fresh = false
    const started = performance.now()
    const anchor = this.ranges[this.current]
    const { matches, capped } = findInBlocks(textBlocks(this.root), this.needle)
    const document = this.root.ownerDocument
    this.ranges = matches.map((match) => {
      const range = document.createRange()
      range.setStart(match.start.node, match.start.offset)
      range.setEnd(match.end.node, match.end.offset)
      return range
    })
    this.capped = capped
    this.current = this.pick(anchor)
    this.cost = performance.now() - started
    const step = this.pendingStep
    this.pendingStep = 0
    if (fresh && step) {
      this.step(step)
      return
    }
    this.paint()
    if (fresh) this.bringIntoView()
    this.report(this.current, this.ranges.length, capped)
  }

  /**
   * The match to show after a search: the first at or after the one shown before (typing more letters keeps the
   * place), or with none before, the first at or below the top of the view; round to the first past the end.
   */
  private pick(anchor: Range | undefined): number {
    const count = this.ranges.length
    if (!count) return -1
    let index: number
    try {
      index = anchor
        ? firstAtOrAfter(count, (at) => this.ranges[at].compareBoundaryPoints(Range.START_TO_START, anchor))
        : this.firstInView()
    } catch {
      index = this.firstInView()
    }
    return index < count ? index : 0
  }

  private firstInView(): number {
    const top = this.scroller.getBoundingClientRect().top + this.inset()
    return firstAtOrAfter(this.ranges.length, (at) => (this.ranges[at].getBoundingClientRect().bottom > top ? 0 : -1))
  }

  private paint(): void {
    const highlights = registry()
    if (!highlights) return
    if (!this.ranges.length) {
      highlights.delete(MARKS)
      highlights.delete(CURRENT)
      return
    }
    highlights.set(MARKS, new Highlight(...this.ranges))
    const current = this.ranges[this.current]
    if (!current) {
      highlights.delete(CURRENT)
      return
    }
    const mark = new Highlight(current)
    mark.priority = 1
    highlights.set(CURRENT, mark)
  }

  /** Scrolls the match in view to the middle when it is outside the part of the thread the bar leaves free. */
  private bringIntoView(): void {
    const range = this.ranges[this.current]
    if (!range) return
    const view = this.scroller.getBoundingClientRect()
    const top = view.top + this.inset()
    const rect = range.getBoundingClientRect()
    if (rect.top < top || rect.bottom > view.bottom - 12) {
      this.scroller.scrollTop += rect.top + rect.height / 2 - (top + view.bottom) / 2
    }
    // A long line of code or output scrolls sideways to the match.
    const wide = range.startContainer.parentElement?.closest('pre')
    if (wide && wide.scrollWidth > wide.clientWidth) {
      const box = wide.getBoundingClientRect()
      const now = range.getBoundingClientRect()
      if (now.left < box.left || now.right > box.right) wide.scrollLeft += now.left - box.left - box.width / 3
    }
  }
}

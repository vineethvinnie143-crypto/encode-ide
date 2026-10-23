import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { CompletionEntry, SignatureInfo } from '@shared/types'
import { useAssist, type Anchor, type EditorAssist } from '../../editor/assist/controller'
import { codeBlockHtml, markupHtml } from '../../editor/assist/markup'
import { cx } from '../../ui/cx'
import { ChevronDown, ChevronUp } from '../../ui/icons'
import { place } from '../../ui/place'
import { Spinner } from '../../ui/Spinner'

/** One row of the list; the list shows at most this many before it scrolls. */
const ROW = 24
const ROWS = 12
/** Rows drawn above and below the ones in sight, so a quick scroll shows no gap. */
const OVERSCAN = 4
/** The details beside the list: as wide as this when there is room, never narrower than the least. */
const DETAILS_WIDTH = 360
const DETAILS_MIN_WIDTH = 240
const DETAILS_MAX_HEIGHT = 288
/** Between the list and its details, and kept clear at the window's edges. */
const DETAILS_GAP = 4
const EDGE = 8
/** The badge and its padding before a row's label: the list moves left by it, so labels line up with the word typed. */
const LABEL_INSET = 30

/** A suggestion's kind as a monogram on a tinted square, with the family that colours it. */
const KINDS = new Map<string, readonly [string, string]>([
  ['text', ['t', 'plain']],
  ['method', ['m', 'fn']],
  ['function', ['f', 'fn']],
  ['constructor', ['n', 'fn']],
  ['field', ['p', 'var']],
  ['property', ['p', 'var']],
  ['variable', ['v', 'var']],
  ['value', ['v', 'const']],
  ['constant', ['c', 'const']],
  ['enumMember', ['e', 'const']],
  ['class', ['C', 'type']],
  ['struct', ['S', 'type']],
  ['interface', ['I', 'type']],
  ['enum', ['E', 'type']],
  ['typeParameter', ['T', 'type']],
  ['module', ['M', 'mod']],
  ['file', ['F', 'mod']],
  ['folder', ['D', 'mod']],
  ['reference', ['r', 'mod']],
  ['keyword', ['K', 'plain']],
  ['operator', ['o', 'plain']],
  ['unit', ['u', 'const']],
  ['color', ['#', 'const']],
  ['event', ['!', 'fn']],
  ['snippet', ['s', 'snip']],
])

function KindBadge({ kind }: { kind?: string }) {
  const [letter, tone] = (kind && KINDS.get(kind)) || ['·', 'plain']
  return (
    <span className={cx('sw-kind', `is-${tone}`)} aria-hidden="true">
      {letter}
    </span>
  )
}

/** A label with the letters the typed text matched set apart. */
function Matched({ text, matches }: { text: string; matches: readonly number[] }) {
  if (!matches.length) return <>{text}</>
  const parts: ReactNode[] = []
  const hit = new Set(matches)
  let run = ''
  let runHit = hit.has(0)
  for (let index = 0; index < text.length; index++) {
    const isHit = hit.has(index)
    if (isHit !== runHit && run) {
      parts.push(runHit ? <b key={index}>{run}</b> : run)
      run = ''
    }
    runHit = isHit
    run += text[index]
  }
  if (run) parts.push(runHit ? <b key="end">{run}</b> : run)
  return <>{parts}</>
}

/** Places a floating box by its anchor once it has a size; hidden until then, so it never shows in the wrong spot. */
function usePlacement(anchor: Rect, box: RefObject<HTMLElement | null>, side: 'top' | 'bottom', deps: readonly unknown[]): { left: number; top: number } | null {
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const placed = place(anchor, { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, { side, align: 'start', gap: 2 })
    setSpot({ left: placed.left, top: placed.top })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return spot
}

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

const rectOf = (anchor: Anchor, inset = 0): Rect => ({ left: anchor.left - inset, top: anchor.top, width: 1, height: anchor.bottom - anchor.top })

/** Where the details of the selected item go: beside the list where there is room, else under it (over it, when the list is over the line). */
type DetailsSide = 'right' | 'left' | 'below' | 'above'

interface SuggestSpot {
  left: number
  top: number
  details: DetailsSide
  detailsWidth: number
  detailsHeight: number
}

/**
 * The list under the word (over it when there is no room below), placed by its own size so that it stays by the
 * word wherever its details go; then the details on the side with room for them.
 */
function useSuggestPlacement(anchor: Anchor | undefined, list: RefObject<HTMLElement | null>, deps: readonly unknown[]): SuggestSpot | null {
  const [spot, setSpot] = useState<SuggestSpot | null>(null)
  useLayoutEffect(() => {
    const element = list.current
    if (!element || !anchor) return
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const size = { width: element.offsetWidth, height: element.offsetHeight }
    const placed = place(rectOf(anchor, LABEL_INSET), size, viewport, { side: 'bottom', align: 'start', gap: 2, margin: EDGE })
    const right = viewport.width - EDGE - (placed.left + size.width + DETAILS_GAP)
    const left = placed.left - DETAILS_GAP - EDGE
    let details: DetailsSide
    let detailsWidth = DETAILS_WIDTH
    let detailsHeight = DETAILS_MAX_HEIGHT
    if (right >= DETAILS_WIDTH) details = 'right'
    else if (left >= DETAILS_WIDTH) details = 'left'
    else if (Math.max(right, left) >= DETAILS_MIN_WIDTH) {
      details = right >= left ? 'right' : 'left'
      detailsWidth = Math.max(right, left)
    } else {
      details = placed.side === 'top' ? 'above' : 'below'
      detailsWidth = size.width
      const room = details === 'below' ? viewport.height - EDGE - (placed.top + size.height + DETAILS_GAP) : placed.top - DETAILS_GAP - EDGE
      detailsHeight = Math.max(72, Math.min(DETAILS_MAX_HEIGHT, room))
    }
    setSpot({ left: placed.left, top: placed.top, details, detailsWidth, detailsHeight })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return spot
}

/** What the server says of an item: its type or signature as code, then its documentation. */
function Details({ entry, language }: { entry: CompletionEntry; language: string }) {
  const html = useMemo(() => {
    let out = ''
    if (entry.detail) out += codeBlockHtml(entry.detail, language)
    if (entry.documentation) out += markupHtml(entry.documentation, language)
    return out
  }, [entry.detail, entry.documentation, language])
  if (!html) return <div className="sw-details-empty">{entry.resolved ? 'No details for this one.' : 'Loading details…'}</div>
  // Built by markupHtml: everything escaped first, then the renderer's own tags only.
  return <div className="sw-details-body markup" dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * The suggestions of the language servers under the word being typed. It takes no focus: the keys stay in the editor,
 * which moves through it (arrows, Page Up and Down), accepts (Enter, Tab, a commit character) and closes it (Esc).
 * Only the rows in sight are drawn, so a list of thousands opens as fast as one of ten.
 */
export function SuggestWidget({ assist, language }: { assist: EditorAssist; language: string }) {
  const suggest = useAssist((state) => state.suggest)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const count = suggest?.items.length ?? 0
  const selected = suggest?.selected ?? 0
  const height = Math.max(1, Math.min(ROWS, count)) * ROW
  const spot = useSuggestPlacement(suggest?.anchor, boxRef, [suggest?.anchor, count, suggest?.details, suggest?.loading])

  // The selected row stays in sight as it moves.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || !count) return
    const top = selected * ROW
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + ROW > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW - list.clientHeight
    setScrollTop(list.scrollTop)
  }, [selected, count])

  if (!suggest) return null
  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN)
  const last = Math.min(count, Math.ceil((scrollTop + height) / ROW) + OVERSCAN)
  const current = suggest.items[selected]?.entry
  const status = suggest.loading ? 'Loading suggestions' : suggest.empty ? 'No suggestions' : current ? `${current.label}${current.kind ? `, ${current.kind}` : ''}, ${selected + 1} of ${count}` : ''

  return createPortal(
    <div
      className={cx('suggest-widget', `details-${spot?.details ?? 'right'}`)}
      style={spot ? { left: spot.left, top: spot.top } : { left: 0, top: 0, visibility: 'hidden' }}
      // The editor keeps the focus: a click here must not take it.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div ref={boxRef} className="sw-list-box">
        {suggest.loading || suggest.empty ? (
          <div className="sw-status-row">
            {suggest.loading ? <Spinner size={13} /> : null}
            <span>{suggest.loading ? 'Loading…' : 'No suggestions.'}</span>
          </div>
        ) : (
          <div ref={listRef} className="sw-list" role="listbox" aria-label="Suggestions" style={{ height }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
            <div style={{ height: count * ROW, position: 'relative' }}>
              {suggest.items.slice(first, last).map((item, offset) => {
                const index = first + offset
                const entry = item.entry
                const isSelected = index === selected
                return (
                  <div
                    key={`${entry.id}`}
                    role="option"
                    aria-selected={isSelected}
                    className={cx('sw-row', isSelected && 'is-selected', entry.deprecated && 'is-deprecated')}
                    style={{ top: index * ROW }}
                    onClick={() => assist.accept(index)}
                  >
                    <KindBadge kind={entry.kind} />
                    <span className="sw-label">
                      <Matched text={entry.label} matches={item.matches} />
                      {entry.labelDetail ? <span className="sw-label-detail">{entry.labelDetail}</span> : null}
                    </span>
                    {entry.description ? (
                      <span className="sw-description">{entry.description}</span>
                    ) : isSelected && entry.detail && !suggest.details ? (
                      <span className="sw-description">{entry.detail}</span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        )}
        <div className="sw-live" aria-live="polite">
          {status}
        </div>
      </div>
      {suggest.details && current ? (
        <div className="sw-details" style={spot ? { width: spot.detailsWidth, maxHeight: spot.detailsHeight } : undefined}>
          <Details entry={current} language={language} />
        </div>
      ) : null}
    </div>,
    document.body,
  )
}

/** A signature's label with the active parameter set apart. */
function SignatureLabel({ signature, active }: { signature: SignatureInfo; active: number | undefined }) {
  const parameter = active === undefined ? undefined : signature.parameters?.[active]
  const label = signature.label
  let range: [number, number] | null = null
  if (parameter) {
    if (Array.isArray(parameter.label)) range = parameter.label
    else {
      // A parameter named by its text: the first whole match after the opening bracket.
      const open = Math.max(0, label.indexOf('('))
      const at = label.indexOf(parameter.label, open)
      if (at >= 0) range = [at, at + parameter.label.length]
    }
  }
  if (!range || range[0] < 0 || range[1] > label.length || range[0] >= range[1]) return <code className="sig-label">{label}</code>
  return (
    <code className="sig-label">
      {label.slice(0, range[0])}
      <b className="sig-active">{label.slice(range[0], range[1])}</b>
      {label.slice(range[1])}
    </code>
  )
}

/** The parameters of the call the cursor is in, above the line: the one being typed set apart, with what it is for. */
export function SignatureCard({ assist, language }: { assist: EditorAssist; language: string }) {
  const view = useAssist((state) => state.signature)
  const boxRef = useRef<HTMLDivElement>(null)
  const spot = usePlacement(view ? rectOf(view.anchor) : { left: 0, top: 0, width: 0, height: 0 }, boxRef, 'top', [view])
  const signature = view?.help.signatures[view.active]
  const activeParameter = signature ? (signature.activeParameter ?? view?.help.activeParameter) : undefined
  const docs = useMemo(() => {
    if (!signature) return ''
    const parameter = activeParameter === undefined ? undefined : signature.parameters?.[activeParameter]
    let html = ''
    if (parameter?.documentation) html += `<div class="sig-param-doc">${markupHtml(parameter.documentation, language)}</div>`
    if (signature.documentation) html += markupHtml(signature.documentation, language)
    return html
  }, [signature, activeParameter, language])
  if (!view || !signature) return null
  const count = view.help.signatures.length
  return createPortal(
    <div
      ref={boxRef}
      className="signature-card"
      role="tooltip"
      style={spot ? { left: spot.left, top: spot.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="sig-head">
        {count > 1 ? (
          <span className="sig-cycle">
            <button type="button" className="sig-step" aria-label="Previous signature" onClick={() => assist.cycleSignature(-1)}>
              <ChevronUp size={12} />
            </button>
            <span className="sig-count">
              {view.active + 1}/{count}
            </span>
            <button type="button" className="sig-step" aria-label="Next signature" onClick={() => assist.cycleSignature(1)}>
              <ChevronDown size={12} />
            </button>
          </span>
        ) : null}
        <SignatureLabel signature={signature} active={activeParameter} />
      </div>
      {/* Built by markupHtml: everything escaped first, then the renderer's own tags only. */}
      {docs ? <div className="sig-docs markup" dangerouslySetInnerHTML={{ __html: docs }} /> : null}
    </div>,
    document.body,
  )
}

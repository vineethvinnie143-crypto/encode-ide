import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { FindingPriority, ReviewFile, ReviewHunk, ReviewLine, ReviewSnapshot } from '@shared/types'
// The token colours (.tok-*) the lines are drawn with are the editor's.
import '@encode/editor-view/style.css'
import { DISPLAY_LIMIT, HunkTokens, segmentsOf } from '../../review/highlight'
import { columnsOf, expandTabs, wrappedLines } from '../../review/measure'
import { inFolder } from '../../review/paths'
import {
  ROW_HEIGHT,
  anchorOf,
  buildRows,
  changeBadge,
  fileRows,
  firstChangedLine,
  foldedPaths,
  hunkRange,
  hunkRows,
  layoutRows,
  lineAt,
  pathParts,
  pinnedFile,
  rowAt,
  type Anchor,
  type ReviewComment,
  type Row,
} from '../../review/rows'
import { useEditor } from '../../stores/editor'
import { usePanels } from '../../stores/panels'
import { useReview } from '../../stores/review'
import { useSettings } from '../../stores/settings'
import { Button, IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { ChevronRight, Code2, MessageSquare, Minus, Pencil, Plus, Trash2, Undo2 } from '../../ui/icons'

/** Pixels drawn above and below the visible part, so a fast scroll does not show blank rows. */
const OVERSCAN = 600
/** Space after the code of a line, and the comment button's column. */
const CODE_PAD = 16
const SIGN_WIDTH = 18
const NO_COMMENTS: readonly ReviewComment[] = []

/** What the person can do in the view shown: stage and revert, unstage, revert an agent's turn, or nothing. */
type Scope = 'unstaged' | 'staged' | 'turn' | null

interface Metrics {
  charWidth: number
  numWidth: number
  /** The gutter of a unified row: two numbers and the sign. */
  gutter: number
  /** The gutter of one side of a split row. */
  halfGutter: number
}

/** The width of one character of the code font, measured, and measured again when the font or its size changes. */
function useCharWidth(probe: React.RefObject<HTMLSpanElement | null>): number {
  const appearance = useSettings((state) => state.settings?.appearance)
  const [width, setWidth] = useState(7.2)
  useLayoutEffect(() => {
    const measure = () => {
      const box = probe.current?.getBoundingClientRect()
      if (box && box.width > 0) setWidth(box.width / 64)
    }
    measure()
    // A web font that arrives later changes the width.
    const fonts = document.fonts
    void fonts?.ready.then(measure)
    fonts?.addEventListener?.('loadingdone', measure)
    return () => fonts?.removeEventListener?.('loadingdone', measure)
  }, [appearance, probe])
  return width
}

/** The text of a line, coloured, with its changed words marked and its tabs drawn as spaces. */
const Code = memo(function Code({ text, tokens, words }: { text: string; tokens: readonly number[] | undefined; words: ReviewLine['words'] }) {
  const segments = segmentsOf(text, tokens, words)
  if (!segments.length) return <span className="rv-text"> </span>
  let column = 0
  return (
    <span className="rv-text">
      {segments.map((segment, index) => {
        const expanded = expandTabs(segment.text, column)
        column = expanded.column
        return (
          <span key={index} className={cx(segment.className, segment.changed && 'rv-word')}>
            {expanded.text}
          </span>
        )
      })}
    </span>
  )
})

const SIGNS: Record<ReviewLine['kind'], string> = { add: '+', del: '−', ctx: ' ' }

const PRIORITY_HINT: Record<FindingPriority, string> = {
  P0: 'P0: breaks the build, loses data or opens a security hole',
  P1: 'P1: a bug people will hit',
  P2: 'P2: a bug in a rarer case, or a likely regression',
  P3: 'P3: a small problem',
}

interface LineProps {
  file: ReviewFile
  line: ReviewLine
  tokens: readonly number[] | undefined
  words: boolean
  commentable: boolean
  side?: 'old' | 'new'
}

/** One side of a split row: a number, a sign and the code; or an empty cell where the other side has a line. */
function Half({ file, line, tokens, words, commentable, side }: Partial<LineProps> & { file: ReviewFile; side: 'old' | 'new' }) {
  if (!line) return <div className="rv-half is-empty" />
  const number = side === 'old' ? line.old : line.new
  const anchor = commentable ? anchorOf(file.path, line, side) : null
  return (
    <div className={cx('rv-half', `is-${line.kind}`)}>
      <span className="rv-gutter">
        <span className="rv-num">{number ?? ''}</span>
        <span className="rv-sign">{SIGNS[line.kind]}</span>
        {anchor && <CommentButton anchor={anchor} />}
      </span>
      <span className="rv-code">
        <Code text={line.text} tokens={tokens} words={words ? line.words : undefined} />
        {line.noEol && <NoEol />}
      </span>
    </div>
  )
}

/** Drawn at the right edge, out of the text, so it never changes how a line wraps. */
function NoEol() {
  return (
    <span className="rv-noeol" title="No newline at the end of the file">
      no newline
    </span>
  )
}

function CommentButton({ anchor }: { anchor: Anchor }) {
  return (
    <button
      type="button"
      className="rv-comment-btn"
      aria-label={`Comment on line ${anchor.line}`}
      title="Comment for the agent"
      onClick={(event) => {
        event.stopPropagation()
        useReview.getState().startComment(anchor)
      }}
    >
      <Plus size={12} />
    </button>
  )
}

function FileHead({ file, folder, folded, scope, busy, pinned }: { file: ReviewFile; folder: string; folded: boolean; scope: Scope; busy: string | null; pinned?: boolean }) {
  const badge = changeBadge(file.change)
  const { dir, name } = pathParts(file.path)
  const act = useReview.getState().act
  const locked = busy !== null
  const fingerprint = file.fingerprint || undefined
  // The editor opens files of the open folder, which can be a folder inside the repository.
  const local = inFolder(file.path, folder)
  const openable = file.change !== 'deleted' && file.kind === 'text'
  return (
    <div className={cx('rv-file-head', pinned && 'is-pinned')}>
      <button
        type="button"
        className="rv-fold"
        aria-expanded={!folded}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        onClick={() => useReview.getState().toggleFold(file.path)}
      >
        <ChevronRight size={14} className={cx('rv-chevron', !folded && 'is-open')} />
        <span className={`rv-badge is-${badge.tone}`} aria-label={badge.label}>
          {badge.letter}
        </span>
        <span className="rv-path">
          {dir && <span className="rv-dir">{dir}</span>}
          <span className="rv-name">{name}</span>
        </span>
        {(file.added > 0 || file.removed > 0) && (
          <span className="rv-stats">
            {file.added > 0 && <span className="add-stat">+{file.added}</span>}
            {file.removed > 0 && <span className="del-stat">−{file.removed}</span>}
          </span>
        )}
      </button>
      <span className="rv-file-actions">
        {openable && (
          <IconButton
            label={local === null ? 'Outside the open folder' : 'Open in the editor'}
            disabled={local === null}
            onClick={() => {
              if (local === null) return
              usePanels.getState().open('editor')
              void useEditor.getState().openFile(local, firstChangedLine(file))
            }}
          >
            <Code2 size={14} />
          </IconButton>
        )}
        {scope === 'unstaged' && (
          <>
            <IconButton label="Revert this file" disabled={locked} onClick={() => void act({ type: 'revert-file', path: file.path, ...(fingerprint ? { fingerprint } : {}) })}>
              <Undo2 size={14} />
            </IconButton>
            <IconButton label="Stage this file" disabled={locked} onClick={() => void act({ type: 'stage-file', path: file.path, ...(fingerprint ? { fingerprint } : {}) })}>
              <Plus size={14} />
            </IconButton>
          </>
        )}
        {scope === 'staged' && (
          <IconButton label="Unstage this file" disabled={locked} onClick={() => void act({ type: 'unstage-file', path: file.path, ...(fingerprint ? { fingerprint } : {}) })}>
            <Minus size={14} />
          </IconButton>
        )}
        {scope === 'turn' &&
          (file.fixed ? (
            <span className="rv-fixed" title={file.fixed}>
              Read only
            </span>
          ) : (
            <IconButton
              label={file.change === 'added' ? 'Delete this file' : 'Revert this file'}
              disabled={locked}
              onClick={() => void act({ type: 'revert-file', path: file.path, ...(fingerprint ? { fingerprint } : {}) })}
            >
              {file.change === 'added' ? <Trash2 size={14} /> : <Undo2 size={14} />}
            </IconButton>
          ))}
      </span>
    </div>
  )
}

function HunkHead({ file, hunk, scope, busy }: { file: ReviewFile; hunk: ReviewHunk; scope: Scope; busy: string | null }) {
  const act = useReview.getState().act
  const actions = scope !== null && file.hunkActions
  const locked = busy !== null
  const action = (type: 'stage-hunk' | 'unstage-hunk' | 'revert-hunk') => void act({ type, path: file.path, hunk: hunk.id, fingerprint: file.fingerprint })
  return (
    <div className="rv-hunk-head">
      <span className="rv-hunk-range">{hunkRange(hunk)}</span>
      {actions ? (
        <span className="rv-hunk-actions">
          {scope === 'unstaged' && (
            <>
              <button type="button" className="rv-chip" disabled={locked} onClick={() => action('revert-hunk')}>
                Revert
              </button>
              <button type="button" className="rv-chip" disabled={locked} onClick={() => action('stage-hunk')}>
                Stage
              </button>
            </>
          )}
          {scope === 'staged' && (
            <button type="button" className="rv-chip" disabled={locked} onClick={() => action('unstage-hunk')}>
              Unstage
            </button>
          )}
          {scope === 'turn' && (
            <button type="button" className="rv-chip" disabled={locked} onClick={() => action('revert-hunk')}>
              Revert
            </button>
          )}
        </span>
      ) : (
        scope !== null &&
        !file.fixed &&
        file.hunkActionsOff && (
          <span className="rv-hunk-off" title={file.hunkActionsOff}>
            Whole file only
          </span>
        )
      )}
    </div>
  )
}

function CommentCard({ comment, detached }: { comment: ReviewComment; detached: boolean }) {
  const review = useReview.getState()
  const reviewer = comment.by === 'reviewer'
  return (
    <div className={cx('rv-comment', reviewer && 'is-reviewer')} data-priority={reviewer ? (comment.priority ?? 'P2') : undefined}>
      <div className="rv-comment-head">
        {reviewer ? (
          <span className="rv-finding-priority" title={PRIORITY_HINT[comment.priority ?? 'P2']}>
            {comment.priority ?? 'P2'}
          </span>
        ) : (
          <MessageSquare size={13} />
        )}
        <span className="rv-comment-where">
          {reviewer && <span className="rv-comment-by">Reviewer · </span>}
          {comment.side === 'old' ? `Old line ${comment.line}` : `Line ${comment.line}`}
          {detached && <span className="rv-comment-gone"> · no longer in this view</span>}
        </span>
        <span className="rv-comment-actions">
          <IconButton label="Edit comment" onClick={() => review.startComment(comment, comment)}>
            <Pencil size={13} />
          </IconButton>
          <IconButton label="Delete comment" onClick={() => review.removeComment(comment.id)}>
            <Trash2 size={13} />
          </IconButton>
        </span>
      </div>
      {reviewer && comment.title && <div className="rv-finding-title">{comment.title}</div>}
      <div className="rv-comment-text">{comment.text}</div>
    </div>
  )
}

function CommentEditor({ file, anchor, comment }: { file: ReviewFile; anchor: Anchor; comment: ReviewComment | null }) {
  const [text, setText] = useState(comment?.text ?? '')
  const review = useReview.getState()
  const save = () => review.saveComment(text, comment?.excerpt ?? lineAt(file, anchor)?.text ?? '')
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      save()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      review.cancelComment()
    }
  }
  return (
    <div className="rv-editor">
      <textarea
        className="rv-editor-input"
        autoFocus
        rows={3}
        value={text}
        placeholder={`Comment on ${anchor.side === 'old' ? 'old line' : 'line'} ${anchor.line} for the agent`}
        aria-label="Comment for the agent"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="rv-editor-foot">
        <span className="rv-editor-hint">Ctrl+Enter to save. Comments go to the agent together.</span>
        <Button size="sm" variant="ghost" onClick={() => review.cancelComment()}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!text.trim() && !comment} onClick={save}>
          {comment ? 'Save' : 'Comment'}
        </Button>
      </div>
    </div>
  )
}

/** A row whose height is its content's: it tells the list when that changes. */
function Measured({ id, onSize, children }: { id: string; onSize: (id: string, height: number) => void; children: ReactNode }) {
  const node = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = node.current
    if (!element) return
    onSize(id, element.offsetHeight)
    const observer = new ResizeObserver(() => onSize(id, element.offsetHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [id, onSize])
  return (
    <div ref={node} className="rv-measured">
      {children}
    </div>
  )
}

interface ListModel {
  rows: Row[]
  folded: ReadonlySet<string>
}

/**
 * The review's files, hunks and lines as one scrolling list that draws only the rows on screen. The header of the
 * file being read stays pinned at the top; F7 and Shift+F7 move from change to change.
 */
export default function DiffList({ snapshot }: { snapshot: ReviewSnapshot }) {
  const view = useReview((state) => state.view)
  const toggled = useReview((state) => state.toggled)
  const comments = useReview((state) => state.comments[state.viewKey()] ?? NO_COMMENTS)
  const editing = useReview((state) => state.editing)
  const busy = useReview((state) => state.busy)
  const revealPath = useReview((state) => state.revealPath)
  const kind = snapshot.scope.kind
  const scope: Scope = snapshot.readOnly ? null : kind === 'unstaged' || kind === 'staged' || kind === 'turn' ? kind : null

  const scroller = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const charWidth = useCharWidth(probe)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [top, setTop] = useState(0)
  const [measured, setMeasured] = useState<ReadonlyMap<string, number>>(() => new Map())
  const tokens = useMemo(() => new HunkTokens(), [])

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const update = () => setBox({ width: element.clientWidth, height: element.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const onSize = useCallback((id: string, height: number) => {
    setMeasured((current) => {
      if (current.get(id) === height) return current
      const next = new Map(current)
      next.set(id, height)
      return next
    })
  }, [])

  const model: ListModel = useMemo(() => {
    const folded = foldedPaths(snapshot.files, toggled)
    return { folded, rows: buildRows(snapshot, { layout: view.layout, collapsed: folded, comments, editing }) }
  }, [snapshot, toggled, view.layout, comments, editing])
  const { rows, folded } = model

  // Widths in columns of every line, by hunk, for wrapping and for the width of the list.
  const widths = useMemo(() => {
    const map = new Map<ReviewHunk, Uint32Array>()
    for (const file of snapshot.files) {
      for (const hunk of file.hunks) {
        const array = new Uint32Array(hunk.lines.length)
        hunk.lines.forEach((line, index) => (array[index] = columnsOf(line.text.length > DISPLAY_LIMIT ? line.text.slice(0, DISPLAY_LIMIT + 1) : line.text)))
        map.set(hunk, array)
      }
    }
    return map
  }, [snapshot])

  const metrics: Metrics = useMemo(() => {
    let largest = 1
    for (const file of snapshot.files) {
      for (const hunk of file.hunks) largest = Math.max(largest, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines)
    }
    const numWidth = Math.ceil(Math.max(2, String(largest).length) * charWidth) + 14
    return { charWidth, numWidth, gutter: numWidth * 2 + SIGN_WIDTH, halfGutter: numWidth + SIGN_WIDTH }
  }, [snapshot, charWidth])

  const split = view.layout === 'split'
  const wrap = view.wrap
  // Two pixels to spare: a line the browser fits in one column fewer than counted here would be cut off.
  const columns = Math.max(12, Math.floor(((split ? Math.floor(box.width / 2) - metrics.halfGutter : box.width - metrics.gutter) - CODE_PAD - 2) / charWidth))

  const widthOf = useCallback(
    (row: Extract<Row, { kind: 'line' | 'pair' }>, side: 'line' | 'left' | 'right') => {
      const hunk = snapshot.files[row.file].hunks[row.hunk]
      const array = widths.get(hunk)
      const index = row.kind === 'line' ? row.line : side === 'left' ? row.left : row.right
      return index === null || index === undefined || !array ? 0 : array[index]
    },
    [snapshot, widths],
  )

  const layout = useMemo(
    () =>
      layoutRows(rows, {
        measured,
        ...(wrap
          ? {
              lines: (row) =>
                row.kind === 'line' ? wrappedLines(widthOf(row, 'line'), columns) : Math.max(wrappedLines(widthOf(row, 'left'), columns), wrappedLines(widthOf(row, 'right'), columns)),
            }
          : {}),
      }),
    [rows, measured, wrap, columns, widthOf],
  )

  // Unwrapped, the list is as wide as its longest line.
  const contentWidth = useMemo(() => {
    if (wrap) return box.width
    let longest = 0
    for (const row of rows) {
      if (row.kind === 'line') longest = Math.max(longest, widthOf(row, 'line'))
      else if (row.kind === 'pair') longest = Math.max(longest, widthOf(row, 'left'), widthOf(row, 'right'))
    }
    const code = Math.min(longest, DISPLAY_LIMIT + 1) * charWidth + CODE_PAD
    return Math.max(box.width, split ? 2 * (metrics.halfGutter + code) : metrics.gutter + code)
  }, [wrap, rows, widthOf, charWidth, split, metrics, box.width])

  // ---- keeping the place: rows that change above the top do not move what is being read

  const anchor = useRef<{ key: string; delta: number; file: string | null } | null>(null)
  const remember = useCallback(
    (scrollTop: number) => {
      const index = rowAt(layout, scrollTop)
      const row = rows[index]
      if (!row) {
        anchor.current = null
        return
      }
      let fileKey: string | null = null
      for (let at = index; at >= 0; at--) {
        if (rows[at].kind === 'file') {
          fileKey = rows[at].key
          break
        }
      }
      anchor.current = { key: row.key, delta: scrollTop - layout.tops[index], file: fileKey }
    },
    [layout, rows],
  )

  useLayoutEffect(() => {
    const element = scroller.current
    const kept = anchor.current
    if (!element || !kept) return
    let index = rows.findIndex((row) => row.key === kept.key)
    let delta = kept.delta
    if (index < 0 && kept.file) {
      index = rows.findIndex((row) => row.key === kept.file)
      delta = 0
    }
    if (index >= 0) {
      const wanted = Math.max(0, layout.tops[index] + delta)
      if (Math.abs(wanted - element.scrollTop) > 1) {
        element.scrollTop = wanted
        setTop(element.scrollTop)
      }
    }
    remember(element.scrollTop)
  }, [layout, rows, remember])

  const frame = useRef(0)
  const onScroll = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const element = scroller.current
      if (!element) return
      setTop(element.scrollTop)
      remember(element.scrollTop)
    })
  }
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // ---- bringing a file into view when asked

  const headers = useMemo(() => fileRows(rows), [rows])
  useEffect(() => {
    if (!revealPath) return
    const index = snapshot.files.findIndex((file) => file.path === revealPath)
    if (index < 0) return
    // A folded file opens first; this runs again once its lines are laid out.
    if (folded.has(revealPath)) {
      useReview.getState().toggleFold(revealPath)
      return
    }
    const element = scroller.current
    if (element && headers[index] !== undefined) {
      element.scrollTop = layout.tops[headers[index]]
      setTop(element.scrollTop)
      remember(element.scrollTop)
    }
    useReview.getState().revealed()
  }, [revealPath, snapshot, folded, headers, layout, remember])

  const moveToChange = (direction: 1 | -1) => {
    const element = scroller.current
    if (!element) return
    const current = element.scrollTop + ROW_HEIGHT.file + 1
    const starts = hunkRows(rows).map((index) => layout.tops[index])
    const target = direction > 0 ? starts.find((start) => start > current) : [...starts].reverse().find((start) => start < current - 2)
    if (target === undefined) return
    element.scrollTop = Math.max(0, target - ROW_HEIGHT.file)
    setTop(element.scrollTop)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('textarea, input')) return
    if (event.key === 'F7') {
      event.preventDefault()
      moveToChange(event.shiftKey ? -1 : 1)
    }
  }

  // ---- what is on screen

  const first = Math.max(0, rowAt(layout, Math.max(0, top - OVERSCAN)))
  const last = Math.min(rows.length - 1, rowAt(layout, top + box.height + OVERSCAN))
  const pinned = pinnedFile(rows, layout, top)
  let push = 0
  if (pinned !== null) {
    const next = headers[pinned + 1]
    if (next !== undefined) push = Math.min(0, layout.tops[next] - top - ROW_HEIGHT.file)
  }

  const style = {
    '--rv-num-w': `${metrics.numWidth}px`,
    '--rv-sign-w': `${SIGN_WIDTH}px`,
    '--rv-view-w': `${box.width}px`,
  } as CSSProperties

  const lineTokens = (fileIndex: number, hunkIndex: number) => tokens.get(snapshot.files[fileIndex].path, snapshot.files[fileIndex].hunks[hunkIndex])

  const drawn: ReactNode[] = []
  for (let index = first; index <= last && index >= 0; index++) {
    const row = rows[index]
    const height = layout.tops[index + 1] - layout.tops[index]
    const place: CSSProperties = { top: layout.tops[index], height }
    switch (row.kind) {
      case 'file':
        drawn.push(
          <div key={row.key} className="rv-row rv-row-block" style={place}>
            <FileHead file={snapshot.files[row.file]} folder={snapshot.repo.folder} folded={folded.has(snapshot.files[row.file].path)} scope={scope} busy={busy} />
          </div>,
        )
        break
      case 'note':
        drawn.push(
          <div key={row.key} className="rv-row rv-row-block" style={place}>
            <div className="rv-note">{row.text}</div>
          </div>,
        )
        break
      case 'hunk':
        drawn.push(
          <div key={row.key} className="rv-row rv-row-block" style={place}>
            <HunkHead file={snapshot.files[row.file]} hunk={snapshot.files[row.file].hunks[row.hunk]} scope={scope} busy={busy} />
          </div>,
        )
        break
      case 'line': {
        const file = snapshot.files[row.file]
        const line = file.hunks[row.hunk].lines[row.line]
        const anchorFor = anchorOf(file.path, line)
        drawn.push(
          <div key={row.key} className={cx('rv-row rv-line', `is-${line.kind}`)} style={place}>
            <span className="rv-gutter">
              <span className="rv-num">{line.kind === 'add' ? '' : (line.old ?? '')}</span>
              <span className="rv-num">{line.kind === 'del' ? '' : (line.new ?? '')}</span>
              <span className="rv-sign">{SIGNS[line.kind]}</span>
              {anchorFor && <CommentButton anchor={anchorFor} />}
            </span>
            <span className="rv-code">
              <Code text={line.text} tokens={lineTokens(row.file, row.hunk)[row.line]} words={view.words ? line.words : undefined} />
              {line.noEol && <NoEol />}
            </span>
          </div>,
        )
        break
      }
      case 'pair': {
        const file = snapshot.files[row.file]
        const lines = file.hunks[row.hunk].lines
        const hunkTokens = lineTokens(row.file, row.hunk)
        const left = row.left === null ? undefined : lines[row.left]
        const right = row.right === null ? undefined : lines[row.right]
        drawn.push(
          <div key={row.key} className="rv-row rv-pair" style={place}>
            <Half file={file} side="old" line={left} tokens={row.left === null ? undefined : hunkTokens[row.left]} words={view.words} commentable />
            <Half file={file} side="new" line={right} tokens={row.right === null ? undefined : hunkTokens[row.right]} words={view.words} commentable />
          </div>,
        )
        break
      }
      case 'comment':
        drawn.push(
          <div key={row.key} className="rv-row rv-row-block" style={{ top: layout.tops[index] }}>
            <Measured id={row.key} onSize={onSize}>
              <CommentCard comment={row.comment} detached={row.detached} />
            </Measured>
          </div>,
        )
        break
      case 'editor':
        drawn.push(
          <div key={row.key} className="rv-row rv-row-block" style={{ top: layout.tops[index] }}>
            <Measured id={row.key} onSize={onSize}>
              <CommentEditor file={snapshot.files[row.file]} anchor={row.anchor} comment={row.comment} />
            </Measured>
          </div>,
        )
        break
      case 'gap':
        break
    }
  }

  return (
    <div className={cx('rv-list', split && 'is-split', wrap && 'is-wrapped')} style={style}>
      <span ref={probe} className="rv-probe" aria-hidden="true">
        {'0'.repeat(64)}
      </span>
      <div ref={scroller} className="rv-scroll" tabIndex={0} role="region" aria-label="Changes" onScroll={onScroll} onKeyDown={onKeyDown}>
        <div className="rv-canvas" style={{ height: layout.total, width: contentWidth }}>
          {drawn}
        </div>
      </div>
      {pinned !== null && (
        <div className="rv-pinned" style={{ transform: `translateY(${push}px)` }}>
          <FileHead file={snapshot.files[pinned]} folder={snapshot.repo.folder} folded={folded.has(snapshot.files[pinned].path)} scope={scope} busy={busy} pinned />
        </div>
      )}
    </div>
  )
}

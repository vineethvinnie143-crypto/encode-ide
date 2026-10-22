import { useEffect, useRef, type RefObject } from 'react'
import { ThreadFinder } from '../../find/dom'
import { countLabel } from '../../find/text'
import { useFind } from '../../stores/find'
import { IconButton } from '../../ui/Button'
import { ChevronDown, ChevronUp, Search, X } from '../../ui/icons'

interface FindBarProps {
  /** The thread, whose text is searched, and the element it scrolls in. */
  thread: RefObject<HTMLElement | null>
  scroller: RefObject<HTMLElement | null>
}

/** Ctrl+F in a session: a bar over the top of the thread that finds words in it, opening folded work to show them. */
export default function FindBar(props: FindBarProps) {
  const open = useFind((state) => state.open)
  return open ? <OpenFindBar {...props} /> : null
}

const next = (direction: 1 | -1) => useFind.getState().move(direction)

function OpenFindBar({ thread, scroller }: FindBarProps) {
  const query = useFind((state) => state.query)
  const needle = useFind((state) => state.needle)
  const focusId = useFind((state) => state.focusId)
  const step = useFind((state) => state.step)
  const index = useFind((state) => state.index)
  const total = useFind((state) => state.total)
  const capped = useFind((state) => state.capped)
  const bar = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const finder = useRef<ThreadFinder | null>(null)

  // The search lives as long as the bar. Closing it puts the focus back where it was (the message box, or the thread).
  useEffect(() => {
    const root = thread.current
    const list = scroller.current
    if (!root || !list) return
    const active = document.activeElement
    const before = active instanceof HTMLElement && active !== document.body && !bar.current?.contains(active) ? active : null
    const instance = new ThreadFinder(
      root,
      list,
      (at, count, more) => useFind.getState().setCount(at, count, more),
      () => (bar.current?.offsetHeight ?? 0) + 18,
    )
    finder.current = instance
    return () => {
      instance.dispose()
      finder.current = null
      const target = before?.isConnected ? before : document.querySelector<HTMLElement>('.composer-input')
      target?.focus({ preventScroll: true })
    }
  }, [thread, scroller])

  // Each Ctrl+F puts the cursor in the field with its text selected, to type over.
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusId])

  useEffect(() => {
    finder.current?.search(needle)
  }, [needle])

  useEffect(() => {
    if (step) finder.current?.step(step.direction)
  }, [step])

  const close = () => {
    finder.current?.revealCurrent()
    useFind.getState().close()
  }

  const state = !needle ? 'idle' : total ? 'found' : 'none'
  return (
    <div
      ref={bar}
      className="find-bar"
      role="search"
      data-state={state}
      data-find-skip
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        event.preventDefault()
        event.stopPropagation()
        close()
      }}
    >
      <Search size={14} className="find-bar-icon" />
      <input
        ref={input}
        className="find-bar-input"
        value={query}
        placeholder="Find in this session"
        aria-label="Find in this session"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => useFind.getState().setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          next(event.shiftKey ? -1 : 1)
        }}
      />
      <span className="find-bar-count" aria-live="polite">
        {needle ? countLabel(index, total, capped) : ''}
      </span>
      <span className="find-bar-rule" />
      <IconButton label="Previous match" shortcut="Shift+Enter" disabled={!total} onClick={() => next(-1)}>
        <ChevronUp size={15} />
      </IconButton>
      <IconButton label="Next match" shortcut="Enter" disabled={!total} onClick={() => next(1)}>
        <ChevronDown size={15} />
      </IconButton>
      <IconButton label="Close" shortcut="Esc" onClick={close}>
        <X size={14} />
      </IconButton>
    </div>
  )
}

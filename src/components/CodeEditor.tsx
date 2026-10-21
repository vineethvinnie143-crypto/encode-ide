import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import type { Tab } from '../stores/editor'
import { useEditor } from '../stores/editor'
import { escapeHtml, renderTokens, tokenize } from '../editor/tokenize'

const LINE_HEIGHT = 19
const PADDING_TOP = 12
const MAX_HIGHLIGHT_LENGTH = 300_000
const MAX_MATCHES = 5000

const OPEN_TO_CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }

function collectMatches(text: string, query: string): number[] {
  const matches: number[] = []
  if (!query) return matches
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  let index = haystack.indexOf(needle)
  while (index !== -1 && matches.length < MAX_MATCHES) {
    matches.push(index)
    index = haystack.indexOf(needle, index + Math.max(1, needle.length))
  }
  return matches
}

/**
 * eNCode's editor: a native textarea (for real key handling, selection, IME,
 * clipboard and undo) layered over a highlighted <pre>, with a synced gutter,
 * current-line marker and an in-file find bar. No editor framework involved.
 */
export default function CodeEditor({ tab }: { tab: Tab | null }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const codeRef = useRef<HTMLElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const tabRef = useRef<Tab | null>(tab)
  tabRef.current = tab

  const scrollMemory = useRef(new Map<string, number>())
  const lastPathRef = useRef<string | null>(null)
  const rafRef = useRef<number | null>(null)
  const findIndexRef = useRef(0)

  const [lineCount, setLineCount] = useState(1)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)
  const [findCount, setFindCount] = useState(0)
  findIndexRef.current = findIndex

  const positionCurrentLine = useCallback(() => {
    const textarea = textareaRef.current
    const line = lineRef.current
    if (!textarea || !line) return
    const before = textarea.value.slice(0, textarea.selectionStart)
    const lineNo = before.split('\n').length
    const top = PADDING_TOP + (lineNo - 1) * LINE_HEIGHT - textarea.scrollTop
    if (top < -LINE_HEIGHT || top > textarea.clientHeight) {
      line.style.opacity = '0'
      return
    }
    line.style.opacity = '1'
    line.style.transform = `translateY(${top}px)`
  }, [])

  const syncScroll = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    if (codeRef.current) {
      codeRef.current.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`
    }
    if (gutterRef.current) {
      gutterRef.current.style.transform = `translateY(${-textarea.scrollTop}px)`
    }
    positionCurrentLine()
  }, [positionCurrentLine])

  const highlight = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const text = textarea.value
    const lines = text.split('\n')
    setLineCount((previous) => (previous === lines.length ? previous : lines.length))
    if (codeRef.current) {
      codeRef.current.innerHTML =
        text.length > MAX_HIGHLIGHT_LENGTH
          ? escapeHtml(text)
          : renderTokens(tokenize(text, tabRef.current?.language ?? 'plaintext'))
    }
    if (gutterRef.current) {
      gutterRef.current.textContent = lines.map((_, index) => String(index + 1)).join('\n')
    }
    syncScroll()
  }, [syncScroll])

  const scheduleHighlight = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      highlight()
    })
  }, [highlight])

  const updateCursor = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const before = textarea.value.slice(0, textarea.selectionStart)
    const lines = before.split('\n')
    useEditor.getState().setCursor(lines.length, (lines[lines.length - 1] ?? '').length + 1)
    positionCurrentLine()
  }, [positionCurrentLine])

  const jumpToMatch = useCallback(
    (target: number) => {
      const textarea = textareaRef.current
      const query = findQuery.trim()
      if (!textarea || !query) return
      const matches = collectMatches(textarea.value, query)
      if (!matches.length) {
        setFindCount(0)
        return
      }
      const index = ((target % matches.length) + matches.length) % matches.length
      const start = matches[index]
      textarea.focus()
      textarea.setSelectionRange(start, start + query.length)
      const lineNo = textarea.value.slice(0, start).split('\n').length
      const top = PADDING_TOP + (lineNo - 1) * LINE_HEIGHT
      textarea.scrollTop = Math.max(0, top - textarea.clientHeight / 2)
      syncScroll()
      updateCursor()
      setFindIndex(index)
      setFindCount(matches.length)
    },
    [findQuery, syncScroll, updateCursor],
  )

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current
    const current = tabRef.current
    if (!textarea || !current) return
    useEditor.getState().updateContent(current.path, textarea.value)
    scheduleHighlight()
    updateCursor()
  }, [scheduleHighlight, updateCursor])

  /** Programmatic edit that keeps the native undo stack usable. */
  const commitEdit = useCallback(
    (insert: string, selectFrom?: number, selectTo?: number) => {
      const textarea = textareaRef.current
      if (!textarea) return
      const start = textarea.selectionStart
      textarea.setRangeText(insert, start, textarea.selectionEnd, 'end')
      if (selectFrom !== undefined && selectTo !== undefined) {
        textarea.setSelectionRange(start + selectFrom, start + selectTo)
      }
      handleInput()
    },
    [handleInput],
  )

  // Load a file (or clear) when the active path changes.
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const previous = lastPathRef.current
    if (previous && previous !== tab?.path) scrollMemory.current.set(previous, textarea.scrollTop)
    lastPathRef.current = tab?.path ?? null
    setFindOpen(false)
    setFindQuery('')
    setFindCount(0)
    setFindIndex(0)

    if (!tab) {
      textarea.value = ''
      highlight()
      return
    }

    textarea.value = tab.content
    textarea.scrollTop = scrollMemory.current.get(tab.path) ?? 0
    textarea.scrollLeft = 0
    highlight()
    updateCursor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.path])

  // External changes (agent edits, reloads) flow into the textarea.
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || !tab) return
    if (textarea.value === tab.content) return
    const caret = Math.min(textarea.selectionStart, tab.content.length)
    textarea.value = tab.content
    textarea.setSelectionRange(caret, caret)
    highlight()
    updateCursor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.content])

  // Quick-open / search "reveal line".
  const revealLine = useEditor((state) => state.revealLine)
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || !tab || revealLine == null) return
    const lines = textarea.value.split('\n')
    const lineNo = Math.max(1, Math.min(revealLine, lines.length))
    let offset = 0
    for (let index = 0; index < lineNo - 1; index++) offset += lines[index].length + 1
    textarea.focus()
    textarea.setSelectionRange(offset, offset + (lines[lineNo - 1] ?? '').length)
    textarea.scrollTop = Math.max(0, PADDING_TOP + (lineNo - 1) * LINE_HEIGHT - textarea.clientHeight / 2)
    syncScroll()
    updateCursor()
    useEditor.getState().consumeRevealLine()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealLine, tab?.path])

  // Find: focus + select-all when opened.
  useEffect(() => {
    if (!findOpen) return
    const frame = window.requestAnimationFrame(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [findOpen])

  // Find: refresh the count as the document changes.
  useEffect(() => {
    if (!findOpen) return
    const textarea = textareaRef.current
    if (!textarea) return
    const query = findQuery.trim()
    setFindCount(query ? collectMatches(textarea.value, query).length : 0)
  }, [findOpen, findQuery, tab?.content])

  const onFindChange = (value: string) => {
    setFindQuery(value)
    const textarea = textareaRef.current
    if (!textarea) return
    const query = value.trim()
    if (!query) {
      setFindCount(0)
      setFindIndex(0)
      return
    }
    const matches = collectMatches(textarea.value, query)
    setFindCount(matches.length)
    if (matches.length && document.activeElement === findInputRef.current) {
      const start = matches[0]
      const lineNo = textarea.value.slice(0, start).split('\n').length
      textarea.setSelectionRange(start, start + query.length)
      textarea.scrollTop = Math.max(0, PADDING_TOP + (lineNo - 1) * LINE_HEIGHT - textarea.clientHeight / 2)
      syncScroll()
      updateCursor()
      setFindIndex(0)
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = textareaRef.current
    if (!textarea) return
    const mod = event.ctrlKey || event.metaKey

    if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      setFindOpen(true)
      return
    }
    if (event.key === 'Escape' && findOpen) {
      event.preventDefault()
      setFindOpen(false)
      return
    }

    if (event.key === 'Tab') {
      event.preventDefault()
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const multiline = textarea.value.slice(start, end).includes('\n')

      if (!multiline && !event.shiftKey) {
        commitEdit('  ')
        return
      }

      const value = textarea.value
      const blockStart = value.lastIndexOf('\n', start - 1) + 1
      let blockEnd = value.indexOf('\n', end)
      if (blockEnd === -1) blockEnd = value.length
      const block = value.slice(blockStart, blockEnd)
      const lines = block.split('\n')
      const shifted = event.shiftKey
        ? lines.map((line) => line.replace(/^ {1,2}/, ''))
        : lines.map((line) => '  ' + line)
      const replacement = shifted.join('\n')
      textarea.setRangeText(replacement, blockStart, blockEnd, 'select')
      handleInput()
      return
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      if (start !== end) return
      const value = textarea.value
      const lineStart = value.lastIndexOf('\n', start - 1) + 1
      const line = value.slice(lineStart, start)
      const indent = /^[\t ]*/.exec(line)?.[0] ?? ''
      const previous = value[start - 1]
      const next = value[start]
      const opensBlock = previous !== undefined && '{(['.includes(previous)
      const closesBlock = next !== undefined && '})]'.includes(next)

      event.preventDefault()
      if (opensBlock && closesBlock) {
        const indented = `\n${indent}  \n${indent}`
        commitEdit(indented, indent.length + 3, indent.length + 3)
      } else {
        commitEdit(`\n${indent}${opensBlock ? '  ' : ''}`)
      }
      return
    }

    // Auto-close pairs (and wrap selections).
    if (!mod && !event.altKey && OPEN_TO_CLOSE[event.key]) {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const close = OPEN_TO_CLOSE[event.key]
      if (start === end) {
        const next = textarea.value[start]
        if (next === close) {
          event.preventDefault()
          textarea.setSelectionRange(start + 1, start + 1)
          updateCursor()
          return
        }
        event.preventDefault()
        commitEdit(event.key + close, 1, 1)
        return
      }
      event.preventDefault()
      const selected = textarea.value.slice(start, end)
      commitEdit(event.key + selected + close, 1, 1 + selected.length)
      return
    }

    // Skip over an existing closing character.
    if (!mod && !event.altKey && [')', ']', '}', '"', "'", '`'].includes(event.key)) {
      const start = textarea.selectionStart
      if (start === textarea.selectionEnd && textarea.value[start] === event.key) {
        event.preventDefault()
        textarea.setSelectionRange(start + 1, start + 1)
        updateCursor()
      }
    }
  }

  const digits = String(Math.max(1, lineCount)).length
  const gutterWidth = Math.max(46, digits * 9 + 26)

  return (
    <div className="code-editor">
      <div className="code-gutter" style={{ width: gutterWidth }}>
        <div className="code-gutter-inner" ref={gutterRef} />
      </div>

      <div className="code-main">
        <div className="code-current-line" ref={lineRef} />
        <pre className="code-highlight" aria-hidden="true">
          <code ref={codeRef} />
        </pre>
        <textarea
          ref={textareaRef}
          className="code-input"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          wrap="off"
          onInput={handleInput}
          onScroll={syncScroll}
          onSelect={updateCursor}
          onClick={updateCursor}
          onKeyDown={handleKeyDown}
          onKeyUp={updateCursor}
        />

        {findOpen && (
          <div className="find-bar">
            <Search size={13} className="find-icon" />
            <input
              ref={findInputRef}
              className="find-input"
              value={findQuery}
              placeholder="Find in file"
              onChange={(event) => onFindChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  jumpToMatch(findIndex + (event.shiftKey ? -1 : 1))
                }
                if (event.key === 'Escape') setFindOpen(false)
              }}
            />
            <span className="find-count">{findCount ? `${findIndex + 1}/${findCount}` : '0/0'}</span>
            <button className="icon-btn" onClick={() => jumpToMatch(findIndex - 1)} title="Previous match">
              <ChevronUp size={13} />
            </button>
            <button className="icon-btn" onClick={() => jumpToMatch(findIndex + 1)} title="Next match">
              <ChevronDown size={13} />
            </button>
            <button className="icon-btn" onClick={() => setFindOpen(false)} title="Close find">
              <X size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

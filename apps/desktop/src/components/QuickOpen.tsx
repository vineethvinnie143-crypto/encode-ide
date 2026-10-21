import { useEffect, useMemo, useRef, useState } from 'react'
import { File, Loader2, Search } from '../ui/icons'
import { api } from '../api'
import { useEditor } from '../stores/editor'
import { useUi } from '../stores/ui'

function fuzzyScore(query: string, target: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const direct = t.indexOf(q)
  if (direct !== -1) return 1000 - direct - (t.length - q.length) * 0.1

  let score = 0
  let qi = 0
  let streak = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi++
      streak++
      score += 1 + streak
      if (i > 0 && /[/\\_.-]/.test(t[i - 1])) score += 3
    } else {
      streak = 0
    }
  }
  return qi === q.length ? score : -1
}

export default function QuickOpen() {
  const setOpen = useUi((state) => state.setQuickOpenOpen)
  const openFile = useEditor((state) => state.openFile)

  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [truncated, setTruncated] = useState(false)
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.workspace
      .listAllFiles()
      .then((result) => {
        if (cancelled) return
        setFiles(result.files)
        setTruncated(result.truncated)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      cancelled = true
    }
  }, [])

  const results = useMemo(() => {
    const scored = files
      .map((path) => ({ path, score: fuzzyScore(query, path) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 100)
    return scored.map((item) => item.path)
  }, [files, query])

  useEffect(() => {
    setIndex(0)
  }, [query])

  const choose = (path?: string) => {
    const target = path ?? results[index]
    if (!target) return
    setOpen(false)
    useUi.getState().setWorkspaceTab('editor')
    void openFile(target)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIndex((value) => Math.min(results.length - 1, value + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex((value) => Math.max(0, value - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose()
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="quickopen" onMouseDown={(event) => event.stopPropagation()}>
        <div className="quickopen-input-wrap">
          <Search size={15} />
          <input
            ref={inputRef}
            className="quickopen-input"
            value={query}
            placeholder="Search files by name…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {loading && <Loader2 size={14} className="spin" />}
        </div>

        <div className="quickopen-list">
          {results.map((path, itemIndex) => (
            <button
              key={path}
              className={`quickopen-item ${itemIndex === index ? 'is-active' : ''}`}
              onMouseEnter={() => setIndex(itemIndex)}
              onClick={() => choose(path)}
            >
              <File size={13} className="qo-icon" />
              <span className="qo-name">{path.split('/').pop()}</span>
              <span className="qo-dir">{path}</span>
            </button>
          ))}
          {!loading && results.length === 0 && (
            <div className="quickopen-empty">
              No files matched{truncated ? '. The file index was truncated.' : '.'}
            </div>
          )}
        </div>

        <div className="quickopen-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
          {truncated && <span className="muted">index truncated</span>}
        </div>
      </div>
    </div>
  )
}

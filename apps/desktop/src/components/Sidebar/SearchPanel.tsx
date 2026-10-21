import { useEffect, useMemo, useState } from 'react'
import { CaseSensitive, Regex, Search } from '../../ui/icons'
import type { SearchResult } from '@shared/types'
import { api } from '../../api'
import { useEditor } from '../../stores/editor'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'

export default function SearchPanel() {
  const workspace = useWorkspace((state) => state.workspace)
  const openFile = useEditor((state) => state.openFile)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspace || !query.trim()) {
      setResult(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const response = await api.workspace.search({
          query,
          caseSensitive,
          regex,
          maxResults: 300,
        })
        if (!cancelled) {
          setResult(response)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message)
          setResult(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 320)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, caseSensitive, regex, workspace])

  const grouped = useMemo(() => {
    const map = new Map<string, { line: number; column: number; text: string }[]>()
    for (const match of result?.matches ?? []) {
      const list = map.get(match.path) ?? []
      list.push({ line: match.line, column: match.column, text: match.lineText })
      map.set(match.path, list)
    }
    return [...map.entries()]
  }, [result])

  const open = (path: string, line?: number) => {
    useUi.getState().setWorkspaceTab('editor')
    void openFile(path, line)
  }

  return (
    <div className="search-panel">
      <div className="panel-header">
        <span className="panel-title">Search</span>
      </div>

      <div className="search-box">
        <div className="search-input-wrap">
          <Search size={14} className="search-icon" />
          <input
            className="search-input"
            placeholder="Search in folder"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        </div>
        <div className="search-toggles">
          <button
            className={`toggle-btn ${caseSensitive ? 'is-on' : ''}`}
            onClick={() => setCaseSensitive((value) => !value)}
            title="Match case"
          >
            <CaseSensitive size={15} />
          </button>
          <button
            className={`toggle-btn ${regex ? 'is-on' : ''}`}
            onClick={() => setRegex((value) => !value)}
            title="Use regular expression"
          >
            <Regex size={15} />
          </button>
        </div>
      </div>

      <div className="search-meta">
        {loading && 'Searching…'}
        {!loading && error && <span className="error-text">{error}</span>}
        {!loading && !error && result && (
          <span>
            {result.matches.length} result{result.matches.length === 1 ? '' : 's'}
            {result.truncated ? ' (truncated)' : ''} · {result.filesSearched} files
          </span>
        )}
      </div>

      <div className="search-results">
        {grouped.map(([filePath, matches]) => (
          <div key={filePath} className="search-group">
            <button className="search-file" onClick={() => open(filePath, matches[0]?.line)}>
              <span className="search-file-name">{filePath.split('/').pop()}</span>
              <span className="search-file-dir">{filePath}</span>
              <span className="search-file-count">{matches.length}</span>
            </button>
            {matches.slice(0, 100).map((match) => (
              <button
                key={`${filePath}:${match.line}:${match.column}`}
                className="search-hit"
                onClick={() => open(filePath, match.line)}
                title={`Line ${match.line}, column ${match.column}`}
              >
                <span className="search-line">{match.line}</span>
                <span className="search-text">{match.text}</span>
              </button>
            ))}
          </div>
        ))}
        {!loading && result && result.matches.length === 0 && (
          <div className="tree-note">No matches found.</div>
        )}
      </div>
    </div>
  )
}

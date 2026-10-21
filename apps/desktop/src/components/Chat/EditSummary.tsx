import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Pencil } from '../../ui/icons'
import type { ConversationEntry } from '@shared/types'

interface EditedFile {
  path: string
  additions: number
  deletions: number
}

export function collectEdits(entries: ConversationEntry[]): EditedFile[] {
  const files = new Map<string, EditedFile>()
  for (const entry of entries) {
    const tool = entry.tool
    if (!tool?.diff?.length) continue
    const path = String(tool.input.path ?? '')
    if (!path) continue
    const current = files.get(path) ?? { path, additions: 0, deletions: 0 }
    for (const hunk of tool.diff) {
      for (const line of hunk.lines) {
        if (line.type === 'add') current.additions += 1
        else if (line.type === 'del') current.deletions += 1
      }
    }
    files.set(path, current)
  }
  return [...files.values()]
}

/** Inline "Edited N files" card summarising a turn's file changes. */
export default function EditSummary({ entries }: { entries: ConversationEntry[] }) {
  const files = useMemo(() => collectEdits(entries), [entries])
  const [expanded, setExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)

  if (!files.length) return null

  const additions = files.reduce((total, file) => total + file.additions, 0)
  const deletions = files.reduce((total, file) => total + file.deletions, 0)
  const visible = showAll ? files : files.slice(0, 4)

  return (
    <div className="edit-summary">
      <button className="edit-summary-head" onClick={() => setExpanded((value) => !value)}>
        <span className="edit-summary-icon">
          <Pencil size={13} />
        </span>
        <span className="edit-summary-body">
          <span className="edit-summary-title">
            Edited {files.length} file{files.length === 1 ? '' : 's'}
          </span>
          <span className="edit-summary-stats">
            <span className="add-stat">+{additions}</span>
            <span className="del-stat">−{deletions}</span>
          </span>
        </span>
        <span className="edit-summary-chevron">{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
      </button>

      {expanded && (
        <>
          <div className="edit-summary-list">
            {visible.map((file) => (
              <div className="edit-summary-file" key={file.path}>
                <span className="edit-summary-path" title={file.path}>
                  {file.path}
                </span>
                <span className="edit-summary-file-stats">
                  <span className="add-stat">+{file.additions}</span>
                  <span className="del-stat">−{file.deletions}</span>
                </span>
              </div>
            ))}
          </div>
          {files.length > 4 && (
            <button className="edit-summary-more" onClick={() => setShowAll((value) => !value)}>
              {showAll ? 'Show fewer files' : `All ${files.length} files`} <ChevronDown size={12} />
            </button>
          )}
        </>
      )}
    </div>
  )
}

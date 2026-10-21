import { useState } from 'react'
import { ChevronRight, Columns2, LayoutGrid, PanelRightClose, Plus, X } from 'lucide-react'
import { useChat } from '../stores/chat'
import { useUi } from '../stores/ui'
import BrowserPanel from './BrowserPanel'
import WorkspacePanel from './WorkspacePanel'

export default function RightPanel() {
  const rightPanel = useUi((state) => state.rightPanel)
  const setRightPanel = useUi((state) => state.setRightPanel)
  const setRightVisible = useUi((state) => state.setRightVisible)

  const other = rightPanel === 'browse' ? 'workspace' : 'browse'

  return (
    <aside className="right-panel">
      <div className="right-tabs">
        <button className={`right-tab ${rightPanel === 'browse' ? 'is-active' : ''}`} onClick={() => setRightPanel('browse')}>
          Browse
          <span
            className="right-tab-close"
            title="Close"
            onClick={(event) => {
              event.stopPropagation()
              setRightVisible(false)
            }}
          >
            <X size={10} />
          </span>
        </button>
        {rightPanel === 'workspace' && (
          <button className="right-tab is-active" onClick={() => setRightPanel('workspace')}>
            Workspace
            <span
              className="right-tab-close"
              title="Close"
              onClick={(event) => {
                event.stopPropagation()
                setRightPanel('browse')
              }}
            >
              <X size={10} />
            </span>
          </button>
        )}
        <button className="right-tab-add" title="New tab" onClick={() => setRightPanel('workspace')}>
          <Plus size={13} />
        </button>
        <span className="right-tab-spacer" />
        <button className="icon-btn" title="Swap panel" onClick={() => setRightPanel(other)}>
          <LayoutGrid size={14} />
        </button>
        <button className="icon-btn" title="Collapse panel" onClick={() => setRightVisible(false)}>
          <PanelRightClose size={14} />
        </button>
      </div>

      <div className={`right-pane ${rightPanel === 'browse' ? 'is-active' : ''}`}>
        <BrowserPanel />
      </div>
      <div className={`right-pane ${rightPanel === 'workspace' ? 'is-active' : ''}`}>
        <WorkspacePanel />
      </div>
    </aside>
  )
}

export function TrajectoryView() {
  const entries = useChat((state) => state.entries)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  if (!entries.length) {
    return (
      <div className="trajectory-empty">
        <Columns2 size={18} />
        <span>No trajectory yet. Send a task to see every step.</span>
      </div>
    )
  }

  return (
    <div className="trajectory">
      {entries.map((entry, index) => {
        const label =
          entry.kind === 'tool'
            ? entry.tool?.name.replace(/_/g, ' ') ?? 'tool'
            : entry.kind === 'assistant'
              ? 'think'
              : entry.kind
        const isTool = entry.kind === 'tool'
        const expanded = isTool && open[entry.id]

        return (
          <div className={`trajectory-item trajectory-${entry.kind}`} key={entry.id}>
            <span className="trajectory-index">{String(index + 1).padStart(2, '0')}</span>
            <div className="trajectory-main">
              <button
                className="trajectory-head"
                onClick={() => isTool && setOpen((previous) => ({ ...previous, [entry.id]: !expanded }))}
              >
                {isTool && <ChevronRight size={12} className={expanded ? 'is-open' : ''} />}
                <span className={`trajectory-kind kind-${entry.kind}`}>{label}</span>
                <span className="trajectory-preview">
                  {entry.text || (entry.tool ? String(entry.tool.input.path ?? entry.tool.input.command ?? '') : '')}
                </span>
              </button>
              {expanded && entry.tool && (
                <div className="trajectory-detail">
                  <div className="trajectory-detail-label">input</div>
                  <pre>{JSON.stringify(entry.tool.input, null, 2)}</pre>
                  {entry.tool.output && (
                    <>
                      <div className="trajectory-detail-label">output</div>
                      <pre>{entry.tool.output}</pre>
                    </>
                  )}
                </div>
              )}
            </div>
            <span className="trajectory-time">
              {new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </div>
        )
      })}
    </div>
  )
}

import { useMemo, useState } from 'react'
import { Download, FileUp, Gauge, MessageSquare, Package, ScrollText, Settings2, Target } from 'lucide-react'

export type CommandPaletteAction =
  | 'file'
  | 'goal'
  | 'plan'
  | 'feedback'
  | 'compact'
  | 'permission'
  | 'model'
  | 'export'

interface Item {
  id: CommandPaletteAction
  label: string
  detail: string
  group: 'add' | 'command'
  icon: typeof FileUp
}

const ITEMS: Item[] = [
  { id: 'file', label: 'File', detail: 'Attach a file to the next message', group: 'add', icon: FileUp },
  { id: 'goal', label: 'Goal', detail: 'Set or view the goal for a long-running task', group: 'add', icon: Target },
  { id: 'plan', label: 'Plan', detail: 'Enter or leave plan mode', group: 'add', icon: ScrollText },
  { id: 'feedback', label: 'Feedback', detail: 'Record feedback about this session', group: 'add', icon: MessageSquare },
  { id: 'compact', label: 'Compact', detail: 'Compact older conversation history', group: 'command', icon: Package },
  { id: 'permission', label: 'Permission', detail: 'Switch the permission preset (approval policy)', group: 'command', icon: Gauge },
  { id: 'model', label: 'Model', detail: 'Select the model for this conversation', group: 'command', icon: Settings2 },
  { id: 'export', label: 'Export', detail: 'Download this session log as a ZIP archive', group: 'command', icon: Download },
]

export default function CommandPalette({
  onAction,
  onClose,
}: {
  onAction: (action: CommandPaletteAction) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return ITEMS
    return ITEMS.filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(needle))
  }, [query])

  const groups: { key: 'add' | 'command'; title: string }[] = [
    { key: 'add', title: 'Add' },
    { key: 'command', title: 'Commands' },
  ]

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="command-palette" onMouseDown={(event) => event.stopPropagation()}>
        <input
          autoFocus
          className="command-input"
          placeholder="Type a command…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'Enter' && filtered[0]) onAction(filtered[0].id)
          }}
        />
        <div className="command-list">
          {groups.map((group) => {
            const items = filtered.filter((item) => item.group === group.key)
            if (!items.length) return null
            return (
              <div className="command-group" key={group.key}>
                <div className="command-group-title">{group.title}</div>
                {items.map((item) => {
                  const Icon = item.icon
                  return (
                    <button key={item.id} className="command-item" onClick={() => onAction(item.id)}>
                      <Icon size={14} />
                      <span className="command-label">{item.label}</span>
                      <span className="command-detail">{item.detail}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
          {!filtered.length && <div className="rail-empty">No matching commands.</div>}
        </div>
      </div>
    </div>
  )
}

import { FileCode2, FileJson, FileText, X } from '../ui/icons'
import { useEditor } from '../stores/editor'

function iconFor(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['json', 'jsonc', 'lock'].includes(ext)) return FileJson
  if (['md', 'markdown', 'txt'].includes(ext)) return FileText
  return FileCode2
}

export default function EditorTabs() {
  const tabs = useEditor((state) => state.tabs)
  const activePath = useEditor((state) => state.activePath)
  const setActive = useEditor((state) => state.setActive)
  const closeTab = useEditor((state) => state.closeTab)

  if (!tabs.length) return null

  return (
    <div className="editor-tabs" role="tablist">
      {tabs.map((tab) => {
        const Icon = iconFor(tab.name)
        const active = tab.path === activePath
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={active}
            className={`editor-tab ${active ? 'is-active' : ''} ${tab.dirty ? 'is-dirty' : ''}`}
            onClick={() => setActive(tab.path)}
            onAuxClick={(event) => {
              if (event.button === 1) closeTab(tab.path)
            }}
            title={tab.path}
          >
            <Icon size={13} className="tab-icon" />
            <span className="tab-label">{tab.name}</span>
            <span className={`tab-dirty ${tab.dirty ? 'show' : ''}`} />
            <button
              className="tab-close"
              onClick={(event) => {
                event.stopPropagation()
                closeTab(tab.path)
              }}
              title="Close (middle click also works)"
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

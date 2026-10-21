import { usePanels } from '../../stores/panels'
import { IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { X } from '../../ui/icons'
import { PaneFor } from './SidePanel'
import { TabStrip } from './TabStrip'

/** Under the thread and the side panel: terminals and the agent's background jobs. Ctrl+J shows and hides it. */
export default function BottomPanel({ open, height, onResizeStart }: { open: boolean; height: number; onResizeStart: (event: React.PointerEvent) => void }) {
  const tabs = usePanels((state) => state.bottom.tabs)
  const activeId = usePanels((state) => state.bottom.activeId)

  return (
    <section className={cx('bottom-panel', !open && 'is-closed')} style={{ height }} aria-label="Bottom panel">
      <div className="resizer resizer-h" onPointerDown={onResizeStart} />
      <TabStrip
        compact
        tabs={tabs}
        activeId={activeId}
        label="Bottom panel tabs"
        onSelect={(id) => usePanels.getState().activateBottom(id)}
        onClose={(id) => usePanels.getState().closeBottom(id)}
      >
        <IconButton label="Hide bottom panel" shortcut="Ctrl+J" size="md" onClick={() => usePanels.getState().toggleBottom()}>
          <X size={14} />
        </IconButton>
      </TabStrip>
      <div className="panel-panes">
        {tabs.map((tab) => (
          <div key={tab.id} role="tabpanel" aria-label={tab.title} className={cx('panel-pane', tab.id === activeId && 'is-active')}>
            <PaneFor tab={tab} />
          </div>
        ))}
      </div>
    </section>
  )
}

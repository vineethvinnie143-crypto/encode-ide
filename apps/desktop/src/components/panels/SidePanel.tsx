import { usePanels } from '../../stores/panels'
import type { PanelTab } from '../../panels/model'
import { IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Columns2, Maximize2, PanelRightClose } from '../../ui/icons'
import BrowserPanel from '../BrowserPanel'
import ReviewPane from '../review/ReviewPane'
import TerminalPanel from '../Terminal/TerminalPanel'
import TrajectoryView from '../TrajectoryView'
import { EditorPane, FilesPane, JobsPane, NewTabPane } from './Panes'
import { TabStrip } from './TabStrip'

/** What a tab shows. */
export function PaneFor({ tab }: { tab: PanelTab }) {
  switch (tab.kind) {
    case 'new':
      return <NewTabPane />
    case 'browser':
      return <BrowserPanel tabId={tab.id} />
    case 'files':
      return <FilesPane />
    case 'editor':
      return <EditorPane />
    case 'review':
      return <ReviewPane />
    case 'terminal':
      return <TerminalPanel />
    case 'trajectory':
      return <TrajectoryView />
    case 'jobs':
      return <JobsPane />
  }
}

/**
 * The side panel: a strip of tabs, and under it every tab's page. Pages that are not in front
 * stay mounted, so a browser keeps its page and a terminal its shells.
 */
export default function SidePanel() {
  const tabs = usePanels((state) => state.side.tabs)
  const activeId = usePanels((state) => state.side.activeId)
  const layout = usePanels((state) => state.side.layout)

  return (
    <aside className="side-panel" data-layout={layout} aria-label="Side panel">
      <TabStrip
        tabs={tabs}
        activeId={activeId}
        label="Side panel tabs"
        addLabel="New tab"
        onSelect={(id) => usePanels.getState().activate(id)}
        onClose={(id) => usePanels.getState().close(id)}
        onAdd={() => usePanels.getState().open('new')}
      >
        <IconButton
          label={layout === 'full' ? 'Split with the thread' : 'Full width'}
          size="md"
          active={layout === 'full'}
          onClick={() => usePanels.getState().toggleFull()}
        >
          {layout === 'full' ? <Columns2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
        <IconButton label="Hide side panel" size="md" onClick={() => usePanels.getState().toggleHidden()}>
          <PanelRightClose size={14} />
        </IconButton>
      </TabStrip>

      <div className="panel-panes">
        {tabs.map((tab) => (
          <div key={tab.id} role="tabpanel" aria-label={tab.title} className={cx('panel-pane', tab.id === activeId && 'is-active')}>
            <PaneFor tab={tab} />
          </div>
        ))}
      </div>
    </aside>
  )
}

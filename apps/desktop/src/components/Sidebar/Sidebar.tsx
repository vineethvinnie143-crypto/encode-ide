import SidebarExplorer from './Explorer'
import SearchPanel from './SearchPanel'
import GitPanel from './GitPanel'
import { useUi } from '../../stores/ui'

export default function Sidebar() {
  const view = useUi((state) => state.sidebarView)

  return (
    <aside className="sidebar">
      {view === 'explorer' && <SidebarExplorer />}
      {view === 'search' && <SearchPanel />}
      {view === 'git' && <GitPanel />}
    </aside>
  )
}

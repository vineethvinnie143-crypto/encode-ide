import { useEffect } from 'react'
import AutomationModal from './components/AutomationModal'
import ChatPanel from './components/Chat/ChatPanel'
import PluginsModal from './components/PluginsModal'
import PromptDialog from './components/PromptDialog'
import QuickOpen from './components/QuickOpen'
import RightPanel, { TrajectoryView } from './components/RightPanel'
import SessionHeader from './components/SessionHeader'
import SettingsModal from './components/SettingsModal'
import { AboutDialog, ConfirmDialog, ShortcutsDialog } from './components/shell/Dialogs'
import IconRail from './components/shell/IconRail'
import SessionSidebar from './components/shell/SessionSidebar'
import TitleBar from './components/shell/TitleBar'
import Toasts from './components/Toasts'
import { api } from './api'
import { useKeymap } from './commands/useKeymap'
import { useResizable } from './hooks/useResizable'
import { useChat } from './stores/chat'
import { useEditor } from './stores/editor'
import { useGit } from './stores/git'
import { useSessions } from './stores/sessions'
import { useSettings } from './stores/settings'
import { useUi } from './stores/ui'
import { useWorkspace } from './stores/workspace'
import { applyAppearance } from './theme/appearance'

async function refreshOpenTab(path: string): Promise<void> {
  const editor = useEditor.getState()
  const tab = editor.tabs.find((item) => item.path === path)
  if (!tab || tab.dirty) return
  try {
    const file = await api.workspace.read(path)
    if (!file.binary) editor.applyExternalContent(path, file.content)
  } catch {
    /* file may have been deleted */
  }
}

export default function App() {
  const rightVisible = useUi((state) => state.rightVisible)
  const sidebarVisible = useUi((state) => state.sidebarVisible)
  const settingsOpen = useUi((state) => state.settingsOpen)
  const pluginsOpen = useUi((state) => state.pluginsOpen)
  const automationOpen = useUi((state) => state.automationOpen)
  const quickOpenOpen = useUi((state) => state.quickOpenOpen)
  const mainView = useUi((state) => state.mainView)
  const setMainView = useUi((state) => state.setMainView)
  const appearance = useSettings((state) => state.settings?.appearance)
  const workspaceRoot = useWorkspace((state) => state.workspace?.root)

  const sidebar = useResizable({ initial: 272, min: 220, max: 480, axis: 'x', persistKey: 'eNCode.sidebar.v1' })
  const right = useResizable({ initial: 380, min: 320, max: 900, axis: 'x', invert: true, persistKey: 'eNCode.right.v2' })

  useKeymap()

  useEffect(() => {
    void useWorkspace.getState().init()
    void useSettings.getState().load()
    void useSessions.getState().init()
    void useGit.getState().refresh()
  }, [])

  useEffect(() => {
    if (appearance) applyAppearance(appearance)
  }, [appearance])

  // Opening a folder gives it to the empty session that has no project yet, so that session is listed under it.
  useEffect(() => {
    if (workspaceRoot) void useSessions.getState().adoptProject()
  }, [workspaceRoot])

  useEffect(() => {
    const refresh = () => {
      void useWorkspace.getState().refreshAll()
      void useGit.getState().refresh()
    }

    const offAgent = api.agent.onEvent((event) => {
      useChat.getState().applyEvent(event)
      useSessions.getState().applyEvent(event)
      if (event.type === 'file-changed') void refreshOpenTab(event.path)
      if (event.type === 'file-changed' || event.type === 'done') refresh()
    })

    const offFiles = api.workspace.onFileChanged((paths) => {
      for (const path of paths) void refreshOpenTab(path)
      refresh()
    })

    return () => {
      offAgent()
      offFiles()
    }
  }, [])

  return (
    <div className="app">
      <TitleBar />

      <div className="app-body">
        <IconRail />

        <div className="sheet">
          {sidebarVisible && (
            <>
              <div className="sidebar-wrap" style={{ width: sidebar.size }}>
                <SessionSidebar />
              </div>
              <div className="resizer resizer-v" onPointerDown={sidebar.onPointerDown} />
            </>
          )}

          <main className="app-main">
            <SessionHeader />
            <div className="main-tabs">
              <button className={mainView === 'chat' ? 'is-active' : ''} onClick={() => setMainView('chat')}>
                Chat
              </button>
              <button className={mainView === 'trajectory' ? 'is-active' : ''} onClick={() => setMainView('trajectory')}>
                Trajectory
              </button>
            </div>
            <div className="main-body">{mainView === 'chat' ? <ChatPanel /> : <TrajectoryView />}</div>
          </main>

          {rightVisible && (
            <>
              <div className="resizer resizer-v" onPointerDown={right.onPointerDown} />
              <div className="right-wrap" style={{ width: right.size }}>
                <RightPanel />
              </div>
            </>
          )}
        </div>
      </div>

      {quickOpenOpen && <QuickOpen />}
      {settingsOpen && <SettingsModal />}
      {pluginsOpen && <PluginsModal />}
      {automationOpen && <AutomationModal />}
      <PromptDialog />
      <ShortcutsDialog />
      <AboutDialog />
      <ConfirmDialog />
      <Toasts />
    </div>
  )
}

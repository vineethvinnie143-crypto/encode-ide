import { useEffect } from 'react'
import AppMenuBar from './components/AppMenuBar'
import AutomationModal from './components/AutomationModal'
import ChatPanel from './components/Chat/ChatPanel'
import HarnessSidebar from './components/HarnessSidebar'
import PluginsModal from './components/PluginsModal'
import PromptDialog from './components/PromptDialog'
import QuickOpen from './components/QuickOpen'
import RightPanel, { TrajectoryView } from './components/RightPanel'
import SessionHeader from './components/SessionHeader'
import SettingsModal from './components/SettingsModal'
import Toasts from './components/Toasts'
import { api } from './api'
import { useResizable } from './hooks/useResizable'
import { useChat } from './stores/chat'
import { useEditor } from './stores/editor'
import { useGit } from './stores/git'
import { useSessions } from './stores/sessions'
import { useSettings } from './stores/settings'
import { useUi } from './stores/ui'
import { useWorkspace } from './stores/workspace'

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
  const settingsOpen = useUi((state) => state.settingsOpen)
  const pluginsOpen = useUi((state) => state.pluginsOpen)
  const automationOpen = useUi((state) => state.automationOpen)
  const quickOpenOpen = useUi((state) => state.quickOpenOpen)
  const mainView = useUi((state) => state.mainView)
  const setMainView = useUi((state) => state.setMainView)

  const right = useResizable({ initial: 380, min: 320, max: 900, axis: 'x', invert: true, persistKey: 'eNCode.right.v2' })

  useEffect(() => {
    void useWorkspace.getState().init()
    void useSettings.getState().load()
    void useSessions.getState().init()
    void useGit.getState().refresh()
  }, [])

  useEffect(() => {
    const refresh = () => {
      void useWorkspace.getState().refreshAll()
      void useGit.getState().refresh()
    }

    const offAgent = api.agent.onEvent((event) => {
      useChat.getState().applyEvent(event)
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod) {
        if (event.key === 'Escape') useUi.getState().setQuickOpenOpen(false)
        return
      }
      const key = event.key.toLowerCase()

      if (key === 's' && !event.shiftKey) {
        event.preventDefault()
        void useEditor.getState().saveActive()
      } else if (key === 'p' && !event.shiftKey) {
        event.preventDefault()
        useUi.getState().setQuickOpenOpen(true)
      } else if (key === 'n' && !event.shiftKey) {
        event.preventDefault()
        useSessions.getState().newSession()
      } else if (key === 'b' && !event.shiftKey) {
        event.preventDefault()
        useUi.getState().toggleRight()
      } else if (key === 'f' && event.shiftKey) {
        event.preventDefault()
        useUi.getState().setSidebarView('search')
        useUi.getState().setRightPanel('workspace')
        useUi.getState().setWorkspaceTab('files')
      } else if (event.code === 'Backquote' && !event.shiftKey) {
        event.preventDefault()
        useUi.getState().setWorkspaceTab('shell')
      } else if (key === 'x' && event.shiftKey) {
        event.preventDefault()
        useUi.getState().setWorkspaceTab('files')
        useUi.getState().setMainView('chat')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="app">
      <AppMenuBar />

      <div className="app-body">
        <HarnessSidebar />

        <main className="harness-main">
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

      {quickOpenOpen && <QuickOpen />}
      {settingsOpen && <SettingsModal />}
      {pluginsOpen && <PluginsModal />}
      {automationOpen && <AutomationModal />}
      <PromptDialog />
      <Toasts />
    </div>
  )
}

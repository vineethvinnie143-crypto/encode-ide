import { useEffect, useRef } from 'react'
import AutomationModal from './components/AutomationModal'
import ChatPanel from './components/Chat/ChatPanel'
import RewindDialog from './components/Chat/RewindDialog'
import { StatusDialog } from './components/Chat/StatusDialog'
import { alertGate, toastOf } from './components/models/alerts'
import ConnectModelDialog from './components/models/ConnectModelDialog'
import BottomPanel from './components/panels/BottomPanel'
import SidePanel from './components/panels/SidePanel'
import PluginsModal from './components/PluginsModal'
import PromptDialog from './components/PromptDialog'
import QuickOpen from './components/QuickOpen'
import SessionHeader from './components/SessionHeader'
import SettingsModal from './components/SettingsModal'
import { CommandPalette } from './components/shell/CommandPalette'
import { AboutDialog, ConfirmDialog } from './components/shell/Dialogs'
import IconRail from './components/shell/IconRail'
import SessionSidebar from './components/shell/SessionSidebar'
import { ShortcutsDialog } from './components/shell/ShortcutsDialog'
import TitleBar from './components/shell/TitleBar'
import Toasts from './components/Toasts'
import { api } from './api'
import { useKeymap } from './commands/useKeymap'
import { useResizable } from './hooks/useResizable'
import { useChat } from './stores/chat'
import { useEditor } from './stores/editor'
import { useGit } from './stores/git'
import { usePanels } from './stores/panels'
import { useSessions } from './stores/sessions'
import { useSettings } from './stores/settings'
import { useUi } from './stores/ui'
import { useWorkspace } from './stores/workspace'
import { applyAppearance } from './theme/appearance'
import { throttle } from './throttle'
import { cx } from './ui/cx'

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
  const sidebarVisible = useUi((state) => state.sidebarVisible)
  const settingsOpen = useUi((state) => state.settingsOpen)
  const pluginsOpen = useUi((state) => state.pluginsOpen)
  const automationOpen = useUi((state) => state.automationOpen)
  const quickOpenOpen = useUi((state) => state.quickOpenOpen)
  const layout = usePanels((state) => state.side.layout)
  const bottomTabs = usePanels((state) => state.bottom.tabs.length)
  const bottomOpen = usePanels((state) => state.bottom.open)
  const appearance = useSettings((state) => state.settings?.appearance)
  const workspaceRoot = useWorkspace((state) => state.workspace?.root)

  const sidebarRef = useRef<HTMLDivElement>(null)
  const sidebar = useResizable({ initial: 272, min: 220, max: 480, axis: 'x', persistKey: 'eNCode.sidebar.v1', element: () => sidebarRef.current })
  // The side panel is also held under 60% of the window in CSS, so a big saved width cannot cover the thread.
  const sideRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLElement>(null)
  const side = useResizable({
    initial: 440,
    min: 360,
    max: 1400,
    axis: 'x',
    invert: true,
    persistKey: 'eNCode.sidepanel.v1',
    measure: () => sideRef.current?.getBoundingClientRect().width,
    element: () => sideRef.current,
  })
  const bottom = useResizable({
    initial: 280,
    min: 140,
    max: 720,
    axis: 'y',
    invert: true,
    persistKey: 'eNCode.bottompanel.v1',
    measure: () => bottomRef.current?.getBoundingClientRect().height,
    element: () => bottomRef.current,
  })

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
    // An agent that writes a dozen files announces each one: the tree and git are read at the start of the burst and once at its end.
    const refresh = throttle(() => {
      void useWorkspace.getState().refreshAll()
      void useGit.getState().refresh()
    }, 300)

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

    // Problems with a connection (a refused key, a payment) are told at once, wherever the person is.
    const shown = alertGate()
    const offAlert = api.models.onAlert((alert) => {
      if (!shown(alert)) return
      const { kind, text, tab } = toastOf(alert)
      useUi.getState().notify(kind, text, tab ? { label: 'Open Settings', run: () => useUi.getState().openSettings(tab) } : undefined)
    })

    return () => {
      offAgent()
      offFiles()
      offAlert()
      refresh.cancel()
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
              <div className="sidebar-wrap" ref={sidebarRef} style={{ width: sidebar.size }}>
                <SessionSidebar />
              </div>
              <div className="resizer resizer-v" onPointerDown={sidebar.onPointerDown} />
            </>
          )}

          <div className="workarea">
            <div className="workrow">
              {/* The thread stays mounted under a full-width panel, so a draft in the composer survives. */}
              <main className={cx('app-main', layout === 'full' && 'is-covered')}>
                <SessionHeader />
                <div className="main-body">
                  <ChatPanel />
                </div>
              </main>

              {/* The panel stays mounted while hidden, so a browser keeps its page and a terminal its shells. */}
              {layout === 'split' && <div className="resizer resizer-v" onPointerDown={side.onPointerDown} />}
              <div ref={sideRef} className={cx('right-wrap', layout === 'full' && 'is-full', layout === 'hidden' && 'is-hidden')} style={layout === 'split' ? { width: side.size } : undefined}>
                <SidePanel />
              </div>
            </div>

            {bottomTabs > 0 && <BottomPanel panelRef={bottomRef} open={bottomOpen} height={bottom.size} onResizeStart={bottom.onPointerDown} />}
          </div>
        </div>
      </div>

      {quickOpenOpen && <QuickOpen />}
      {settingsOpen && <SettingsModal />}
      {pluginsOpen && <PluginsModal />}
      {automationOpen && <AutomationModal />}
      <ConnectModelDialog />
      <RewindDialog />
      <PromptDialog />
      <ShortcutsDialog />
      <StatusDialog />
      <CommandPalette />
      <AboutDialog />
      <ConfirmDialog />
      <Toasts />
    </div>
  )
}

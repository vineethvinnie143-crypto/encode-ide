import { app, BrowserWindow, Menu, protocol } from 'electron'
import { AgentManager } from './agent/manager'
import { registerIpc } from './ipc'
import { registerAppProtocol } from './protocol'
import { GitService } from './services/git'
import { JobService } from './services/jobs'
import { ModelsService } from './services/models'
import { ScheduleService } from './services/schedules'
import { SettingsService } from './services/settings'
import { ShellService } from './services/shell'
import { SkillService } from './services/skills'
import { WorkspaceService } from './services/workspace'
import { createMainWindow } from './window'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('dev.eNCode.ide')
    Menu.setApplicationMenu(null)

    if (app.isPackaged) {
      registerAppProtocol()
    } else if (!process.env.VITE_DEV_SERVER_URL) {
      // `electron .` after a production build
      registerAppProtocol()
    }

    const settings = new SettingsService()
    const workspace = new WorkspaceService()
    const models = new ModelsService(settings)
    const git = new GitService(workspace)
    const shell = new ShellService()

    const win = createMainWindow()
    mainWindow = win

    const send = (channel: string, payload: unknown) => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }

    const jobs = new JobService(shell, (list) => send('jobs:changed', list))
    const skills = new SkillService(() => workspace.current?.root ?? null)

    const agent = new AgentManager({
      settings,
      workspace,
      shell,
      jobs,
      skills,
      emit: (event) => send('agent:event', event),
    })

    const schedules = new ScheduleService(async (schedule) => {
      void agent.start(schedule.sessionId, { text: schedule.prompt, mode: 'code' }).catch(() => {
        /* session may have been removed */
      })
    })

    // Restore the most recently opened folder before the renderer asks for it.
    const last = settings.get().lastWorkspace
    if (last) {
      try {
        await workspace.open(last)
      } catch {
        settings.setLastWorkspace(null)
      }
    }

    workspace.setChangeHandler((paths) => send('workspace:file-changed', paths))

    win.on('maximize', () => send('window:state', { maximized: true }))
    win.on('unmaximize', () => send('window:state', { maximized: false }))
    win.on('closed', () => {
      shell.disposeAll()
      schedules.dispose()
      agent.dispose()
      mainWindow = null
    })

    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('[eNCode] renderer process gone:', details.reason)
    })

    registerIpc({
      getWindow: () => mainWindow,
      settings,
      workspace,
      shell,
      jobs,
      schedules,
      skills,
      models,
      git,
      agent,
    })

    if (process.env.ENCODE_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

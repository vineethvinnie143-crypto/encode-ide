import { app, BrowserWindow, Menu, protocol, safeStorage, shell as osShell } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { hostConfigOf } from './agent-host/config'
import { spawnAgentHost } from './agent-host/electron'
import { AgentHostService } from './agent-host/service'
import { applyNativeAppearance, followSystemTheme } from './appearance'
import { registerIpc } from './ipc'
import { registerAppProtocol } from './protocol'
import { GitService } from './services/git'
import { ModelsService } from './services/models'
import { ScheduleService } from './services/schedules'
import { SettingsService, serverOf } from './services/settings'
import { ShellService } from './services/shell'
import { SkillService, migrateLegacySkills } from './services/skills'
import { WorkspaceService } from './services/workspace'
import { createMainWindow } from './window'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

// End-to-end tests run against a throwaway profile. A packaged build always
// uses the real one. This must precede the lock, which lives in the profile.
const testProfile = app.isPackaged ? undefined : process.env.ENCODE_USER_DATA_DIR
if (testProfile) app.setPath('userData', path.resolve(testProfile))

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

    const userData = app.getPath('userData')
    const settings = new SettingsService(userData, safeStorage)
    const workspace = new WorkspaceService()
    const models = new ModelsService(settings)
    const git = new GitService(workspace)
    const shell = new ShellService()

    // The user's own folder (instructions, skills, agents) is shared with the command line.
    // A test run points it at a throwaway home; a packaged build never does.
    const home = (!app.isPackaged && process.env.ENCODE_HOME) || os.homedir()
    const userDir = path.join(home, '.encode')
    migrateLegacySkills(path.join(userData, 'skills'), path.join(userDir, 'skills'))
    const skills = new SkillService(() => workspace.current?.root ?? null, userDir, (dir) => osShell.openPath(dir))

    applyNativeAppearance(settings.get().appearance, null)
    const win = createMainWindow(settings.get().appearance)
    mainWindow = win
    followSystemTheme(() => mainWindow)

    const send = (channel: string, payload: unknown) => {
      const target = mainWindow
      if (target && !target.isDestroyed()) target.webContents.send(channel, payload)
    }

    // The agent runs in a utility process; this side hands it the settings it needs and the keys it asks for.
    const agentHost = new AgentHostService({
      spawn: () => spawnAgentHost(path.join(__dirname, 'agent-host.cjs'), (line) => console.error(`[agent-host] ${line}`)),
      init: () => ({
        dir: path.join(userData, 'sessions'),
        home,
        workspace: workspace.current?.root ?? null,
        legacySessionsFile: path.join(userData, 'eNCode-sessions.json'),
      }),
      // A key goes only to the server it was entered for: the host names the address it is about to call.
      apiKey: (profileId, baseUrl) => {
        const profile = settings.raw().profiles.find((candidate) => candidate.id === profileId)
        const server = serverOf(baseUrl)
        return profile && server && serverOf(profile.baseUrl) === server ? settings.keyFor(profileId) : ''
      },
      onEvent: (event) => send('agent:event', event),
      onJobs: (jobs) => send('jobs:changed', jobs),
    })
    const configureAgent = () => agentHost.configure(hostConfigOf(settings.get(), (profile) => models.contextWindow(profile)))
    configureAgent()

    const schedules = new ScheduleService(async (schedule) => {
      void agentHost.client.start(schedule.sessionId, { text: schedule.prompt, mode: 'code' }).catch(() => {
        /* the session may have been removed */
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

    // Start the host now rather than at the first request, so schedules and background work are ready.
    void agentHost.start().catch((error) => console.error('[agent-host] could not start:', error))

    win.on('maximize', () => send('window:state', { maximized: true }))
    win.on('unmaximize', () => send('window:state', { maximized: false }))
    win.on('closed', () => {
      shell.disposeAll()
      schedules.dispose()
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
      schedules,
      skills,
      models,
      git,
      agent: agentHost,
      configureAgent,
    })

    // Close the sessions and their commands before the process goes: the host is asked, then ended.
    let closing = false
    app.on('before-quit', (event) => {
      if (closing) return
      closing = true
      event.preventDefault()
      void agentHost.dispose().finally(() => app.quit())
    })

    if (process.env.ENCODE_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow(settings.get().appearance)
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

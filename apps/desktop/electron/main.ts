import { app, BrowserWindow, Menu, protocol, safeStorage, screen, shell as osShell } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { hostConfigOf } from './agent-host/config'
import { spawnAgentHost } from './agent-host/electron'
import { AgentHostService } from './agent-host/service'
import { applyNativeAppearance, followSystemTheme } from './appearance'
import { aboutInfo, currentEnvironment } from './build-info'
import { Banner, electronShortcuts } from './computer-overlay'
import { registerIpc } from './ipc'
import { registerAppProtocol } from './protocol'
import { ComputerControl } from './services/computer-control'
import { ComputerWatch } from './services/computer-watch'
import { diagnosticsReport } from './services/diagnostics'
import { GitService } from './services/git'
import { LogService } from './services/logs'
import { ModelsService } from './services/models'
import { redact } from './services/redact'
import { ScheduleService } from './services/schedules'
import { SettingsService, serverOf } from './services/settings'
import { ShellService } from './services/shell'
import { SkillService, migrateLegacySkills } from './services/skills'
import { WorkspaceService } from './services/workspace'
import { createMainWindow } from './window'
import { buildLine } from '../shared/about'

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
    // The user's own folder (instructions, skills, agents) is shared with the command line.
    // A test run points it at a throwaway home; a packaged build never does.
    const home = (!app.isPackaged && process.env.ENCODE_HOME) || os.homedir()
    const userDir = path.join(home, '.encode')

    const settings = new SettingsService(userData, safeStorage)

    // What this process prints is kept in userData/logs, without keys or the user's name, for a diagnostics report.
    // Decrypting the keys is not free, so the list the log scrubs against is read again every few seconds only.
    let secrets: string[] = []
    let secretsAt = 0
    const knownKeys = (): string[] => {
      if (Date.now() - secretsAt > 5_000) {
        secrets = settings.secrets()
        secretsAt = Date.now()
      }
      return secrets
    }
    const logs = new LogService(path.join(userData, 'logs'), { redact: (text) => redact(text, { home, secrets: knownKeys() }) })
    logs.captureConsole()
    process.on('uncaughtExceptionMonitor', (error) => console.error('[eNCode] uncaught exception:', error))
    process.on('unhandledRejection', (reason) => console.error('[eNCode] unhandled rejection:', reason))
    app.on('child-process-gone', (_event, details) => console.error(`[eNCode] a ${details.type} process is gone: ${details.reason} (code ${details.exitCode})`))
    const about = aboutInfo(currentEnvironment(app.isPackaged))
    console.info(`[eNCode] ${buildLine(about)} on ${about.os} ${about.arch}`)

    const workspace = new WorkspaceService()
    const models = new ModelsService(settings)
    const git = new GitService(workspace)
    const shell = new ShellService()

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

    // While the agent uses the computer the person sees a banner with a Stop button, and Ctrl+Alt+Esc stops it from any window.
    const banner = new Banner({
      // On the screen the pointer is on: that is where the person is looking, and where the agent works.
      display: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
      onStop: () => computerControl.stop(),
      log: (message) => console.warn(`[computer] ${message}`),
    })
    const computerControl = new ComputerControl({
      overlay: banner,
      shortcuts: electronShortcuts,
      cancel: (sessionId) => agentHost.client.cancel(sessionId),
      log: (message) => console.warn(`[computer] ${message}`),
    })
    const computerWatch = new ComputerWatch((activity) => computerControl.setActivity(activity))
    // Only while the setting offers the tool: a model that invents a Computer call without it has touched nothing.
    let computerOn = false

    // The agent runs in a utility process; this side hands it the settings it needs and the keys it asks for.
    const agentHost = new AgentHostService({
      spawn: () => spawnAgentHost(path.join(__dirname, 'agent-host.cjs'), (line) => console.error(`[agent-host] ${line}`)),
      init: () => ({
        dir: path.join(userData, 'sessions'),
        home,
        workspace: workspace.current?.root ?? null,
        legacySessionsFile: path.join(userData, 'eNCode-sessions.json'),
        routerStateFile: path.join(userData, 'eNCode-models.json'),
        checkpointsDir: path.join(userData, 'checkpoints'),
      }),
      // A key goes only to the server it was entered for: the host names the address it is about to call.
      apiKey: (profileId, baseUrl) => {
        const profile = settings.raw().profiles.find((candidate) => candidate.id === profileId)
        const server = serverOf(baseUrl)
        return profile && server && serverOf(profile.baseUrl) === server ? settings.keyFor(profileId) : ''
      },
      onEvent: (event) => {
        send('agent:event', event)
        if (computerOn) computerWatch.see(event)
      },
      onJobs: (jobs) => send('jobs:changed', jobs),
      onAlert: (alert) => send('models:alert', alert),
      onMcp: () => send('mcp:changed', undefined),
    })
    const configureAgent = () => {
      const current = settings.get()
      computerOn = current.computer && current.computerSupported
      if (!computerOn) computerWatch.reset()
      agentHost.configure(hostConfigOf(current, (profileId) => settings.keyRevision(profileId)))
    }
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
      // The banner is a window too; left up, it would keep eNCode from quitting.
      computerControl.dispose()
      mainWindow = null
    })

    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('[eNCode] renderer process gone:', details.reason)
    })

    const diagnostics = async (): Promise<string> => {
      const sessions = await agentHost.client.sessions().catch(() => null)
      const cpus = os.cpus()
      const primary = screen.getPrimaryDisplay().id
      return diagnosticsReport({
        about,
        generatedAt: Date.now(),
        system: {
          totalMemory: os.totalmem(),
          freeMemory: os.freemem(),
          cpuCount: cpus.length,
          cpuModel: cpus[0]?.model.trim() ?? 'unknown',
          locale: app.getLocale(),
          displays: screen.getAllDisplays().map((display) => ({ width: display.size.width, height: display.size.height, scale: display.scaleFactor, primary: display.id === primary })),
        },
        settings: settings.get(),
        agentHost: agentHost.health(),
        sessions: sessions ? { total: sessions.length, archived: sessions.filter((session) => session.archived).length } : null,
        workspaceOpen: workspace.current !== null,
        environment: Object.keys(process.env).filter((name) => name.startsWith('ENCODE_')).sort(),
        logLines: logs.tail(400),
        logDir: logs.dir,
        // Read fresh: a report is the one place a key must never appear.
        redact: { home, secrets: settings.secrets() },
      })
    }

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
      logs,
      diagnostics,
      onSessionRemoved: (sessionId) => computerWatch.forget(sessionId),
    })

    // Close the sessions and their commands before the process goes: the host is asked, then ended.
    let closing = false
    app.on('before-quit', (event) => {
      if (closing) return
      closing = true
      event.preventDefault()
      computerControl.dispose()
      banner.dispose()
      void agentHost.dispose().finally(() => {
        logs.flush()
        app.quit()
      })
    })
    app.on('will-quit', () => logs.flush())

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

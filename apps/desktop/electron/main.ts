import { app, BrowserWindow, Menu, Notification, powerSaveBlocker, protocol, safeStorage, screen, shell as osShell } from 'electron'
import { appendFileSync } from 'node:fs'
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
import { Attention, type Notice } from './services/attention'
import { ComputerControl } from './services/computer-control'
import { ComputerWatch } from './services/computer-watch'
import { diagnosticsReport } from './services/diagnostics'
import { GitService } from './services/git'
import { LogService } from './services/logs'
import { ModelsService } from './services/models'
import { isFile, searchPath } from './services/programs'
import { redact } from './services/redact'
import { ReviewService } from './services/review'
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

    // Chats work in the eNCode folder in Documents unless the person chooses another; a test run keeps it in its home.
    const documents = !app.isPackaged && process.env.ENCODE_HOME ? path.join(home, 'Documents') : app.getPath('documents')
    const settings = new SettingsService(userData, safeStorage, process.platform, { chatsFolder: path.join(documents, 'eNCode'), home })

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

    // Notices, the taskbar button and sleep follow what the agents do (services/attention.ts). A test run writes the
    // notices to a file instead of showing them; a packaged build never does.
    const noticeLog = app.isPackaged ? undefined : process.env.ENCODE_NOTICES_FILE
    const shownNotices = new Set<Notification>()
    let sleepBlocker: number | null = null
    const showNotice = (notice: Notice) => {
      if (noticeLog) {
        appendFileSync(noticeLog, `${JSON.stringify(notice)}\n`)
        return
      }
      if (!Notification.isSupported()) return
      const shown = new Notification({ title: notice.title, body: notice.body })
      // Held until Windows closes it, so a click still reaches the handler; at most a few at a time.
      shownNotices.add(shown)
      if (shownNotices.size > 20) {
        const oldest = shownNotices.values().next().value
        if (oldest) {
          shownNotices.delete(oldest)
          oldest.close()
        }
      }
      shown.on('click', () => {
        const target = mainWindow
        if (target && !target.isDestroyed()) {
          if (target.isMinimized()) target.restore()
          target.focus()
        }
        if (notice.sessionId) send('app:open-session', notice.sessionId)
      })
      shown.on('close', () => shownNotices.delete(shown))
      shown.show()
    }
    const attention = new Attention(() => settings.raw(), {
      focused: () => {
        const target = mainWindow
        return Boolean(target && !target.isDestroyed() && target.isFocused() && !target.isMinimized())
      },
      titleOf: async (sessionId) => (await agentHost.client.sessions().catch(() => [])).find((session) => session.id === sessionId)?.title,
      notify: showNotice,
      flash: (on) => {
        const target = mainWindow
        if (target && !target.isDestroyed()) target.flashFrame(on)
      },
      keepAwake: (on) => {
        if (on && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension')
        else if (!on && sleepBlocker !== null) {
          powerSaveBlocker.stop(sleepBlocker)
          sleepBlocker = null
        }
      },
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
    })
    win.on('focus', () => attention.focusChanged(true))
    win.on('blur', () => attention.focusChanged(false))

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
        sandboxDir: path.join(userData, 'sandbox'),
      }),
      // A key goes only to the server it was entered for: the host names the address it is about to call.
      apiKey: (profileId, baseUrl) => {
        const profile = settings.raw().profiles.find((candidate) => candidate.id === profileId)
        const server = serverOf(baseUrl)
        return profile && server && serverOf(profile.baseUrl) === server ? settings.keyFor(profileId) : ''
      },
      // A search key has no address to check: where a search goes is fixed in the code, not a setting.
      searchKey: (provider) => settings.searchKeyFor(provider),
      onEvent: (event) => {
        send('agent:event', event)
        attention.see(event)
        if (computerOn) computerWatch.see(event)
      },
      onJobs: (jobs) => send('jobs:changed', jobs),
      onAlert: (alert) => send('models:alert', alert),
      onMcp: () => send('mcp:changed', undefined),
      onSandbox: () => send('sandbox:changed', undefined),
    })
    const configureAgent = () => {
      const current = settings.get()
      computerOn = current.computer && current.computerSupported
      if (!computerOn) computerWatch.reset()
      agentHost.configure(hostConfigOf(current, (profileId) => settings.keyRevision(profileId)))
      attention.settingsChanged()
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

    // The Review tab: the open folder's repository, by git found on PATH. A reverted file git does not track goes to the
    // Recycle Bin, and a commit message is drafted by the agent host's Small tasks model.
    let reviewGit: string | null = null
    const review = new ReviewService({
      folder: () => workspace.current?.root ?? null,
      git: () => {
        if (!reviewGit || !isFile(reviewGit)) reviewGit = searchPath('git', process.env)
        return reviewGit
      },
      trash: (file) => osShell.trashItem(file),
      draft: (input) => agentHost.draftCommit(input),
      reviewCode: (input) => agentHost.codeReview(input),
      // The Turn view reads the agent's record of a request's changes, and writes through it.
      turns: {
        changes: (sessionId, turn) => agentHost.client.turnChanges(sessionId, turn),
        write: (sessionId, write) => agentHost.client.turnWrite(sessionId, write),
      },
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
      review,
      agent: agentHost,
      configureAgent,
      logs,
      diagnostics,
      testNotice: () => attention.test(),
      onSessionRemoved: (sessionId) => {
        computerWatch.forget(sessionId)
        attention.forget(sessionId)
      },
    })

    // Close the sessions and their commands before the process goes: the host is asked, then ended.
    let closing = false
    app.on('before-quit', (event) => {
      if (closing) return
      closing = true
      event.preventDefault()
      attention.dispose()
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

/**
 * The updater's Electron side (ADR 0127): what kind of copy this is, where downloads wait, Chromium's network for the
 * fetches, and starting the installer as eNCode closes. The rules are in services/updates.ts.
 */
import { app, net, shell } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { UpdateStatus } from '../shared/types'
import { feedFromEnv, isTestFeed, releasePage, Updater, type UpdaterOptions } from './services/updates'

export interface UpdaterWiring {
  own: { build: number; channel: string }
  userData: string
  busy(): boolean
  autoCheck(): boolean
  onStatus(status: UpdateStatus): void
}

export interface AppUpdater {
  updater: Updater
  /** A build's release page in the browser: the one named, or the newer build's. */
  openPage(build?: unknown): Promise<void>
}

/**
 * How this copy came to be here: the installer leaves its uninstaller beside the program, the portable program names
 * itself in PORTABLE_EXECUTABLE_FILE, and anything else (the sources, an unpacked folder) does not update itself.
 */
function kindOf(): UpdaterOptions['kind'] {
  if (!app.isPackaged) return 'unpacked'
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'portable'
  return existsSync(path.join(path.dirname(process.execPath), 'Uninstall eNCode.exe')) ? 'installed' : 'unpacked'
}

/**
 * Test hooks, none of which can send the updater to another server (services/updates.ts feedFromEnv):
 * - ENCODE_UPDATE_FEED: "off", or a feed on this computer (CI's installer round trip, the smoke).
 * - ENCODE_UPDATE_AS_BUILD: with a feed on this computer only, the build number this copy goes by, so the round trip
 *   updates the build it installed to itself and sees it take. Not passed on to the installer or the next start.
 * - ENCODE_UPDATE_LAUNCH_LOG: from the sources only, a file the restart is written to instead of quitting and running
 *   the installer, so the smoke sees it without losing the app.
 */
export function createUpdater(wiring: UpdaterWiring): AppUpdater {
  const feed = feedFromEnv(process.env.ENCODE_UPDATE_FEED)
  const test = isTestFeed(feed)
  const pretend = Number(process.env.ENCODE_UPDATE_AS_BUILD)
  const own = test && Number.isSafeInteger(pretend) && pretend > 0 ? { build: pretend, channel: 'tester' } : wiring.own
  const launchLog = app.isPackaged ? undefined : process.env.ENCODE_UPDATE_LAUNCH_LOG
  const kind = launchLog ? 'installed' : kindOf()
  // A test run keeps its download in its throwaway profile; an installed program in its own folder of the local
  // (not roaming) profile, as other Windows programs keep theirs.
  const dir = app.isPackaged ? path.join(process.env.LOCALAPPDATA || app.getPath('temp'), 'eNCode-updates') : path.join(wiring.userData, 'updates')
  let next = 0

  const updater = new Updater(
    {
      own,
      kind,
      installDir: path.dirname(process.execPath),
      dir,
      recordFile: path.join(wiring.userData, 'eNCode-update.json'),
      feed,
    },
    {
      fetch: (url, signal) => net.fetch(url, { signal, cache: 'no-store' }),
      restartInto: (installer, args) => {
        if (launchLog) {
          appendFileSync(launchLog, `${JSON.stringify({ installer, args })}\n`)
          return
        }
        const env = { ...process.env }
        delete env.ENCODE_UPDATE_AS_BUILD
        delete env.ELECTRON_RUN_AS_NODE
        // As eNCode's last act, after the agents and their commands have been closed: the installer waits a moment for
        // the program to be gone, replaces it, and starts the new one.
        app.once('will-quit', () => {
          try {
            // NSIS reads its folder from the end of the line unquoted, so nothing is quoted but the program's own name.
            const child = spawn(installer, args, { detached: true, stdio: 'ignore', env, windowsVerbatimArguments: true, argv0: `"${installer}"` })
            child.on('error', (error) => console.error('[updates] the installer did not start:', error.message))
            child.unref()
          } catch (error) {
            console.error('[updates] the installer did not start:', (error as Error).message)
          }
        })
        app.quit()
      },
      busy: wiring.busy,
      autoCheck: wiring.autoCheck,
      now: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
      onStatus: (status) => {
        if ('next' in status) next = status.next.build
        wiring.onStatus(status)
      },
      log: (line) => console.info(line),
    },
  )

  return {
    updater,
    openPage: async (named) => {
      const status = updater.status()
      const build = typeof named === 'number' && Number.isSafeInteger(named) && named > 0 ? named : 'next' in status ? status.next.build : next
      if (!build) return
      if (launchLog) {
        appendFileSync(launchLog, `${JSON.stringify({ page: releasePage(build) })}\n`)
        return
      }
      await shell.openExternal(releasePage(build))
    },
  }
}

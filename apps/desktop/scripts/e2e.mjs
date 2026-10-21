/**
 * Runs the end-to-end smoke (scripts/smoke.mjs) against the built app, in a
 * throwaway sandbox:
 *
 *   pnpm build && pnpm e2e
 *
 * The demo fixture is copied to a temporary workspace and eNCode gets a
 * temporary profile (ENCODE_USER_DATA_DIR), so neither the repository nor the
 * real profile is touched. Electron listens for DevTools on a free local port,
 * and its whole process tree is stopped afterwards. Screenshots and the
 * Electron log land in ./screenshots.
 *
 * ENCODE_SMOKE_OFFLINE=1 skips the one check that needs the internet (the
 * live OpenRouter catalog). CI sets it.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shotsDir = path.join(root, 'screenshots')
const isWindows = process.platform === 'win32'

function fail(message) {
  console.error(`[e2e] ${message}`)
  process.exit(1)
}

for (const built of ['dist/electron/main.cjs', 'dist/electron/preload.cjs', 'dist/renderer/index.html']) {
  if (!fs.existsSync(path.join(root, built))) fail(`${built} is missing. Run pnpm build first.`)
}

// Resolving the package downloads Electron's binary on first use (checksum-verified).
const electron = createRequire(path.join(root, 'package.json'))('electron')

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

// The long form of the temp folder: Windows hands out 8.3 names such as RUNNER~1.
const sandbox = fs.mkdtempSync(path.join(fs.realpathSync.native(process.env.RUNNER_TEMP || os.tmpdir()), 'encode-e2e-'))
const workspace = path.join(sandbox, 'demo-project')
const profile = path.join(sandbox, 'profile')
fs.cpSync(path.join(root, 'test', 'fixtures', 'demo-project'), workspace, { recursive: true })
fs.mkdirSync(profile)
fs.rmSync(shotsDir, { recursive: true, force: true })
fs.mkdirSync(shotsDir, { recursive: true })

const [debugPort, providerPort] = await Promise.all([freePort(), freePort()])
const env = {
  ...process.env,
  ENCODE_USER_DATA_DIR: profile,
  ENCODE_DEBUG_PORT: String(debugPort),
  ENCODE_FAKE_PROVIDER_PORT: String(providerPort),
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
}
delete env.VITE_DEV_SERVER_URL
delete env.ELECTRON_RUN_AS_NODE

let command = electron
let args = ['.', `--remote-debugging-port=${debugPort}`]
if (process.platform === 'linux') {
  // Chromium refuses to start its sandbox as root (containers); everyone else keeps it.
  if (process.getuid?.() === 0) args.push('--no-sandbox')
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    if (spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).error) fail('No display. Install xvfb (xvfb-run) or run under a desktop session.')
    args = ['-a', '-s', '-screen 0 1600x1000x24', command, ...args]
    command = 'xvfb-run'
  }
}

const log = fs.openSync(path.join(shotsDir, 'electron.log'), 'w')
const app = spawn(command, args, {
  cwd: root,
  env,
  stdio: ['ignore', log, log],
  // Its own process group on POSIX, so the tree can be stopped as a whole.
  detached: !isWindows,
})
let appExited = false
app.on('exit', () => {
  appExited = true
})

function stopApp() {
  if (appExited || app.pid === undefined) return
  try {
    if (isWindows) spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-app.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

let cleanedUp = false
function cleanUp() {
  if (cleanedUp) return
  cleanedUp = true
  stopApp()
  fs.closeSync(log)
  try {
    // Electron can hold files under the profile for a moment after it dies on Windows.
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (error) {
    console.warn(`[e2e] could not remove ${sandbox}: ${error.message}`)
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanUp()
    process.exit(130)
  })
}

console.log(`[e2e] workspace ${workspace}`)
const smoke = spawnSync(process.execPath, [path.join(root, 'scripts', 'smoke.mjs'), workspace], {
  cwd: root,
  env,
  stdio: 'inherit',
  timeout: 15 * 60_000,
})
cleanUp()

if (smoke.error || smoke.status !== 0) {
  const tail = fs.readFileSync(path.join(shotsDir, 'electron.log'), 'utf8').split('\n').slice(-40).join('\n')
  console.error(`[e2e] electron.log, last lines:\n${tail}`)
  fail(`FAILED: ${smoke.error ? smoke.error.message : `exit code ${smoke.status}`}. Screenshots and electron.log are in ${shotsDir}`)
}
console.log('[e2e] PASS')

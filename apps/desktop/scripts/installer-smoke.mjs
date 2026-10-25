/**
 * Installs the Windows installer silently, starts the installed program with packaged-smoke.mjs, updates it
 * the way a tester's Restart to update does, and uninstalls it again, checking what a tester sees: the program
 * in the folder, a Start menu shortcut while it is installed and none after, and the user's own data left alone.
 *
 *   pnpm package && node scripts/installer-smoke.mjs
 *
 * Windows and CI only, like packaged-smoke.mjs: the program uses the real profile.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, sleep } from './cdp.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = path.join(root, 'release')

function fail(message) {
  console.error(`[installer] ${message}`)
  process.exit(1)
}

if (process.platform !== 'win32') fail('The installer is for Windows.')
if (!process.env.CI) fail('This installs and removes a program and runs it on the real profile. Run it in CI.')

const setup = fs.readdirSync(release).find((name) => /-setup\.exe$/.test(name))
if (!setup) fail(`No *-setup.exe in ${release}. Run pnpm package first.`)

// A folder without spaces: the installer reads its target from the end of the command line, unquoted.
const target = path.join(fs.realpathSync.native(process.env.RUNNER_TEMP || os.tmpdir()), 'encode-installed')
const shortcut = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'eNCode.lnk')
fs.rmSync(target, { recursive: true, force: true })

console.log(`[installer] installing ${setup} into ${target}`)
const install = spawnSync(path.join(release, setup), ['/S', `/D=${target}`], { stdio: 'inherit', timeout: 5 * 60_000 })
if (install.error || install.status !== 0) fail(`the installer failed: ${install.error?.message ?? `exit code ${install.status}`}`)

const exe = path.join(target, 'eNCode.exe')
if (!fs.existsSync(exe)) fail(`the installer did not put eNCode.exe in ${target}`)
if (!fs.existsSync(shortcut)) fail(`the installer made no Start menu shortcut (${shortcut})`)
console.log('[installer] installed, with a Start menu shortcut')

const smoke = spawnSync(process.execPath, [path.join(root, 'scripts', 'packaged-smoke.mjs'), exe], { stdio: 'inherit', timeout: 5 * 60_000 })

/**
 * The update round trip (ADR 0127). The installed program goes by the build before its own, and its release is served
 * from this computer: the same installer, named as its own build with its SHA-256. It finds the build, downloads it and
 * checks the fingerprint, and restarts into it as a person's Restart to update does. The installer runs silently over
 * the installed copy and starts it again, and the program that starts says it updated.
 */
async function updateRoundTrip() {
  const build = Number(process.env.ENCODE_BUILD)
  if (!Number.isSafeInteger(build) || build < 2) {
    console.log('[installer] no ENCODE_BUILD, so no update round trip')
    return
  }
  const setupPath = path.join(release, setup)
  const bytes = fs.readFileSync(setupPath)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const manifest = {
    schema: 1,
    channel: 'tester',
    version: pkg.version,
    build,
    commit: /^[0-9a-f]{40}$/i.test(process.env.ENCODE_COMMIT ?? '') ? process.env.ENCODE_COMMIT.toLowerCase() : '0'.repeat(40),
    publishedAt: new Date().toISOString(),
    notes: ['The installer round trip in CI'],
    installer: { name: setup, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  }
  const server = http.createServer((request, response) => {
    if (request.url === '/encode-update.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(manifest))
    } else if (request.url === `/download/build-${build}/${encodeURIComponent(setup)}`) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length })
      response.end(bytes)
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address()
      probe.close(() => resolve(free))
    })
  })

  const userData = path.join(process.env.APPDATA ?? '', 'eNCode')
  const recordFile = path.join(userData, 'eNCode-update.json')
  const logFile = path.join(userData, 'logs', 'eNCode.log')
  const downloads = path.join(process.env.LOCALAPPDATA ?? '', 'eNCode-updates')
  fs.rmSync(recordFile, { force: true })
  const logStart = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0
  const readLog = () => {
    try {
      return fs.readFileSync(logFile, 'utf8').slice(logStart)
    } catch {
      return ''
    }
  }

  const env = { ...process.env, ENCODE_UPDATE_FEED: `http://127.0.0.1:${server.address().port}/encode-update.json`, ENCODE_UPDATE_AS_BUILD: String(build - 1) }
  delete env.ELECTRON_RUN_AS_NODE
  const shots = path.join(root, 'screenshots')
  fs.mkdirSync(shots, { recursive: true })
  const out = fs.openSync(path.join(shots, 'update-round-trip.log'), 'w')
  const app = spawn(exe, [`--remote-debugging-port=${port}`], { env, stdio: ['ignore', out, out] })
  let exited = false
  app.on('exit', () => {
    exited = true
  })
  let page
  try {
    page = await connect(port)
    await page.waitFor("typeof window.eNCode === 'object' && window.eNCode !== null", 60000, 'the bridge to the program')
    const before = await page.evaluate('window.eNCode.updates.status()')
    if (before.build !== build - 1 || before.state === 'off') throw new Error(`the installed program's updater is not on as build ${build - 1}: ${JSON.stringify(before)}`)
    const found = await page.evaluate('window.eNCode.updates.check()')
    if (found.state !== 'ready' || found.next?.build !== build) throw new Error(`the program did not download build ${build}: ${JSON.stringify(found)}`)
    console.log(`[installer] the program, as build ${build - 1}, found build ${build}, downloaded it and checked its fingerprint`)

    // As Restart to update: the program closes, and the installer replaces it and starts it again.
    void page.evaluate('window.eNCode.updates.install()').catch(() => undefined)
    for (const until = Date.now() + 60_000; !exited && Date.now() < until; ) await sleep(250)
    if (!exited) throw new Error('the program did not close to update')
    console.log('[installer] the program closed to update')

    let said = ''
    for (const until = Date.now() + 5 * 60_000; Date.now() < until; ) {
      said = (/\[updates\] (updated from build \d+ to build \d+|the update to build \d+ did not install[^\n]*)/.exec(readLog()) ?? [])[1] ?? ''
      if (said) break
      await sleep(1000)
    }
    if (said !== `updated from build ${build - 1} to build ${build}`) {
      throw new Error(`the program the installer started did not say it updated (${said || 'nothing'}); log since the round trip began:\n${readLog().split('\n').slice(-30).join('\n')}`)
    }
    if (!fs.existsSync(exe)) throw new Error(`the update left no eNCode.exe in ${target}`)
    if (!fs.existsSync(shortcut)) throw new Error('the update took the Start menu shortcut away')
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    if (record.attempt || record.failed?.length) throw new Error(`the record of the update: ${JSON.stringify(record)}`)
    // The installer holds its own file until it exits, a moment after it starts the program; then the program deletes it.
    const kept = () => (fs.existsSync(downloads) ? fs.readdirSync(downloads) : [])
    for (const until = Date.now() + 2 * 60_000; kept().length && Date.now() < until; ) await sleep(1000)
    if (kept().length) throw new Error(`the download is still kept two minutes after the update: ${kept().join(', ')}`)
    console.log(`[installer] the installer ran silently over the installed copy and started it again, and it says: ${said}`)
  } finally {
    page?.ws.close()
    // The program the installer started, which no one here has a handle on.
    spawnSync('taskkill', ['/im', 'eNCode.exe', '/t', '/f'], { stdio: 'ignore' })
    if (!exited) app.kill()
    server.close()
    fs.closeSync(out)
    await sleep(1000)
  }
}

let roundTrip = null
if (smoke.status === 0 && !smoke.error) {
  try {
    await updateRoundTrip()
  } catch (error) {
    roundTrip = error
  }
}

// The uninstaller copies itself aside and returns at once unless it is told to stay where it is.
const uninstaller = path.join(target, 'Uninstall eNCode.exe')
console.log('[installer] uninstalling')
const uninstall = fs.existsSync(uninstaller) ? spawnSync(uninstaller, ['/S', `_?=${target}`], { stdio: 'inherit', timeout: 5 * 60_000 }) : undefined
fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })

if (smoke.error || smoke.status !== 0) fail('the installed program did not pass the packaged smoke')
if (roundTrip) fail(`the update round trip failed: ${roundTrip.message}`)
if (!uninstall || uninstall.error || uninstall.status !== 0) fail(`the uninstaller failed: ${uninstall?.error?.message ?? `exit code ${uninstall?.status}`}`)
if (fs.existsSync(shortcut)) fail('the Start menu shortcut is still there after uninstalling')
console.log('[installer] PASS')

/**
 * Starts the packaged app the way a tester starts it and checks that it comes up: the window shows the
 * interface, About names this build, and the agent process answers a message.
 *
 *   pnpm package            (electron-builder, into release/)
 *   node scripts/packaged-smoke.mjs [path-to-the-program]
 *
 * With no argument it runs release/win-unpacked/eNCode.exe. A packaged build always uses the real profile,
 * never a throwaway one, so this refuses to run outside CI unless ENCODE_PACKAGED_SMOKE_ANYWAY=1.
 *
 * What it covers that scripts/smoke.mjs does not: the files inside the package (the asar), the app:// page
 * served from it, the agent process started from it, and the stamp the build carries.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, sleep } from './cdp.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const exe = path.resolve(process.argv[2] ?? path.join(root, 'release', 'win-unpacked', 'eNCode.exe'))
const shotsDir = path.join(root, 'screenshots')

function fail(message) {
  console.error(`[packaged] ${message}`)
  process.exit(1)
}

if (!process.env.CI && process.env.ENCODE_PACKAGED_SMOKE_ANYWAY !== '1') {
  fail('A packaged build uses the real profile. Run this in CI, or set ENCODE_PACKAGED_SMOKE_ANYWAY=1 to use yours.')
}
if (!fs.existsSync(exe)) fail(`${exe} is missing. Run pnpm package first.`)
// Test this model (ADR 0101) runs the benchmark's tasks, shipped beside the program; the portable one unpacks them when it starts.
const resources = path.join(path.dirname(exe), 'resources')
if (fs.existsSync(resources) && !fs.existsSync(path.join(resources, 'bench-tasks', 'fix-failing-test', 'task.json'))) fail(`The benchmark's tasks are missing from ${resources}`)

const port = await new Promise((resolve, reject) => {
  const server = net.createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port: free } = server.address()
    server.close(() => resolve(free))
  })
})

fs.mkdirSync(shotsDir, { recursive: true })
const log = fs.openSync(path.join(shotsDir, 'packaged.log'), 'w')

let command = exe
let args = [`--remote-debugging-port=${port}`]
if (process.platform === 'linux') {
  if (process.getuid?.() === 0) args.push('--no-sandbox')
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    args = ['-a', '-s', '-screen 0 1600x1000x24', command, ...args]
    command = 'xvfb-run'
  }
}

const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
delete env.ELECTRON_RUN_AS_NODE
delete env.VITE_DEV_SERVER_URL

// Language servers eNCode installs from npm run on the program itself as Node.js (ADR 0083): check the program still can,
// talking over stdin and stdout as a server does. The portable program is a launcher; the one it unpacks is checked here.
if (path.basename(exe).toLowerCase() === 'encode.exe' || !isWindows) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-as-node-'))
  const script = path.join(scratch, 'echo.cjs')
  fs.writeFileSync(script, "process.stdin.once('data', (chunk) => { process.stdout.write(JSON.stringify({ node: process.versions.node, got: String(chunk).trim() })); process.exit(0) })\n")
  const ran = spawnSync(exe, [script], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, input: 'ping\n', encoding: 'utf8', timeout: 30000, windowsHide: true })
  fs.rmSync(scratch, { recursive: true, force: true })
  let answer = null
  try {
    answer = JSON.parse(ran.stdout)
  } catch {
    // Reported below.
  }
  if (!answer || answer.got !== 'ping' || !/^\d+\.\d+\.\d+$/.test(answer.node)) {
    fail(`the program does not run as Node.js, which installed language servers need (exit ${ran.status}, ${JSON.stringify(`${ran.stdout ?? ''}${ran.stderr ?? ''}`).slice(0, 400)})`)
  }
  console.log(`[packaged] runs as Node.js ${answer.node}`)
}

// The command line (ADR 0108): bin/encode.cmd beside the program runs the CLI bundle in the asar. It answers its
// version, and a print-mode request on the offline demo agent, which nobody is there to approve.
const launcher = path.join(path.dirname(exe), 'bin', 'encode.cmd')
if (isWindows && path.basename(exe).toLowerCase() === 'encode.exe') {
  if (!fs.existsSync(launcher)) fail(`${launcher} is missing`)
  // As a person types it at a prompt: cmd.exe's /s takes the quoted line as it is.
  const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)
  const cli = (args, cwd) =>
    spawnSync('cmd.exe', ['/d', '/s', '/c', `"${[launcher, ...args].map(quote).join(' ')}"`], { cwd, env, encoding: 'utf8', timeout: 120000, windowsHide: true, windowsVerbatimArguments: true })
  const version = cli(['--version'])
  const pkg = JSON.parse(fs.readFileSync(path.join(root, '..', 'cli', 'package.json'), 'utf8'))
  // The version, then the build's channel and commit, as the About box says them; CI names the commit it built.
  const named = (process.env.ENCODE_COMMIT ?? '').toLowerCase().slice(0, 7)
  const versionOk = new RegExp(`^eNCode ${pkg.version.replace(/\./g, '\\.')} [a-z]+, commit ${named || '[0-9a-f]{7}'}$`).test(version.stdout.trim())
  if (version.status !== 0 || !versionOk) fail(`encode --version: exit ${version.status}, ${JSON.stringify(`${version.stdout}${version.stderr}`).slice(0, 400)}`)
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-cli-'))
  fs.writeFileSync(path.join(project, 'a.txt'), 'hello\n')
  const demo = cli(['-p', '--model', 'demo', '--output-format', 'json', 'look around'], project)
  fs.rmSync(project, { recursive: true, force: true })
  let result = null
  try {
    result = JSON.parse(demo.stdout)
  } catch {
    // Reported below.
  }
  if (demo.status !== 0 || result?.type !== 'result' || result.ok !== true || !result.result) {
    fail(`encode -p on the demo agent: exit ${demo.status}, ${JSON.stringify(`${demo.stdout}${demo.stderr}`).slice(0, 600)}`)
  }
  console.log(`[packaged] the command line answers (${version.stdout.trim()}, ${result.usage.calls} demo calls)`)
}

const app = spawn(command, args, { env, stdio: ['ignore', log, log], detached: !isWindows })
let exited = false
app.on('exit', () => {
  exited = true
})

function stopApp() {
  if (exited || app.pid === undefined) return
  try {
    if (isWindows) spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-app.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopApp()
    process.exit(130)
  })
}

let page
try {
  page = await connect(port)
  const { evaluate, waitFor, send, errors } = page
  console.log('[packaged] page:', page.target.url)
  if (!page.target.url.startsWith('app://')) throw new Error(`the window shows ${page.target.url}, not the bundled interface`)

  // A slow start (the portable program unpacks itself first) lists the page before its bridge exists.
  await waitFor("typeof window.eNCode === 'object' && window.eNCode !== null", 60000, 'the bridge to the program')
  const about = await evaluate('window.eNCode.app.about()')
  console.log('[packaged] build:', JSON.stringify(about))
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (!about.packaged) throw new Error('the app does not know it is packaged')
  if (about.version !== pkg.version) throw new Error(`About says ${about.version}, package.json says ${pkg.version}`)
  if (!/^[0-9a-f]{40}$/.test(about.commit)) throw new Error(`the build carries no commit (${JSON.stringify(about.commit)})`)
  if (process.env.ENCODE_COMMIT && about.commit !== process.env.ENCODE_COMMIT.toLowerCase()) {
    throw new Error(`the build is from ${about.commit}, CI named ${process.env.ENCODE_COMMIT}`)
  }
  if (process.env.ENCODE_CHANNEL && about.channel !== process.env.ENCODE_CHANNEL) throw new Error(`the build says ${about.channel}, CI named ${process.env.ENCODE_CHANNEL}`)
  if (process.env.ENCODE_BUILD && about.build !== Number(process.env.ENCODE_BUILD)) throw new Error(`the build says it is build ${about.build}, CI named ${process.env.ENCODE_BUILD}`)
  // CI turns the updater off for this run (ENCODE_UPDATE_FEED=off), so a smoke never reaches GitHub; it says so.
  const updates = await evaluate('window.eNCode.updates.status()')
  if (process.env.ENCODE_UPDATE_FEED === 'off' && updates.state !== 'off') throw new Error(`the updater is ${updates.state} with its feed turned off`)

  await waitFor("!!document.querySelector('.titlebar') && !!document.querySelector('.icon-rail')", 30000, 'the interface')

  // The agent runs in a process of its own, started from inside the package, and works in an open folder.
  // The built-in demo model needs no key.
  const project = fs.mkdtempSync(path.join(fs.realpathSync.native(process.env.RUNNER_TEMP || os.tmpdir()), 'encode-packaged-'))
  fs.writeFileSync(path.join(project, 'hello.txt'), 'hello\n')
  await evaluate(`window.eNCode.workspace.openPath(${JSON.stringify(project)})`)
  const session = await evaluate('window.eNCode.agent.createSession({ projectRoot: null })')
  // The demo writes a note, which asks first: answer the card the way the Approve button does.
  await evaluate(`void window.eNCode.agent.start(${JSON.stringify(session.id)}, { text: 'hello', mode: 'code' })`)
  await waitFor(
    `(async () => {
      const history = await window.eNCode.agent.history(${JSON.stringify(session.id)})
      if (history.approval) await window.eNCode.agent.approve(history.approval.id, true)
      return history.entries.some((entry) => entry.kind === 'assistant' && /completes the offline demo/.test(entry.text ?? ''))
    })()`,
    60000,
    'the demo agent to finish',
  )
  await evaluate(`window.eNCode.agent.remove(${JSON.stringify(session.id)})`)
  await evaluate('window.eNCode.workspace.close()')
  // The program may still be letting go of the folder (a command or a status check ending); that is not what is tested here.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(project, { recursive: true, force: true })
      break
    } catch (error) {
      if (attempt >= 24) {
        console.warn(`[packaged] could not remove ${project} (${error.message}); leaving it`)
        break
      }
      await sleep(250)
    }
  }

  // The page holds no secret and no development hook.
  const exposed = await evaluate('Object.keys(window).filter((name) => /^(process|require|module|Buffer)$/.test(name))')
  if (exposed.length) throw new Error(`the page can see Node: ${exposed}`)

  await sleep(500)
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(shotsDir, 'packaged.png'), Buffer.from(data, 'base64'))

  if (errors.length) throw new Error(`renderer errors:\n${errors.join('\n---\n')}`)
  console.log('[packaged] PASS')
} catch (error) {
  console.error(`[packaged] FAILED: ${error.message}`)
  // What the page looked like when it failed: enough to tell a slow start from a broken bridge.
  const state = await page?.evaluate("JSON.stringify({ url: location.href, ready: document.readyState, bridge: typeof window.eNCode, body: document.body?.children.length })").catch(() => undefined)
  if (state) console.error(`[packaged] page state: ${state}`)
  const tail = fs.readFileSync(path.join(shotsDir, 'packaged.log'), 'utf8').split('\n').slice(-40).join('\n')
  console.error(`[packaged] log, last lines:\n${tail}`)
  process.exitCode = 1
} finally {
  page?.ws.close()
  stopApp()
  fs.closeSync(log)
  await sleep(300)
  process.exit(process.exitCode ?? 0)
}

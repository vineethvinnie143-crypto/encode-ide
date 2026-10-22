/**
 * A stand-in for the helper program, for tests of the client and the backend: a Node script that speaks the same
 * protocol (see client.ts) and answers with canned data, so the process handling, the framing and the checks
 * run for real while no Windows is needed. How it behaves is set by environment variables.
 *
 *   FAKE_LOG         file that gets every request it received, one JSON per line
 *   FAKE_PROTOCOL    protocol number in its hello (default 1)
 *   FAKE_MODE        "silent": never says hello; "deaf": ignores cancel
 *   FAKE_READY_FAILS how many `ready` requests fail with "unavailable" before one is answered
 *   FAKE_STATE       file that counts those failures
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const SCRIPT = String.raw`
import fs from 'node:fs'

const log = process.env.FAKE_LOG
const mode = process.env.FAKE_MODE || ''
const write = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const record = (message) => { if (log) fs.appendFileSync(log, JSON.stringify(message) + '\n') }

if (mode !== 'silent') write({ event: 'hello', protocol: Number(process.env.FAKE_PROTOCOL || 1), version: '1', pid: process.pid })

let first = 1
const waiting = new Map()
const box = [100, 100, 800, 600]
const windowOf = (n, app, title) => ({ id: 'w' + n, app, label: app, title, pid: 4000 + n, box, state: 'normal', foreground: n === first })
const windows = () => [windowOf(first, 'notepad.exe', 'Untitled - Notepad'), windowOf(first + 1, 'calc.exe', 'Calculator')]
const element = (n, role, name, extra) => Object.assign({ ref: 'e' + n, role, name, depth: 0, box: [120, 140 + n * 30, 100, 24], states: [], can: [] }, extra || {})
const look = (args) => ({
  window: windows()[0],
  related: [],
  capture: { id: 's1', box, width: 800, height: 600, scale: 1, mediaType: 'image/png', masked: 0, ...(args.image === true ? { data: 'AAAA' } : {}) },
  outline: args.outline === 'none' ? undefined : { elements: [element(1, 'button', 'Save', { can: ['invoke'] }), element(2, 'edit', 'Search box', { value: 'hello' }), element(3, 'button', 'Save as', { can: ['invoke'] }), element(4, 'text', 'Ready')], total: 4, focused: 'e2' },
  changed: true,
  stable: true,
})

function attempt() {
  if (!process.env.FAKE_STATE) return false
  const limit = Number(process.env.FAKE_READY_FAILS || 0)
  let count = 0
  try { count = Number(fs.readFileSync(process.env.FAKE_STATE, 'utf8')) } catch {}
  if (count >= limit) return false
  fs.writeFileSync(process.env.FAKE_STATE, String(count + 1))
  return true
}

function handle(message) {
  record(message)
  const { id, op, args } = message
  if (op === 'cancel') {
    const timer = waiting.get(id)
    if (!timer) return
    clearInterval(timer)
    waiting.delete(id)
    if (mode !== 'deaf') write({ id, ok: false, error: { code: 'interrupted', message: 'stopped' } })
    return
  }
  switch (op) {
    case 'echo': return write({ id, ok: true, result: args })
    case 'fail': return write({ id, ok: false, error: args })
    case 'slow': waiting.set(id, setInterval(() => {}, 1000)); return
    case 'crash': process.exit(3)
    case 'garbage':
      process.stdout.write('not json\n')
      process.stdout.write('[1,2]\n')
      process.stdout.write('{"id": 999, "ok": true}\n')
      return write({ id, ok: true, result: 'after garbage' })
    case 'split': {
      const bytes = Buffer.from(JSON.stringify({ id, ok: true, result: String.fromCodePoint(0x68, 0xe9, 0x6c, 0x6c, 0x6f, 0x20, 0x65e5, 0x672c, 0x8a9e) }) + '\n', 'utf8')
      const cut = bytes.indexOf(0xc3) + 1
      process.stdout.write(bytes.subarray(0, cut))
      setTimeout(() => process.stdout.write(bytes.subarray(cut)), 30)
      return
    }
    case 'ready':
      if (attempt()) return write({ id, ok: false, error: { code: 'unavailable', message: 'The screen is locked.' } })
      first = Number((args && args.firstWindow) || 1)
      return write({ id, ok: true, result: { platform: 'win32', version: '1', scale: 125, monitors: [[0, 0, 1920, 1080]], watching: true } })
    case 'windows': return write({ id, ok: true, result: windows() })
    case 'focus': return write({ id, ok: true, result: Object.assign(windows()[0], { foreground: true }) })
    case 'look': return write({ id, ok: true, result: look(args) })
    case 'act':
      return write({ id, ok: true, result: { performed: args.steps.map((step) => ({ kind: step.kind, via: step.kind === 'type' || step.kind === 'key' ? 'keys' : 'mouse' })), look: look(args.look), opened: [windowOf(first + 2, 'dialog.exe', 'Save')], closed: [], cursor: [220, 330] } })
    case 'cursor': return write({ id, ok: true, result: [10, 20] })
    case 'bad-look': return write({ id, ok: true, result: { window: 'nope' } })
    default: return write({ id, ok: false, error: { code: 'failed', message: 'Unknown request: ' + op } })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))
`

/** Writes the script into a folder the test owns and returns its path. */
export async function writeFakeHelper(folder: string): Promise<string> {
  const file = path.join(folder, 'fake-helper.mjs')
  await fs.writeFile(file, SCRIPT, 'utf8')
  return file
}

export function spawnFakeHelper(script: string, env: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}

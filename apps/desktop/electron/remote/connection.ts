/**
 * This PC's end of an SSH connection to eNCode's program on another machine (ADR 0111): starts `ssh` with the start
 * command, answers the program's request for itself, waits for it to start, and then carries eNCode's channels over
 * the connection's standard input and output. What `ssh` and the machine print on standard error is kept for the
 * log, and read for a plain reason when the connection fails.
 */
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { streamChannels, type StreamChannels } from '@encode/protocol/stream'
import { installCommand, startCommand, type Mark } from './bootstrap'
import { sshArgs, targetLabel, type SshTarget } from './target'

/** Why a connection did not come up, in words for the person, with what kind of problem it was. */
export interface ConnectFailure {
  ok: false
  kind: 'ssh-missing' | 'auth' | 'host-key' | 'host-key-changed' | 'unreachable' | 'node-missing' | 'node-old' | 'failed'
  message: string
  /** For node-missing and node-old: the machine, as `uname -s`-`uname -m`. */
  machine?: string
  /** What ssh said, for a Details fold. */
  detail?: string
}

export interface Connection {
  ok: true
  target: SshTarget
  channels: StreamChannels
  /** Ends the connection: `ssh` is stopped, and every channel closes. */
  close(): void
  /** Calls `handler` once, when the connection has ended for any reason. */
  onClose(handler: (reason: string) => void): void
  readonly closed: boolean
}

export interface ConnectOptions {
  target: SshTarget
  /** The `ssh` program, by absolute path. */
  ssh: string
  /** The program for the other machine, and its checksum. */
  server: { bytes: Buffer; sha256: string }
  /** Lines `ssh` and the other machine print on standard error, for the log. */
  log?(line: string): void
  /** Called as the start goes on: a slow first start is an upload. */
  progress?(step: 'connecting' | 'uploading' | 'starting'): void
  /** How long the start may take, ms. Default 120 000: an upload on a slow line. */
  timeoutMs?: number
  /** For tests: how a process is started. */
  spawn?: (command: string, args: string[]) => ChildProcessWithoutNullStreams
}

const MARK_LINE = /^ENCODE-([A-Z-]+) (\S+)(?: (.*))?$/
const MAX_PREAMBLE = 64 * 1024

/** The build's folder on the other machine: the program's checksum, so a changed build is a new folder. */
export function serverVersion(sha256: string): string {
  return sha256.slice(0, 16)
}

/** What `ssh` said when it failed, as a reason the person can act on. */
export function sshFailure(stderr: string, target: SshTarget): Omit<ConnectFailure, 'ok'> {
  const name = targetLabel(target)
  const detail = stderr.trim().split(/\r?\n/).slice(-12).join('\n')
  const has = (pattern: RegExp) => pattern.test(stderr)
  if (has(/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i))
    return { kind: 'host-key-changed', message: `${name} answered with a different key than the one your PC knows for it. That can mean someone is in between. eNCode did not connect. If the machine was set up again, remove its old line from ~/.ssh/known_hosts (ssh-keygen -R ${target.host}) and connect once from a terminal.`, detail }
  if (has(/Host key verification failed|No .* host key is known/i))
    return { kind: 'host-key', message: `Your PC does not know ${name}'s key yet, so SSH did not connect. Connect once from a terminal (ssh ${name}) and accept the key, then try again here.`, detail }
  if (has(/Permission denied|Too many authentication failures|no mutual signature/i))
    return { kind: 'auth', message: `${name} did not accept your SSH key. eNCode signs in with a key, not a password: add your public key to ~/.ssh/authorized_keys on that machine (ssh-copy-id does it), or load it into ssh-agent, then try again.`, detail }
  if (has(/Could not resolve hostname|Name or service not known|nodename nor servname/i))
    return { kind: 'unreachable', message: `Your PC could not find a machine called ${target.host}. Check the name, or add it to ~/.ssh/config.`, detail }
  if (has(/Connection refused/i)) return { kind: 'unreachable', message: `${name} refused the connection: its SSH server is not running, or listens on another port.`, detail }
  if (has(/timed out|No route to host|Network is unreachable|Connection reset|Connection closed by/i))
    return { kind: 'unreachable', message: `${name} could not be reached. Check that it is on, and that this PC can reach it (a VPN, a firewall).`, detail }
  return { kind: 'failed', message: `SSH could not connect to ${name}.`, detail }
}

/** Starts eNCode's program on the machine. Resolves when its channels are up, or with why not; never rejects. */
export function connect(options: ConnectOptions): Promise<Connection | ConnectFailure> {
  const nonce = randomBytes(9).toString('hex')
  const command = startCommand({ version: serverVersion(options.server.sha256), sha256: options.server.sha256, nonce })
  const start = options.spawn ?? ((program: string, args: string[]) => spawnProcess(program, args, { stdio: 'pipe', windowsHide: true }))
  options.progress?.('connecting')

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = start(options.ssh, sshArgs(options.target, command))
    } catch (error) {
      resolve({ ok: false, kind: 'ssh-missing', message: `SSH could not be started: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    let stderr = ''
    let errLine = ''
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (stderr.length < 64 * 1024) stderr += text
      errLine += text
      const lines = errLine.split(/\r?\n/)
      errLine = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) options.log?.(line)
    })

    let settled = false
    let preamble = Buffer.alloc(0)
    const finish = (value: Connection | ConnectFailure) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!value.ok) {
        child.stdout.off('data', onPreamble)
        child.kill()
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish({ ok: false, kind: 'unreachable', message: `${targetLabel(options.target)} did not finish starting eNCode in time.`, detail: stderr.trim() }), options.timeoutMs ?? 120_000)

    const onMark = (mark: Mark, rest: string | undefined): boolean => {
      switch (mark) {
        case 'UPLOAD':
          options.progress?.('uploading')
          child.stdin.write(`${options.server.bytes.length}\n`)
          child.stdin.write(options.server.bytes)
          return false
        case 'NODE-MISSING':
          finish({ ok: false, kind: 'node-missing', machine: rest ?? '', message: `${targetLabel(options.target)} has no Node.js, which eNCode's agent needs there.` })
          return true
        case 'NODE-OLD': {
          const [machine = '', major = '?'] = (rest ?? '').split(' ')
          finish({ ok: false, kind: 'node-old', machine, message: `${targetLabel(options.target)} has Node.js ${major}; eNCode's agent needs 22 or newer.` })
          return true
        }
        case 'FAILED':
          finish({ ok: false, kind: 'failed', message: `eNCode could not be set up on ${targetLabel(options.target)} (${rest ?? 'unknown'}).`, detail: stderr.trim() })
          return true
        case 'START':
          return true
      }
    }

    const onPreamble = (chunk: Buffer) => {
      preamble = Buffer.concat([preamble, chunk])
      for (;;) {
        const at = preamble.indexOf(10)
        if (at === -1) break
        const line = preamble.subarray(0, at).toString('utf8').replace(/\r$/, '')
        preamble = preamble.subarray(at + 1)
        const match = line.match(MARK_LINE)
        // A login script's output, or a line of another connection: passed over.
        if (!match || match[2] !== nonce) continue
        const mark = match[1] as Mark
        if (!onMark(mark, match[3])) continue
        if (mark !== 'START') return
        options.progress?.('starting')
        child.stdout.off('data', onPreamble)
        const source = new PassThrough()
        if (preamble.length) source.write(preamble)
        child.stdout.pipe(source)
        const channels = streamChannels(source, child.stdin, { onProblem: (error) => options.log?.(`connection: ${error.message}`) })
        const closers: Array<(reason: string) => void> = []
        let reason = 'The connection closed.'
        let closed = false
        const closeAll = () => {
          if (closed) return
          closed = true
          for (const handler of closers.splice(0)) handler(reason)
        }
        channels.onClose(closeAll)
        child.on('close', (code) => {
          const failure = sshFailure(stderr, options.target)
          reason = failure.kind === 'failed' ? `The connection to ${targetLabel(options.target)} ended (code ${code ?? 'none'}).` : failure.message
          channels.close()
          closeAll()
        })
        finish({
          ok: true,
          target: options.target,
          channels,
          close: () => {
            channels.close()
            child.kill()
          },
          onClose: (handler) => {
            if (closed) queueMicrotask(() => handler(reason))
            else closers.push(handler)
          },
          get closed() {
            return closed
          },
        })
        return
      }
      if (preamble.length > MAX_PREAMBLE) finish({ ok: false, kind: 'failed', message: `${targetLabel(options.target)} printed too much before eNCode started; a login script may be in the way.`, detail: stderr.trim() })
    }
    child.stdout.on('data', onPreamble)
    child.on('error', (error) => {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      finish({ ok: false, kind: missing ? 'ssh-missing' : 'failed', message: missing ? 'SSH is not installed on this PC.' : `SSH could not be started: ${error.message}` })
    })
    child.on('close', () => {
      if (!settled) finish({ ok: false, ...sshFailure(stderr, options.target) })
    })
    child.stdin.on('error', () => undefined)
  })
}

/** What went wrong in an install, by the word the install script ends with. */
const INSTALL_FAILURES: Record<string, string> = {
  folder: 'could not make its folder in your home there',
  download: 'could not download Node.js from nodejs.org (the machine may have no internet access)',
  'no-downloader': 'found neither curl nor wget to download it with',
  checksum: 'downloaded a file whose checksum is not the one eNCode expects, so it did not use it',
  unpack: 'could not unpack the download',
  move: 'could not put it in place',
  link: 'could not put it in place',
  run: 'installed a Node.js that does not start there',
}

export interface InstallOptions {
  target: SshTarget
  ssh: string
  /** From nodePlatform. */
  platform: string
  log?(line: string): void
  /** Default ten minutes: a download on a slow line. */
  timeoutMs?: number
  spawn?: ConnectOptions['spawn']
  /** For tests: where Node.js is downloaded from. */
  base?: string
}

/** Puts Node.js in eNCode's own folder on the machine (installCommand), once the person said yes. Never rejects. */
export function installNode(options: InstallOptions): Promise<{ ok: true } | { ok: false; message: string; detail?: string }> {
  const nonce = randomBytes(9).toString('hex')
  const name = targetLabel(options.target)
  let command: string
  try {
    command = installCommand({ platform: options.platform, nonce, ...(options.base ? { base: options.base } : {}) })
  } catch (error) {
    return Promise.resolve({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
  const start = options.spawn ?? ((program: string, args: string[]) => spawnProcess(program, args, { stdio: 'pipe', windowsHide: true }))
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = start(options.ssh, sshArgs(options.target, command))
    } catch (error) {
      resolve({ ok: false, message: `SSH could not be started: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    let out = ''
    let stderr = ''
    let settled = false
    const finish = (value: { ok: true } | { ok: false; message: string; detail?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(value)
    }
    const timer = setTimeout(() => finish({ ok: false, message: `Installing Node.js on ${name} did not finish in time.` }), options.timeoutMs ?? 10 * 60_000)
    child.stdout.on('data', (chunk: Buffer) => {
      out = (out + chunk.toString('utf8')).slice(-8 * 1024)
      // Whole lines only: the last one may still be coming.
      for (const line of out.split(/\r?\n/).slice(0, -1)) {
        const match = line.match(MARK_LINE)
        if (!match || match[2] !== nonce) continue
        if (match[1] === 'INSTALLED') finish({ ok: true })
        else if (match[1] === 'FAILED') finish({ ok: false, message: `eNCode ${INSTALL_FAILURES[match[3] ?? ''] ?? 'could not install Node.js'} on ${name}.`, ...(stderr.trim() ? { detail: stderr.trim().slice(-2_000) } : {}) })
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (stderr.length < 64 * 1024) stderr += text
      for (const line of text.split(/\r?\n/)) if (line.trim()) options.log?.(line)
    })
    child.on('error', (error) => finish({ ok: false, message: `SSH could not be started: ${error.message}` }))
    child.on('close', () => finish({ ok: false, ...sshFailure(stderr, options.target) }))
    child.stdin.end()
  })
}

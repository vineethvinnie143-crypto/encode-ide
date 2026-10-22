import { spawn, type ChildProcess } from 'node:child_process'
import { killTree } from '@encode/hooks'
import { ConnectionClosedError, ProtocolError, parseMessages, type JsonRpcMessage, type SendOptions, type Transport } from './jsonrpc'
import type { SpawnTarget } from './program'

/**
 * A server that is a program: one JSON-RPC message per line on its standard
 * input and output, its standard error free for logs. Closing follows the
 * specification: close its input, give it a moment, then ask it to stop
 * (a signal to its whole process group on macOS and Linux), then stop it and
 * everything it started (taskkill /T on Windows).
 */

export interface StdioOptions {
  target: SpawnTarget
  env: Record<string, string>
  cwd: string
  platform?: NodeJS.Platform
  /** The longest line accepted from the server, in bytes. */
  maxMessageBytes?: number
  /** How long each step of closing waits, in ms. */
  graceMs?: number
  /** Called with each piece of the server's standard error. */
  onStderr?: (text: string) => void
}

const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
const DEFAULT_GRACE_MS = 2000
/** How much standard error is kept for an error message. */
const STDERR_TAIL_BYTES = 32 * 1024

export class StdioTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void
  onclose?: (reason?: Error) => void
  onerror?: (error: Error) => void

  private child: ChildProcess | undefined
  private pieces: Buffer[] = []
  private pieceBytes = 0
  private stderrText = ''
  private ignoredLines = 0
  private closing = false
  private closedOnce = false
  private exited: Promise<void> | undefined
  private readonly platform: NodeJS.Platform
  private readonly maxBytes: number
  private readonly graceMs: number

  constructor(private readonly options: StdioOptions) {
    this.platform = options.platform ?? process.platform
    this.maxBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  }

  /** The end of what the server wrote to standard error, for telling the user why it failed. */
  stderrTail(): string {
    return this.stderrText.trim()
  }

  async start(): Promise<void> {
    const { target } = this.options
    const child = spawn(target.file, target.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: this.platform !== 'win32',
      ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })
    this.child = child
    this.exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    }).catch((error: Error) => {
      this.closedOnce = true
      throw new Error(`Could not start the server: ${error.message}`)
    })

    child.stdout?.on('data', (chunk: Buffer) => this.read(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.log(chunk.toString('utf8')))
    // A server that never reads its input closes it early; the exit tells why.
    child.stdin?.on('error', () => {})
    child.on('error', (error) => this.onerror?.(error))
    child.on('close', (code, signal) => {
      if (this.closedOnce) return
      this.closedOnce = true
      const tail = this.stderrTail()
      const how = signal ? `signal ${signal}` : `code ${code}`
      this.onclose?.(this.closing ? undefined : new Error(`The server exited (${how}).${tail ? ` It printed: ${tail.slice(-400)}` : ''}`))
    })
  }

  async send(message: JsonRpcMessage, _options?: SendOptions): Promise<void> {
    const stdin = this.child?.stdin
    if (this.closing || !stdin || !stdin.writable) throw new ConnectionClosedError('The server is not running.')
    const line = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(line) > this.maxBytes) throw new ProtocolError('The message is too large to send.')
    await new Promise<void>((resolve, reject) => {
      stdin.write(line, (error) => (error ? reject(new ConnectionClosedError('The server stopped reading.')) : resolve()))
    })
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child || this.closing) return this.exited
    this.closing = true
    child.stdin?.end()
    if (await this.waitForExit(this.graceMs)) return this.afterExit(child)
    if (this.platform !== 'win32' && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      if (await this.waitForExit(this.graceMs)) return this.afterExit(child)
    }
    killTree(child, this.platform)
    await this.waitForExit(this.graceMs * 3)
    this.afterExit(child)
  }

  // -------------------------------------------------------------------------

  /** True when the server exited within `ms`. */
  private async waitForExit(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    })
    try {
      return await Promise.race([this.exited!.then(() => true), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** The server has exited; anything it started that is still in its process group goes too. */
  private afterExit(child: ChildProcess): void {
    if (this.platform !== 'win32' && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Nothing left in the group.
      }
    }
  }

  private log(text: string): void {
    this.stderrText = (this.stderrText + text).slice(-STDERR_TAIL_BYTES)
    this.options.onStderr?.(text)
  }

  private read(chunk: Buffer): void {
    let start = 0
    for (let end = chunk.indexOf(10, start); end !== -1; end = chunk.indexOf(10, start)) {
      this.pieces.push(chunk.subarray(start, end))
      const line = Buffer.concat(this.pieces)
      this.pieces = []
      this.pieceBytes = 0
      start = end + 1
      this.line(line)
    }
    const rest = chunk.subarray(start)
    if (!rest.length) return
    this.pieces.push(rest)
    this.pieceBytes += rest.length
    if (this.pieceBytes > this.maxBytes) {
      this.pieces = []
      this.pieceBytes = 0
      this.onerror?.(new ProtocolError('The server sent a line that is too long.'))
      void this.close()
    }
  }

  private line(bytes: Buffer): void {
    const text = bytes.toString('utf8').trim()
    if (!text) return
    // Servers must keep standard output for the protocol; many print a banner or a log line anyway. Skip those, keep a few to show.
    if (text[0] !== '{' && text[0] !== '[') {
      if (this.ignoredLines++ < 20) this.log(`[stdout] ${text.slice(0, 200)}\n`)
      return
    }
    try {
      for (const message of parseMessages(text)) this.onmessage?.(message)
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

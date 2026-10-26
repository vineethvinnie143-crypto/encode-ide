/**
 * A folder on another machine, as the main process uses it (ADR 0111): one SSH connection to eNCode's program there,
 * made again when it drops, and the folder services of this PC (files, git, the terminal, the Review tab) as calls
 * over it. The agent host there starts through hostProcess(), the way the utility process does on this PC, and its
 * model and search calls come back here through the tunnel, where the keys are.
 *
 * Paths of that machine are POSIX paths, whatever this PC is.
 */
import path from 'node:path'
import { Peer, RpcError, type Envelope, type Port } from '@encode/protocol'
import type { HostInit } from '../agent-host/api'
import type { HostProcess } from '../agent-host/service'
import type { ReviewService } from '../services/review'
import type { ShellService, ShellSink } from '../services/shell'
import type { FolderFiles } from '../services/workspace'
import type { GitService } from '../services/git'
import { connect, type ConnectFailure, type ConnectOptions, type Connection } from './connection'
import type { FolderMainApi, FolderServerApi, FolderService, RemoteFolderInfo, RemoteHello } from './protocol'
import { targetLabel, type SshTarget } from './target'
import { KeyTokens, serveTunnel, type NetHostApi, type NetMainApi, type TunnelOptions } from './tunnel'

export type RemoteStatus = 'connecting' | 'uploading' | 'starting' | 'connected' | 'lost' | 'closed'

/** How the connection stands, for the window. */
export interface RemoteState {
  status: RemoteStatus
  /** `user@host:port`, as the person wrote it. */
  label: string
  /** Why it was lost, in words. */
  message?: string
}

export interface RemoteMachineOptions {
  target: SshTarget
  /** The `ssh` program, by absolute path. */
  ssh: string
  /** The program for that machine, read when it is first needed. */
  server(): { bytes: Buffer; sha256: string }
  /** Which servers the machine may reach through this PC, and with which keys. */
  tunnel: TunnelOptions
  /** What eNCode's program there asks of this PC: the agent's models, for a commit message or a review, and its record of a request. */
  main: {
    draftCommit(input: FolderMainApi['requests']['draftCommit']['params']): Promise<string>
    reviewCode(input: FolderMainApi['requests']['reviewCode']['params']): Promise<FolderMainApi['requests']['reviewCode']['result']>
    turnChanges(params: FolderMainApi['requests']['turnChanges']['params']): Promise<FolderMainApi['requests']['turnChanges']['result']>
    turnWrite(params: FolderMainApi['requests']['turnWrite']['params']): Promise<FolderMainApi['requests']['turnWrite']['result']>
  }
  onState(state: RemoteState): void
  /** Files of the open folder changed there, by their paths in it. */
  onChanged(paths: string[]): void
  log(line: string): void
  spawn?: ConnectOptions['spawn']
}

const CALL_TIMEOUT_MS = 2 * 60_000
/** A review by the model, or a commit message: as long as the agent host gives them, and a little more. */
const LONG_CALLS: Partial<Record<FolderService, Record<string, number>>> = {
  review: { askReviewer: 7 * 60_000, draft: 3 * 60_000, commit: 3 * 60_000 },
  workspace: { search: 3 * 60_000 },
}
const HELLO_TIMEOUT_MS = 20_000
const ANY_OBJECT = { type: 'object' } as const

/** A port whose other end comes later: what is posted before is held, and it closes if the end never comes. */
class DeferredPort implements Port {
  private target: Port | null = null
  private failed = false
  private readonly queue: Envelope[] = []
  private readonly listeners = new Set<(message: unknown) => void>()
  private readonly closers = new Set<() => void>()
  private stops: Array<() => void> = []

  attach(port: Port): void {
    if (this.failed || this.target) return
    this.target = port
    for (const listener of this.listeners) this.stops.push(port.listen(listener))
    const stopClose = port.onClose?.(() => this.fail())
    if (stopClose) this.stops.push(stopClose)
    for (const message of this.queue.splice(0)) port.post(message)
  }

  fail(): void {
    if (this.failed) return
    this.failed = true
    for (const stop of this.stops.splice(0)) stop()
    this.queue.length = 0
    for (const handler of [...this.closers]) handler()
    this.closers.clear()
  }

  post(message: Envelope): void {
    if (this.failed) throw new RpcError('closed', 'The connection is closed.')
    if (this.target) this.target.post(message)
    else this.queue.push(message)
  }

  listen(handler: (message: unknown) => void): () => void {
    this.listeners.add(handler)
    let stop: (() => void) | undefined
    if (this.target) {
      stop = this.target.listen(handler)
      this.stops.push(stop)
    }
    return () => {
      this.listeners.delete(handler)
      stop?.()
    }
  }

  onClose(handler: () => void): () => void {
    if (this.failed) {
      queueMicrotask(handler)
      return () => {}
    }
    this.closers.add(handler)
    return () => this.closers.delete(handler)
  }
}

/** A path inside the folder, from one the window sends: the same check as WorkspaceService.resolve, in POSIX terms. */
function insideRoot(root: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  const abs = path.posix.resolve(root, cleaned)
  const relative = path.posix.relative(root, abs)
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) throw new Error(`Path "${rel}" is outside the workspace`)
  return abs
}

export class RemoteMachine {
  readonly tokens = new KeyTokens()
  readonly label: string
  readonly target: SshTarget
  private hello: RemoteHello | null = null
  private connection: Connection | null = null
  private folder: Peer<FolderMainApi, FolderServerApi> | null = null
  private connecting: Promise<Connection> | null = null
  private root: string | null = null
  private closed = false
  private state: RemoteState
  private readonly sinks = new Map<string, ShellSink>()

  constructor(private readonly o: RemoteMachineOptions) {
    this.target = o.target
    this.label = targetLabel(o.target)
    this.state = { status: 'closed', label: this.label }
  }

  get current(): RemoteState {
    return this.state
  }

  /** The machine's account and system, once a connection came up. */
  get about(): RemoteHello | null {
    return this.hello
  }

  private setState(status: RemoteStatus, message?: string): void {
    this.state = { status, label: this.label, ...(message ? { message } : {}) }
    this.o.onState(this.state)
  }

  /** The first connection, for the Open dialog: null when it came up, or why not in words. */
  async open(): Promise<ConnectFailure | null> {
    try {
      await this.ensure()
      return null
    } catch (error) {
      if (error instanceof ConnectError) return error.failure
      return { ok: false, kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** The connection, made again if it dropped. */
  ensure(): Promise<Connection> {
    if (this.closed) return Promise.reject(new Error(`The connection to ${this.label} is closed.`))
    if (this.connection && !this.connection.closed) return Promise.resolve(this.connection)
    if (!this.connecting) {
      const connecting = this.dial().finally(() => {
        if (this.connecting === connecting) this.connecting = null
      })
      this.connecting = connecting
    }
    return this.connecting
  }

  private async dial(): Promise<Connection> {
    this.setState('connecting')
    const result = await connect({
      target: this.target,
      ssh: this.o.ssh,
      server: this.o.server(),
      log: (line) => this.o.log(`[ssh ${this.label}] ${line}`),
      progress: (step) => this.setState(step),
      ...(this.o.spawn ? { spawn: this.o.spawn } : {}),
    })
    if (!result.ok) {
      this.setState('lost', result.message)
      throw new ConnectError(result)
    }
    if (this.closed) {
      result.close()
      throw new Error(`The connection to ${this.label} is closed.`)
    }
    const folder = new Peer<FolderMainApi, FolderServerApi>(result.channels.port('folder'), { onProtocolError: (error) => this.o.log(`[ssh ${this.label}] ${error.message}`) })
    // What the program there asks back goes to the agent host, which checks it like anything else it is sent.
    folder.handle('draftCommit', (input) => this.o.main.draftCommit(input), { schema: ANY_OBJECT })
    folder.handle('reviewCode', (input) => this.o.main.reviewCode(input), { schema: ANY_OBJECT })
    folder.handle('turnChanges', (params) => this.o.main.turnChanges(params), { schema: ANY_OBJECT })
    folder.handle('turnWrite', (params) => this.o.main.turnWrite(params), { schema: ANY_OBJECT })
    folder.on('changed', ({ paths }) => {
      if (Array.isArray(paths)) this.o.onChanged(paths.filter((item): item is string => typeof item === 'string').slice(0, 2_000))
    })
    folder.on('shellData', ({ id, text }) => this.sinks.get(id)?.data(String(text)))
    folder.on('shellPrompt', (info) => this.sinks.get(info.id)?.prompt(info))
    folder.on('shellExit', ({ id, code }) => {
      this.sinks.get(id)?.exit(Number(code))
      this.sinks.delete(id)
    })
    const net = new Peer<NetMainApi, NetHostApi>(result.channels.port('net'), { onProtocolError: (error) => this.o.log(`[ssh ${this.label}] ${error.message}`) })
    serveTunnel(net, this.tokens, this.o.tunnel)

    try {
      this.hello = await folder.request('hello', undefined, { timeoutMs: HELLO_TIMEOUT_MS })
      // A connection made again finds the folder the window shows open there too.
      if (this.root) await folder.request('call', { service: 'workspace', method: 'open', args: [this.root] }, { timeoutMs: CALL_TIMEOUT_MS })
    } catch (error) {
      result.close()
      const message = `eNCode started on ${this.label} but did not answer: ${error instanceof Error ? error.message : String(error)}`
      this.setState('lost', message)
      throw new ConnectError({ ok: false, kind: 'failed', message })
    }
    this.connection = result
    this.folder = folder
    result.onClose((reason) => this.dropped(result, folder, net, reason))
    this.setState('connected')
    this.o.log(`[ssh ${this.label}] connected: Node ${this.hello.node} on ${this.hello.platform} ${this.hello.arch}`)
    return result
  }

  private dropped(connection: Connection, folder: Peer<FolderMainApi, FolderServerApi>, net: Peer<NetMainApi, NetHostApi>, reason: string): void {
    folder.close(reason)
    net.close(reason)
    if (this.connection !== connection) return
    this.connection = null
    this.folder = null
    // A terminal there ended with the connection.
    for (const [id, sink] of this.sinks) {
      sink.data(`\r\n${reason}\r\n`)
      sink.exit(1)
      this.sinks.delete(id)
    }
    if (!this.closed) {
      this.o.log(`[ssh ${this.label}] ${reason}`)
      this.setState('lost', reason)
    }
  }

  /** Ends the connection for good. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.connection?.close()
    this.connection = null
    this.setState('closed')
  }

  /** A folder the person typed, as that machine's absolute path; refused when it is not a folder there. */
  async resolveFolder(typed: string): Promise<RemoteFolderInfo> {
    await this.ensure()
    return this.folder!.request('resolveFolder', { path: typed }, { timeoutMs: CALL_TIMEOUT_MS })
  }

  private async call<T>(service: FolderService, method: string, args: unknown[]): Promise<T> {
    await this.ensure()
    const folder = this.folder
    if (!folder) throw new Error(`The connection to ${this.label} is closed.`)
    return (await folder.request('call', { service, method, args }, { timeoutMs: LONG_CALLS[service]?.[method] ?? CALL_TIMEOUT_MS })) as T
  }

  /**
   * The agent host there, as AgentHostService starts one: its channel of the connection, made again if it dropped.
   * Ending it ends the connection, as a host that stops takes the folder's services with it.
   */
  hostProcess(): HostProcess {
    const port = new DeferredPort()
    const exits = new Set<() => void>()
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      port.fail()
      for (const handler of [...exits]) handler()
    }
    this.ensure().then(
      (connection) => {
        if (ended) return
        port.attach(connection.channels.port('host'))
        connection.onClose(end)
      },
      (error: unknown) => {
        this.o.log(`[ssh ${this.label}] the agent there could not start: ${error instanceof Error ? error.message : String(error)}`)
        end()
      },
    )
    return {
      port,
      kill: () => {
        end()
        this.connection?.close()
      },
      onExit: (handler) => {
        if (ended) queueMicrotask(handler)
        else exits.add(handler)
      },
    }
  }

  /** Where the agent host there keeps its things: eNCode's folder in that machine's home. */
  hostInit(): Omit<HostInit, 'config'> {
    const home = this.hello?.home
    if (!home) throw new Error(`eNCode has not connected to ${this.label} yet.`)
    const own = path.posix.join(home, '.encode-server')
    const data = path.posix.join(own, 'data')
    return {
      dir: path.posix.join(data, 'sessions'),
      home,
      workspace: this.root,
      routerStateFile: path.posix.join(data, 'models.json'),
      checkpointsDir: path.posix.join(data, 'checkpoints'),
      sandboxDir: path.posix.join(data, 'sandbox'),
      // The program, its Node.js and every chat there: off limits to the agent, like the profile folder on this PC.
      profileDir: own,
      toolsDir: path.posix.join(data, 'tools'),
      serverCacheDir: path.posix.join(data, 'server-cache'),
      // A run of the debugger starts that machine's code there, as its terminal does (ADR 0143).
      debugDir: path.posix.join(data, 'debug'),
    }
  }

  /** The folder services of that machine, in the shapes the main process uses for this PC's. */
  readonly workspace: FolderFiles = (() => {
    const machine = this
    const call = <T>(method: string, ...args: unknown[]) => machine.call<T>('workspace', method, args)
    return {
      get current() {
        return machine.root ? { root: machine.root, name: path.posix.basename(machine.root) || machine.root } : null
      },
      get rootPath() {
        return machine.root
      },
      get rootRealPath() {
        return machine.root
      },
      resolve(rel = '') {
        if (!machine.root) throw new Error('No folder is open')
        return insideRoot(machine.root, rel)
      },
      toRelative(abs: string) {
        if (!machine.root) return abs
        return path.posix.relative(machine.root, abs)
      },
      async open(root: string) {
        await call('open', root)
        machine.root = root
        return { root, name: path.posix.basename(root) || root }
      },
      async close() {
        const open = machine.root
        machine.root = null
        if (open && machine.connection && !machine.connection.closed) await call('close').catch(() => undefined)
      },
      list: (rel = '') => call('list', rel),
      listAll: () => call('listAll'),
      read: (rel) => call('read', rel),
      readForEditor: (rel) => call('readForEditor', rel),
      write: (rel, content) => call('write', rel, content),
      createFile: (parent, name) => call('createFile', parent, name),
      createDir: (parent, name) => call('createDir', parent, name),
      rename: (rel, name) => call('rename', rel, name),
      remove: (rel) => call('remove', rel),
      reveal: async () => {
        throw new Error('A file on another machine cannot be shown in this PC’s file manager.')
      },
      search: (options) => call('search', options),
    }
  })()

  readonly git: Pick<GitService, 'status'> = { status: () => this.call('git', 'status', []) }

  readonly shell: Pick<ShellService, 'create' | 'run' | 'cancel' | 'close' | 'complete' | 'disposeAll'> = (() => {
    const machine = this
    const call = <T>(method: string, ...args: unknown[]) => machine.call<T>('shell', method, args)
    return {
      // The terminal's output comes as events, by its id; one that arrives before the answer waits for its sink.
      create: ((options: { cwd?: string }, makeSink: (id: string) => ShellSink) =>
        call<{ id: string; cwd: string; prompt: string }>('create', options).then((info) => {
          machine.sinks.set(info.id, makeSink(info.id))
          return info
        })) as unknown as ShellService['create'],
      run: ((id: string, line: string) => call('run', id, line)) as unknown as ShellService['run'],
      cancel: ((id: string) => call('cancel', id)) as unknown as ShellService['cancel'],
      close: ((id: string) => {
        machine.sinks.delete(id)
        return call('close', id)
      }) as unknown as ShellService['close'],
      complete: ((id: string, line: string) => call('complete', id, line)) as unknown as ShellService['complete'],
      disposeAll: () => {
        machine.sinks.clear()
        if (machine.connection && !machine.connection.closed) void call('disposeAll').catch(() => undefined)
      },
    }
  })()

  readonly review: Pick<ReviewService, 'load' | 'act' | 'undo' | 'commits' | 'branches' | 'commit' | 'draft' | 'askReviewer'> = (() => {
    const call = <T>(method: string, ...args: unknown[]) => this.call<T>('review', method, args)
    return {
      load: (scope, options) => call('load', scope, options),
      act: (scope, action, options) => call('act', scope, action, options),
      undo: (scope, options) => call('undo', scope, options),
      commits: () => call('commits'),
      branches: () => call('branches'),
      commit: (request) => call('commit', request),
      draft: (all) => call('draft', all),
      askReviewer: (scope, options) => call('askReviewer', scope, options),
    }
  })()
}

/** A first connection that did not come up, with why. */
export class ConnectError extends Error {
  constructor(readonly failure: ConnectFailure) {
    super(failure.message)
    this.name = 'ConnectError'
  }
}

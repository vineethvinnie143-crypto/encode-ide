/**
 * eNCode's program on another machine (ADR 0111), bundled on its own (dist/electron/encode-server.cjs) and started over
 * SSH by the loader of bootstrap.ts. It runs the same agent host as the desktop app, and the folder services of the
 * main process (files, git, the terminal, the Review tab), over three channels of its standard input and output:
 *
 * - `host`: the agent host's session API, as the utility process serves it on this PC;
 * - `net`: model and search calls, which go out from the PC with the keys put in there (tunnel.ts);
 * - `folder`: the folder services (protocol.ts).
 *
 * Standard output carries only these messages: whatever else would print there goes to standard error, which the PC
 * keeps in its log. When the PC goes away (the connection drops, or eNCode closes), the program closes its sessions
 * and ends.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Peer, RpcError } from '@encode/protocol'
import { streamChannels } from '@encode/protocol/stream'
import { runHostRuntime } from '../agent-host/runtime'
import { GitService } from '../services/git'
import { isFile, searchPath } from '../services/programs'
import { ReviewService } from '../services/review'
import { ShellService } from '../services/shell'
import { WorkspaceService } from '../services/workspace'
import { FOLDER_CALL_SCHEMA, FOLDER_METHODS, type FolderMainApi, type FolderServerApi, type FolderService } from './protocol'
import { tunnelFetch, type NetHostApi, type NetMainApi } from './tunnel'

const protocolOut = process.stdout.write.bind(process.stdout)
// Anything else that prints (a library, a stray console.log) goes to standard error, so it cannot break a message.
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => (process.stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write

const log = (message: string) => process.stderr.write(`[encode-server] ${message}\n`)
process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`))
process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error.stack ?? error.message}`)
  process.exit(1)
})

const home = os.homedir()
const ownDir = path.join(home, '.encode-server')

const channels = streamChannels(process.stdin, { write: (text) => protocolOut(text), end: () => process.stdout.end() }, { onProblem: (error) => log(error.message) })

// Model and search calls go to the PC.
const net = new Peer<NetHostApi, NetMainApi>(channels.port('net'), { onProtocolError: (error) => log(error.message) })
const fetchThroughPc = tunnelFetch(net)

/** A file the person deletes goes to eNCode's own bin there, which a Linux server has no other of. */
async function trash(abs: string): Promise<void> {
  const bin = path.join(ownDir, 'trash', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(bin, { recursive: true, mode: 0o700 })
  const target = path.join(bin, path.basename(abs))
  try {
    await fs.rename(abs, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await fs.cp(abs, target, { recursive: true, preserveTimestamps: true })
    await fs.rm(abs, { recursive: true, force: true })
  }
}

const folder = new Peer<FolderServerApi, FolderMainApi>(channels.port('folder'), { onProtocolError: (error) => log(error.message) })
const workspace = new WorkspaceService({
  trash,
  reveal: () => {
    throw new Error('A file on another machine cannot be shown in this PC’s file manager.')
  },
})
workspace.setChangeHandler((paths) => folder.notify('changed', { paths }))
const git = new GitService(workspace)
const shell = new ShellService()
let gitPath: string | null = null
const review = new ReviewService({
  folder: () => workspace.current?.root ?? null,
  git: () => {
    if (!gitPath || !isFile(gitPath)) gitPath = searchPath('git', process.env)
    return gitPath
  },
  trash,
  draft: (input) => folder.request('draftCommit', input, { timeoutMs: 120_000 }),
  reviewCode: (input) => folder.request('reviewCode', input, { timeoutMs: 6 * 60_000 }),
  turns: {
    changes: (sessionId, turn) => folder.request('turnChanges', { sessionId, turn }, { timeoutMs: 60_000 }),
    write: (sessionId, write) => folder.request('turnWrite', { sessionId, write }, { timeoutMs: 60_000 }),
  },
})

folder.handle('hello', () => ({
  home,
  platform: process.platform,
  arch: process.arch,
  node: process.versions.node,
  user: (() => {
    try {
      return os.userInfo().username
    } catch {
      return ''
    }
  })(),
  hostname: os.hostname(),
}))

folder.handle(
  'resolveFolder',
  async ({ path: typed }) => {
    const expanded = typed === '~' ? home : typed.startsWith('~/') ? path.join(home, typed.slice(2)) : typed
    if (!path.isAbsolute(expanded)) throw new RpcError('invalid-params', 'Type the whole path: it starts with / or ~/.')
    const root = path.resolve(expanded)
    let stat
    try {
      stat = await fs.stat(root)
    } catch {
      throw new RpcError('not-found', `${root} does not exist on that machine.`)
    }
    if (!stat.isDirectory()) throw new RpcError('not-found', `${root} is a file, not a folder.`)
    try {
      await fs.access(root, fs.constants.R_OK | fs.constants.X_OK)
    } catch {
      throw new RpcError('denied', `The account eNCode signs in as cannot open ${root}.`)
    }
    return { root, name: path.basename(root) || root }
  },
  { schema: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } } } },
)

const services: Record<FolderService, Record<string, (...args: never[]) => unknown>> = {
  workspace: workspace as unknown as Record<string, (...args: never[]) => unknown>,
  git: git as unknown as Record<string, (...args: never[]) => unknown>,
  shell: {
    // The terminal's output goes back as events, by the terminal's id.
    create: (options: never) =>
      shell.create(options, (id) => ({
        data: (text) => folder.notify('shellData', { id, text }),
        prompt: (info) => folder.notify('shellPrompt', info),
        exit: (code) => folder.notify('shellExit', { id, code }),
      })),
    run: ((id: string, line: string) => shell.run(id, line)) as never,
    cancel: ((id: string) => shell.cancel(id)) as never,
    close: ((id: string) => shell.close(id)) as never,
    complete: ((id: string, line: string) => shell.complete(id, line)) as never,
    disposeAll: () => shell.disposeAll(),
  },
  review: review as unknown as Record<string, (...args: never[]) => unknown>,
}

folder.handle(
  'call',
  async ({ service, method, args }) => {
    const allowed = FOLDER_METHODS[service] as readonly string[] | undefined
    if (!allowed?.includes(method)) throw new RpcError('unknown-method', `No method ${service}.${method}.`)
    const target = services[service]
    const fn = target[method]
    if (typeof fn !== 'function') throw new RpcError('unknown-method', `No method ${service}.${method}.`)
    return await (fn as (...args: unknown[]) => unknown).apply(target, args)
  },
  { schema: FOLDER_CALL_SCHEMA as never },
)

// The agent host, as on the PC: the same runtime, with the network of the PC.
runHostRuntime(channels.port('host'), {
  log,
  fetch: fetchThroughPc,
  search: { fetch: fetchThroughPc as never },
  onShutdown: () => {
    shell.disposeAll()
    void workspace.close().finally(() => process.exit(0))
  },
})

channels.onClose(() => {
  // The PC went away: whatever ran ends with it; the chats are in the session logs already.
  shell.disposeAll()
  setTimeout(() => process.exit(0), 3_000).unref()
  void workspace.close()
})

// The loader left standard input paused after an upload; everything that came after the program is read now.
process.stdin.resume()
log(`eNCode's program runs as pid ${process.pid}, with Node ${process.versions.node}`)

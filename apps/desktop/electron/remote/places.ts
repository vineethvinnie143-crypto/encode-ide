/**
 * Where the open folder is (ADR 0111): on this PC, or on another machine over SSH. The main process reaches the open
 * folder's files, git, terminals and Review tab through this, whichever it is, and the agent host follows the folder
 * there and back. One place at a time: opening a folder elsewhere closes the one before, as opening another folder on
 * this PC always has.
 *
 * The window names a folder on another machine by its path there, the way that machine's agent names it in its
 * sessions. While such a folder is open, a path the window sends is taken as that machine's, unless it is one of this
 * PC's (a Windows path, the chats folder, a recent folder of this PC). A folder elsewhere is named in full as
 * `ssh://user@host/path` (target.ts), as the recent folders keep it.
 */
import type { OpenWorkspace } from '../../shared/types'
import type { GitService } from '../services/git'
import type { ReviewService } from '../services/review'
import type { ShellService } from '../services/shell'
import type { FolderFiles, WorkspaceService } from '../services/workspace'
import { ConnectError, type RemoteMachine } from './machine'
import { parseRemoteRoot, remoteRoot, targetLabel, type RemoteFolder, type SshTarget } from './target'

export type FolderGit = Pick<GitService, 'status'>
export type FolderShell = Pick<ShellService, 'create' | 'run' | 'cancel' | 'close' | 'complete' | 'disposeAll'>
export type FolderReview = Pick<ReviewService, 'load' | 'act' | 'undo' | 'commits' | 'branches' | 'commit' | 'draft' | 'askReviewer'>

export interface PlacesOptions {
  local: { workspace: WorkspaceService; git: GitService; shell: ShellService; review: ReviewService }
  /** A machine to connect to; nothing happens until it is asked to open. */
  machine(target: SshTarget): RemoteMachine
  /** The open folder moved to or from another machine: the agent host goes with it. */
  moved(): Promise<void>
  /** This PC's own folders by name: the recent ones and the chats folder. */
  localFolders(): readonly string[]
  platform: NodeJS.Platform
}

/** An object that is whichever `pick` returns at the moment of each use. */
export function following<T extends object>(pick: () => T): T {
  return new Proxy({} as T, {
    get(_target, key) {
      const target = pick() as Record<PropertyKey, unknown>
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

export class Places {
  private machine: RemoteMachine | null = null
  readonly workspace: FolderFiles
  readonly git: FolderGit
  readonly shell: FolderShell
  readonly review: FolderReview

  constructor(private readonly o: PlacesOptions) {
    this.workspace = following<FolderFiles>(() => this.machine?.workspace ?? o.local.workspace)
    this.git = following<FolderGit>(() => this.machine?.git ?? o.local.git)
    this.shell = following<FolderShell>(() => this.machine?.shell ?? o.local.shell)
    this.review = following<FolderReview>(() => this.machine?.review ?? o.local.review)
  }

  /** The other machine whose folder is open, if one is. */
  get remote(): RemoteMachine | null {
    return this.machine
  }

  /** The open folder, as the window is told of it. */
  get shown(): OpenWorkspace | null {
    const current = this.workspace.current
    if (!current || !this.machine) return current
    return { ...current, remote: { label: this.machine.label, uri: remoteRoot({ ...this.machine.target, path: current.root }) } }
  }

  /** Whether a path the window sent is the other machine's. */
  private onMachine(root: string): boolean {
    if (!this.machine || !root.startsWith('/') || root.startsWith('//')) return false
    if (this.o.platform === 'win32') return true
    return !this.o.localFolders().includes(root)
  }

  /**
   * Opens a folder where its name says: on this PC, on the machine whose folder is open, or on another machine.
   * `local` is for a folder only this PC can have given, as the system's folder dialog does.
   */
  async open(root: string, options: { local?: boolean } = {}): Promise<OpenWorkspace> {
    const folder = options.local ? null : parseRemoteRoot(root)
    if (folder) return this.openRemote(folder)
    if (!options.local && this.machine && this.onMachine(root)) return this.openRemote({ ...this.machine.target, path: root })
    if (this.machine) await this.leave()
    return this.o.local.workspace.open(root)
  }

  /** Opens a folder on a machine, connecting first if it is another one. A first connection that fails throws ConnectError. */
  async openRemote(folder: RemoteFolder): Promise<OpenWorkspace> {
    const current = this.machine
    const same = current !== null && targetLabel(current.target) === targetLabel(folder)
    const machine = same ? current : this.o.machine({ host: folder.host, ...(folder.user ? { user: folder.user } : {}), ...(folder.port ? { port: folder.port } : {}) })
    if (!same) {
      const failure = await machine.open()
      if (failure) {
        machine.close()
        throw new ConnectError(failure)
      }
    }
    let info
    try {
      info = await machine.resolveFolder(folder.path)
    } catch (error) {
      if (!same) machine.close()
      throw error
    }
    if (!same) {
      // What was open closes, here or on the machine before; then the agent host moves.
      this.o.local.shell.disposeAll()
      await this.o.local.workspace.close()
      if (current) {
        current.shell.disposeAll()
        await current.workspace.close()
      }
      this.machine = machine
      await this.o.moved()
      current?.close()
    }
    await machine.workspace.open(info.root)
    return this.shown!
  }

  /** Closes the folder that is open, and with one on another machine its connection; the agent host comes back here. */
  async close(): Promise<void> {
    this.shell.disposeAll()
    await this.workspace.close()
    if (this.machine) await this.leave()
  }

  private async leave(): Promise<void> {
    const machine = this.machine
    if (!machine) return
    machine.shell.disposeAll()
    await machine.workspace.close()
    this.machine = null
    await this.o.moved()
    machine.close()
  }

  /** At quit: the connection ends with eNCode. */
  dispose(): void {
    this.machine?.close()
  }
}

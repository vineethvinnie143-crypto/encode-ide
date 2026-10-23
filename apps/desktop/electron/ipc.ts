import { BrowserWindow, app, dialog, ipcMain, shell as osShell, type IpcMainInvokeEvent } from 'electron'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { describeError, shownError } from '@encode/core'
import { isRpcError } from '@encode/protocol'
import { rewindRequestOf } from './agent-host/rewind-request'
import { HOST_STOPPED_MESSAGE, type AgentHostService } from './agent-host/service'
import { aboutInfo, currentEnvironment } from './build-info'
import { diagnosticsFileName } from './services/diagnostics'
import { noAnswer, readEditorAsk, readEditorChange } from './services/editor-ask'
import { exportSessionZip } from './services/export'
import type { GitService } from './services/git'
import type { LogService } from './services/logs'
import type { ModelsService } from './services/models'
import type { ReviewService } from './services/review'
import { commitRequestOf, reviewActionOf, reviewOptionsOf, reviewScopeOf } from './services/review-input'
import type { ScheduleService } from './services/schedules'
import type { SettingsService } from './services/settings'
import type { ShellService } from './services/shell'
import type { SkillService } from './services/skills'
import type { WorkspaceService } from './services/workspace'
import { applyNativeAppearance } from './appearance'
import { isRendererUrl } from './window'
import type { SearchProviderId } from '../shared/search'
import type {
  AgentStartInput,
  ApprovalAnswer,
  EditorChangeResult,
  McpAction,
  PermissionsAction,
  PlanRequest,
  SandboxAction,
  SearchOptions,
  SessionGoal,
  SessionPatch,
  Settings,
  ShellCreateOptions,
  TodoItem,
} from '../shared/types'

export interface IpcDeps {
  getWindow: () => BrowserWindow | null
  settings: SettingsService
  workspace: WorkspaceService
  shell: ShellService
  schedules: ScheduleService
  skills: SkillService
  models: ModelsService
  git: GitService
  review: ReviewService
  agent: AgentHostService
  /** Tells the agent host the settings changed. */
  configureAgent: () => void
  logs: LogService
  /** The text of a diagnostics report, made at the moment the user asks for one. */
  diagnostics: () => Promise<string>
  /** Shows a notice the way a finished request would. */
  testNotice: () => void
  /** A session was removed; whatever follows its events can let go of it. */
  onSessionRemoved?: (sessionId: string) => void
}

/**
 * What the renderer is allowed to send as an answer to an approval: a yes or no, a short note, "for this session",
 * or "always" with the settings file the rule goes to. Only an approval can be remembered.
 */
export function approvalAnswerOf(answer: unknown): ApprovalAnswer {
  if (typeof answer !== 'object' || answer === null) return { approved: Boolean(answer) }
  const given = answer as { approved?: unknown; note?: unknown; remember?: unknown; scope?: unknown }
  const approved = given.approved === true
  const scope = given.scope === 'user' || given.scope === 'project' || given.scope === 'local' ? given.scope : undefined
  return {
    approved,
    ...(typeof given.note === 'string' && given.note.trim() ? { note: given.note.slice(0, 2_000) } : {}),
    ...(approved && given.remember === 'session' ? { remember: 'session' as const } : {}),
    ...(approved && given.remember === 'always' ? { remember: 'always' as const, ...(scope ? { scope } : {}) } : {}),
  }
}

/** The largest file the editor shows a language server, in characters; the servers read no more from the disk. */
const MAX_DOCUMENT_CHARS = 8 * 1024 * 1024

/** The host going away is not the caller's fault: say what happened, in words the user can act on. */
function hostFailure(error: unknown): Error {
  return isRpcError(error) && error.code === 'closed' ? new Error(HOST_STOPPED_MESSAGE) : error instanceof Error ? error : new Error(String(error))
}

export function registerIpc(deps: IpcDeps): void {
  const { getWindow, settings, workspace, shell, schedules, skills, models, git, review, agent, configureAgent, logs, diagnostics, testNotice } = deps
  const host = agent.client

  /**
   * Only the app's own page may call the main process: the top frame of the
   * main window, showing the bundled renderer (or the dev server in
   * development). A page in the browser panel's frame, or anything that
   * navigated the window elsewhere, is refused.
   */
  const fromApp = (event: IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame
    const win = getWindow()
    if (!frame || frame.parent !== null || !win || win.isDestroyed() || event.sender !== win.webContents) return false
    return isRendererUrl(frame.url)
  }

  const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!fromApp(event)) throw new Error(`eNCode refused ${channel} from ${event.senderFrame?.url ?? 'an unknown frame'}`)
      try {
        return await fn(...args)
      } catch (error) {
        throw plainFailure(channel, error)
      }
    })
  }

  /**
   * What the renderer may show of a failure: one plain line (a system error in words, no class name, no stack, no
   * key). The whole of it goes to the log, where Diagnostics finds it.
   */
  const plainFailure = (channel: string, error: unknown): Error => {
    const text = shownError(error)
    const whole = describeError(error)
    // A failure already said plainly is the caller's to show; anything else is worth a line in the log.
    if (whole.split('\n')[0] !== `Error: ${text}`) logs.write('warn', `${channel} failed: ${whole}`)
    return new Error(text)
  }

  const sendToWindow = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  /** The host learns the open folder. If it is down it reads the folder again when it starts, so a failure here is only logged. */
  const tellHostFolder = async (root: string | null): Promise<void> => {
    try {
      await host.setWorkspace(root)
    } catch (error) {
      console.error('[agent-host] could not tell it the open folder:', error)
    }
  }

  /** The chats folder, made if it is missing: a chat opens it like a project. */
  const chatsFolder = (): string => {
    const folder = settings.chatsFolder()
    mkdirSync(folder, { recursive: true })
    return folder
  }

  const openWorkspaceAt = async (rootPath: string) => {
    agent.closeDocuments()
    const opened = await workspace.open(rootPath)
    settings.touchWorkspace(opened.root)
    await tellHostFolder(opened.root)
    return opened
  }

  handle('app:about', () => aboutInfo(currentEnvironment(app.isPackaged)))
  handle('app:user', () => {
    try {
      return os.userInfo().username
    } catch {
      return 'developer'
    }
  })

  handle('window:minimize', () => getWindow()?.minimize())
  handle('window:toggle-maximize', () => {
    const win = getWindow()
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  handle('window:toggle-fullscreen', () => {
    const win = getWindow()
    if (!win) return false
    win.setFullScreen(!win.isFullScreen())
    return win.isFullScreen()
  })
  handle('window:zoom', (action: unknown) => {
    const contents = getWindow()?.webContents
    if (!contents) return 0
    const level = action === 'reset' ? 0 : Math.min(5, Math.max(-3, contents.getZoomLevel() + (action === 'in' ? 0.5 : -0.5)))
    contents.setZoomLevel(level)
    return level
  })
  handle('window:close', () => getWindow()?.close())

  handle('workspace:open-dialog', async () => {
    const win = getWindow()
    const options = { title: 'Open Folder', properties: ['openDirectory', 'createDirectory'] as const }
    const result = win
      ? await dialog.showOpenDialog(win, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    if (result.canceled || !result.filePaths[0]) return null
    return openWorkspaceAt(result.filePaths[0])
  })
  handle('workspace:open-path', (rootPath: string) => openWorkspaceAt(String(rootPath)))
  handle('workspace:get', () => workspace.current)
  handle('workspace:close', async () => {
    agent.closeDocuments()
    shell.disposeAll()
    await workspace.close()
    settings.setLastWorkspace(null)
    await tellHostFolder(null)
  })
  handle('workspace:recent', () => settings.get().recentWorkspaces)
  handle('workspace:list', (rel: string) => workspace.list(String(rel ?? '')))
  handle('workspace:list-all', () => workspace.listAll())
  // The editor's files, for the language servers: each path is checked like any other the renderer sends.
  handle('code:document', (kind: unknown, rel: unknown, text?: unknown, dirty?: unknown) => {
    const root = workspace.current?.root
    if (!root || typeof rel !== 'string') return
    let path: string
    try {
      path = workspace.toRelative(workspace.resolve(rel))
    } catch {
      return
    }
    if (!path) return
    if (kind === 'close') return agent.document({ kind, root, path })
    if ((kind !== 'open' && kind !== 'change') || typeof text !== 'string') return
    // Larger than a server is given: the editor shows it without one.
    if (text.length > MAX_DOCUMENT_CHARS) return agent.document({ kind: 'close', root, path })
    agent.document({ kind, root, path, text, dirty: dirty === true })
  })
  // A question of the editor's about a file it shows. The same channel as the changes above, so it comes after them.
  handle('code:ask', async (value: unknown) => {
    const root = workspace.current?.root
    const kind = (value as { kind?: unknown } | null)?.kind
    if (!root) return noAnswer(kind)
    const ask = readEditorAsk(value, (rel) => {
      try {
        return workspace.toRelative(workspace.resolve(rel)) || null
      } catch {
        return null
      }
    })
    if (!ask) return noAnswer(kind)
    // The editor shows nothing for a question it could not have answered; a reason would only be noise there.
    return agent.codeAsk(root, ask).catch(() => noAnswer(kind))
  })
  // A rename or code action across the folder: checked like a question, its open files made the folder's own.
  handle('code:edit', async (value: unknown): Promise<EditorChangeResult> => {
    const root = workspace.current?.root
    if (!root) return { ok: false, reason: 'Open a folder first.' }
    const request = readEditorChange(value, (rel) => {
      try {
        return workspace.toRelative(workspace.resolve(rel)) || null
      } catch {
        return null
      }
    })
    if (!request) return { ok: false, reason: 'That change could not be made.' }
    return agent.codeChange(root, request).catch((error: unknown) => ({
      ok: false as const,
      reason: isRpcError(error) && error.code === 'closed' ? HOST_STOPPED_MESSAGE : 'The language servers did not finish the change in time. Look over the files it would change before you try again.',
    }))
  })
  handle('code:report', () => {
    const root = workspace.current?.root
    if (!root) return null
    return agent.codeReport(root).catch((error) => Promise.reject(hostFailure(error)))
  })
  handle('workspace:read', (rel: string) => workspace.read(String(rel)))
  handle('workspace:read-for-editor', (rel: string) => workspace.readForEditor(String(rel)))
  handle('workspace:write', (rel: string, content: string) => workspace.write(String(rel), String(content)))
  handle('workspace:create-file', (parent: string, name: string) => workspace.createFile(String(parent ?? ''), String(name)))
  handle('workspace:create-dir', (parent: string, name: string) => workspace.createDir(String(parent ?? ''), String(name)))
  handle('workspace:rename', (rel: string, newName: string) => workspace.rename(String(rel), String(newName)))
  handle('workspace:delete', (rel: string) => workspace.remove(String(rel)))
  handle('workspace:reveal', (rel: string) => workspace.reveal(String(rel)))
  handle('workspace:search', (options: SearchOptions) => workspace.search(options))

  handle('settings:get', () => settings.get())
  handle('settings:save', (patch: Partial<Settings>) => {
    const saved = settings.save(patch)
    if (patch?.appearance !== undefined) applyNativeAppearance(saved.appearance, getWindow())
    configureAgent()
    return saved
  })
  handle('settings:set-key', (profileId: string, key: string) => {
    const saved = settings.setProfileKey(String(profileId), String(key ?? ''))
    // The host learns that the key changed (not what it is), so the router tries a refused provider again.
    configureAgent()
    return saved
  })
  // The chats folder is only ever chosen here, in the system's dialog: a path the window sends is not taken.
  handle('settings:choose-chats-folder', async () => {
    const win = getWindow()
    const options = { title: 'Folder for chats', defaultPath: settings.chatsFolder(), properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
    const result = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return settings.setChatsFolder(result.filePaths[0])
  })
  handle('settings:reset-chats-folder', () => settings.setChatsFolder(null))
  // A search key reaches the host only when a search is made: the host asks for it then, so nothing is told here.
  handle('settings:set-search-key', (provider: string, key: string) => settings.setSearchKey(provider as SearchProviderId, String(key ?? '')))
  handle('search:test', () => agent.searchCheck().catch((error) => Promise.reject(hostFailure(error))))

  handle('models:openrouter', (freeOnly?: boolean) => models.openRouter(Boolean(freeOnly)))
  handle('models:provider', (profileId: string) => models.provider(String(profileId)))
  // Whether the models can be listed, then a small tool call to the chosen model, as the agent makes it. The call is the test:
  // a provider that does not list its models can still answer.
  handle('models:test', async (profileId: string) => {
    const id = String(profileId)
    const listing = await models.test(id)
    const profile = settings.raw().profiles.find((candidate) => candidate.id === id)
    const model = profile?.model.trim() ?? ''
    if (!profile || profile.kind === 'demo' || !model || !profile.baseUrl.trim()) return listing
    try {
      const check = await agent.modelCheck(id, model)
      return { ok: check.ok, message: check.ok && listing.ok ? `${listing.message}. ${check.message}` : check.message, ...(check.detail ? { detail: check.detail } : {}) }
    } catch (error) {
      return { ok: false, message: hostFailure(error).message }
    }
  })
  handle('models:status', () => agent.modelStatus().catch((error) => Promise.reject(hostFailure(error))))
  handle('models:recheck', () => agent.modelRecheck().catch((error) => Promise.reject(hostFailure(error))))

  handle('git:status', () => git.status())

  // The Review tab is about the folder that is open; what the renderer sends is checked before git sees it.
  handle('review:load', (scope: unknown, options: unknown) => review.load(reviewScopeOf(scope), reviewOptionsOf(options)))
  handle('review:act', (scope: unknown, action: unknown, options: unknown) => review.act(reviewScopeOf(scope), reviewActionOf(action), reviewOptionsOf(options)))
  handle('review:undo', (scope: unknown, options: unknown) => review.undo(reviewScopeOf(scope), reviewOptionsOf(options)))
  handle('review:commits', () => review.commits())
  handle('review:branches', () => review.branches())
  handle('review:commit', (request: unknown) => review.commit(commitRequestOf(request)))
  handle('review:draft', (options?: { all?: unknown }) => review.draft(options?.all === true))
  handle('review:ask', (scope: unknown, options: unknown) => review.askReviewer(reviewScopeOf(scope), reviewOptionsOf(options)))

  handle('shell:create', (options: ShellCreateOptions) =>
    shell.create(options, (id) => ({
      data: (text) => sendToWindow('shell:data', { id, text }),
      prompt: (info) => sendToWindow('shell:prompt', info),
      exit: (code) => sendToWindow('shell:exit', { id, code }),
    })),
  )
  handle('shell:run', (id: string, line: string) => shell.run(String(id), String(line)))
  handle('shell:cancel', (id: string) => shell.cancel(String(id)))
  handle('shell:close', (id: string) => shell.close(String(id)))
  handle('shell:complete', (id: string, line: string) => shell.complete(String(id), String(line)))

  handle('agent:sessions', () => host.sessions())
  handle('agent:create', (options?: { projectRoot?: unknown }) => {
    const projectRoot = options?.projectRoot
    return host.create(projectRoot === null || typeof projectRoot === 'string' ? { projectRoot } : undefined)
  })
  handle('agent:chats-folder', () => chatsFolder())
  handle('agent:create-chat', () => host.create({ projectRoot: chatsFolder() }))
  handle('agent:update', (sessionId: string, patch: SessionPatch) => host.update(String(sessionId), patch))
  handle('agent:statuses', () => host.statuses())
  handle('agent:history', (sessionId?: string) => host.history(sessionId ? String(sessionId) : undefined))
  handle('agent:start', async (sessionId: string, input: AgentStartInput) => {
    try {
      await host.start(String(sessionId), input)
    } catch (error) {
      throw hostFailure(error)
    }
  })
  handle('agent:retry', async (sessionId: string, mode?: unknown) => {
    try {
      await host.retry(String(sessionId), mode === 'ask' || mode === 'plan' || mode === 'code' ? mode : undefined)
    } catch (error) {
      throw hostFailure(error)
    }
  })
  handle('agent:cancel', (sessionId: string) => host.cancel(String(sessionId)))
  // The host checks the text and the id against its schema; null means no step can take the message now, and the renderer sends it as a request instead.
  handle('agent:steer', (sessionId: string, text: string, id: string) => host.steer(String(sessionId), String(text ?? ''), String(id ?? '')))
  handle('agent:reset', (sessionId?: string) => host.reset(sessionId ? String(sessionId) : undefined))
  handle('agent:remove', async (sessionId: string) => {
    await host.remove(String(sessionId))
    deps.onSessionRemoved?.(String(sessionId))
  })
  handle('agent:fork', (sessionId: string) => host.fork(String(sessionId)))
  handle('agent:rename', (sessionId: string, title: string) => host.rename(String(sessionId), String(title)))
  handle('agent:goal', (sessionId: string) => host.goal(String(sessionId)))
  handle('agent:set-goal', (sessionId: string, goal: SessionGoal | null) => host.setGoal(String(sessionId), goal ?? null))
  handle('agent:todos', (sessionId: string) => host.todos(String(sessionId)))
  handle('agent:set-todos', (sessionId: string, todos: TodoItem[]) => host.setTodos(String(sessionId), Array.isArray(todos) ? todos : []))
  handle('agent:plan', (sessionId: string) => host.plan(String(sessionId)))
  handle('agent:set-plan', (sessionId: string, plan: PlanRequest | null) => host.setPlan(String(sessionId), plan ?? null))

  handle('agent:compact', (sessionId: string) => host.compact(String(sessionId)))
  // Rewinding: the host works the plan out again from the record and the disk, so the renderer only names the request and echoes the fingerprint.
  handle('agent:checkpoints', (sessionId: string) => host.checkpoints(String(sessionId)).catch((error) => Promise.reject(hostFailure(error))))
  handle('agent:rewind-plan', (sessionId: string, turn: string) => host.rewindPlan(String(sessionId), String(turn)).catch((error) => Promise.reject(hostFailure(error))))
  handle('agent:redo-plan', (sessionId: string) => host.redoPlan(String(sessionId)).catch((error) => Promise.reject(hostFailure(error))))
  handle('agent:rewind-apply', (sessionId: string, request: unknown) =>
    host.rewindApply(String(sessionId), rewindRequestOf(request)).catch((error) => Promise.reject(hostFailure(error))),
  )
  handle('agent:rewind-conversation', (sessionId: string, entryId: string) =>
    host.rewind(String(sessionId), String(entryId)).catch((error) => Promise.reject(hostFailure(error))),
  )
  // The host writes the transcript; the save dialog and the file are the main process's.
  handle('agent:export', async (sessionId: string, targetPath?: string) =>
    exportSessionZip(await host.exportData(String(sessionId)), targetPath ? String(targetPath) : undefined),
  )
  handle('app:feedback', (text: string) => {
    const file = join(app.getPath('userData'), 'feedback.jsonl')
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), text: String(text) })}\n`)
  })

  // The report is made now, shown to nobody, and written where the user says; nothing leaves the computer by itself.
  handle('app:export-diagnostics', async () => {
    // A test run answers the save dialog in advance; a packaged build never does.
    const answered = app.isPackaged ? undefined : process.env.ENCODE_DIAGNOSTICS_FILE
    if (answered) {
      writeFileSync(answered, await diagnostics(), 'utf8')
      return answered
    }
    const win = getWindow()
    const options = {
      title: 'Save diagnostics',
      defaultPath: join(app.getPath('downloads'), diagnosticsFileName(Date.now())),
      filters: [{ name: 'Text', extensions: ['txt'] }],
    }
    const picked = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return null
    writeFileSync(picked.filePath, await diagnostics(), 'utf8')
    return picked.filePath
  })
  handle('app:test-notification', () => testNotice())
  handle('app:screen-reader', () => app.isAccessibilitySupportEnabled())
  handle('app:open-logs', async () => {
    logs.flush()
    const failure = await osShell.openPath(logs.dir)
    if (failure) throw new Error(failure)
  })

  handle('jobs:list', () => host.jobs())
  handle('jobs:output', (id: string) => host.jobOutput(String(id)))
  handle('jobs:kill', (id: string) => host.killJob(String(id)))

  handle('schedules:list', () => schedules.list())
  handle('schedules:create', (input: { prompt: string; sessionId: string; afterSeconds?: number; everySeconds?: number }) =>
    schedules.create(input),
  )
  handle('schedules:remove', (id: string) => schedules.remove(String(id)))
  handle('schedules:toggle', (id: string, enabled: boolean) => schedules.toggle(String(id), Boolean(enabled)))

  handle('skills:list', () => skills.list())
  handle('skills:read', (name: string) => skills.read(String(name)))
  handle('skills:create', (name: string, description?: string) =>
    skills.create(String(name), description ? String(description) : undefined),
  )
  handle('skills:open-folder', () => skills.openFolder())
  // The Permissions screen is about the folder that is open; the renderer never names one.
  handle('permissions:report', async () => {
    const root = workspace.current?.root
    if (!root) return null
    return agent.permissionsReport(root).catch((error) => Promise.reject(hostFailure(error)))
  })
  handle('permissions:act', async (action: PermissionsAction) => {
    const root = workspace.current?.root
    if (!root) throw new Error('Open a folder first.')
    return agent.permissionsAct(root, action).catch((error) => Promise.reject(hostFailure(error)))
  })
  // The MCP screen is about the folder that is open too.
  handle('mcp:report', async (options?: { start?: boolean }) => {
    const root = workspace.current?.root
    if (!root) return null
    return agent.mcpReport(root, { start: options?.start !== false }).catch((error) => Promise.reject(hostFailure(error)))
  })
  handle('mcp:act', async (action: McpAction) => {
    const root = workspace.current?.root
    if (!root) throw new Error('Open a folder first.')
    return agent.mcpAct(root, action).catch((error) => Promise.reject(hostFailure(error)))
  })
  // The Sandbox screen too.
  handle('sandbox:report', async () => {
    const root = workspace.current?.root
    if (!root) return null
    return agent.sandboxReport(root).catch((error) => Promise.reject(hostFailure(error)))
  })
  handle('sandbox:act', async (action: SandboxAction) => {
    const root = workspace.current?.root
    if (!root) throw new Error('Open a folder first.')
    return agent.sandboxAct(root, action).catch((error) => Promise.reject(hostFailure(error)))
  })
  // The answer is yes or no, or an object with a note and "for this session".
  handle('agent:approve', async (id: string, answer: unknown) => {
    await host.approve(String(id), approvalAnswerOf(answer))
  })
  handle('agent:answer', async (id: string, answer: string) => {
    await host.answer(String(id), String(answer))
  })
}

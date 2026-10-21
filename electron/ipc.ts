import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import type { AgentManager } from './agent/manager'
import type { GitService } from './services/git'
import type { JobService } from './services/jobs'
import type { ModelsService } from './services/models'
import type { ScheduleService } from './services/schedules'
import type { SettingsService } from './services/settings'
import type { ShellService } from './services/shell'
import type { SkillService } from './services/skills'
import type { WorkspaceService } from './services/workspace'
import type {
  AgentStartInput,
  PlanRequest,
  SearchOptions,
  SessionGoal,
  Settings,
  ShellCreateOptions,
  TodoItem,
} from '../shared/types'

export interface IpcDeps {
  getWindow: () => BrowserWindow | null
  settings: SettingsService
  workspace: WorkspaceService
  shell: ShellService
  jobs: JobService
  schedules: ScheduleService
  skills: SkillService
  models: ModelsService
  git: GitService
  agent: AgentManager
}

export function registerIpc(deps: IpcDeps): void {
  const { getWindow, settings, workspace, shell, jobs, schedules, skills, models, git, agent } = deps

  const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => fn(...args))
  }

  const sendToWindow = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  const openWorkspaceAt = async (rootPath: string) => {
    agent.reset()
    const opened = await workspace.open(rootPath)
    settings.touchWorkspace(opened.root)
    return opened
  }

  handle('app:version', () => process.env.npm_package_version ?? '0.1.0')
  handle('app:platform', () => process.platform)
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
    agent.reset()
    shell.disposeAll()
    await workspace.close()
    settings.setLastWorkspace(null)
  })
  handle('workspace:recent', () => settings.get().recentWorkspaces)
  handle('workspace:list', (rel: string) => workspace.list(String(rel ?? '')))
  handle('workspace:list-all', () => workspace.listAll())
  handle('workspace:read', (rel: string) => workspace.read(String(rel)))
  handle('workspace:write', (rel: string, content: string) => workspace.write(String(rel), String(content)))
  handle('workspace:create-file', (parent: string, name: string) => workspace.createFile(String(parent ?? ''), String(name)))
  handle('workspace:create-dir', (parent: string, name: string) => workspace.createDir(String(parent ?? ''), String(name)))
  handle('workspace:rename', (rel: string, newName: string) => workspace.rename(String(rel), String(newName)))
  handle('workspace:delete', (rel: string) => workspace.remove(String(rel)))
  handle('workspace:reveal', (rel: string) => workspace.reveal(String(rel)))
  handle('workspace:search', (options: SearchOptions) => workspace.search(options))

  handle('settings:get', () => settings.get())
  handle('settings:save', (patch: Partial<Settings>) => settings.save(patch))
  handle('settings:set-key', (profileId: string, key: string) => settings.setProfileKey(String(profileId), String(key ?? '')))

  handle('models:openrouter', (freeOnly?: boolean) => models.openRouter(Boolean(freeOnly)))
  handle('models:provider', (profileId: string) => models.provider(String(profileId)))
  handle('models:test', (profileId: string) => models.test(String(profileId)))

  handle('git:status', () => git.status())

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

  handle('agent:sessions', () => agent.list())
  handle('agent:create', () => agent.create())
  handle('agent:history', (sessionId?: string) => agent.history(sessionId ? String(sessionId) : undefined))
  handle('agent:start', (sessionId: string, input: AgentStartInput) => agent.start(String(sessionId), input))
  handle('agent:cancel', (sessionId: string) => agent.cancel(String(sessionId)))
  handle('agent:reset', (sessionId?: string) => agent.reset(sessionId ? String(sessionId) : undefined))
  handle('agent:remove', (sessionId: string) => agent.remove(String(sessionId)))
  handle('agent:fork', (sessionId: string) => agent.fork(String(sessionId)))
  handle('agent:rename', (sessionId: string, title: string) => agent.rename(String(sessionId), String(title)))
  handle('agent:goal', (sessionId: string) => agent.goal(String(sessionId)))
  handle('agent:set-goal', (sessionId: string, goal: SessionGoal | null) =>
    agent.setGoal(String(sessionId), goal ?? null),
  )
  handle('agent:todos', (sessionId: string) => agent.todos(String(sessionId)))
  handle('agent:set-todos', (sessionId: string, todos: TodoItem[]) =>
    agent.setTodos(String(sessionId), Array.isArray(todos) ? todos : []),
  )
  handle('agent:plan', (sessionId: string) => agent.plan(String(sessionId)))
  handle('agent:set-plan', (sessionId: string, plan: PlanRequest | null) =>
    agent.setPlan(String(sessionId), plan ?? null),
  )

  handle('agent:compact', (sessionId: string) => agent.compact(String(sessionId)))
  handle('agent:export', (sessionId: string, targetPath?: string) =>
    agent.exportSession(String(sessionId), targetPath ? String(targetPath) : undefined),
  )
  handle('app:feedback', (text: string) => {
    const file = join(app.getPath('userData'), 'feedback.jsonl')
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), text: String(text) })}\n`)
  })

  handle('jobs:list', () => jobs.list())
  handle('jobs:output', (id: string) => jobs.output(String(id)))
  handle('jobs:kill', (id: string) => jobs.kill(String(id)))

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
  handle('agent:approve', (id: string, approved: boolean) => agent.resolveApproval(String(id), Boolean(approved)))
  handle('agent:answer', (id: string, answer: string) => agent.resolveAnswer(String(id), String(answer)))
}

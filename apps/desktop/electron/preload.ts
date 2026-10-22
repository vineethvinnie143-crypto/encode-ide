import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentEvent,
  ApprovalAnswer,
  AgentStartInput,
  BackgroundJob,
  EncodeApi,
  ModelAlert,
  McpAction,
  PermissionsAction,
  PlanRequest,
  RewindRequest,
  SearchOptions,
  SessionGoal,
  SessionPatch,
  Settings,
  ShellCreateOptions,
  ShellPromptInfo,
  TodoItem,
  ZoomAction,
} from '../shared/types'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

function on<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: EncodeApi = {
  app: {
    about: () => invoke('app:about'),
    user: () => invoke('app:user'),
    feedback: (text: string) => invoke('app:feedback', text),
    exportDiagnostics: () => invoke('app:export-diagnostics'),
    openLogs: () => invoke('app:open-logs'),
  },
  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggle-maximize'),
    toggleFullScreen: () => invoke('window:toggle-fullscreen'),
    zoom: (action: ZoomAction) => invoke('window:zoom', action),
    close: () => invoke('window:close'),
    onStateChange: (callback) => on('window:state', callback),
  },
  workspace: {
    openDialog: () => invoke('workspace:open-dialog'),
    openPath: (path: string) => invoke('workspace:open-path', path),
    get: () => invoke('workspace:get'),
    close: () => invoke('workspace:close'),
    recent: () => invoke('workspace:recent'),
    list: (path: string) => invoke('workspace:list', path),
    listAllFiles: () => invoke('workspace:list-all'),
    read: (path: string) => invoke('workspace:read', path),
    write: (path: string, content: string) => invoke('workspace:write', path, content),
    createFile: (parent: string, name: string) => invoke('workspace:create-file', parent, name),
    createDir: (parent: string, name: string) => invoke('workspace:create-dir', parent, name),
    rename: (path: string, newName: string) => invoke('workspace:rename', path, newName),
    delete: (path: string) => invoke('workspace:delete', path),
    reveal: (path: string) => invoke('workspace:reveal', path),
    search: (options: SearchOptions) => invoke('workspace:search', options),
    onFileChanged: (callback) => on('workspace:file-changed', callback),
  },
  settings: {
    get: () => invoke('settings:get'),
    save: (patch: Partial<Settings>) => invoke('settings:save', patch),
    setProfileKey: (id: string, key: string) => invoke('settings:set-key', id, key),
  },
  models: {
    openRouter: (freeOnly?: boolean) => invoke('models:openrouter', freeOnly),
    provider: (id: string) => invoke('models:provider', id),
    test: (id: string) => invoke('models:test', id),
    status: () => invoke('models:status'),
    recheck: () => invoke('models:recheck'),
    onAlert: (callback) => on<ModelAlert>('models:alert', callback),
  },
  git: {
    status: () => invoke('git:status'),
  },
  shell: {
    create: (options: ShellCreateOptions) => invoke('shell:create', options),
    run: (id: string, line: string) => invoke('shell:run', id, line),
    cancel: (id: string) => invoke('shell:cancel', id),
    close: (id: string) => invoke('shell:close', id),
    complete: (id: string, line: string) => invoke('shell:complete', id, line),
    onData: (callback) => on<{ id: string; text: string }>('shell:data', (payload) => callback(payload.id, payload.text)),
    onPrompt: (callback) => on<ShellPromptInfo>('shell:prompt', callback),
    onExit: (callback) => on<{ id: string; code: number }>('shell:exit', (payload) => callback(payload.id, payload.code)),
  },
  jobs: {
    list: () => invoke('jobs:list'),
    output: (id: string) => invoke('jobs:output', id),
    kill: (id: string) => invoke('jobs:kill', id),
    onChange: (callback) => on('jobs:changed', callback),
  },
  schedules: {
    list: () => invoke('schedules:list'),
    create: (input: { prompt: string; sessionId: string; afterSeconds?: number; everySeconds?: number }) =>
      invoke('schedules:create', input),
    remove: (id: string) => invoke('schedules:remove', id),
    toggle: (id: string, enabled: boolean) => invoke('schedules:toggle', id, enabled),
  },
  skills: {
    list: () => invoke('skills:list'),
    read: (name: string) => invoke('skills:read', name),
    create: (name: string, description?: string) => invoke('skills:create', name, description),
    openFolder: () => invoke('skills:open-folder'),
  },
  permissions: {
    report: () => invoke('permissions:report'),
    act: (action: PermissionsAction) => invoke('permissions:act', action),
  },
  mcp: {
    report: (options) => invoke('mcp:report', options),
    act: (action: McpAction) => invoke('mcp:act', action),
    onChanged: (callback) => on('mcp:changed', callback),
  },
  agent: {
    sessions: () => invoke('agent:sessions'),
    createSession: (options?: { projectRoot?: string | null }) => invoke('agent:create', options),
    update: (sessionId: string, patch: SessionPatch) => invoke('agent:update', sessionId, patch),
    statuses: () => invoke('agent:statuses'),
    history: (sessionId?: string) => invoke('agent:history', sessionId),
    start: (sessionId: string, input: AgentStartInput) => invoke('agent:start', sessionId, input),
    cancel: (sessionId: string) => invoke('agent:cancel', sessionId),
    reset: (sessionId?: string) => invoke('agent:reset', sessionId),
    remove: (sessionId: string) => invoke('agent:remove', sessionId),
    fork: (sessionId: string) => invoke('agent:fork', sessionId),
    rename: (sessionId: string, title: string) => invoke('agent:rename', sessionId, title),
    goal: (sessionId: string) => invoke('agent:goal', sessionId),
    setGoal: (sessionId: string, goal: SessionGoal | null) => invoke('agent:set-goal', sessionId, goal),
    todos: (sessionId: string) => invoke('agent:todos', sessionId),
    setTodos: (sessionId: string, todos: TodoItem[]) => invoke('agent:set-todos', sessionId, todos),
    compact: (sessionId: string) => invoke('agent:compact', sessionId),
    export: (sessionId: string, targetPath?: string) => invoke('agent:export', sessionId, targetPath),
    plan: (sessionId: string) => invoke('agent:plan', sessionId),
    setPlan: (sessionId: string, plan: PlanRequest | null) => invoke('agent:set-plan', sessionId, plan),
    checkpoints: (sessionId: string) => invoke('agent:checkpoints', sessionId),
    rewindPlan: (sessionId: string, turn: string) => invoke('agent:rewind-plan', sessionId, turn),
    redoPlan: (sessionId: string) => invoke('agent:redo-plan', sessionId),
    rewindApply: (sessionId: string, request: RewindRequest) => invoke('agent:rewind-apply', sessionId, request),
    rewindConversation: (sessionId: string, entryId: string) => invoke('agent:rewind-conversation', sessionId, entryId),
    approve: (requestId: string, answer: boolean | ApprovalAnswer) => invoke('agent:approve', requestId, answer),
    answer: (requestId: string, answer: string) => invoke('agent:answer', requestId, answer),
    onEvent: (callback) => on<AgentEvent>('agent:event', callback),
  },
}

contextBridge.exposeInMainWorld('eNCode', api)

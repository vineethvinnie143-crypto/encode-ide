/**
 * A ToolContext for tests: a real directory, a real file-state tracker, and
 * services that fail loudly when a test did not expect them to be used.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ComputerState } from './computer/state'
import { DEFAULT_DESKTOP_OPTIONS, type DesktopBackend, type DesktopOptions } from './computer/contract'
import type { DesktopHandle } from './computer/state'
import { createFileStateTracker } from './file-state'
import type { AgentShell, Interaction, JobManager, ToolContext, WebAccess } from './types'

function unexpected(name: string): never {
  throw new Error(`The test did not expect ${name} to be used.`)
}

const noShell: AgentShell = {
  dialect: 'bash',
  program: '/bin/false',
  state: () => unexpected('the shell'),
  run: async () => unexpected('the shell'),
}

const noJobs: JobManager = {
  start: async () => unexpected('jobs'),
  read: () => unexpected('jobs'),
  kill: async () => unexpected('jobs'),
  list: () => [],
}

const noWeb: WebAccess = {
  fetch: async () => unexpected('the web'),
  search: async () => unexpected('the web'),
}

const noInteraction: Interaction = {
  ask: async () => unexpected('questions'),
  proposePlan: async () => unexpected('plans'),
  setTodos: () => unexpected('todos'),
}

export function testContext(root: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    root,
    home: os.homedir(),
    platform: process.platform,
    sessionId: 'session',
    agentId: 'main',
    mode: 'code',
    turnId: 'turn',
    toolUseId: 'call',
    signal: new AbortController().signal,
    files: createFileStateTracker(),
    shell: noShell,
    jobs: noJobs,
    web: noWeb,
    interaction: noInteraction,
    ...overrides,
  }
}

/** A fresh temporary directory (its real path), with `files` written into it. */
export async function tempWorkspace(files: Record<string, string | Buffer> = {}): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'encode-tools-')))
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }
  return root
}

export function textOf(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === 'string' ? content : content.map((block) => block.text ?? `[${block.type}]`).join('\n')
}

export { FakeDesktop, type FakeElement, type FakeWindow } from './computer/fake'

/**
 * What a session hands the Computer tool, over a backend a test controls. `permitted` is the set of
 * applications the user allowed; `vision` says whether the model reads images.
 */
export function testDesktop(
  backend: DesktopBackend,
  options: { permitted?: Iterable<string> | 'all'; vision?: boolean; options?: Partial<DesktopOptions>; state?: ComputerState } = {},
): DesktopHandle {
  const permitted = options.permitted === 'all' ? undefined : new Set(options.permitted ?? [])
  return {
    backend,
    state: options.state ?? new ComputerState(),
    options: { ...DEFAULT_DESKTOP_OPTIONS, pace: 'instant', ...options.options },
    permitted: (app) => (permitted ? permitted.has(app) : true),
    vision: () => options.vision ?? true,
  }
}

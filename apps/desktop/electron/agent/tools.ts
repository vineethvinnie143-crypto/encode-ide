import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import type { AgentMode, ApprovalPolicy, Settings } from '../../shared/types'
import { buildDiff } from './diff'
import type { ParsedToolCall, ToolContext, ToolResult, ToolSchema } from './types'

export { buildDiff } from './diff'

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'release', '.next', '.nuxt', '.turbo',
  '.venv', 'venv', '__pycache__', 'target', '.idea', '.cache', '.gradle', '.svelte-kit',
  'vendor', 'coverage', '.eNCode',
])

const READ_MAX_LINES = 2000

function err(message: string): ToolResult {
  return { ok: false, output: message }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

async function readIfExists(ctx: ToolContext, rel: string): Promise<string | null> {
  try {
    const file = await ctx.workspace.read(rel)
    return file.content
  } catch {
    return null
  }
}

async function listFiles(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const rel = asString(input.path).trim()
  const depth = clamp(asNumber(input.depth, 2), 1, 6)
  const abs = ctx.workspace.resolve(rel)

  const lines: string[] = []
  const maxLines = 400

  const walk = async (dirAbs: string, relPath: string, level: number): Promise<void> => {
    if (lines.length >= maxLines) return
    let dirents: Dirent[]
    try {
      dirents = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })

    for (const dirent of dirents) {
      if (lines.length >= maxLines) return
      if (dirent.name === '.git') continue
      const childRel = relPath ? `${relPath}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        if (IGNORED_DIRS.has(dirent.name)) continue
        lines.push(`${childRel}/`)
        if (level < depth) await walk(path.join(dirAbs, dirent.name), childRel, level + 1)
      } else if (dirent.isFile()) {
        lines.push(childRel)
      }
    }
  }

  await walk(abs, rel, 0)
  if (!lines.length) return { ok: true, output: '(empty directory)' }
  const truncated = lines.length >= maxLines
  return {
    ok: true,
    output: lines.join('\n') + (truncated ? `\n… (listing truncated at ${maxLines} entries)` : ''),
  }
}

async function readFile(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const rel = asString(input.path).trim()
  if (!rel) return err('path is required')
  const file = await ctx.workspace.read(rel)
  if (file.binary) return err(`${rel} looks like a binary file and cannot be read as text.`)

  const lines = file.content.split(/\r?\n/)
  const start = clamp(asNumber(input.start_line, 1), 1, Math.max(1, lines.length))
  const requestedEnd = asNumber(input.end_line, lines.length)
  const end = clamp(requestedEnd, start, Math.min(lines.length, start + READ_MAX_LINES - 1))
  const width = String(end).length

  const body = lines
    .slice(start - 1, end)
    .map((line, index) => `${String(start + index).padStart(width, ' ')}\t${line}`)
    .join('\n')

  return {
    ok: true,
    output: `File: ${rel} (${lines.length} lines total${file.size ? `, ${file.size} bytes` : ''})\n${body}`,
  }
}

async function writeFile(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const rel = asString(input.path).trim()
  if (!rel) return err('path is required')
  const content = asString(input.content)
  const previous = await readIfExists(ctx, rel)
  const diff = buildDiff(rel, previous ?? '', content)
  await ctx.workspace.write(rel, content)
  const action = previous === null ? 'Created' : 'Overwrote'
  return {
    ok: true,
    output: `${action} ${rel} (${content.length} chars${previous !== null ? `, was ${previous.length}` : ''}).`,
    diff,
    changedPath: rel,
  }
}

async function replaceInFile(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const rel = asString(input.path).trim()
  const oldString = asString(input.old_string)
  const newString = asString(input.new_string)
  if (!rel) return err('path is required')
  if (!oldString) return err('old_string is required')

  const file = await ctx.workspace.read(rel)
  if (file.binary) return err(`${rel} is a binary file.`)

  let content = file.content
  let actualOld = oldString
  let index = content.indexOf(actualOld)

  // Tolerate CRLF files when the model emitted LF snippets.
  if (index === -1 && oldString.includes('\n') && content.includes('\r\n')) {
    const crlfOld = oldString.replace(/\n/g, '\r\n')
    if (content.includes(crlfOld)) {
      index = content.indexOf(crlfOld)
      actualOld = crlfOld
    }
  }

  if (index === -1) {
    return err(
      `old_string was not found in ${rel}. Read the file again and copy the exact text, including indentation and line endings.`,
    )
  }
  if (content.indexOf(actualOld, index + actualOld.length) !== -1) {
    return err(`old_string matches more than one place in ${rel}. Include more surrounding context so it is unique.`)
  }

  const actualNew = actualOld === oldString ? newString : newString.replace(/\n/g, '\r\n')
  const updated = content.slice(0, index) + actualNew + content.slice(index + actualOld.length)
  const diff = buildDiff(rel, content, updated)
  await ctx.workspace.write(rel, updated)

  return { ok: true, output: `Edited ${rel}.`, diff, changedPath: rel }
}

async function searchFiles(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const query = asString(input.query)
  if (!query) return err('query is required')
  const include = asString(input.include).trim() || undefined
  const maxResults = clamp(asNumber(input.max_results, 60), 1, 200)

  const result = await ctx.workspace.search({ query, include, maxResults })
  if (!result.matches.length) {
    return { ok: true, output: `No matches for "${query}"${include ? ` in ${include}` : ''}.` }
  }
  const lines = result.matches.map((m) => `${m.path}:${m.line}:${m.column}: ${m.lineText}`)
  return {
    ok: true,
    output: lines.join('\n') + (result.truncated ? `\n… (truncated at ${maxResults} matches)` : ''),
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

async function webFetch(input: Record<string, unknown>): Promise<ToolResult> {
  const url = asString(input.url).trim()
  if (!/^https?:\/\//i.test(url)) return err('url must start with http:// or https://')
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'eNCode/0.1 (+local coding harness)' },
    })
    if (!response.ok) return err(`request failed with HTTP ${response.status}`)
    const text = await response.text()
    const plain = /<html|<!doctype/i.test(text) ? htmlToText(text) : text
    return { ok: true, output: plain.slice(0, 20_000) || '(empty response)' }
  } catch (error) {
    return err(`fetch failed: ${(error as Error).message}`)
  }
}

async function webSearch(input: Record<string, unknown>): Promise<ToolResult> {
  const query = asString(input.query).trim()
  if (!query) return err('query is required')
  try {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
    })
    if (response.ok) {
      const html = await response.text()
      const results: string[] = []
      const pattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
      let match: RegExpExecArray | null
      while ((match = pattern.exec(html)) !== null && results.length < 8) {
        const href = match[1].replace(/&amp;/g, '&')
        const title = htmlToText(match[2])
        if (title) results.push(`- ${title}\n  ${href}`)
      }
      if (results.length) return { ok: true, output: `Results for "${query}":\n${results.join('\n')}` }
    }

    const fallback = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { 'user-agent': 'eNCode/0.1' } },
    )
    if (!fallback.ok) return err(`search failed with HTTP ${fallback.status}`)
    const json = (await fallback.json()) as { AbstractText?: string; RelatedTopics?: { Text?: string }[] }
    const lines: string[] = []
    if (json.AbstractText) lines.push(json.AbstractText)
    for (const topic of json.RelatedTopics ?? []) {
      if (topic.Text && lines.length < 8) lines.push(`- ${topic.Text}`)
    }
    return lines.length
      ? { ok: true, output: `Results for "${query}":\n${lines.join('\n')}` }
      : { ok: true, output: `No web results for "${query}".` }
  } catch (error) {
    return err(`search failed: ${(error as Error).message}`)
  }
}

async function todoWrite(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const raw = Array.isArray(input.todos) ? input.todos : []
  const todos = raw
    .map((entry, index) => {
      const item = entry as { text?: unknown; status?: unknown }
      const status = String(item?.status ?? 'pending')
      return {
        id: `todo-${index + 1}`,
        text: String(item?.text ?? '').trim(),
        status: (['pending', 'in_progress', 'completed'].includes(status) ? status : 'pending') as
          | 'pending'
          | 'in_progress'
          | 'completed',
      }
    })
    .filter((item) => item.text)
  ctx.todos.set(todos)
  if (!todos.length) return { ok: true, output: 'Todo list cleared.' }
  const rendered = todos
    .map((item) => `[${item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '~' : ' '}] ${item.text}`)
    .join('\n')
  return { ok: true, output: `Todo list updated:\n${rendered}` }
}

function jobList(ctx: ToolContext): ToolResult {
  const jobs = ctx.jobs.list()
  if (!jobs.length) return { ok: true, output: 'No background jobs.' }
  return {
    ok: true,
    output: jobs
      .map((job) => `${job.id.slice(0, 8)} [${job.status}] ${job.command}${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ''}`)
      .join('\n'),
  }
}

function jobOutput(input: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const id = asString(input.id).trim()
  const job = ctx.jobs.list().find((item) => item.id === id || item.id.startsWith(id))
  if (!job) return err(`Unknown job: ${id}`)
  const output = ctx.jobs.output(job.id)
  return {
    ok: true,
    output: `[${job.status}] ${job.command}\n${output ? output.slice(-20_000) : '(no output yet)'}`,
  }
}

function jobKill(input: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const id = asString(input.id).trim()
  const job = ctx.jobs.list().find((item) => item.id === id || item.id.startsWith(id))
  if (!job) return err(`Unknown job: ${id}`)
  ctx.jobs.kill(job.id)
  return { ok: true, output: `Killed ${job.command}.` }
}

function loadSkill(input: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const name = asString(input.name).trim()
  if (!name) return err('name is required')
  try {
    return { ok: true, output: ctx.skills.read(name).slice(0, 20_000) }
  } catch (error) {
    return err((error as Error).message)
  }
}

async function runCommand(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = asString(input.command).trim()
  if (!command) return err('command is required')
  const cwdRel = asString(input.cwd).trim()
  const cwd = cwdRel ? ctx.workspace.resolve(cwdRel) : ctx.workspace.rootPath ?? process.cwd()
  const timeoutMs = clamp(asNumber(input.timeout_ms, 120_000), 1_000, 600_000)

  if (input.background === true) {
    const job = ctx.jobs.start(command, cwd, '')
    return {
      ok: true,
      output: `Started background job ${job.id.slice(0, 8)}: ${command}\nPoll it with job_output or list jobs with job_list.`,
    }
  }

  const result = await ctx.shell.capture(command, cwd, timeoutMs, ctx.signal)
  let output = result.output
  if (output.length > 60_000) output = `${output.slice(0, 60_000)}\n… (output truncated)`

  if (result.aborted) return { ok: false, output: `Command cancelled.\n${output}` }
  if (result.timedOut) return { ok: false, output: `Command timed out after ${timeoutMs}ms.\n${output}` }
  return { ok: result.code === 0, output: `exit code ${result.code}\n${output}` }
}

export async function executeTool(call: ParsedToolCall, ctx: ToolContext): Promise<ToolResult> {
  const name = call.name
  const input = call.input ?? {}

  try {
    if (ctx.mode === 'ask' && (name === 'write' || name === 'write_file' || name === 'edit' || name === 'replace_in_file' || name === 'pwsh' || name === 'run_command')) {
      return err('This is ASK mode (read-only). File edits and commands are disabled. Explain the proposed change instead, or switch to CODE mode.')
    }
    if (ctx.mode === 'plan' && (name === 'write' || name === 'write_file' || name === 'edit' || name === 'replace_in_file' || name === 'pwsh' || name === 'run_command')) {
      return err('This is PLAN mode (read-only). Investigate the project, then submit your implementation plan with exit_plan_mode.')
    }

    const policy = (ctx.settings.raw() as { policy?: ApprovalPolicy }).policy
    if (policy === 'read-only' && (name === 'write' || name === 'write_file' || name === 'edit' || name === 'replace_in_file' || name === 'pwsh' || name === 'run_command')) {
      return err('This session is in Read Only policy, so file changes and commands are blocked. Ask the user to switch the policy (Workspace Write, Full access or Auto review) to continue.')
    }

    switch (name) {
      case 'glob':
      case 'list_files':
        return await listFiles(input, ctx)
      case 'read':
      case 'read_file':
        return await readFile(input, ctx)
      case 'write':
      case 'write_file':
        return await writeFile(input, ctx)
      case 'edit':
      case 'replace_in_file':
        return await replaceInFile(input, ctx)
      case 'grep':
      case 'search_files':
        return await searchFiles(input, ctx)
      case 'pwsh':
      case 'run_command':
        return await runCommand(input, ctx)
      case 'ask_user_question':
      case 'ask_followup_question': {
        const question = asString(input.question).trim()
        if (!question) return err('question is required')
        const options = Array.isArray(input.options) ? input.options.map(String) : undefined
        const answer = await ctx.ask(question, options)
        return { ok: true, output: `User answered: ${answer}` }
      }
      case 'todo_write':
        return await todoWrite(input, ctx)
      case 'job_list':
        return jobList(ctx)
      case 'job_output':
        return jobOutput(input, ctx)
      case 'job_kill':
        return jobKill(input, ctx)
      case 'skill':
      case 'load_skill':
        return loadSkill(input, ctx)
      case 'web_fetch':
        return await webFetch(input)
      case 'web_search':
        return await webSearch(input)
      case 'exit_plan_mode': {
        const plan = asString(input.plan).trim()
        if (!plan) return err('plan is required')
        ctx.proposePlan(plan)
        return { ok: true, output: plan, done: true, summary: 'Plan proposed.' }
      }
      case 'get_goal': {
        const goal = ctx.goals.get()
        return { ok: true, output: goal ? JSON.stringify(goal, null, 2) : 'No goal is set.' }
      }
      case 'create_goal': {
        const text = asString(input.goal).trim()
        if (!text) return err('goal is required')
        const existing = ctx.goals.get()
        if (existing) return err(`A goal already exists: "${existing.text}" (status ${existing.status}). Update it instead.`)
        const now = Date.now()
        ctx.goals.set({ text, status: 'active', rounds: 0, createdAt: now, updatedAt: now })
        return { ok: true, output: `Goal set: ${text}` }
      }
      case 'update_goal': {
        const goal = ctx.goals.get()
        if (!goal) return err('There is no goal to update. Call create_goal first.')
        const status = asString(input.status).trim().toLowerCase()
        if (!['active', 'paused', 'complete', 'blocked'].includes(status)) {
          return err('status must be one of: active, paused, complete, blocked')
        }
        const reason = asString(input.reason).trim()
        ctx.goals.set({ ...goal, status: status as typeof goal.status, updatedAt: Date.now() })
        const suffix = reason ? ` (${reason})` : ''
        return { ok: true, output: `Goal marked ${status}${suffix}.`, done: status === 'complete' || status === 'blocked', summary: `Goal ${status}.` }
      }
      case 'attempt_completion': {
        const summary = (asString(input.result) || asString(input.summary)).trim() || 'Task complete.'
        return { ok: true, output: summary, done: true, summary }
      }
      default:
        return err(`Unknown tool "${name}". Use only the tools provided.`)
    }
  } catch (error) {
    return err(`Error: ${(error as Error).message}`)
  }
}

const SAFE_COMMAND = /^(ls|dir|cat|type|pwd|head|tail|wc|which|git status|git diff|git log|node --version|npm --version|npm test|npm run (build|test|lint|typecheck)|tsc)\b/i

/** Mirrors the harness policy menu: read-only, workspace-write, full-access, auto-review. */
export function requiresApprovalFor(
  tool: string,
  settings: Pick<Settings, 'autoApprove' | 'autoApproveCommands'> & { policy?: ApprovalPolicy },
  mode: AgentMode,
  input: Record<string, unknown> = {},
): boolean {
  if (mode === 'ask' || mode === 'plan') return false
  switch (settings.policy) {
    case 'read-only':
    case 'full-access':
      return false
    case 'workspace-write':
      return tool === 'run_command' || tool === 'pwsh'
    case 'auto-review':
      if (tool !== 'run_command' && tool !== 'pwsh') return false
      return !SAFE_COMMAND.test(String(input.command ?? '').trim())
    default:
      break
  }
  if (tool === 'write' || tool === 'write_file' || tool === 'edit' || tool === 'replace_in_file') return !settings.autoApprove
  if (tool === 'run_command' || tool === 'pwsh') return !settings.autoApproveCommands
  return false
}

export function summarizeApproval(tool: string, input: Record<string, unknown>): { title: string; detail: string } {
  if (tool === 'write_file') {
    const content = asString(input.content)
    return {
      title: `Write ${asString(input.path) || '(missing path)'}`,
      detail: `${content.split('\n').length} lines · ${content.length} chars`,
    }
  }
  if (tool === 'replace_in_file') {
    return {
      title: `Edit ${asString(input.path) || '(missing path)'}`,
      detail: `Replace ${asString(input.old_string).length} chars with ${asString(input.new_string).length} chars`,
    }
  }
  if (tool === 'run_command') {
    return { title: 'Run command', detail: asString(input.command) || '(missing command)' }
  }
  return { title: tool, detail: '' }
}

export const toolDefs: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'List files and folders of the workspace as an indented tree. Use it to discover the project before reading or editing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory relative to the workspace root. Omit or "" for the root.' },
          depth: { type: 'number', description: 'How deep to recurse (1-6). Default 2.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a text file with line numbers. Always read before editing a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          start_line: { type: 'number', description: '1-based first line. Default 1.' },
          end_line: { type: 'number', description: '1-based last line. Default end of file.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Create a file or completely overwrite an existing one. Parent directories are created automatically. Prefer replace_in_file for small edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          content: { type: 'string', description: 'Complete new file contents.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description: 'Replace a unique snippet in an existing file. old_string must match the file exactly (including indentation) and appear exactly once.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          old_string: { type: 'string', description: 'Exact text to find. Must be unique in the file.' },
          new_string: { type: 'string', description: 'Replacement text. Use an empty string to delete.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with a literal string or regular expression. Returns path, line and column for each match.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regular expression to find.' },
          include: { type: 'string', description: 'Optional comma separated globs, e.g. "src/**/*.ts,**/*.json".' },
          max_results: { type: 'number', description: 'Maximum matches (default 60, max 200).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pwsh',
      description: 'Run a shell command in the workspace and return stdout, stderr and the exit code. Non-interactive; avoid servers and watch modes.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line to execute.' },
          cwd: { type: 'string', description: 'Optional working directory relative to the workspace root.' },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000).' },
          background: { type: 'boolean', description: 'Run as a background job and return its id immediately.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user_question',
      description: 'Ask the user a question when you are genuinely blocked and only the user can provide the missing information.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers.' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_goal',
      description: 'Set the session goal when the user asks for a long-running objective. Only one goal can exist at a time.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The concrete objective to pursue across turns.' },
        },
        required: ['goal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_goal',
      description: 'Update the session goal status: active, paused, complete or blocked. Use complete when the objective is genuinely finished.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'paused', 'complete', 'blocked'] },
          reason: { type: 'string', description: 'Optional short reason, required when blocked.' },
        },
        required: ['status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'Publish or update the task list for the current work. Pass the complete list each time.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['text', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task',
      description: 'Delegate a self-contained investigation or subtask to a subagent and get its summary back.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Precise instructions, including what to report back.' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'job_list',
      description: 'List background jobs started with run_command background:true.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'job_output',
      description: 'Read the accumulated output of a background job.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Job id (prefix is enough).' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'job_kill',
      description: 'Stop a running background job.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill',
      description: 'Load the full instructions of a saved skill by name.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information. Use web_fetch to read a promising result.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch an HTTP(S) URL and return its readable text.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exit_plan_mode',
      description: 'In plan mode, submit the final implementation plan for user approval.',
      parameters: {
        type: 'object',
        properties: { plan: { type: 'string', description: 'Ordered, concrete implementation plan.' } },
        required: ['plan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'attempt_completion',
      description: 'Signal that the task is finished. Call this instead of writing a final answer as plain text.',
      parameters: {
        type: 'object',
        properties: {
          result: { type: 'string', description: 'Concise summary of what was done and verified.' },
        },
        required: ['result'],
      },
    },
  },
]

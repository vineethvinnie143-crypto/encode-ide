/** Adds compaction, session export and feedback plumbing. */
import fs from 'node:fs'

const edits = [
  ['electron/agent/agent.ts', '  /** Snapshot for session persistence. */',
    `  /** Replace the transcript (used by compaction). */
  setMessages(messages: ChatMessage[]): void {
    this.messages = messages.map((message) => structuredClone(message))
  }

  /** Snapshot for session persistence. */`],

  ['electron/agent/manager.ts', "import { Agent } from './agent'",
    "import { Agent } from './agent'\nimport { exportSessionZip } from '../services/export'"],

  ['electron/agent/manager.ts', '  dispose(): void {',
    `  /** Compacts older history: keeps the system prompt plus the recent tail. */
  compact(sessionId: string): { removed: number } {
    const id = sessionId || this.list()[0].id
    const agent = this.agent(id)
    const snapshot = agent.snapshot()
    const messages = snapshot.messages
    if (messages.length <= 12) return { removed: 0 }
    const system = messages.filter((message) => message.role === 'system')
    const tail = messages.slice(-12)
    const removed = messages.length - system.length - tail.length
    agent.setMessages([...system, ...tail])
    this.capture(id)
    this.deps.emit({
      type: 'entry',
      entry: {
        id: randomUUID(),
        kind: 'notice',
        text: \`Compacted \${removed} earlier messages to free up context.\`,
        createdAt: Date.now(),
      },
      sessionId: id,
    })
    this.persistNow()
    return { removed }
  }

  /** Builds the markdown + json payload and writes it as a zip archive. */
  async exportSession(sessionId: string, targetPath?: string): Promise<string | null> {
    const id = sessionId || this.list()[0].id
    const summary = this.summary(id)
    const history = this.agent(id).getHistory()
    const entries = history.entries
    const transcript = [
      \`# \${summary.title}\`,
      '',
      ...entries.map((entry) => {
        if (entry.kind === 'tool') {
          const path = String(entry.tool?.input.path ?? entry.tool?.input.command ?? '')
          return \`## \${entry.tool?.name ?? 'tool'} \${path}\\n\\n\\\`\\\`\\\`\\n\${entry.tool?.output ?? ''}\\n\\\`\\\`\\\`\\n\`
        }
        return \`## \${entry.kind}\\n\\n\${entry.text ?? ''}\\n\`
      }),
    ].join('\\n')
    const json = JSON.stringify(
      { ...summary, goal: this.goals.get(id) ?? null, todos: this.todosBySession.get(id) ?? [], entries },
      null,
      2,
    )
    return exportSessionZip({ title: summary.title, transcript, json }, targetPath)
  }

  dispose(): void {`],

  ['electron/ipc.ts', "  handle('jobs:list', () => jobs.list())",
    `  handle('agent:compact', (sessionId: string) => agent.compact(String(sessionId)))
  handle('agent:export', (sessionId: string, targetPath?: string) =>
    agent.exportSession(String(sessionId), targetPath ? String(targetPath) : undefined),
  )
  handle('app:feedback', (text: string) => {
    const file = join(app.getPath('userData'), 'feedback.jsonl')
    appendFileSync(file, \`\${JSON.stringify({ at: Date.now(), text: String(text) })}\\n\`)
  })

  handle('jobs:list', () => jobs.list())`],

  ['electron/ipc.ts', "import { BrowserWindow, dialog, ipcMain } from 'electron'\nimport os from 'node:os'",
    "import { BrowserWindow, app, dialog, ipcMain } from 'electron'\nimport { appendFileSync } from 'node:fs'\nimport { join } from 'node:path'\nimport os from 'node:os'"],

  ['electron/preload.ts', "    plan: (sessionId: string) => invoke('agent:plan', sessionId),",
    `    compact: (sessionId: string) => invoke('agent:compact', sessionId),
    export: (sessionId: string, targetPath?: string) => invoke('agent:export', sessionId, targetPath),
    plan: (sessionId: string) => invoke('agent:plan', sessionId),`],

  ['electron/preload.ts', "    user: () => invoke('app:user'),",
    "    user: () => invoke('app:user'),\n    feedback: (text: string) => invoke('app:feedback', text),"],

  ['shared/types.ts', '    plan(sessionId: string): Promise<PlanRequest | null>',
    `    compact(sessionId: string): Promise<{ removed: number }>
    export(sessionId: string, targetPath?: string): Promise<string | null>
    plan(sessionId: string): Promise<PlanRequest | null>`],

  ['shared/types.ts', '    user(): Promise<string>',
    '    user(): Promise<string>\n    feedback(text: string): Promise<void>'],
]

let changed = 0
for (const [file, from, to] of edits) {
  const text = fs.readFileSync(file, 'utf8')
  if (!text.includes(from)) {
    console.log(`MISS ${file}: ${from.slice(0, 60).replace(/\n/g, '\\n')}`)
    continue
  }
  fs.writeFileSync(file, text.replace(from, to), 'utf8')
  changed += 1
}
console.log(`applied ${changed}/${edits.length}`)

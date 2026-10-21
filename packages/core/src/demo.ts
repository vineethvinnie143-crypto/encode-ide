/**
 * The offline demo agent: a scripted model that lists the workspace, writes a
 * small note through the approval flow and reads it back. It lets someone try
 * the app (streaming, tool cards, diffs, approvals) before connecting a real
 * model, and it needs no network or key.
 */
import path from 'node:path'
import { messageText, type CompletionRequest, type Message } from '@encode/providers'
import { createScriptedClient, type ScriptedClient, type ScriptedStep } from './scripted'

export const DEMO_NOTE = '.encode/demo-note.md'

const NOTE_CONTENT = [
  '# eNCode demo',
  '',
  'This file was written by the offline demo agent.',
  '',
  '- Tools run locally against your real workspace.',
  '- Connect a model in Settings, or use the free models that come with eNCode.',
  '- Choose how much runs without asking from the approval chip in the composer.',
  '',
].join('\n')

const ROOT_PATTERN = /Workspace root: (.+)/

/** The workspace root named in the conversation's environment reminder. */
function rootOf(messages: readonly Message[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const match = ROOT_PATTERN.exec(messageText(message))
    if (match) return match[1].trim()
  }
  return process.cwd()
}

/** How many times the demo has answered since the user's last request. */
function stepOf(messages: readonly Message[]): { step: number; failed: boolean } {
  let last = messages.length - 1
  while (last >= 0) {
    const message = messages[last]
    if (message.role === 'user' && !message.content.some((block) => block.type === 'tool-result')) break
    last--
  }
  const since = messages.slice(last + 1)
  const lastResult = since.at(-1)
  const failed = lastResult?.role === 'user' && lastResult.content.some((block) => block.type === 'tool-result' && block.isError === true)
  return { step: since.filter((message) => message.role === 'assistant').length, failed: Boolean(failed) }
}

export function demoStep(request: CompletionRequest): ScriptedStep {
  const messages = request.payload.messages
  const root = rootOf(messages)
  const note = path.join(root, ...DEMO_NOTE.split('/'))
  const { step, failed } = stepOf(messages)
  if (request.role !== 'main') return { text: 'Offline demo.' }
  switch (step) {
    case 0:
      return { text: 'Let me look around the workspace first.', calls: [{ name: 'Glob', input: { pattern: '*', path: root } }] }
    case 1:
      return {
        text: 'I will create a small note so you can see edits, diffs and the approval flow in action. Approve or reject it when prompted.',
        calls: [{ name: 'Write', input: { file_path: note, content: NOTE_CONTENT } }],
      }
    case 2:
      if (failed) return { text: 'The note was not written, which is fine: that ends the demo. Connect a model in Settings to put the agent to work.' }
      return { text: 'Now let me read it back to confirm the write landed.', calls: [{ name: 'Read', input: { file_path: note } }] }
    default:
      return {
        text: `That completes the offline demo: I listed the workspace, created \`${DEMO_NOTE}\` through the approval flow and read it back. Connect a model in Settings to put the agent to work.`,
      }
  }
}

export function createDemoClient(): ScriptedClient {
  return createScriptedClient((request) => demoStep(request), { delayMs: 14, contextWindow: 200_000 })
}

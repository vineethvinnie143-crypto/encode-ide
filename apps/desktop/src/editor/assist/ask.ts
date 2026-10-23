import type { Text } from '@encode/text'
import type { EditorAnswer, EditorAsks, EditorTriggers } from '@shared/types'
import { api } from '../../api'
import { flushLanguageSync } from '../language'

/**
 * Asks the servers of a file the editor shows. The change still waiting for a pause in typing goes first, so the
 * answer is for the text as it is. Nothing that goes wrong reaches the person: no answer is an empty one.
 */
export async function askServers<K extends keyof EditorAsks>(ask: { kind: K } & EditorAsks[K]['params']): Promise<EditorAnswer<K>> {
  // A question asked while the editor hands out a change (a `(` typed asks for the parameters at once) comes before
  // the editor's other listeners have noted the change: it waits for them, or the servers would answer for the text
  // without it.
  await Promise.resolve()
  flushLanguageSync(ask.path)
  const empty = (ask.kind === 'highlights' ? [] : null) as EditorAnswer<K>
  return api.code.ask(ask).then(
    (answer) => answer ?? empty,
    () => empty,
  )
}

/** A position as the servers count it: a zero-based line, and the UTF-16 column in it. */
export function lspAt(doc: Text, pos: number): { line: number; character: number } {
  const line = doc.lineAt(pos)
  return { line: line.number - 1, character: pos - line.from }
}

/** What typing asks of each file's server, kept until a server starts or stops. */
const triggers = new Map<string, EditorTriggers | null>()
let generation = 0

/** The characters that ask a file's server for something; null while none runs for it. */
export async function triggersFor(path: string): Promise<EditorTriggers | null> {
  if (triggers.has(path)) return triggers.get(path)!
  const mine = generation
  const found = await askServers({ kind: 'triggers', path })
  // A server that started or stopped meanwhile may say otherwise: the next question asks again.
  if (mine === generation && found) triggers.set(path, found)
  return found
}

/** A server started, stopped or failed: what typing asks may have changed. */
export function forgetTriggers(): void {
  generation++
  triggers.clear()
}

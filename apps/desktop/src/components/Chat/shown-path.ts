import { createContext } from 'react'

/** The folder the conversation's agent works in, so a step names its files from there, as Codex does. */
export const WorkRoot = createContext<string | null>(null)

function slashed(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * A path as the chat shows it: inside the folder, from the folder with forward slashes ("src/app.ts", as the Review
 * tab and git show it); anywhere else, as it is. A Windows folder matches without regard to case.
 */
export function shownPath(path: string, root: string | null): string {
  if (!root || !path) return path
  const base = slashed(root)
  const full = slashed(path)
  if (!base) return path
  const fold = /^[a-z]:\//i.test(base) || base.startsWith('//') ? (text: string) => text.toLowerCase() : (text: string) => text
  if (fold(full) === fold(base)) return '.'
  const prefix = `${base}/`
  return full.length > prefix.length && fold(full.slice(0, prefix.length)) === fold(prefix) ? full.slice(prefix.length) : path
}

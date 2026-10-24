/**
 * The rules of the Browser tabs (ADR 0103), apart from Electron so that they are unit tested.
 *
 * A Browser tab is a <webview>: a page in a process of its own, in a session of its own. The person's tabs share one
 * session kept on disk, so a sign-in lasts. The agent's tab of a chat has a session kept in memory and shared with
 * nothing, so it starts signed out of everything and forgets it all when eNCode closes.
 */
import { createHash } from 'node:crypto'
import { isLocalHost } from '@encode/tools'

/** The person's tabs: cookies and sign-ins kept between runs. */
export const PERSON_PARTITION = 'persist:encode-browser'
/** A chat's agent tab: in memory, its name made from the chat's id. */
export const AGENT_PARTITION = /^encode-agent-([a-f0-9]{16})$/

/** The key of a chat's agent tab: the same chat always gets the same key, and the key does not give the chat's id away. */
export function agentKey(sessionId: string): string {
  return createHash('sha256').update(`encode-agent-tab:${sessionId}`).digest('hex').slice(0, 16)
}

export const agentPartition = (key: string): string => `encode-agent-${key}`

/** The key of an agent tab's partition, or null for any other partition. */
export function agentKeyOf(partition: string | undefined): string | null {
  return AGENT_PARTITION.exec(partition ?? '')?.[1] ?? null
}

/** What a tab may load: a web page, or the blank page it starts on. */
export function isWebUrl(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** A user agent without the Electron and eNCode tokens: a site answers it as it answers Chrome. */
export function plainUserAgent(userAgent: string): string {
  return userAgent
    .replace(/\s(Electron|eNCode|encode-desktop|@encode\/desktop)\/\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host.toLowerCase() : null
  } catch {
    return null
  }
}

const bare = (host: string) => host.replace(/^www\./, '')

/**
 * Whether the agent's tab may follow a link, a script or a redirect to `url` on its own: an address on this computer,
 * or a host the agent opened (with or without www.). Anywhere else the tab stays where it is, and the agent hears what
 * was held back: it can open that address, which asks the person like any web access.
 */
export function followsOnItsOwn(opened: ReadonlySet<string>, url: string): boolean {
  const host = hostOf(url)
  if (!host) return url === 'about:blank'
  if (isLocalHost(new URL(url).hostname)) return true
  for (const allowed of opened) if (bare(allowed) === bare(host)) return true
  return false
}

/** The host an address opens, for the agent tab's list of opened hosts; null for anything not http or https. */
export function openedHost(url: string): string | null {
  return hostOf(url)
}

/**
 * What a page in a Browser tab may ask for. The person's tabs may go full screen and write to the clipboard; nothing
 * else (camera, microphone, location, notifications, reading the clipboard, devices) is given, and the agent's tab
 * gets nothing at all.
 */
export function permits(permission: string, agent: boolean): boolean {
  if (agent) return false
  return permission === 'fullscreen' || permission === 'clipboard-sanitized-write'
}

/** A key as the DevTools protocol sends it. */
export interface KeyStroke {
  key: string
  code: string
  keyCode: number
  /** Alt 1, Control 2, Shift 8. */
  modifiers: number
  text?: string
}

const NAMED: Record<string, Omit<KeyStroke, 'modifiers'>> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  F5: { key: 'F5', code: 'F5', keyCode: 116 },
}
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Shift: 8 }

/** The key the Browser tool names (Enter, ArrowDown, Control+A), or null for one it does not press. */
export function keyStroke(name: string): KeyStroke | null {
  const named = NAMED[name]
  if (named) return { ...named, modifiers: 0 }
  const chord = /^(Control|Shift|Alt)\+([A-Za-z0-9])$/.exec(name)
  if (!chord) return null
  const char = chord[2]!
  const upper = char.toUpperCase()
  const digit = /\d/.test(char)
  const shifted = chord[1] === 'Shift'
  return {
    key: shifted ? upper : char.toLowerCase(),
    code: digit ? `Digit${char}` : `Key${upper}`,
    keyCode: upper.charCodeAt(0),
    modifiers: MODIFIERS[chord[1]!]!,
    // Shift and a letter types the capital; with Control or Alt it is a shortcut and types nothing.
    ...(shifted ? { text: upper } : {}),
  }
}

/**
 * What the Computer tool tells the model: the window list, a look at a window, the outcome of an input.
 * Every line is written to be read once by a model and acted on, so it states what is true now and what
 * the next step can use, and nothing else.
 */
import { classifyApp, labelFor } from './apps'
import type { ActResult, Capture, Element, Look, WindowInfo } from './contract'
import { diffOutlines, clip, formatOutline, untrustedScreenContent } from './outline'
import type { DesktopHandle } from './state'

const WINDOW_LINES = 40
const OUTLINE_LINES = 300
/** An outline printed in place of a change list that would have been as long. */
const REPLACEMENT_LINES = 80

export function sizeOf(window: WindowInfo): string {
  return `${window.box[2]}x${window.box[3]}`
}

/** A window as one line, with a title only when the application may be used. */
function windowLine(window: WindowInfo, withTitle: boolean): string {
  const flags = [window.foreground ? 'focused' : '', window.state === 'minimized' ? 'minimized' : window.state === 'maximized' ? 'maximized' : ''].filter(Boolean)
  const title = withTitle && window.title ? ` "${clip(window.title, 90)}"` : ''
  return `${window.id} ${labelFor(window.app, window.label)}${title} ${sizeOf(window)}${flags.length ? ` ${flags.join(' ')}` : ''}`
}

export function describeWindows(windows: readonly WindowInfo[], desktop: DesktopHandle): string {
  const usable: string[] = []
  const asks: string[] = []
  const never = new Map<string, string>()
  for (const window of windows) {
    const reason = window.blocked ?? classifyApp(window.app).blocked
    if (reason) {
      const label = labelFor(window.app, window.label)
      if (!never.has(label)) never.set(label, reason)
      continue
    }
    if (desktop.permitted(window.app)) usable.push(windowLine(window, true))
    else asks.push(`${window.id} ${labelFor(window.app, window.label)}`)
  }
  const lines: string[] = []
  if (usable.length) {
    lines.push('Windows you can use:')
    lines.push(...usable.slice(0, WINDOW_LINES))
    if (usable.length > WINDOW_LINES) lines.push(`… and ${usable.length - WINDOW_LINES} more`)
  } else {
    lines.push('No window is open in an application you may use yet.')
  }
  if (asks.length) lines.push(`Not allowed yet (the first use asks the user): ${asks.slice(0, WINDOW_LINES).join(', ')}`)
  if (never.size) lines.push(`Never available: ${[...never].map(([label, reason]) => `${label} (${reason})`).join('; ')}`)
  if (!windows.length) lines.push('The desktop shows no windows.')
  return lines.join('\n')
}

function imageNote(capture: Capture, attached: boolean, vision: boolean): string {
  const shrunk = capture.scale < 1 ? ` (the window is ${Math.round(capture.box[2])}x${Math.round(capture.box[3])}, sent smaller)` : ''
  if (attached) return `Screenshot ${capture.id} is ${capture.width}x${capture.height} pixels${shrunk}. Coordinates are pixels of this screenshot.`
  if (!vision) return `This model cannot read images, so there is no screenshot: use the refs. Positions written @x,y are pixels of the window (${capture.width}x${capture.height}).`
  return `Positions and coordinates are pixels of screenshot ${capture.id} (${capture.width}x${capture.height})${shrunk}.`
}

function relatedLine(look: Look): string {
  if (!look.related.length) return ''
  const list = look.related.slice(0, 6).map((window) => `${window.id}${window.title ? ` "${clip(window.title, 60)}"` : ''}`)
  return `Other windows of this application: ${list.join(', ')}.`
}

/** A look at a window: where it is, what it shows as an outline and, when the model can read it, as an image. */
export function describeLook(look: Look, desktop: DesktopHandle, options: { image: boolean }): string {
  const window = look.window
  const lines = [`${windowLine(window, true)}`]
  lines.push(imageNote(look.capture, options.image, desktop.vision()))
  if (look.capture.masked) lines.push(`${look.capture.masked} area${look.capture.masked === 1 ? ' is' : 's are'} painted over: it belongs to another application or is a password field.`)
  if (!look.stable) lines.push('The window was still changing when this was taken.')
  const related = relatedLine(look)
  if (related) lines.push(related)
  if (look.outline) {
    const outline = formatOutline(look.outline.elements, look.outline.total, look.capture, OUTLINE_LINES)
    lines.push(outline.text ? untrustedScreenContent(window.id, outline.text) : 'The window lists no elements. Use the screenshot and coordinates.')
  }
  return lines.join('\n')
}

/** Elements found by a search, printed like an outline. */
export function describeFound(elements: readonly Element[], total: number, look: Look): string {
  if (!elements.length) return `Nothing in ${look.window.id} matches. The outline lists only what is in view: scroll, or try another word.`
  const outline = formatOutline(elements, total, look.capture)
  return `${elements.length} match${elements.length === 1 ? '' : 'es'} in ${look.window.id}:\n${untrustedScreenContent(look.window.id, outline.text)}`
}

const VERBS: Record<string, string> = {
  click: 'Clicked',
  move: 'Moved the pointer to',
  drag: 'Dragged',
  scroll: 'Scrolled',
  type: 'Typed',
  key: 'Pressed',
  set_value: 'Set the value of',
  select: 'Selected',
}

export interface Described {
  /** The text the model reads. */
  text: string
  /** The window changed enough that a screenshot is worth sending. */
  changed: boolean
}

/** What a look shows against the outline before it: nothing changed, what changed, or the whole content when so much did. */
export function describeChange(look: Look, before: readonly Element[] | undefined): Described {
  const lines: string[] = []
  if (!look.stable) lines.push('The window was still changing when I looked; wait or take a screenshot.')
  else if (!look.changed) lines.push('Nothing visible changed.')
  if (look.capture.masked) lines.push(`${look.capture.masked} area${look.capture.masked === 1 ? ' is' : 's are'} painted over in the screenshot.`)
  if (look.outline) {
    const diff = before ? diffOutlines(before, look.outline.elements, look.capture) : undefined
    if (diff && !diff.replaced) {
      if (diff.text) lines.push(`Changes in ${look.window.id}:\n${untrustedScreenContent(look.window.id, diff.text)}`)
    } else {
      const outline = formatOutline(look.outline.elements, look.outline.total, look.capture, REPLACEMENT_LINES)
      lines.push(`${before ? 'The content changed a lot. ' : ''}Now in ${look.window.id}:\n${untrustedScreenContent(look.window.id, outline.text)}`)
    }
  }
  return { text: lines.join('\n'), changed: look.changed || !look.stable }
}

/** What an input did: how it was done, what opened or closed, and what changed in the window. */
export function describeAct(result: ActResult, before: readonly Element[] | undefined, subject: (index: number) => string): Described {
  const lines: string[] = []
  result.performed.forEach((done, index) => {
    const how = done.via === 'mouse' || done.via === 'keys' ? '' : ` through its own interface (${done.via})`
    lines.push(`${VERBS[done.kind] ?? done.kind} ${subject(index)}${how}${done.detail ? ` (${done.detail})` : ''}.`)
  })
  const look = result.look
  for (const window of result.opened) {
    const same = look && window.app === look.window.app
    lines.push(
      same
        ? `Opened ${window.id}${window.title ? ` "${clip(window.title, 70)}"` : ''}. Use it with window: "${window.id}".`
        : `Another application opened a window (${labelFor(window.app, window.label)}).`,
    )
  }
  if (result.closed.length) lines.push(`Closed: ${result.closed.join(', ')}.`)
  if (!look) {
    lines.push('The window is gone. Call windows to see what is open.')
    return { text: lines.join('\n'), changed: false }
  }
  const change = describeChange(look, before)
  if (change.text) lines.push(change.text)
  return { text: lines.join('\n'), changed: change.changed }
}

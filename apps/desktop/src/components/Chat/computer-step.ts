/**
 * How a step of the Computer tool reads in the work log: "Clicked menuitem "File" in Notepad", "Pressed ctrl+s in
 * Notepad", "You took over". Pure, so the wording is unit tested.
 *
 * It reads the call's input and the one line the tool keeps for people (the long text the model read is not what the log
 * shows), and never says more than a line. A step that failed shows its reason only when it is opened.
 */
import type { ConversationEntry } from '@shared/types'

type ToolState = NonNullable<NonNullable<ConversationEntry['tool']>['state']>

/** What the tool puts in the log when the person used the mouse or keyboard (TAKEN_OVER_DISPLAY in @encode/tools). */
export const TAKEN_OVER = 'you took over'

export interface ComputerStepText {
  label: string
  detail: string
}

const LABELS: Record<string, string> = {
  windows: 'Looked at the windows',
  open: 'Opened',
  focus: 'Switched to',
  screenshot: 'Looked at',
  zoom: 'Zoomed in',
  find: 'Searched for',
  left_click: 'Clicked',
  right_click: 'Right-clicked',
  middle_click: 'Middle-clicked',
  double_click: 'Double-clicked',
  triple_click: 'Triple-clicked',
  mouse_move: 'Moved the pointer to',
  left_click_drag: 'Dragged',
  scroll: 'Scrolled',
  type: 'Typed',
  key: 'Pressed',
  set_value: 'Set the value of',
  select: 'Selected',
  wait: 'Waited',
  cursor_position: 'Read the pointer position',
}

/** The word the tool starts the line of an input with: "click", "type", "key"... */
const INPUT_VERB = /^(?:click|move|drag|scroll|type|key|set_value|select)\s+/
/** A ref the model used to name an element ("e12"): meaningless to a person. */
const REF = /\be\d{1,6}\s+/g

/** The line without refs, leaving alone what is in quotes: it may be text that was typed. */
const withoutRefs = (line: string): string =>
  line
    .split(/("(?:[^"\\]|\\.)*")/)
    .map((part, index) => (index % 2 ? part : part.replace(REF, '')))
    .join('')

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const quoted = (value: unknown, max = 60): string => {
  const raw = text(value).replace(/\s+/g, ' ')
  return raw ? `"${raw.length > max ? `${raw.slice(0, max - 1)}…` : raw}"` : ''
}
const place = (value: unknown): string => (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'number') ? `(${value.join(', ')})` : '')

/** What an input was aimed at when the tool's own line is not there (a call that failed, or one still running). */
function aimOf(input: Record<string, unknown>): string {
  const target = text(input.element) || place(input.coordinate)
  switch (input.action) {
    case 'left_click_drag': {
      const from = text(input.start_element) || place(input.start_coordinate)
      return from || target ? `from ${from || '?'} to ${target || '?'}` : ''
    }
    case 'type':
      return quoted(input.text)
    case 'key':
      return text(input.text)
    case 'scroll':
      return [text(input.scroll_direction), typeof input.scroll_amount === 'number' ? String(input.scroll_amount) : ''].filter(Boolean).join(' ')
    case 'set_value':
      return [target, quoted(input.text)].filter(Boolean).join(' to ')
    case 'select':
      return target || quoted(input.text)
    case 'find':
      return [quoted(input.text), text(input.role)].filter(Boolean).join(' ')
    case 'wait':
      return input.text ? quoted(input.text) : typeof input.duration === 'number' ? `${input.duration}s` : ''
    default:
      return target
  }
}

export function computerStep(input: Record<string, unknown>, output: string | undefined, state: ToolState | undefined): ComputerStepText {
  const action = typeof input.action === 'string' ? input.action : ''
  const failed = state === 'error' || state === 'rejected'
  const shown = output?.trim() ?? ''
  if (state === 'error' && shown === TAKEN_OVER) return { label: 'You took over', detail: 'the agent stopped' }
  const label = LABELS[action] ?? 'Used the computer'
  // The tool's line is only trusted for a call that worked: a failure's output is its reason, and is long.
  const own = state === 'done' ? shown : ''
  switch (action) {
    case 'windows':
    case 'cursor_position':
      return { label, detail: own }
    case 'focus':
    case 'screenshot':
      return { label, detail: own || text(input.window) }
    case 'zoom':
      return { label, detail: '' }
    case 'open':
      return { label: failed ? 'Tried to open' : label, detail: text(input.text) }
    case 'find':
      return { label, detail: failed ? aimOf(input) : [aimOf(input), own].filter(Boolean).join(' · ') }
    case 'wait':
      return { label, detail: aimOf(input) || (own.startsWith('waited ') ? own.slice('waited '.length) : '') }
    default:
      return { label, detail: own ? withoutRefs(own.replace(INPUT_VERB, '')) : aimOf(input) }
  }
}

/**
 * What the command line writes: text from a model, a tool or a file made safe for a terminal, and the few styles it
 * uses. Nothing from a session reaches the terminal raw: an escape sequence in a reply or a command's output could
 * move the cursor, retitle the window or hide text, and a direction character could reorder what a line says.
 */

/** Control characters other than tab and newline, C1 controls, and the characters that reorder or hide text. */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu

/** Text as plain characters: every unsafe character becomes `?`. A lone carriage return is dropped, CRLF reads as LF. */
export function plain(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(UNSAFE, (char) => (char === '\r' ? '' : '?'))
}

/** JSON for a line of output, with the characters that reorder or hide text escaped (JSON.stringify leaves them). */
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** The first line of a text, at most `max` characters, with an ellipsis when cut. */
export function firstLine(text: string, max = 120): string {
  const line = plain(text).trim().split('\n', 1)[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** "1 file", "2 files". */
export function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

export interface Style {
  bold(text: string): string
  dim(text: string): string
  red(text: string): string
  green(text: string): string
  yellow(text: string): string
  cyan(text: string): string
}

const wrap = (open: number, close: number) => (text: string) => `\u001b[${open}m${text}\u001b[${close}m`

export const COLOR: Style = { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39) }
const same = (text: string) => text
export const NO_COLOR: Style = { bold: same, dim: same, red: same, green: same, yellow: same, cyan: same }

/** Colour when the output is a terminal and nobody asked for none (https://no-color.org). */
export function styleFor(isTty: boolean, env: NodeJS.ProcessEnv, forced?: boolean): Style {
  if (forced !== undefined) return forced ? COLOR : NO_COLOR
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return NO_COLOR
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return COLOR
  return isTty && env.TERM !== 'dumb' ? COLOR : NO_COLOR
}

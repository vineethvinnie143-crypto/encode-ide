import type { CodeRange, EditorLocation } from '@shared/types'
import { useEditor } from '../../stores/editor'
import { useUi } from '../../stores/ui'
import { docState } from '../docs'

/** A place in a file of the folder, as the servers count (zero-based lines, UTF-16 columns). */
export interface Place {
  path: string
  range: CodeRange
}

/** The most of a line a place's preview keeps, as the host does. */
const PREVIEW_CHARS = 300

/** How many places Back remembers. */
const MAX_HISTORY = 50

const back: Place[] = []
const forward: Place[] = []

const samePlace = (a: Place, b: Place): boolean => a.path === b.path && a.range.start.line === b.range.start.line

function remember(stack: Place[], place: Place): void {
  if (stack.length && samePlace(stack[stack.length - 1], place)) stack.pop()
  stack.push(place)
  if (stack.length > MAX_HISTORY) stack.shift()
}

/** The range of a place a server named. */
export const rangeOfLocation = (location: EditorLocation): CodeRange => ({
  start: { line: location.line, character: location.character },
  end: { line: location.endLine, character: location.endCharacter },
})

/**
 * Goes to a place a server named, remembering `from` for Back. A file outside the folder is not opened: the editor
 * shows only the folder's files, so the person is told where it is instead.
 */
export function goToLocation(location: EditorLocation, from: Place | null): void {
  if (location.path === null) {
    useUi.getState().notify('info', `That is outside the open folder: ${location.file}`)
    return
  }
  const to: Place = { path: location.path, range: rangeOfLocation(location) }
  if (from && !samePlace(from, to)) remember(back, from)
  forward.length = 0
  void useEditor.getState().openAt(to.path, to.range)
}

/** Back to where the last jump started; `current` is kept for Forward. False when there is nowhere to go. */
export function goBack(current: Place | null): boolean {
  const to = back.pop()
  if (!to) return false
  if (current) remember(forward, current)
  void useEditor.getState().openAt(to.path, to.range)
  return true
}

export function goForward(current: Place | null): boolean {
  const to = forward.pop()
  if (!to) return false
  if (current) remember(back, current)
  void useEditor.getState().openAt(to.path, to.range)
  return true
}

export const canGoBack = (): boolean => back.length > 0
export const canGoForward = (): boolean => forward.length > 0

/** The folder changed: its places mean nothing in the next one. */
export function forgetHistory(): void {
  back.length = 0
  forward.length = 0
}

/** The places with the text of their line as the editor has it, for the files it has open (unsaved text included). */
export function withOpenText(locations: readonly EditorLocation[]): EditorLocation[] {
  return locations.map((location) => {
    const state = location.path === null ? undefined : docState(location.path)
    if (!state || location.line >= state.doc.lineCount) return location
    const text = state.doc.line(location.line + 1).text.trimEnd()
    return { ...location, preview: text.slice(0, PREVIEW_CHARS) }
  })
}

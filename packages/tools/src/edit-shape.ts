/**
 * Edit and MultiEdit calls a model sent in another tool's shape, read as meant. Weaker models mix the two (a list of
 * edits sent to Edit, one replacement sent to MultiEdit) or write the SEARCH/REPLACE blocks of other coding agents;
 * refused, they tend to send the same thing again. Each shape here has one reading, and the result says how the call
 * was read.
 */
import { sameParameter } from '@encode/protocol'
import type { Reshaped } from './types'

/** SEARCH/REPLACE blocks as Cline, Roo and Aider write them: `<<<<<<< SEARCH` (or `------- SEARCH`), `=======`, `>>>>>>> REPLACE` (or `+++++++ REPLACE`). */
const BLOCK = /^(?:<{5,9}|-{5,9}) ?SEARCH[^\n]*\n([\s\S]*?)\n?^={5,9}[ \t]*\r?\n([\s\S]*?)\n?^(?:>{5,9}|\+{5,9}) ?REPLACE[ \t]*\r?$/gm

/** Keys a list of edits comes under. */
const LIST_KEYS = ['edits', 'changes', 'replacements', 'diff', 'patch']

const PAIR = ['old_string', 'new_string', 'replace_all'] as const

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The replacements in SEARCH/REPLACE blocks, or undefined when the text holds none. */
export function searchReplaceEdits(text: string): Array<{ old_string: string; new_string: string }> | undefined {
  const edits = [...text.replace(/\r\n/g, '\n').matchAll(BLOCK)].map((match) => ({ old_string: match[1], new_string: match[2] }))
  return edits.length ? edits : undefined
}

/** A list of edits: an array of objects, one written as JSON text, or SEARCH/REPLACE blocks. */
function editList(value: unknown): Array<Record<string, unknown>> | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.startsWith('[')) {
      try {
        return editList(JSON.parse(text))
      } catch {
        return undefined
      }
    }
    return searchReplaceEdits(value)
  }
  if (Array.isArray(value) && value.length > 0 && value.every(isObject)) return value
  return undefined
}

/** The key that names one of old_string, new_string and replace_all, if any does. */
const pairPart = (key: string) => PAIR.find((name) => sameParameter(key, name))

/**
 * An Edit or MultiEdit call in the shape of the other, or as SEARCH/REPLACE blocks, in `own`'s shape (or MultiEdit's,
 * for several edits sent to Edit). Undefined when the call has no such reading.
 */
export function reshapeEdit(input: Record<string, unknown>, own: 'Edit' | 'MultiEdit'): Reshaped | undefined {
  const fixes: string[] = []
  const rest: Record<string, unknown> = { ...input }
  // Anthropic's text editor names its action; for a replacement it adds nothing.
  if (rest.command === 'str_replace') {
    delete rest.command
    fixes.push('"command": "str_replace" left out')
  }
  const pairKeys = Object.keys(rest).filter((key) => pairPart(key))
  const listKey = Object.keys(rest).find((key) => LIST_KEYS.some((name) => sameParameter(key, name)) && editList(rest[key]))

  if (listKey && !pairKeys.length) {
    const edits = editList(rest[listKey])!
    delete rest[listKey]
    const how = typeof input[listKey] === 'string' ? (input[listKey] as string).trim().startsWith('[') ? 'as a list' : 'as SEARCH/REPLACE blocks' : ''
    if (own === 'MultiEdit') {
      if (listKey === 'edits' && !how) return fixes.length ? { input: { ...rest, edits }, fixes } : undefined
      return { input: { ...rest, edits }, fixes: [...fixes, `"${listKey}" read ${how || 'as edits'}`] }
    }
    if (edits.length === 1) {
      return { input: { ...rest, ...edits[0] }, fixes: [...fixes, `"${listKey}" ${how ? `${how} ` : ''}with one change read as old_string and new_string`] }
    }
    return { input: { ...rest, edits }, fixes: [...fixes, `${edits.length} changes in "${listKey}"${how ? ` ${how}` : ''} made with MultiEdit, all or none`], tool: 'MultiEdit' }
  }

  if (own === 'MultiEdit' && pairKeys.length && !listKey && pairKeys.some((key) => pairPart(key) === 'old_string')) {
    const edit: Record<string, unknown> = {}
    for (const key of pairKeys) {
      edit[key] = rest[key]
      delete rest[key]
    }
    return { input: { ...rest, edits: [edit] }, fixes: [...fixes, 'old_string and new_string read as one edit'] }
  }

  return fixes.length ? { input: rest, fixes } : undefined
}

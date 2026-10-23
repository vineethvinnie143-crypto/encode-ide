/**
 * Mends a tool call's input where what the model sent can mean one thing only (ADR 0089). Weaker models often send
 * the right value in the wrong shape: "50" for a number, one path where a list is asked for, `path` where the tool
 * names it `file_path`, `oldString` for `old_string`, null for a parameter they mean to leave out. Refusing such a
 * call costs a round trip, and a weak model may not get it right the second time either.
 *
 * Rules:
 *   - an input that already passes its schema is never changed;
 *   - each change has one reading: no guessing between two parameters, nothing inside anyOf or oneOf;
 *   - the mended input must pass the schema as a whole, or nothing is changed and the error names what was sent;
 *   - every change is listed, so the model is told and the call is shown as it runs.
 */
import { validate, type JsonSchema } from './schema'

export interface Repaired {
  value: Record<string, unknown>
  /** What was changed, for the model: `"limit": "50" as 50`. Empty when nothing was. */
  fixes: string[]
}

/**
 * Other names models give a parameter, by the name the schema uses. Only used when the schema has that parameter,
 * does not have the other name, and the call did not also send the parameter by its own name.
 */
const ALIASES: Record<string, readonly string[]> = {
  file_path: ['path', 'file', 'filename', 'fullpath', 'filepath'],
  notebook_path: ['path', 'file', 'filepath', 'notebook'],
  path: ['dir', 'directory', 'folder', 'file', 'filepath'],
  old_string: ['old', 'oldstr', 'oldtext', 'original', 'search', 'find'],
  new_string: ['new', 'newstr', 'newtext', 'replacement', 'replace', 'with'],
  content: ['contents', 'text', 'filecontent', 'filecontents', 'body'],
  command: ['cmd', 'commandline', 'script'],
  pattern: ['regex', 'regexp', 'glob', 'query'],
  query: ['q', 'search', 'searchquery'],
  url: ['link', 'href', 'uri'],
  limit: ['maxlines', 'numlines', 'linecount'],
  offset: ['start', 'startline', 'fromline'],
  replace_all: ['all', 'global', 'replaceall'],
  timeout: ['timeoutms'],
  timeout_ms: ['timeout'],
}

/** A name as models vary it: case, underscores and dashes do not count. */
const norm = (name: string) => name.toLowerCase().replace(/[_\-\s]/g, '')

const INTEGER = /^\s*-?\d{1,15}\s*$/
const NUMBER = /^\s*-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\s*$/i

function typesOf(schema: JsonSchema): string[] {
  return typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? (schema.type as string[]) : []
}

function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

function at(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key
}

function parsed(text: string, open: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith(open)) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

const passes = (value: unknown, schema: JsonSchema) => validate(value, schema).length === 0

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case 'integer':
      return Number.isInteger(value)
    case 'array':
      return Array.isArray(value)
    case 'null':
      return value === null
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value)
    default:
      return typeof value === type
  }
}

function mend(value: unknown, schema: JsonSchema, path: string, fixes: string[]): unknown {
  if (!schema || typeof schema !== 'object' || 'anyOf' in schema || 'oneOf' in schema) return value
  const types = typesOf(schema)
  if (!types.length || types.some((type) => isType(value, type))) {
    if (Array.isArray(value) && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      return value.map((item, index) => mend(item, schema.items as JsonSchema, at(path, index), fixes))
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) return mendObject(value as Record<string, unknown>, schema, path, fixes)
    return value
  }
  const told = (made: unknown, how = '') => {
    fixes.push(`${path ? `"${path}": ` : ''}${shown(value)} as ${shown(made)}${how}`)
    return made
  }
  if (typeof value === 'string') {
    if (types.includes('integer') && INTEGER.test(value)) return told(Number(value))
    if (types.includes('number') && NUMBER.test(value)) return told(Number(value))
    if (types.includes('boolean') && /^\s*(true|false)\s*$/i.test(value)) return told(value.trim().toLowerCase() === 'true')
    if (types.includes('array')) {
      const list = parsed(value, '[')
      const items = schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items) ? (schema.items as JsonSchema) : undefined
      if (Array.isArray(list)) return told(items ? list.map((item, index) => mend(item, items, at(path, index), [])) : list)
      if (items && typesOf(items).includes('string')) return told([value], ', one item')
    }
    if (types.includes('object')) {
      const object = parsed(value, '{')
      if (object && typeof object === 'object' && !Array.isArray(object)) return told(mendObject(object as Record<string, unknown>, schema, path, []))
    }
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value) && types.includes('string')) return told(String(value))
  if (Array.isArray(value) && value.length === 1 && ['string', 'number', 'integer', 'boolean'].some((type) => types.includes(type))) {
    const [only] = value
    if (passes(only, schema)) return told(only)
  }
  return value
}

function mendObject(value: Record<string, unknown>, schema: JsonSchema, path: string, fixes: string[]): Record<string, unknown> {
  const properties = (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<string, JsonSchema>
  const names = Object.keys(properties)
  if (!names.length) return value
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  const out: Record<string, unknown> = {}
  const free = names.filter((name) => !Object.hasOwn(value, name))
  const wanted = new Map<string, string>()
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) continue
    let targets = free.filter((name) => norm(name) === norm(key))
    if (!targets.length) targets = free.filter((name) => ALIASES[name]?.includes(norm(key)))
    if (targets.length === 1) wanted.set(key, targets[0])
  }
  // Two names the call sent for one parameter (`path` and `file` for `file_path`) leave a choice: neither is read.
  const claims = [...wanted.values()]
  const renamed = new Map([...wanted].filter(([, name]) => claims.indexOf(name) === claims.lastIndexOf(name)))
  for (const [key, field] of Object.entries(value)) {
    const name = renamed.get(key) ?? key
    if (name !== key) fixes.push(`"${at(path, key)}" as "${at(path, name)}"`)
    const fieldSchema = properties[name]
    if (field === null && fieldSchema && !required.has(name) && !typesOf(fieldSchema).includes('null') && !('anyOf' in fieldSchema) && !('oneOf' in fieldSchema)) {
      fixes.push(`"${at(path, name)}": null left out`)
      continue
    }
    out[name] = fieldSchema ? mend(field, fieldSchema, at(path, name), fixes) : field
  }
  return out
}

/** The input mended where it has one meaning, with what was changed; the input as it was otherwise. */
export function repairInput(value: Record<string, unknown>, schema: JsonSchema): Repaired {
  if (!value || typeof value !== 'object' || Array.isArray(value) || passes(value, schema)) return { value, fixes: [] }
  const fixes: string[] = []
  const mended = mendObject(value, schema, '', fixes)
  if (!fixes.length || !passes(mended, schema)) return { value, fixes: [] }
  return { value: mended, fixes }
}

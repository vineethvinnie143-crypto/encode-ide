/**
 * How a value of the paused program reads, from what the inspector says of it (a RemoteObject): the way a console
 * shows it, cut to a line. Nothing here runs code in the program.
 */

export interface PropertyPreview {
  name: string
  type: string
  value?: string
  valuePreview?: ObjectPreview
  subtype?: string
}

export interface ObjectPreview {
  type: string
  subtype?: string
  description?: string
  overflow?: boolean
  properties?: PropertyPreview[]
  entries?: { key?: ObjectPreview; value: ObjectPreview }[]
}

export interface RemoteObject {
  type: string
  subtype?: string
  className?: string
  value?: unknown
  unserializableValue?: string
  description?: string
  objectId?: string
  preview?: ObjectPreview
}

/** The longest a value's text is, in a variable's row or a console line. */
export const MAX_VALUE_CHARS = 1_000
const MAX_PREVIEW_ITEMS = 6

function cut(text: string, limit = MAX_VALUE_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function quote(text: string, limit = MAX_VALUE_CHARS): string {
  return JSON.stringify(cut(text, limit))
}

/** A function as one line: `ƒ name(a, b)`, `ƒ (x) => …`, `class Name`. */
export function functionText(description: string | undefined): string {
  const source = (description ?? '').trim()
  const first = source.split('\n')[0] ?? ''
  const classMatch = /^class\s+([\w$]+)?/.exec(first)
  if (classMatch) return classMatch[1] ? `class ${classMatch[1]}` : 'class'
  const named = /^(async\s+)?function\s*(\*?)\s*([\w$]*)\s*\(([^)]*)\)/.exec(first)
  if (named) return cut(`${named[1] ? 'async ' : ''}ƒ${named[2]} ${named[3]}(${named[4].trim()})`, 120)
  const arrow = /^(async\s*)?(\(([^)]*)\)|([\w$]+))\s*=>/.exec(first)
  if (arrow) return cut(`${arrow[1] ? 'async ' : ''}ƒ (${(arrow[3] ?? arrow[4] ?? '').trim()}) => …`, 120)
  const method = /^(async\s+)?(\*?)\s*(get\s+|set\s+)?([\w$[\]"'.]+)\s*\(([^)]*)\)/.exec(first)
  if (method) return cut(`${method[1] ? 'async ' : ''}ƒ ${method[4]}(${method[5].trim()})`, 120)
  return cut(`ƒ ${first}`, 120)
}

/** The text of a preview's property value: strings quoted, objects by their kind. */
function previewValue(property: PropertyPreview): string {
  if (property.valuePreview) return nestedPreview(property.valuePreview)
  const value = property.value ?? ''
  switch (property.type) {
    case 'string':
      return quote(value, 60)
    case 'function':
      return 'ƒ'
    case 'object':
      if (property.subtype === 'null') return 'null'
      if (property.subtype === 'array') return value || 'Array'
      return value === 'Object' ? '{…}' : value || '{…}'
    case 'accessor':
      return '(…)'
    default:
      return value
  }
}

/** An object inside a preview: by its kind, not its properties. */
function nestedPreview(preview: ObjectPreview): string {
  if (preview.subtype === 'array') return preview.description ?? 'Array'
  if (preview.type === 'function') return 'ƒ'
  if (preview.description === 'Object') return '{…}'
  return preview.description ?? '{…}'
}

function previewText(object: RemoteObject, preview: ObjectPreview): string {
  const more = preview.overflow ? ', …' : ''
  if (preview.subtype === 'array' || preview.subtype === 'typedarray') {
    const length = /\((\d+)\)$/.exec(object.description ?? '')?.[1]
    const items = (preview.properties ?? []).filter((property) => /^\d+$/.test(property.name)).slice(0, MAX_PREVIEW_ITEMS).map(previewValue)
    const prefix = object.subtype === 'typedarray' ? `${object.className ?? 'TypedArray'}(${length ?? '?'})` : `(${length ?? items.length})`
    return `${prefix} [${items.join(', ')}${preview.overflow || (length !== undefined && Number(length) > items.length) ? ', …' : ''}]`
  }
  if (preview.subtype === 'map' || preview.subtype === 'set' || preview.subtype === 'weakmap' || preview.subtype === 'weakset') {
    const entries = (preview.entries ?? []).slice(0, MAX_PREVIEW_ITEMS).map((entry) => (entry.key ? `${nestedOrPrimitive(entry.key)} => ${nestedOrPrimitive(entry.value)}` : nestedOrPrimitive(entry.value)))
    return `${object.description ?? object.className ?? 'Map'} {${entries.join(', ')}${more}}`
  }
  if (object.subtype === 'error' || object.subtype === 'date' || object.subtype === 'regexp') return cut((object.description ?? '').split('\n')[0] ?? '')
  const properties = (preview.properties ?? []).slice(0, MAX_PREVIEW_ITEMS).map((property) => `${property.name}: ${previewValue(property)}`)
  const name = object.className && object.className !== 'Object' ? `${object.className} ` : ''
  return cut(`${name}{${properties.join(', ')}${more}}`)
}

/** A preview of a key or value in a Map or Set: a primitive as itself, an object by its kind. */
function nestedOrPrimitive(preview: ObjectPreview): string {
  if (preview.type === 'string') return quote(preview.description ?? '', 60)
  if (preview.type === 'object' && preview.subtype !== 'null') return nestedPreview(preview)
  return preview.description ?? preview.type
}

/** A value as one line. */
export function valueText(object: RemoteObject): string {
  switch (object.type) {
    case 'undefined':
      return 'undefined'
    case 'string':
      return quote(String(object.value ?? ''))
    case 'number':
      return object.unserializableValue ?? object.description ?? String(object.value)
    case 'bigint':
      return object.unserializableValue ?? object.description ?? ''
    case 'boolean':
      return String(object.value)
    case 'symbol':
      return object.description ?? 'Symbol()'
    case 'function':
      return functionText(object.description)
    case 'object':
      if (object.subtype === 'null') return 'null'
      if (object.preview) return previewText(object, object.preview)
      return cut((object.description ?? object.className ?? 'Object').split('\n')[0] ?? '')
    default:
      return cut(object.description ?? String(object.value ?? object.type))
  }
}

/** A value as a console prints an argument: a string as it is, everything else as `valueText` gives it. */
export function consoleText(object: RemoteObject): string {
  return object.type === 'string' ? cut(String(object.value ?? ''), 20_000) : valueText(object)
}

/** The type a variable's row names: the class of an object, the kind of anything else. */
export function typeText(object: RemoteObject): string {
  if (object.type === 'object') return object.subtype === 'null' ? 'null' : (object.className ?? 'Object')
  return object.type
}

/** Whether the value has children to show. */
export function hasChildren(object: RemoteObject): boolean {
  return !!object.objectId && (object.type === 'object' || object.type === 'function') && object.subtype !== 'null'
}

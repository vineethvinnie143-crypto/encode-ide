/**
 * FiveM's natives as definitions lua-language-server reads (ADR 0084), written from Cfx.re's own typings of them
 * (`@citizenfx/client` and `@citizenfx/server` on npm, pinned in `npm-locks.ts`). The typings are read as text, never
 * run, and every word taken from them lands in a `---` comment or as a checked identifier, so nothing in them can
 * become Lua code.
 */

export interface NativeParam {
  name: string
  type: string
  optional: boolean
  doc?: string
}

export interface Native {
  name: string
  params: NativeParam[]
  /** Lua types of what it gives back, in order; empty when it gives nothing. */
  returns: string[]
  returnDoc?: string
  /** The description, a line each. */
  doc: string[]
  /** Another name of the native just before it (`N_0x...`, an old spelling). */
  aliasOf?: string
}

const LUA_KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while'])
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const DECLARATION = /^declare function ([A-Za-z_][A-Za-z0-9_]*)\((.*)\): (.*);\s*$/

/** A TypeScript type of the typings as Lua sees the value. */
export function luaType(ts: string): string {
  const type = ts.trim()
  if (/\/\*\s*actually bool\s*\*\//.test(type)) return 'boolean'
  switch (type.replace(/\/\*.*?\*\//g, '').trim()) {
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'string':
      return 'string'
    // A hash: the Lua runtime turns a string into its hash.
    case 'string | number':
      return 'string|integer'
    // A Vector3 comes back as the runtime's vector3.
    case 'number[]':
      return 'vector3'
    case 'Function':
      return 'function'
    default:
      return 'any'
  }
}

/** What a declaration gives back: none, one, or several values for a tuple. */
function returnTypes(ts: string): string[] {
  const type = ts.trim()
  if (type === 'void') return []
  if (type.startsWith('[') && type.endsWith(']')) {
    const inner = type.slice(1, -1).replace(/\/\*.*?\*\//g, (comment) => comment.replace(/,/g, ' '))
    return inner.split(',').map((part) => (/actually bool/.test(part) ? 'boolean' : luaType(part)))
  }
  return [luaType(type)]
}

function splitParams(list: string): string[] {
  return list.trim() ? list.split(',').map((part) => part.trim()) : []
}

/** A comment's text made safe for one `---` line: no line breaks or other control characters. */
function clean(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\t/g, '  ')
    .trimEnd()
}

/**
 * Markdown from the native docs, as a hover shows it: links to other natives on the docs site become their names, and
 * pictures are left out (a hover loads nothing from the internet).
 */
function hoverText(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt ? `(picture: ${alt})` : ''))
    .replace(/\[([^\]]+)\]\(#[^)]*\)/g, '`$1`')
    .replace(/\\_/g, '_')
}

interface Comment {
  description: string[]
  params: Map<string, string>
  returns?: string
}

function readComment(lines: string[]): Comment {
  const description: string[] = []
  const params = new Map<string, string>()
  let returns: string | undefined
  let tag: { kind: 'param'; name: string } | { kind: 'return' } | { kind: 'other' } | null = null
  for (const raw of lines) {
    const line = clean(hoverText(raw.replace(/^\s*\*\s?/, '')))
    const param = /^@param\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/.exec(line.trim())
    if (param) {
      tag = { kind: 'param', name: param[1]! }
      params.set(param[1]!, param[2]!.trim())
      continue
    }
    const result = /^@returns?\s*(.*)$/.exec(line.trim())
    if (result) {
      tag = { kind: 'return' }
      returns = result[1]!.trim()
      continue
    }
    if (line.trim().startsWith('@')) {
      tag = { kind: 'other' }
      continue
    }
    if (!tag) description.push(line)
    else if (line.trim() && tag.kind === 'param') params.set(tag.name, `${params.get(tag.name) ?? ''} ${line.trim()}`.trim())
    else if (line.trim() && tag.kind === 'return') returns = `${returns ?? ''} ${line.trim()}`.trim()
  }
  while (description.length && !description[0]!.trim()) description.shift()
  while (description.length && !description.at(-1)!.trim()) description.pop()
  return { description, params, ...(returns ? { returns } : {}) }
}

/** The natives a typings file declares, in its order, each with its doc and whether it is another's alias. */
export function parseNatives(dts: string): Native[] {
  const natives: Native[] = []
  const lines = dts.split(/\r?\n/)
  let comment: string[] | null = null
  let pending: { lines: string[]; key: string } | null = null
  // Declarations with no blank line between them are one native under several names, the first its own.
  let group: { head: string; key: string; signature: string } | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (comment) {
      const end = line.indexOf('*/')
      if (end < 0) {
        comment.push(line)
        continue
      }
      comment.push(line.slice(0, end))
      pending = { lines: comment, key: comment.join('\n') }
      comment = null
      continue
    }
    const trimmed = line.trim()
    if (trimmed.startsWith('/**')) {
      const rest = trimmed.slice(3)
      const end = rest.indexOf('*/')
      if (end >= 0) pending = { lines: [rest.slice(0, end)], key: rest.slice(0, end) }
      else comment = rest.trim() ? [rest] : []
      continue
    }
    if (!trimmed) {
      group = null
      pending = null
      continue
    }
    const declared = DECLARATION.exec(line)
    if (!declared) continue
    const [, name, list, result] = declared as unknown as [string, string, string, string]
    const doc = readComment(pending?.lines ?? [])
    const params: NativeParam[] = []
    for (const part of splitParams(list)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*:\s*(.+)$/.exec(part)
      if (!match) continue
      const raw = match[1]!
      const lua = LUA_KEYWORDS.has(raw) ? `${raw}_` : raw
      const paramDoc = doc.params.get(raw) ?? doc.params.get(raw.replace(/^_+/, ''))
      params.push({ name: lua, type: luaType(match[3]!), optional: Boolean(match[2]), ...(paramDoc ? { doc: paramDoc } : {}) })
    }
    const native: Native = { name, params, returns: returnTypes(result), doc: doc.description, ...(doc.returns ? { returnDoc: doc.returns } : {}) }
    const key = pending?.key ?? ''
    const signature = `${list}:${result}`
    if (group && key && group.key === key && group.signature === signature && group.head !== name) native.aliasOf = group.head
    else group = { head: name, key, signature }
    natives.push(native)
    pending = null
  }
  return natives
}

/** `fun(a: number, b?: string): boolean, number`, for an overload. */
function funType(native: Native): string {
  const params = native.params.map((param) => `${param.name}${param.optional ? '?' : ''}: ${param.type}`).join(', ')
  return `fun(${params})${native.returns.length ? `: ${native.returns.join(', ')}` : ''}`
}

/** Server natives that name a player take its server id as a number as well, as `source` is. */
function serverSide(native: Native): Native {
  return { ...native, params: native.params.map((param) => (param.type === 'string' && /^(playerSrc|playerId|player)$/.test(param.name) ? { ...param, type: 'string|integer' } : param)) }
}

function emit(native: Native, side: 'client' | 'server' | 'both', other?: Native): string {
  const out: string[] = []
  for (const line of native.doc) out.push(line.trim() ? `--- ${line}` : '---')
  const note = side === 'client' ? 'Client only.' : side === 'server' ? 'Server only.' : other ? 'Client and server; the second form is the server\'s.' : ''
  if (note) {
    if (native.doc.length) out.push('---')
    out.push(`--- *${note}*`)
  }
  for (const param of native.params) out.push(`---@param ${param.name}${param.optional ? '?' : ''} ${param.type}${param.doc ? ` ${param.doc}` : ''}`)
  native.returns.forEach((type, index) => out.push(`---@return ${type}${index === 0 && native.returnDoc ? ` # ${native.returnDoc}` : ''}`))
  if (native.aliasOf) out.push(`---@deprecated Use ${native.aliasOf}.`)
  if (other) out.push(`---@overload ${funType(other)}`)
  out.push(`function ${native.name}(${native.params.map((param) => param.name).join(', ')}) end`)
  return out.join('\n')
}

export interface LibraryFile {
  name: string
  text: string
}

/** The natives of the client's and the server's typings, by name, each side's form of it. */
function bothSides(client: string, server: string): Map<string, { client?: Native; server?: Native }> {
  const byName = new Map<string, { client?: Native; server?: Native }>()
  for (const native of parseNatives(client)) {
    if (!IDENTIFIER.test(native.name) || LUA_KEYWORDS.has(native.name)) continue
    const entry = byName.get(native.name) ?? {}
    entry.client ??= native
    byName.set(native.name, entry)
  }
  for (const native of parseNatives(server)) {
    if (!IDENTIFIER.test(native.name) || LUA_KEYWORDS.has(native.name)) continue
    const entry = byName.get(native.name) ?? {}
    entry.server ??= serverSide(native)
    byName.set(native.name, entry)
  }
  return byName
}

/** A native as the agent looks it up (CodeMap, ADR 0091): which side has it, and the server's form where it differs. */
export interface NativeDoc extends Native {
  side: 'client' | 'server' | 'both'
  server?: Pick<Native, 'params' | 'returns'>
}

/** Every native of both sides once, by name, for the agent's lookups. */
export function nativesIndex(client: string, server: string): NativeDoc[] {
  const out: NativeDoc[] = []
  for (const [name, entry] of [...bothSides(client, server)].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (entry.client && entry.server) {
      const base = entry.client.doc.length || !entry.server.doc.length ? entry.client : { ...entry.client, doc: entry.server.doc }
      const differs = funType(entry.client) !== funType(entry.server)
      out.push({ ...base, name, side: 'both', ...(differs ? { server: { params: entry.server.params, returns: entry.server.returns } } : {}) })
    } else if (entry.client) out.push({ ...entry.client, side: 'client' })
    else out.push({ ...entry.server!, side: 'server' })
  }
  return out
}

/** Files of at most about this many bytes: lua-language-server skips larger ones when it preloads. */
const FILE_BYTES = 400_000

/**
 * The natives of both sides as `---@meta` files, by name, split so each stays small. A native both sides have is
 * written once, with the server's form as an overload where it differs; each says which side has it.
 */
export function nativesLibrary(client: string, server: string, source: string): LibraryFile[] {
  const byName = bothSides(client, server)
  const header = `---@meta _\n-- FiveM's natives for lua-language-server, written by eNCode from ${clean(source)}. Written again when they are installed again.\n`
  const files: LibraryFile[] = []
  let chunk: string[] = []
  let size = 0
  const flush = () => {
    if (!chunk.length) return
    files.push({ name: `natives-${String(files.length + 1).padStart(2, '0')}.lua`, text: `${header}\n${chunk.join('\n\n')}\n` })
    chunk = []
    size = 0
  }
  for (const name of [...byName.keys()].sort()) {
    const entry = byName.get(name)!
    let text: string
    if (entry.client && entry.server) {
      const differs = funType(entry.client) !== funType(entry.server)
      text = emit(entry.client.doc.length || !entry.server.doc.length ? entry.client : { ...entry.client, doc: entry.server.doc }, 'both', differs ? entry.server : undefined)
    } else if (entry.client) text = emit(entry.client, 'client')
    else text = emit(entry.server!, 'server')
    if (size + text.length > FILE_BYTES) flush()
    chunk.push(text)
    size += text.length + 2
  }
  flush()
  return files
}

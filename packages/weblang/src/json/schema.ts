/**
 * JSON Schema, the parts editors use (drafts 4 to 2020-12): types, enums and consts, properties and their patterns,
 * items, bounds, lengths, patterns, the combinators, if/then/else and `$ref` within a schema. A schema is data: it is
 * read, never run, and a `$ref` outside the schema is not followed.
 */
import { valueOf, type JsonNode } from './parser'

export interface Schema {
  $ref?: string
  $id?: string
  type?: string | string[]
  enum?: unknown[]
  const?: unknown
  properties?: Record<string, SchemaRef>
  patternProperties?: Record<string, SchemaRef>
  additionalProperties?: SchemaRef
  propertyNames?: SchemaRef
  required?: string[]
  minProperties?: number
  maxProperties?: number
  dependentRequired?: Record<string, string[]>
  items?: SchemaRef | SchemaRef[]
  prefixItems?: SchemaRef[]
  additionalItems?: SchemaRef
  contains?: SchemaRef
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number | boolean
  exclusiveMaximum?: number | boolean
  multipleOf?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
  allOf?: SchemaRef[]
  anyOf?: SchemaRef[]
  oneOf?: SchemaRef[]
  not?: SchemaRef
  if?: SchemaRef
  then?: SchemaRef
  else?: SchemaRef
  definitions?: Record<string, SchemaRef>
  $defs?: Record<string, SchemaRef>
  title?: string
  description?: string
  markdownDescription?: string
  deprecated?: boolean
  deprecationMessage?: string
  errorMessage?: string
  default?: unknown
  examples?: unknown[]
  /** Labels for `enum`'s values, in order (editors' own keyword). */
  enumDescriptions?: string[]
}

export type SchemaRef = Schema | boolean

export interface SchemaProblem {
  node: JsonNode
  message: string
  /** 1: error, 2: warning. */
  severity: 1 | 2
  deprecated?: boolean
}

const MAX_DEPTH = 64
const MAX_PROBLEMS = 500

/** Follows `$ref` within the root schema (`#`, `#/definitions/x`, `#/$defs/x`, any JSON pointer into it). */
export function resolve(schema: SchemaRef | undefined, root: Schema, depth = 0): Schema | null {
  if (schema === undefined || schema === true) return {}
  if (schema === false) return null
  let current: Schema = schema
  for (let hops = 0; current.$ref && hops < 32; hops++) {
    const target = pointer(root, current.$ref)
    if (target === null) return { ...current, $ref: undefined }
    if (target === false) return null
    // Keywords beside a $ref still apply (2019-09 and later); the ref's are taken first.
    const { $ref: _ref, ...rest } = current
    current = Object.keys(rest).length ? { ...(target === true ? {} : target), ...rest } : target === true ? {} : target
  }
  return depth > MAX_DEPTH ? {} : current
}

function pointer(root: Schema, ref: string): SchemaRef | null {
  if (!ref.startsWith('#')) return null
  let node: unknown = root
  for (const raw of ref.slice(1).split('/').filter(Boolean)) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
    if (node === null || typeof node !== 'object' || !(key in node)) return null
    node = (node as Record<string, unknown>)[key]
  }
  return typeof node === 'boolean' || (node !== null && typeof node === 'object') ? (node as SchemaRef) : null
}

function typeOf(node: JsonNode): string {
  if (node.type === 'number') return Number.isInteger(node.value) ? 'integer' : 'number'
  return node.type
}

function typeMatches(node: JsonNode, type: string): boolean {
  const actual = typeOf(node)
  return actual === type || (type === 'number' && actual === 'integer')
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((item, index) => deepEqual(item, (b as unknown[])[index]))
  const keys = Object.keys(a as object)
  return keys.length === Object.keys(b as object).length && keys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

const patterns = new Map<string, RegExp | null>()
function regex(source: string): RegExp | null {
  if (!patterns.has(source)) {
    let made: RegExp | null = null
    try {
      // Unicode mode, as JSON Schema's patterns are; a pattern this cannot read is not checked.
      made = source.length <= 1000 ? new RegExp(source, 'u') : null
    } catch {
      made = null
    }
    if (patterns.size > 500) patterns.clear()
    patterns.set(source, made)
  }
  return patterns.get(source)!
}

const show = (value: unknown) => JSON.stringify(value)

export interface Validation {
  problems: SchemaProblem[]
  /** Schemas that matched each node, for completion and hovers. */
  matched?: Map<JsonNode, Schema[]>
}

/** The problems a value has against a schema. */
export function validate(node: JsonNode, schema: SchemaRef, root: Schema): SchemaProblem[] {
  const problems: SchemaProblem[] = []
  check(node, schema, root, problems, 0)
  return problems.slice(0, MAX_PROBLEMS)
}

function check(node: JsonNode, ref: SchemaRef, root: Schema, problems: SchemaProblem[], depth: number): void {
  if (depth > MAX_DEPTH || problems.length >= MAX_PROBLEMS) return
  const schema = resolve(ref, root, depth)
  if (schema === null) {
    problems.push({ node, message: 'No value is allowed here.', severity: 2 })
    return
  }
  const add = (message: string, at: JsonNode = node) => problems.push({ node: at, message: schema.errorMessage ?? message, severity: 2 })
  if (schema.deprecationMessage || schema.deprecated) {
    const target = node.parent?.type === 'property' ? node.parent.children![0]! : node
    problems.push({ node: target, message: schema.deprecationMessage ?? 'This is deprecated.', severity: 2, deprecated: true })
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => typeMatches(node, type))) {
      add(`Expected ${types.map((type) => (/^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`)).join(' or ')}.`)
      return
    }
  }
  const value = valueOf(node)
  if (schema.enum && !schema.enum.some((option) => deepEqual(option, value))) add(`Expected one of ${schema.enum.slice(0, 12).map(show).join(', ')}${schema.enum.length > 12 ? '…' : ''}.`)
  if ('const' in schema && !deepEqual(schema.const, value)) add(`Expected ${show(schema.const)}.`)

  for (const part of schema.allOf ?? []) check(node, part, root, problems, depth + 1)
  if (schema.anyOf) {
    const outcomes = schema.anyOf.map((part) => validate(node, part, root))
    if (!outcomes.some((found) => !found.some((problem) => !problem.deprecated))) problems.push(...best(outcomes, node, 'Matches none of the forms this value may take.'))
  }
  if (schema.oneOf) {
    const outcomes = schema.oneOf.map((part) => validate(node, part, root))
    const passing = outcomes.filter((found) => !found.some((problem) => !problem.deprecated)).length
    if (passing === 0) problems.push(...best(outcomes, node, 'Matches none of the forms this value may take.'))
    else if (passing > 1) add('Matches more than one of the forms this value may take.')
  }
  if (schema.not !== undefined && !validate(node, schema.not, root).some((problem) => !problem.deprecated)) add('This value is not allowed here.')
  if (schema.if !== undefined) {
    const holds = !validate(node, schema.if, root).some((problem) => !problem.deprecated)
    const branch = holds ? schema.then : schema.else
    if (branch !== undefined) check(node, branch, root, problems, depth + 1)
  }

  if (node.type === 'string') {
    const text = String(node.value)
    const length = [...text].length
    if (schema.minLength !== undefined && length < schema.minLength) add(`Must be at least ${schema.minLength} characters long.`)
    if (schema.maxLength !== undefined && length > schema.maxLength) add(`Must be at most ${schema.maxLength} characters long.`)
    if (schema.pattern) {
      const pattern = regex(schema.pattern)
      if (pattern && !pattern.test(text)) add(`Does not match the pattern ${show(schema.pattern)}.`)
    }
    if (schema.format && !formatHolds(schema.format, text)) add(`Not a valid ${schema.format}.`)
  }
  if (node.type === 'number') {
    const number = node.value as number
    const exclusiveMin = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : schema.exclusiveMinimum === true ? schema.minimum : undefined
    const exclusiveMax = typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : schema.exclusiveMaximum === true ? schema.maximum : undefined
    if (schema.minimum !== undefined && schema.exclusiveMinimum !== true && number < schema.minimum) add(`Must be ${schema.minimum} or more.`)
    if (schema.maximum !== undefined && schema.exclusiveMaximum !== true && number > schema.maximum) add(`Must be ${schema.maximum} or less.`)
    if (exclusiveMin !== undefined && number <= exclusiveMin) add(`Must be more than ${exclusiveMin}.`)
    if (exclusiveMax !== undefined && number >= exclusiveMax) add(`Must be less than ${exclusiveMax}.`)
    if (schema.multipleOf && Math.abs(number / schema.multipleOf - Math.round(number / schema.multipleOf)) > 1e-9) add(`Must be a multiple of ${schema.multipleOf}.`)
  }
  if (node.type === 'array') {
    const items = node.children ?? []
    if (schema.minItems !== undefined && items.length < schema.minItems) add(`Needs at least ${schema.minItems} items.`)
    if (schema.maxItems !== undefined && items.length > schema.maxItems) add(`Takes at most ${schema.maxItems} items.`)
    const tuple = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : undefined)
    const rest = schema.prefixItems ? (Array.isArray(schema.items) ? undefined : schema.items) : Array.isArray(schema.items) ? schema.additionalItems : schema.items
    items.forEach((item, index) => {
      const itemSchema = tuple && index < tuple.length ? tuple[index] : rest
      if (itemSchema === false) add('No more items are allowed here.', item)
      else if (itemSchema !== undefined) check(item, itemSchema, root, problems, depth + 1)
    })
    if (schema.contains !== undefined && !items.some((item) => !validate(item, schema.contains!, root).some((problem) => !problem.deprecated))) add('None of the items is of the kind this list needs.')
    if (schema.uniqueItems) {
      const values = items.map((item) => valueOf(item))
      values.forEach((item, index) => {
        if (values.findIndex((other) => deepEqual(other, item)) < index) add('This item is already in the list.', items[index])
      })
    }
  }
  if (node.type === 'object') {
    const properties = node.children ?? []
    const seen = new Set<string>()
    for (const property of properties) {
      const key = String(property.children![0]!.value)
      seen.add(key)
      const keyNode = property.children![0]!
      const valueNode = property.children![1]
      let covered = false
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        covered = true
        const sub = schema.properties[key]!
        if (sub === false) add(`The property ${show(key)} is not allowed.`, keyNode)
        else if (valueNode) check(valueNode, sub, root, problems, depth + 1)
      }
      for (const [source, sub] of Object.entries(schema.patternProperties ?? {})) {
        const pattern = regex(source)
        if (!pattern?.test(key)) continue
        covered = true
        if (sub === false) add(`The property ${show(key)} is not allowed.`, keyNode)
        else if (valueNode) check(valueNode, sub, root, problems, depth + 1)
      }
      if (!covered && schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) add(`The property ${show(key)} is not allowed.`, keyNode)
        else if (valueNode) check(valueNode, schema.additionalProperties, root, problems, depth + 1)
      }
      if (schema.propertyNames !== undefined) {
        for (const problem of validate(keyNode, schema.propertyNames, root)) problems.push({ ...problem, node: keyNode })
      }
    }
    for (const name of schema.required ?? []) {
      if (!seen.has(name)) add(`Missing the property ${show(name)}.`, node.parent?.type === 'property' ? node.parent.children![0]! : firstLine(node))
    }
    for (const [name, needs] of Object.entries(schema.dependentRequired ?? {})) {
      if (!seen.has(name)) continue
      for (const need of needs) if (!seen.has(need)) add(`${show(name)} needs the property ${show(need)} too.`)
    }
    if (schema.minProperties !== undefined && properties.length < schema.minProperties) add(`Needs at least ${schema.minProperties} properties.`)
    if (schema.maxProperties !== undefined && properties.length > schema.maxProperties) add(`Takes at most ${schema.maxProperties} properties.`)
  }
}

/** An object's opening brace, so a missing property is marked there and not over the whole object. */
function firstLine(node: JsonNode): JsonNode {
  return { ...node, length: 1 }
}

/** The problems of the branch that came closest, or one message when none came close. */
function best(outcomes: SchemaProblem[][], node: JsonNode, message: string): SchemaProblem[] {
  const ranked = outcomes.map((found) => found.filter((problem) => !problem.deprecated)).filter((found) => found.length).sort((a, b) => a.length - b.length)
  // A branch whose only complaint is the value's type was not this value's form at all.
  const close = ranked.find((found) => !found.every((problem) => problem.node === node && problem.message.startsWith('Expected a')))
  return close ?? [{ node, message, severity: 2 }]
}

function formatHolds(format: string, text: string): boolean {
  switch (format) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
    case 'uri':
      return /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/.test(text)
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(text)
    case 'date-time':
      return /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?$/.test(text)
    case 'color-hex':
      return /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(text)
    default:
      return true
  }
}

/**
 * The schemas that apply at a path, for completion and hovers: every branch of a combinator that could, with `if`
 * taken both ways. Values on the way decide nothing, so a half-written document still gets its suggestions.
 */
export function schemasAt(root: Schema, path: readonly (string | number)[]): Schema[] {
  let current = expand(root, root)
  for (const segment of path) {
    const next: Schema[] = []
    for (const schema of current) {
      if (typeof segment === 'string') {
        let covered = false
        const direct = schema.properties?.[segment]
        if (direct !== undefined && Object.hasOwn(schema.properties!, segment)) {
          covered = true
          next.push(...expand(direct, root))
        }
        for (const [source, sub] of Object.entries(schema.patternProperties ?? {})) {
          if (regex(source)?.test(segment)) {
            covered = true
            next.push(...expand(sub, root))
          }
        }
        if (!covered && schema.additionalProperties !== undefined && schema.additionalProperties !== false) next.push(...expand(schema.additionalProperties, root))
      } else {
        const tuple = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : undefined)
        const rest = schema.prefixItems ? (Array.isArray(schema.items) ? undefined : schema.items) : Array.isArray(schema.items) ? schema.additionalItems : schema.items
        const item = tuple && segment < tuple.length ? tuple[segment] : rest
        if (item !== undefined && item !== false) next.push(...expand(item, root))
      }
    }
    current = next
    if (!current.length) break
  }
  return current
}

/** A schema and every branch under its combinators, `$ref`s followed. */
export function expand(ref: SchemaRef, root: Schema, depth = 0, out: Schema[] = []): Schema[] {
  const schema = resolve(ref, root, depth)
  if (!schema || depth > 16 || out.length > 200 || out.includes(schema)) return out
  out.push(schema)
  for (const part of [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) expand(part, root, depth + 1, out)
  if (schema.then !== undefined) expand(schema.then, root, depth + 1, out)
  if (schema.else !== undefined) expand(schema.else, root, depth + 1, out)
  return out
}

/** A schema's words for a hover or a suggestion, as Markdown. */
export function describe(schema: Schema): string {
  const parts: string[] = []
  if (schema.title) parts.push(`**${schema.title}**`)
  const text = schema.markdownDescription ?? schema.description
  if (text) parts.push(text)
  if (schema.deprecationMessage) parts.push(`*Deprecated:* ${schema.deprecationMessage}`)
  return parts.join('\n\n')
}

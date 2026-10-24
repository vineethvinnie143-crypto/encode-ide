/**
 * A JSON Schema checker for the subset tool inputs and protocol messages use:
 * type (one or several), properties, required, additionalProperties, items,
 * enum, const, string length and pattern, number bounds, array size, anyOf
 * and oneOf. Keywords outside the subset are ignored, never guessed at.
 *
 * Errors read as sentences a model can act on: "todos[0].status must be one
 * of: pending, in_progress, completed".
 */

export type JsonSchema = Record<string, unknown>

export interface SchemaError {
  /** Where, as a JavaScript-like path ('' for the value itself). */
  path: string
  message: string
}

const MAX_ERRORS = 8

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value)
  if (type === 'number') return actual === 'number' || actual === 'integer'
  return actual === type
}

function describe(value: unknown): string {
  const text = JSON.stringify(value)
  return text === undefined ? String(value) : text.length > 40 ? `${text.slice(0, 40)}…` : text
}

function label(path: string): string {
  return path || 'the input'
}

function child(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`
  return /^[A-Za-z_$][\w$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`
}

function check(value: unknown, schema: JsonSchema, path: string, errors: SchemaError[]): void {
  if (errors.length >= MAX_ERRORS || !schema || typeof schema !== 'object') return
  const fail = (message: string) => {
    if (errors.length < MAX_ERRORS) errors.push({ path, message: `${label(path)} ${message}` })
  }

  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    fail(`must be ${describe(schema.const)}`)
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    fail(`must be one of: ${schema.enum.map((option) => (typeof option === 'string' ? option : describe(option))).join(', ')}`)
    return
  }
  const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? (schema.type as string[]) : []
  if (types.length && !types.some((type) => matchesType(value, type))) {
    fail(`must be ${types.map((type) => (type === 'array' || type === 'object' || type === 'integer' ? `an ${type}` : `a ${type}`)).join(' or ')}, not ${typeOf(value) === 'integer' ? 'a number' : typeOf(value)}`)
    return
  }

  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const options = schema[keyword]
    if (!Array.isArray(options) || !options.length) continue
    const passing = options.filter((option) => {
      const trial: SchemaError[] = []
      check(value, option as JsonSchema, path, trial)
      return trial.length === 0
    }).length
    if (keyword === 'anyOf' ? passing === 0 : passing !== 1) {
      fail(passing === 0 ? 'does not match any of the allowed shapes' : 'matches more than one of the allowed shapes')
      return
    }
  }

  if (typeof value === 'string') {
    // Characters are counted only when the length in UTF-16 units cannot settle it: a picture's base64 runs to megabytes.
    const units = value.length
    const characters = () => [...value].length
    if (typeof schema.minLength === 'number' && (units < schema.minLength || (units < schema.minLength * 2 && characters() < schema.minLength))) fail(`must be at least ${schema.minLength} characters`)
    if (typeof schema.maxLength === 'number' && units > schema.maxLength && characters() > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`)
    if (typeof schema.pattern === 'string') {
      let pattern: RegExp | undefined
      try {
        pattern = new RegExp(schema.pattern, 'u')
      } catch {
        pattern = undefined
      }
      if (pattern && !pattern.test(value)) fail(`must match ${schema.pattern}`)
    }
  } else if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(`must be at least ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail(`must be at most ${schema.maximum}`)
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) fail(`must be greater than ${schema.exclusiveMinimum}`)
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) fail(`must be less than ${schema.exclusiveMaximum}`)
  } else if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(`must have at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(`must have at most ${schema.maxItems} items`)
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      value.forEach((item, index) => check(item, schema.items as JsonSchema, child(path, index), errors))
    }
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const properties = (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<string, JsonSchema>
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && record[key] === undefined) {
          if (errors.length < MAX_ERRORS) errors.push({ path: child(path, key), message: `${child(path, key)} is required` })
        }
      }
    }
    for (const [key, field] of Object.entries(record)) {
      // An undefined value is an absent one, as it would be after JSON; a port that clones structurally keeps it.
      if (field === undefined) continue
      if (Object.hasOwn(properties, key)) {
        check(field, properties[key], child(path, key), errors)
      } else if (schema.additionalProperties === false) {
        if (errors.length < MAX_ERRORS) errors.push({ path: child(path, key), message: `${child(path, key)} is not a known parameter` })
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(field, schema.additionalProperties as JsonSchema, child(path, key), errors)
      }
    }
  }
}

/** Every way `value` breaks `schema` (up to eight), or an empty list. */
export function validate(value: unknown, schema: JsonSchema): SchemaError[] {
  const errors: SchemaError[] = []
  check(value, schema, '', errors)
  return errors
}

/** The errors as one message, or undefined when there are none. */
export function validationMessage(value: unknown, schema: JsonSchema): string | undefined {
  const errors = validate(value, schema)
  if (!errors.length) return undefined
  return errors.map((error) => error.message).join('; ')
}

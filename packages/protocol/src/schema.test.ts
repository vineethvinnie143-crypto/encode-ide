import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validate, validationMessage, type JsonSchema } from './schema'

const TODOS: JsonSchema = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 1 },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        },
        required: ['content', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['todos'],
  additionalProperties: false,
}

describe('validate', () => {
  it('accepts a value that fits', () => {
    assert.deepEqual(validate({ todos: [{ content: 'Write tests', status: 'pending' }] }, TODOS), [])
  })

  it('names the path and what is wrong, in words a model can act on', () => {
    const errors = validate({ todos: [{ content: '', status: 'doing', owner: 'me' }], extra: 1 }, TODOS)
    assert.deepEqual(
      errors.map((error) => error.message),
      [
        'todos[0].content must be at least 1 characters',
        'todos[0].status must be one of: pending, in_progress, completed',
        'todos[0].owner is not a known parameter',
        'extra is not a known parameter',
      ],
    )
    assert.equal(errors[1].path, 'todos[0].status')
  })

  it('reads an undefined value as an absent one, which is what JSON would make of it', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { text: { type: 'string' }, attachments: { type: 'array', items: { type: 'string' } } },
      required: ['text'],
      additionalProperties: false,
    }
    assert.deepEqual(validate({ text: 'hi', attachments: undefined }, schema), [])
    assert.deepEqual(validate({ text: 'hi', other: undefined }, schema), [])
    assert.equal(validationMessage({ text: undefined }, schema), 'text is required')
    assert.equal(validationMessage({ text: 'hi', attachments: 'x' }, schema), 'attachments must be an array, not string')
  })

  it('reports missing required fields and wrong types', () => {
    assert.equal(validationMessage({}, TODOS), 'todos is required')
    assert.equal(validationMessage({ todos: 'x' }, TODOS), 'todos must be an array, not string')
    assert.equal(validationMessage(null, TODOS), 'the input must be an object, not null')
  })

  it('tells integers from numbers, and accepts integers as numbers', () => {
    assert.equal(validationMessage(1.5, { type: 'integer' }), 'the input must be an integer, not number')
    assert.equal(validationMessage(3, { type: 'number' }), undefined)
    assert.equal(validationMessage(3, { type: ['string', 'integer'] }), undefined)
    assert.equal(validationMessage(5, { type: 'integer', minimum: 1, maximum: 4 }), 'the input must be at most 4')
    assert.equal(validationMessage(0, { type: 'number', exclusiveMinimum: 0 }), 'the input must be greater than 0')
  })

  it('handles anyOf and oneOf', () => {
    const schema: JsonSchema = { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }
    assert.equal(validationMessage('a', schema), undefined)
    assert.equal(validationMessage(['a'], schema), undefined)
    assert.equal(validationMessage(3, schema), 'the input does not match any of the allowed shapes')
    const one: JsonSchema = { oneOf: [{ type: 'number' }, { type: 'integer' }] }
    assert.equal(validationMessage(2, one), 'the input matches more than one of the allowed shapes')
  })

  it('checks patterns, lengths by code point, const and odd property names', () => {
    assert.equal(validationMessage('ab', { type: 'string', pattern: '^[a-z]+$' }), undefined)
    assert.equal(validationMessage('aB', { type: 'string', pattern: '^[a-z]+$' }), 'the input must match ^[a-z]+$')
    assert.equal(validationMessage('😀', { type: 'string', maxLength: 1 }), undefined)
    assert.equal(validationMessage('x', { const: 'y' }), 'the input must be "y"')
    assert.equal(validationMessage({ 'a-b': 1 }, { type: 'object', additionalProperties: false }), '["a-b"] is not a known parameter')
  })

  it('checks additionalProperties given as a schema', () => {
    const schema: JsonSchema = { type: 'object', additionalProperties: { type: 'string' } }
    assert.equal(validationMessage({ a: 'x', b: 2 }, schema), 'b must be a string, not a number')
  })

  it('stops after eight errors', () => {
    const value = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, index]))
    assert.equal(validate(value, { type: 'object', additionalProperties: false }).length, 8)
  })

  it('ignores keywords outside the subset instead of guessing', () => {
    assert.deepEqual(validate('x', { type: 'string', format: 'email', $ref: '#/nowhere' }), [])
  })
})

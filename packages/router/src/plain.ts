/**
 * What the router tells a person, in plain words: one sentence for why a model was left or a request cannot run,
 * made from what the router knows. The provider's own text, and the router's longer account, go in `detail`.
 *
 * Provider ids appear as they are; a client that names providers differently (the desktop's profiles) replaces them.
 */
import { failureSentence, type PlainFailure } from '@encode/providers'
import { parseModelRef } from './refs'
import type { Skip } from './select'

function names(key: string): { model: string; provider: string } {
  const parsed = parseModelRef(key)
  return parsed ? { model: parsed.model, provider: parsed.provider } : { model: key, provider: key }
}

/** One sentence on what happened to the model `key`. */
export function failureOf(failure: PlainFailure, key: string): string {
  return failureSentence(failure, names(key))
}

/** One sentence on why selection passed over a model; `kind` is the block's kind when the skip is a block. */
export function skipSentence(skip: Skip, kind?: string): string {
  const { model, provider } = names(skip.key)
  switch (skip.reason) {
    case 'not-free':
      return `${model} is not free, and only free models are allowed.`
    case 'no-key':
      return `There is no API key for ${provider}.`
    case 'no-adapter':
      return `eNCode cannot talk to ${provider}.`
    case 'expired':
      return `${provider} retired ${model}.`
    case 'tools':
      return `${model} cannot use tools.`
    case 'images':
      return `${model} cannot read images.`
    case 'context':
      return `The conversation is too long for ${model}.`
    case 'pacing':
      return `The free models on ${provider} have reached their limit for the minute.`
    case 'tried':
      return `${model} already failed on this request.`
    case 'provider-blocked':
    case 'paid-blocked':
    case 'free-closed':
    case 'cooling':
      return failureOf({ kind: kind ?? 'unavailable' }, skip.key)
  }
}

/** "this chat" for the main role, "the reviewer role" for the others. */
export function roleText(role: string): string {
  return role === 'main' ? 'this chat' : `the ${role} role`
}

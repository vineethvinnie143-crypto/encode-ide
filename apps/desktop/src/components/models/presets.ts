import type { ProfileKind } from '@shared/types'

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1'

/** A provider the interface can set up in a few fields. Anything else is "Custom": an address that speaks the OpenAI API. */
export interface Preset {
  id: string
  label: string
  /** What a new connection to it is called. */
  name: string
  kind: ProfileKind
  baseUrl: string
  /** A first model to try when the provider's list cannot be read. */
  model: string
  /** A server on this computer: no key, and nothing to pay. */
  local?: boolean
  /** The shape of this provider's keys, shown in the empty field. */
  keyHint: string
  /** What keys from this provider start with, to catch a key pasted into the wrong place. */
  keyPrefix?: string
  /** Where a person gets a key. */
  keyUrl?: string
}

export const PRESETS: readonly Preset[] = [
  { id: 'openrouter', label: 'OpenRouter', name: 'OpenRouter', kind: 'openrouter', baseUrl: OPENROUTER_URL, model: '', keyHint: 'sk-or-v1-…', keyPrefix: 'sk-or-', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'anthropic', label: 'Anthropic', name: 'Anthropic', kind: 'custom', baseUrl: 'https://api.anthropic.com', model: '', keyHint: 'sk-ant-…', keyPrefix: 'sk-ant-', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', name: 'OpenAI', kind: 'custom', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyHint: 'sk-…', keyPrefix: 'sk-', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', label: 'DeepSeek', name: 'DeepSeek', kind: 'custom', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', keyHint: 'sk-…', keyPrefix: 'sk-', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'ollama', label: 'Ollama', name: 'Ollama', kind: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', local: true, keyHint: '' },
  { id: 'lmstudio', label: 'LM Studio', name: 'LM Studio', kind: 'custom', baseUrl: 'http://localhost:1234/v1', model: '', local: true, keyHint: '' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', name: 'Custom', kind: 'custom', baseUrl: '', model: '', keyHint: 'sk-…' },
]

export function presetOf(id: string): Preset {
  return PRESETS.find((preset) => preset.id === id) ?? PRESETS[PRESETS.length - 1]
}

/** Whether an address is Anthropic's own API, which is called with its own headers and a different path. */
export function isAnthropicUrl(url: string): boolean {
  try {
    return new URL(url.trim()).hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

/** Compares addresses the way a person would: same host and path, a trailing slash or capital letters aside. */
export function sameAddress(a: string, b: string): boolean {
  const norm = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase()
  return norm(a) !== '' && norm(a) === norm(b)
}

/** A gentle warning when a key looks like another provider's. null when it looks right or nothing is known about the shape. */
export function keyWarning(preset: Preset, key: string): string | null {
  const text = key.trim()
  if (!text) return null
  if (/\s/.test(text)) return 'This key has a space or a line break in it. Copy it again without anything around it.'
  if (!preset.keyPrefix || text.startsWith(preset.keyPrefix)) return null
  return `${preset.label} keys start with ${preset.keyPrefix}. eNCode will still try this one.`
}

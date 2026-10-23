/**
 * Suggestions as you type (ghost text, ADR 0087): how much of a file the editor may send for one, and whether they are
 * on for the settings as they are. Pure, so the main process, which refuses a request while they are off, and the
 * interface, which says why they are off, judge alike.
 */
import { isFreeRef, labelOfRef, modelMode, parseRef, roleRefs } from './models'
import type { InlineSuggest, Settings } from './types'

/** The most of the text before the cursor that is sent: the function it is in, and more above it. */
export const INLINE_PREFIX_CHARS = 6_000
/** The most of the text after the cursor. */
export const INLINE_SUFFIX_CHARS = 2_000
/** How many parts of other open files go with it, and the most of each. */
export const INLINE_SNIPPETS = 3
export const INLINE_SNIPPET_CHARS = 1_500
/** The longest path or language id taken. */
export const INLINE_NAME_CHARS = 1_024

/** The end of `text` within `max` characters, from the start of a line, so the model never sees half a line first. */
export function tailFromLine(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(text.length - max)
  const newline = cut.indexOf('\n')
  return newline < 0 ? '' : cut.slice(newline + 1)
}

/** The start of `text` within `max` characters, to the end of a line. */
export function headToLine(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const newline = cut.lastIndexOf('\n')
  return newline < 0 ? '' : cut.slice(0, newline)
}

export const INLINE_MODES: readonly InlineSuggest[] = ['auto', 'on', 'off']

export const isInlineSuggest = (value: unknown): value is InlineSuggest => typeof value === 'string' && (INLINE_MODES as readonly string[]).includes(value)

export interface InlineState {
  on: boolean
  /** One or two sentences for the person: where the suggestions come from, or why there are none. */
  reason: string
}

type InlineSettings = Pick<Settings, 'inlineSuggest' | 'roles' | 'profiles' | 'activeProfileId' | 'freeOnly'>

/**
 * Whether a reference is one of the free models a provider allows only so many requests a day: "@free", or an
 * OpenRouter model whose id ends in ":free". A server on this computer costs nothing and has no such limit.
 */
export function isRationedRef(settings: Pick<Settings, 'profiles'>, ref: string): boolean {
  const parsed = parseRef(ref, settings.profiles)
  if (!parsed) return false
  if (parsed.kind === 'free') return true
  const profile = settings.profiles.find((candidate) => candidate.id === parsed.profileId)
  return profile?.kind === 'openrouter' && parsed.model.endsWith(':free')
}

/** Whether the editor suggests code as you type under these settings, and why or why not, in words. */
export function inlineState(settings: InlineSettings): InlineState {
  if (settings.inlineSuggest === 'off') return { on: false, reason: 'Off. Choose Auto or On to have the editor suggest code as you type.' }
  const mode = modelMode(settings)
  if (mode === 'demo') return { on: false, reason: 'The offline demo does not suggest code. Connect a model in Settings, Models first.' }
  if (mode === 'none') return { on: false, reason: 'No model is connected. Connect one in Settings, Models first.' }
  const refs = roleRefs(settings, 'inline')
  const usable = settings.freeOnly ? refs.filter((ref) => isFreeRef(settings, ref)) : refs
  if (!usable.length) {
    return { on: false, reason: 'Off: only free models may answer (Settings, Models), and the Inline suggestions role has none. Give it a free model, or let paid models answer.' }
  }
  const first = usable[0]
  if (settings.inlineSuggest === 'auto' && isRationedRef(settings, first)) {
    return {
      on: false,
      reason:
        'Off for now: the Inline suggestions role would use free models, which take only so many requests a day, and those are kept for the agent. Give the role a model of its own in Settings, Models, or choose On to use the free models anyway.',
    }
  }
  return { on: true, reason: `Suggestions come from ${labelOfRef(settings, first)}.` }
}

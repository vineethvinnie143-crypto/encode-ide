/**
 * Which models are sent the short instructions and tool descriptions (ADR 0094). The full guide spells out habits a
 * frontier model keeps without being told (say what you are about to do, read before you edit, search rather than
 * guess); for such a model the guide is tokens paid on every step for nothing. The models listed here follow the short
 * one as well as the long; every other model, and every model when the person chooses the full guide, gets it all.
 */

/** `auto`: the short guide for the models below, the full one for the rest. `full`: the full guide for every model. */
export type GuideSetting = 'auto' | 'full'

export const isGuideSetting = (value: unknown): value is GuideSetting => value === 'auto' || value === 'full'

/** A model id as providers write it ("anthropic/claude-sonnet-4.5:beta", "gpt-5-2025-08-07"), as its bare name. */
function bareName(model: string): string {
  return (model.split('/').pop() ?? model).split(':')[0].trim().toLowerCase()
}

const atLeast = (version: string | undefined, least: number) => version !== undefined && Number.parseFloat(version.replace('-', '.')) >= least

/** Whether `model` follows the short guide: Claude Opus, Sonnet and Fable from 4, GPT-5 and o3 (not their small sizes), Gemini Pro from 2.5, Grok 4. */
export function needsNoGuide(model: string): boolean {
  const name = bareName(model)
  const claude = /^claude-(?:(?:opus|sonnet|fable)-(\d+(?:[.-]\d)?)|(\d+(?:[.-]\d)?)-(?:opus|sonnet))(?:$|[-.@])/.exec(name)
  if (claude) return atLeast(claude[1] ?? claude[2], 4)
  if (/^gpt-5(?:\.\d+)?(?:-(?:codex|pro|chat-latest|\d{4}-\d{2}-\d{2}))*$/.test(name)) return true
  if (/^o3(?:-pro)?(?:-\d{4}-\d{2}-\d{2})?$/.test(name)) return true
  const gemini = /^gemini-(\d+(?:\.\d+)?)-pro(?:$|-)/.exec(name)
  if (gemini) return atLeast(gemini[1], 2.5)
  return /^grok-4(?:\.\d+)?(?:-\d{4})?$/.test(name)
}

/** Whether this call goes out with the short guide. */
export function shortGuide(setting: GuideSetting | undefined, model: string): boolean {
  return (setting ?? 'auto') === 'auto' && needsNoGuide(model)
}

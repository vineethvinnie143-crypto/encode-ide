/**
 * Which models are strong enough to work without eNCode's extra help (ADR 0094, 0100): the frontier models, which
 * keep the habits the full guide spells out and do the hard steps a smaller model fails at. Every other model is a
 * smaller one: it gets the full guide, the help for smaller models, and a stronger model offered when it fails twice.
 *
 * Pure, over the model's id, so the agent and the desktop's settings read the same rule.
 */

/** A model id as providers write it ("anthropic/claude-sonnet-4.5:beta", "gpt-5-2025-08-07"), as its bare name. */
function bareName(model: string): string {
  return (model.split('/').pop() ?? model).split(':')[0].trim().toLowerCase()
}

const atLeast = (version: string | undefined, least: number) => version !== undefined && Number.parseFloat(version.replace('-', '.')) >= least

/** Claude Opus, Sonnet and Fable from 4, GPT-5 and o3 (not their small sizes), Gemini Pro from 2.5, Grok 4. */
export function isStrongModel(model: string): boolean {
  const name = bareName(model)
  const claude = /^claude-(?:(?:opus|sonnet|fable)-(\d+(?:[.-]\d)?)|(\d+(?:[.-]\d)?)-(?:opus|sonnet))(?:$|[-.@])/.exec(name)
  if (claude) return atLeast(claude[1] ?? claude[2], 4)
  if (/^gpt-5(?:\.\d+)?(?:-(?:codex|pro|chat-latest|\d{4}-\d{2}-\d{2}))*$/.test(name)) return true
  if (/^o3(?:-pro)?(?:-\d{4}-\d{2}-\d{2})?$/.test(name)) return true
  const gemini = /^gemini-(\d+(?:\.\d+)?)-pro(?:$|-)/.exec(name)
  if (gemini) return atLeast(gemini[1], 2.5)
  return /^grok-4(?:\.\d+)?(?:-\d{4})?$/.test(name)
}

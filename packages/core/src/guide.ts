/**
 * Which models are sent the short instructions and tool descriptions (ADR 0094). The full guide spells out habits a
 * frontier model keeps without being told (say what you are about to do, read before you edit, search rather than
 * guess); for such a model the guide is tokens paid on every step for nothing. The strong models (`isStrongModel` in
 * @encode/providers) follow the short one as well as the long; every other model, and every model when the person
 * chooses the full guide, gets it all.
 */
import { isStrongModel } from '@encode/providers'

/** `auto`: the short guide for the strong models, the full one for the rest. `full`: the full guide for every model. */
export type GuideSetting = 'auto' | 'full'

export const isGuideSetting = (value: unknown): value is GuideSetting => value === 'auto' || value === 'full'

/** Whether `model` follows the short guide. */
export const needsNoGuide = isStrongModel

/** Whether this call goes out with the short guide. */
export function shortGuide(setting: GuideSetting | undefined, model: string): boolean {
  return (setting ?? 'auto') === 'auto' && needsNoGuide(model)
}

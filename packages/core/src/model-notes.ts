/**
 * Notes for one family of models (ADR 0142): a few lines after a role's instructions, on what that family does that a
 * line of instructions changes. Each note answers a failure the benchmark measured, and stays only while a comparison of
 * runs with and without the notes (`pnpm bench run --pair model-notes`) shows that it helps. The notes are fixed text,
 * so a prompt cache holds them with the instructions.
 *
 * DeepSeek's Reviewer: on a change of about 1,200 tokens, V4.1 Flash thought for 10,000 to 12,000 tokens in 11 of 45
 * reviews and ran out the Reviewer's 4 minutes (the re-run of 2026-10-26); its reasoning effort barely shortens that.
 * The agent has no note yet: what its declined and failed commands were is recorded from this change on, and a note
 * waits for what they show.
 */
import type { ModelClient, ModelFamily, ModelRole, SystemPart } from '@encode/providers'

/** `auto` (the default): a model of a family with notes gets them. `off`: no model does. */
export type ModelNotesSetting = 'auto' | 'off'

export const isModelNotesSetting = (value: unknown): value is ModelNotesSetting => value === 'auto' || value === 'off'

export interface ModelNotes {
  /** For a Reviewer that reads changes: the completion review and the code review. */
  reviewer?: string
}

const DEEPSEEK: ModelNotes = {
  reviewer: `# Keep your reasoning short

Read each change once against the request and decide: a problem, or not. Do not go over the same lines again, and do not work out what the code does beyond what the decision needs. A review like this needs a few hundred words of reasoning, not thousands; then write your answer.`,
}

/** The notes of a model's family: by the family the client knows, or by the model's id (a preset named after its model). */
export function modelNotes(model: string, family?: ModelFamily): ModelNotes {
  if (family === 'deepseek' || /deepseek/i.test(model)) return DEEPSEEK
  return {}
}

/**
 * The instructions of a Reviewer that reads changes, with the note for the model the router expects for its role.
 * A client that cannot say which model that is gets the instructions alone; the call itself then says what is wrong.
 */
export async function reviewerSystem(client: Pick<ModelClient, 'budget'>, text: string, setting: ModelNotesSetting | undefined, role: ModelRole = 'reviewer'): Promise<SystemPart[]> {
  const system: SystemPart[] = [{ text, cache: true }]
  if (setting === 'off') return system
  let note: string | undefined
  try {
    const budget = await client.budget(role)
    note = modelNotes(budget.model, budget.family).reviewer
  } catch {
    return system
  }
  return note ? [...system, { text: note, cache: true }] : system
}

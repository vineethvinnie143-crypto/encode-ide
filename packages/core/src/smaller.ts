/**
 * Help for smaller models, and a stronger model when one keeps failing (ADR 0100).
 *
 * A model that is not one of the strong ones (`isStrongModel`) already gets the full guide (0094) and the Reviewer
 * before it finishes (0096). Two more things hold it, unless the person turned them off:
 *
 * - a short part after the instructions: say what will change before the first change, take one checked step at a
 *   time, and change a call that failed before sending it again;
 * - think before edit: the first change of a request waits until the agent has said, in its reply or its reasoning,
 *   what it will change. The calls are not run; their results say why, and the agent sends them again.
 *
 * When such a model runs into trouble twice in one request (the checks, the language servers, the claim check or the
 * Reviewer send its work back, or a call fails the same way twice), and a role the person gave a strong model of its
 * own (Plan, then Review) is there, the person is asked whether that model may do the rest of the request. It costs
 * more, so it is never done unasked; "for this session" makes it the rule until the session ends.
 */
import { isStrongModel, requestStart, type Message, type ModelBudget, type ModelRole, type SystemPart } from '@encode/providers'

/** `auto`: a smaller model gets the help. `off`: no model does. */
export type SmallerHelp = 'auto' | 'off'
/** `ask`: a stronger model is offered after two setbacks. `off`: never. */
export type StrongerOffer = 'ask' | 'off'

export const isSmallerHelp = (value: unknown): value is SmallerHelp => value === 'auto' || value === 'off'
export const isStrongerOffer = (value: unknown): value is StrongerOffer => value === 'ask' || value === 'off'

/** Whether this model gets the help for smaller models. */
export function helpsSmaller(setting: SmallerHelp | undefined, model: string): boolean {
  return (setting ?? 'auto') === 'auto' && !isStrongModel(model)
}

export const SMALLER_MODEL_TEXT = `# Small, checked steps

- Before your first change in a request, write two to four lines: which files you will change, what changes in each, and how you will check it. Work across several files starts with its steps in TodoWrite.
- Change one thing, then check it: read the whole error or test output and fix its cause before the next change.
- When a call fails, read its error and change what you send: a call sent again unchanged fails again.`

/** After the instructions, for a smaller model: fixed, so prompt caches hold it with them. */
export const SMALLER_MODEL_PART: SystemPart = { text: SMALLER_MODEL_TEXT, cache: true }

/** The tools whose calls change files. */
export const CHANGE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'LSPEdit'])

/** Characters of reply, or of reasoning, that count as having said what will change. */
const SAID_ENOUGH = 80

/** Whether the agent has written, or reasoned, enough since the request began to have said what it will change. */
export function saidWhatChanges(messages: readonly Message[]): boolean {
  let text = 0
  let thought = 0
  for (const message of messages.slice(requestStart(messages) + 1)) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'text') text += block.text.trim().length
      else if (block.type === 'thinking') thought += block.text.trim().length || (block.details?.length ? SAID_ENOUGH : 0)
      // Reasoning that came encrypted is reasoning all the same.
      else if (block.type === 'redacted-thinking') thought += SAID_ENOUGH
    }
  }
  return text >= SAID_ENOUGH || thought >= SAID_ENOUGH
}

/** The result of a change held until the agent says what it will change. */
export const THINK_FIRST =
  'Not run yet. Before the first change of a request, say in two to four lines which files you will change, what changes in each, and how you will check it. Then make this call again.'

/** Setbacks in one request after which a stronger model is offered. */
export const STRONGER_AFTER = 2

/** Why a finish gate sent the work back, as a setback. */
export type SentBack = 'errors' | 'checks' | 'claims' | 'reviewer'

const SENT_BACK: Record<SentBack, string> = {
  errors: 'the language servers reported errors in its changes',
  checks: "the project's checks failed after its changes",
  claims: 'its reply said what eNCode could not confirm',
  reviewer: "the Reviewer found a problem in its changes",
}

/** A path argument of a call, for counting misses on one file. */
function pathOf(input: Record<string, unknown>): string | undefined {
  const value = input.file_path ?? input.path ?? input.notebook_path
  return typeof value === 'string' && value ? value : undefined
}

/**
 * What went wrong in one request, counted: each send-back of a finish gate, a call that failed the same way a second
 * time, and a second failed change to one file.
 */
export class Setbacks {
  private readonly why: string[] = []
  private readonly calls = new Map<string, string>()
  private readonly counted = new Set<string>()
  private readonly misses = new Map<string, number>()

  clear(): void {
    this.why.length = 0
    this.calls.clear()
    this.counted.clear()
    this.misses.clear()
  }

  get count(): number {
    return this.why.length
  }

  /** What went wrong, in words, in order. */
  get reasons(): readonly string[] {
    return this.why
  }

  sentBack(gate: SentBack): void {
    this.why.push(SENT_BACK[gate])
  }

  /** A call of the agent's ended; `failure` is its error when it failed. */
  call(name: string, input: Record<string, unknown>, failure: string | undefined): void {
    const key = `${name}\u0000${JSON.stringify(input)}`
    if (failure === undefined) {
      this.calls.delete(key)
      return
    }
    const error = failure.slice(0, 500)
    if (this.calls.get(key) === error) {
      if (!this.counted.has(key)) this.why.push(`the same \`${name}\` call failed twice`)
      this.counted.add(key)
      return
    }
    this.calls.set(key, error)
    const file = CHANGE_TOOLS.has(name) ? pathOf(input) : undefined
    if (!file) return
    const misses = (this.misses.get(file) ?? 0) + 1
    this.misses.set(file, misses)
    if (misses === 2) this.why.push(`\`${name}\` failed twice on ${file.split(/[\\/]/).pop()}`)
  }
}

/** The roles whose own model may take over, best first: Plan drafts the hardest steps, Review checks them. */
export const STRONGER_ROLES: readonly ModelRole[] = ['planner', 'reviewer']

const ROLE_NAME: Record<string, string> = { planner: 'Plan', reviewer: 'Review' }

/** "anthropic/claude-sonnet-4.5" as "claude-sonnet-4.5". */
export function shortModel(model: string): string {
  return model.split('/').pop() ?? model
}

function dollars(value: number): string {
  return `$${value < 1 ? value.toFixed(2).replace(/0$/, '') : value.toFixed(2)}`
}

/** What the person is asked, with what the stronger model costs next to the one in use when both prices are known. */
export function strongerPrompt(input: { from: string; to: ModelBudget; role: ModelRole; reasons: readonly string[]; price?: ModelBudget['price'] }): { title: string; detail: string } {
  const from = shortModel(input.from)
  const to = shortModel(input.to.model)
  // The same setback twice is said once, with how often.
  const counts = new Map<string, number>()
  for (const reason of input.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  const reasons = [...counts].slice(0, 3).map(([reason, count]) => (count === 1 ? reason : `${reason}, ${count === 2 ? 'twice' : `${count} times`}`))
  const said = reasons.length > 1 ? `${reasons.slice(0, -1).join('; ')}; and ${reasons.at(-1)}` : (reasons[0] ?? 'it failed twice')
  const lines = [`${from} ran into trouble twice in this request: ${said}.`, `${to}, the model of your ${ROLE_NAME[input.role] ?? input.role} role, would do the rest of it. The next request goes back to ${from}.`]
  const price = input.to.price
  if (input.to.free) lines.push(`${to} is free to call.`)
  else if (price) {
    const now = input.price && (input.price.input > 0 || input.price.output > 0) ? `, against ${dollars(input.price.input)} and ${dollars(input.price.output)} for ${from}` : ''
    lines.push(`It costs ${dollars(price.input)} per million tokens read and ${dollars(price.output)} written${now}.`)
  } else lines.push('It may cost more per token.')
  return { title: `Let ${to} take over this request?`, detail: lines.join(' ') }
}

/** What the model that takes over is told first. */
export function takeOverNote(from: string): string {
  return `A stronger model does the rest of this request: ${shortModel(from)} ran into trouble twice. Read what was tried and why it failed before you change anything, then finish the request.`
}

/**
 * Tools that talk to the user or shape the session rather than touch the
 * disk: TodoWrite, AskUserQuestion, EnterPlanMode, ExitPlanMode, Task, Skill,
 * the session goal, and attempt_completion for models that need an explicit
 * way to stop.
 */
import { plural } from './text'
import type { GoalStatus, Question, SkillSummary, SubagentType, TodoInput, Tool, ToolOutcome } from './types'

function fail(content: string): ToolOutcome {
  return { ok: false, content }
}

// ---------------------------------------------------------------------------
// TodoWrite

interface TodoWriteInput extends Record<string, unknown> {
  todos: TodoInput[]
}

export const todoWriteTool: Tool<TodoWriteInput> = {
  definition: {
    name: 'TodoWrite',
    description: [
      'Keeps a visible task list for the current work. Send the complete list every time; it replaces the previous one.',
      '',
      'Use it when the work has three or more distinct steps, when the user gives several tasks, or when new steps come up along the way. Skip it for a single quick task.',
      '',
      '- Each item has content (what to do, imperative: "Run the tests"), activeForm (what is happening, present continuous: "Running the tests") and status.',
      '- Mark an item in_progress before starting it, and keep exactly one in progress at a time.',
      '- Mark it completed as soon as it is done, not in batches. Only completed when it is really done: tests passing, nothing left half-finished. If you are blocked, keep it in_progress and add an item for what blocks it.',
      '- Remove items that no longer apply.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', minLength: 1 },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string', minLength: 1 },
            },
            required: ['content', 'status', 'activeForm'],
            additionalProperties: false,
          },
          description: 'The whole list, in order.',
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
  },
  kind: 'interaction',
  readOnly: true,
  access: () => ({ type: 'none' }),
  describe: (input) => ({ title: `Update the task list (${plural(input.todos.length, 'item')})` }),
  async run(input, ctx) {
    ctx.interaction.setTodos(input.todos)
    if (!input.todos.length) return { ok: true, content: 'The task list is now empty.' }
    const active = input.todos.filter((todo) => todo.status === 'in_progress').length
    const advice = active > 1 ? ' More than one item is in progress; keep exactly one in progress at a time.' : ''
    return { ok: true, content: `Task list updated. Keep it current as you work.${advice}` }
  },
}

// ---------------------------------------------------------------------------
// AskUserQuestion

interface AskInput extends Record<string, unknown> {
  questions: Question[]
}

export const askUserQuestionTool: Tool<AskInput> = {
  definition: {
    name: 'AskUserQuestion',
    description: [
      'Asks the user one to four multiple-choice questions and waits for the answers.',
      '',
      'Use it when a decision is genuinely the user\'s (a preference, a trade-off, an unclear requirement) and guessing would waste work. Do not use it for things you can find out yourself.',
      '',
      '- header is a label of at most 12 characters, such as "Auth method".',
      '- Give two to four options, each with a short label and a description of what it means. The user can always answer in their own words instead.',
      '- Set multiSelect when several options can be chosen together.',
      '- If you recommend an option, put it first and end its label with "(Recommended)".',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', minLength: 1, description: 'The full question, ending with a question mark.' },
              header: { type: 'string', minLength: 1, maxLength: 12, description: 'A short label for the question.' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', minLength: 1, description: 'One to five words.' },
                    description: { type: 'string', description: 'What choosing it means.' },
                  },
                  required: ['label'],
                  additionalProperties: false,
                },
              },
              multiSelect: { type: 'boolean', description: 'Allow choosing several options.' },
            },
            required: ['question', 'header', 'options', 'multiSelect'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  },
  kind: 'interaction',
  readOnly: true,
  access: () => ({ type: 'none' }),
  describe: (input) => ({ title: input.questions.length === 1 ? input.questions[0].question : `Ask ${plural(input.questions.length, 'question')}` }),
  async run(input, ctx) {
    const answers = await ctx.interaction.ask(input.questions, ctx.signal)
    const lines = input.questions.map((question, index) => `- ${question.question}\n  ${answers[index]?.trim() || '(no answer)'}`)
    return { ok: true, content: `The user answered:\n${lines.join('\n')}\n\nContinue with these answers in mind.` }
  },
}

// ---------------------------------------------------------------------------
// EnterPlanMode

interface EnterPlanInput extends Record<string, unknown> {
  reason?: string
}

/** What the model reads once it is in plan mode: the same rules the plan mode reminder gives. */
export const PLAN_MODE_ENTERED =
  'You are in plan mode now. Only the read-only tools work: read and search the code, run nothing that changes anything. Investigate until you can plan the change, then call ExitPlanMode with a concrete, ordered plan. The user reviews it before any work starts.'

export const enterPlanModeTool: Tool<EnterPlanInput> = {
  definition: {
    name: 'EnterPlanMode',
    description: [
      'Asks the user to switch to plan mode, to agree on the approach before changing anything.',
      '',
      'Use it for work worth agreeing on first: a new feature, a change across files, a choice between approaches, or an unclear request. Not for a small fix, a change the user spelled out, or a question.',
      '',
      '- In plan mode only read-only tools work: investigate, then call ExitPlanMode with the plan.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'One sentence for the user: why a plan should come first.' } },
      additionalProperties: false,
    },
  },
  kind: 'interaction',
  readOnly: true,
  modes: ['code'],
  access: () => ({ type: 'none' }),
  describe: (input) => ({ title: 'Plan first', ...(input.reason?.trim() ? { detail: input.reason.trim() } : {}) }),
  async run(input, ctx) {
    const consent = await ctx.interaction.enterPlan((input.reason ?? '').trim().slice(0, 500), ctx.signal)
    if (!consent.approved) {
      return { ok: true, content: `The user wants you to go ahead without a plan.${consent.note ? ` They said: ${consent.note}` : ''} Carry on with the work in code mode.` }
    }
    return { ok: true, content: PLAN_MODE_ENTERED, mode: 'plan' }
  },
}

// ---------------------------------------------------------------------------
// ExitPlanMode

interface PlanInput extends Record<string, unknown> {
  plan: string
}

export const exitPlanModeTool: Tool<PlanInput> = {
  definition: {
    name: 'ExitPlanMode',
    description: [
      'In plan mode, presents your implementation plan to the user for approval.',
      '',
      '- Call it once you have investigated enough to plan the change, and only for work that will change code. Not for research questions: answer those directly.',
      '- plan is Markdown: the steps in order, the files each one touches, and how the result will be checked. Be concrete and brief.',
      '- If the user approves, you leave plan mode and can start on it. If not, revise the plan from their feedback.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: { plan: { type: 'string', minLength: 1, description: 'The plan, in Markdown.' } },
      required: ['plan'],
      additionalProperties: false,
    },
  },
  kind: 'interaction',
  readOnly: true,
  modes: ['plan'],
  access: () => ({ type: 'none' }),
  describe: () => ({ title: 'Propose a plan' }),
  async run(input, ctx) {
    const verdict = await ctx.interaction.proposePlan(input.plan, ctx.signal)
    if (verdict.deferred) {
      return {
        ok: true,
        content: 'The plan is with the user for review. Stop here; they will reply in a new message.',
        stop: { summary: 'Plan proposed.' },
      }
    }
    if (verdict.approved) {
      return { ok: true, content: 'The user approved the plan. You have left plan mode; carry it out now, keeping the task list current.', mode: 'code' }
    }
    return fail(`The user did not approve the plan.${verdict.feedback ? ` Their feedback: ${verdict.feedback}` : ''} Stay in plan mode and revise it.`)
  },
}

// ---------------------------------------------------------------------------
// Task

interface TaskInput extends Record<string, unknown> {
  description: string
  prompt: string
  subagent_type: string
  run_in_background?: boolean
}

export function createTaskTool(types: readonly SubagentType[]): Tool<TaskInput> {
  const names = types.map((type) => type.name)
  return {
    definition: {
      name: 'Task',
      description: [
        'Starts a subagent that works on its own and reports back once, with its final message.',
        '',
        'Available subagent types:',
        ...types.map((type) => `- ${type.name}: ${type.description}${type.tools ? ` (tools: ${type.tools.join(', ')})` : ''}`),
        '',
        'Use it for open-ended searches across a large codebase, and for self-contained pieces of work whose details you do not need to keep in your own context. Do not use it to read one known file or find one known name; use Read, Glob or Grep for that.',
        '',
        '- The subagent sees none of this conversation. Write prompt as a complete brief: the goal, what is known, what to return, and whether it may change files.',
        '- Its report reaches only you; tell the user what matters from it.',
        '- To run several subagents at once, call Task more than once in the same reply.',
        '- run_in_background true returns at once; the report reaches you as a notice when it ends. Do not wait or poll.',
        '- The result names an agent id: SendMessage to it continues that work.',
        '- description is three to five words naming the task.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', minLength: 1, description: 'Three to five words naming the task.' },
          prompt: { type: 'string', minLength: 1, description: 'The complete brief for the subagent.' },
          subagent_type: { type: 'string', enum: names, description: 'Which kind of subagent to start.' },
          run_in_background: { type: 'boolean', description: 'Return at once; the report arrives as a notice.' },
        },
        required: ['description', 'prompt', 'subagent_type'],
        additionalProperties: false,
      },
    },
    kind: 'agent',
    readOnly: true,
    access: () => ({ type: 'agent' }),
    describe: (input) => ({ title: input.description, detail: input.prompt + (input.run_in_background ? '\n(in the background)' : '') }),
    async run(input, ctx) {
      if (!ctx.subagents) return fail('Subagents are not available here. Do the work yourself.')
      const request = { description: input.description, prompt: input.prompt, type: input.subagent_type, toolUseId: ctx.toolUseId, mode: ctx.mode }
      if (input.run_in_background) {
        if (!ctx.subagents.start) return fail('Subagents cannot run in the background here. Call Task without run_in_background.')
        const started = await ctx.subagents.start(request)
        if (!started.ok) return fail(started.report)
        return {
          ok: true,
          content: `Started agent ${started.agentId} in the background. Its report reaches you as a notice when it ends; carry on with other work or end your turn.`,
          display: { output: `Working in the background (${started.agentId})` },
        }
      }
      const result = await ctx.subagents.run(request, ctx.signal)
      const report = result.report || '(the subagent returned no report)'
      return {
        ok: result.ok,
        content: result.agentId && ctx.subagents.message ? `${report}\n\n(agent id: ${result.agentId}; SendMessage to it continues this work)` : report,
        display: { output: report },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Skill

interface SkillInput extends Record<string, unknown> {
  skill: string
  args?: string
}

export function createSkillTool(skills: readonly SkillSummary[]): Tool<SkillInput> {
  return {
    definition: {
      name: 'Skill',
      description: [
        'Loads a skill: saved instructions for a particular kind of task. When a task matches a skill below, load it first and follow it.',
        '',
        'Available skills:',
        ...(skills.length ? skills.map((skill) => `- ${skill.name}: ${skill.description}`) : ['(none yet)']),
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', minLength: 1, description: 'The skill name, exactly as listed.' },
          args: { type: 'string', description: 'Anything the skill should know about this use of it.' },
        },
        required: ['skill'],
        additionalProperties: false,
      },
    },
    kind: 'read',
    readOnly: true,
    access: () => ({ type: 'none' }),
    describe: (input) => ({ title: `Load the ${input.skill} skill` }),
    async run(input, ctx) {
      const skill = await ctx.skills?.load(input.skill)
      if (!skill) {
        const known = ctx.skills?.list().map((item) => item.name) ?? []
        return fail(`There is no skill called ${input.skill}.${known.length ? ` Known skills: ${known.join(', ')}.` : ''}`)
      }
      const args = input.args?.trim() ? `\n\nArguments: ${input.args.trim()}` : ''
      return { ok: true, content: `Skill ${skill.name}. Its files are in ${skill.directory}.\n\n${skill.body}${args}` }
    },
  }
}

// ---------------------------------------------------------------------------
// The session goal

interface CreateGoalInput extends Record<string, unknown> {
  goal: string
}

interface UpdateGoalInput extends Record<string, unknown> {
  status: GoalStatus
  reason?: string
}

export const createGoalTool: Tool<CreateGoalInput> = {
  definition: {
    name: 'CreateGoal',
    description:
      'Sets the session goal: a long-running objective you keep working on across turns until it is complete or blocked. Use it only when the user asks for an outcome that will take many turns. There is one goal at a time.',
    inputSchema: {
      type: 'object',
      properties: { goal: { type: 'string', minLength: 1, description: 'The objective, concrete enough to tell when it is done.' } },
      required: ['goal'],
      additionalProperties: false,
    },
  },
  kind: 'interaction',
  readOnly: true,
  access: () => ({ type: 'none' }),
  describe: (input) => ({ title: 'Set the session goal', detail: input.goal }),
  async run(input, ctx) {
    if (!ctx.goals) return fail('Goals are not available here.')
    const existing = ctx.goals.get()
    if (existing && (existing.status === 'active' || existing.status === 'paused')) {
      return fail(`A goal is already set: "${existing.text}" (${existing.status}). Update it with UpdateGoal instead.`)
    }
    const now = Date.now()
    ctx.goals.set({ text: input.goal.trim(), status: 'active', rounds: 0, createdAt: now, updatedAt: now })
    return { ok: true, content: `Goal set: ${input.goal.trim()}` }
  },
}

export const updateGoalTool: Tool<UpdateGoalInput> = {
  definition: {
    name: 'UpdateGoal',
    description:
      'Changes the session goal\'s status: active, paused, complete (the objective is truly met and checked) or blocked (it cannot go on without the user; give the reason). Complete and blocked end the turn.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'paused', 'complete', 'blocked'] },
        reason: { type: 'string', description: 'Why; required when blocked.' },
      },
      required: ['status'],
      additionalProperties: false,
    },
  },
  kind: 'interaction',
  readOnly: true,
  check: (input) => (input.status === 'blocked' && !input.reason?.trim() ? 'reason is required when the goal is blocked.' : undefined),
  access: () => ({ type: 'none' }),
  describe: (input) => ({ title: `Mark the goal ${input.status}`, ...(input.reason ? { detail: input.reason } : {}) }),
  async run(input, ctx) {
    const goal = ctx.goals?.get()
    if (!goal) return fail('There is no goal to update. Set one with CreateGoal first.')
    ctx.goals!.set({ ...goal, status: input.status, updatedAt: Date.now() })
    const reason = input.reason?.trim() ? ` (${input.reason.trim()})` : ''
    const ends = input.status === 'complete' || input.status === 'blocked'
    return { ok: true, content: `Goal marked ${input.status}${reason}.`, ...(ends ? { stop: { summary: `Goal ${input.status}${reason}.` } } : {}) }
  },
}

export const getGoalTool: Tool = {
  definition: {
    name: 'GetGoal',
    description: 'Shows the session goal and its status, if one is set.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  kind: 'interaction',
  readOnly: true,
  access: () => ({ type: 'none' }),
  describe: () => ({ title: 'Check the session goal' }),
  async run(_input, ctx) {
    const goal = ctx.goals?.get()
    return { ok: true, content: goal ? `Goal: ${goal.text}\nStatus: ${goal.status}\nRounds so far: ${goal.rounds}` : 'No goal is set.' }
  },
}

// ---------------------------------------------------------------------------
// attempt_completion

interface CompletionInput extends Record<string, unknown> {
  result: string
}

/** For models that keep talking after the work is done: an explicit way to finish. */
export const attemptCompletionTool: Tool<CompletionInput> = {
  definition: {
    name: 'attempt_completion',
    description:
      'Call this when the task is finished, instead of ending with plain text. result says what was done and how it was checked. Do not call it while anything is unfinished or unverified.',
    inputSchema: {
      type: 'object',
      properties: { result: { type: 'string', minLength: 1, description: 'What was done and verified.' } },
      required: ['result'],
      additionalProperties: false,
    },
  },
  kind: 'interaction',
  readOnly: true,
  access: () => ({ type: 'none' }),
  describe: () => ({ title: 'Finish' }),
  async run(input) {
    return { ok: true, content: input.result, stop: { summary: input.result } }
  },
}

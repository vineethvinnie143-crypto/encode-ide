/**
 * The tool set a session starts with. Descriptions depend on the session
 * (the shell's dialect, the subagent types, the skills), so a registry is
 * built per session and then kept unchanged, keeping the prompt prefix
 * stable.
 */
import { bashOutputTool, createBashTool, killShellTool } from './bash'
import { computerTool } from './computer/tool'
import { editTool, multiEditTool, readTool, writeTool } from './files'
import {
  askUserQuestionTool,
  attemptCompletionTool,
  createGoalTool,
  createSkillTool,
  createTaskTool,
  exitPlanModeTool,
  getGoalTool,
  todoWriteTool,
  updateGoalTool,
} from './interaction'
import { ToolRegistry } from './registry'
import { globTool, grepTool } from './search'
import type { ShellDialect, SkillSummary, SubagentType, Tool } from './types'
import { webFetchTool, webSearchTool } from './web/tools'

export interface BuiltinToolOptions {
  dialect: ShellDialect
  platform: NodeJS.Platform
  /** Subagent types the Task tool offers; none leaves Task out (subagents do not start their own). */
  subagentTypes?: readonly SubagentType[]
  /** Skills the Skill tool lists; none leaves Skill out. */
  skills?: readonly SkillSummary[]
  /** The session goal tools. Default true. */
  goals?: boolean
  /** attempt_completion, for models that need an explicit way to finish. Default false. */
  completion?: boolean
  /** WebFetch and WebSearch. Default true. */
  web?: boolean
  /** The Computer tool, for sessions that have a desktop to use. Default false. */
  computer?: boolean
  /** Only these tools, by name. */
  only?: readonly string[]
}

export function builtinTools(options: BuiltinToolOptions): Tool[] {
  const tools: Tool[] = [
    createBashTool(options.dialect, options.platform) as Tool,
    bashOutputTool as Tool,
    killShellTool as Tool,
    globTool as Tool,
    grepTool as Tool,
    readTool as Tool,
    editTool as Tool,
    multiEditTool as Tool,
    writeTool as Tool,
  ]
  if (options.web ?? true) tools.push(webFetchTool as Tool, webSearchTool as Tool)
  if (options.computer) tools.push(computerTool as Tool)
  tools.push(todoWriteTool as Tool, askUserQuestionTool as Tool, exitPlanModeTool as Tool)
  if (options.subagentTypes?.length) tools.push(createTaskTool(options.subagentTypes) as Tool)
  if (options.skills?.length) tools.push(createSkillTool(options.skills) as Tool)
  if (options.goals ?? true) tools.push(createGoalTool as Tool, updateGoalTool as Tool, getGoalTool)
  if (options.completion) tools.push(attemptCompletionTool as Tool)
  const only = options.only ? new Set(options.only) : undefined
  return only ? tools.filter((tool) => only.has(tool.definition.name)) : tools
}

export function createToolRegistry(options: BuiltinToolOptions, extra: readonly Tool[] = []): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of [...builtinTools(options), ...extra]) registry.register(tool)
  return registry
}

/** What the built-in subagent types may use. */
export const READ_ONLY_TOOL_NAMES = ['Bash', 'BashOutput', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'] as const

export const BUILTIN_SUBAGENT_TYPES: readonly SubagentType[] = [
  {
    name: 'general-purpose',
    description:
      'Researches questions, searches code and carries out multi-step tasks on its own. Use it when a search may take several rounds of looking, or for a self-contained piece of work.',
  },
  {
    name: 'Explore',
    description:
      'Finds things fast in a codebase without changing anything: files by pattern, code by keyword, how something works. Say how thorough to be: quick, medium or very thorough.',
    tools: [...READ_ONLY_TOOL_NAMES],
  },
  {
    name: 'Plan',
    description:
      'Works out how to carry out a change without making it: reads the code, weighs the options and returns steps with the files to touch and the risks. Say what to plan and what constrains it.',
    tools: [...READ_ONLY_TOOL_NAMES],
  },
  {
    name: 'Review',
    description:
      'Reviews changes for bugs, risks and missing tests without altering anything. Say what to review (a diff, some files, a branch) and what matters most. Returns findings by severity, each with file and line.',
    tools: [...READ_ONLY_TOOL_NAMES],
  },
]

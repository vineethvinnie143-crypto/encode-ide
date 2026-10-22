/**
 * The tools one session offers. Built-in tools and tools from outside eNCode
 * (MCP servers) register the same way: a definition with its own JSON Schema
 * and an executor. Every call is checked against the schema before it runs,
 * and the error reads as something the model can fix.
 */
import { validationMessage } from '@encode/protocol'
import type { ToolDefinition } from '@encode/providers'
import type { AgentMode, Tool } from './types'

/** What every provider accepts as a tool name. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

const ALL_MODES: readonly AgentMode[] = ['code', 'ask', 'plan']
const WRITING_MODES: readonly AgentMode[] = ['code']

export function modesOf(tool: Tool): readonly AgentMode[] {
  return tool.modes ?? (tool.readOnly ? ALL_MODES : WRITING_MODES)
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  /** Adds a tool and returns a function that removes it. A name already taken throws. */
  register(tool: Tool): () => void {
    const { name } = tool.definition
    if (!TOOL_NAME.test(name)) throw new Error(`"${name}" is not a valid tool name: use 1 to 64 letters, digits, _ or -.`)
    if (this.tools.has(name)) throw new Error(`A tool called ${name} is already registered.`)
    const schema = tool.definition.inputSchema
    if (!schema || typeof schema !== 'object' || (schema as { type?: unknown }).type !== 'object') {
      throw new Error(`${name}'s input schema must describe an object.`)
    }
    this.tools.set(name, tool)
    return () => {
      if (this.tools.get(name) === tool) this.tools.delete(name)
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** The tools a mode offers, in registration order, optionally limited to `allowed` names. */
  offered(mode: AgentMode, allowed?: readonly string[]): Tool[] {
    const only = allowed ? new Set(allowed) : undefined
    return [...this.tools.values()].filter((tool) => modesOf(tool).includes(mode) && (!only || only.has(tool.definition.name)))
  }

  definitions(mode: AgentMode, allowed?: readonly string[]): ToolDefinition[] {
    return this.offered(mode, allowed).map((tool) => tool.definition)
  }

  /**
   * Every tool, whatever its modes, optionally limited to `allowed` names. A
   * session sends this list in every mode, so switching modes does not change
   * the prompt prefix; `check` refuses what the current mode does not offer.
   */
  list(allowed?: readonly string[]): Tool[] {
    const only = allowed ? new Set(allowed) : undefined
    return [...this.tools.values()].filter((tool) => !only || only.has(tool.definition.name))
  }

  allDefinitions(allowed?: readonly string[]): ToolDefinition[] {
    return this.list(allowed).map((tool) => tool.definition)
  }

  /**
   * What is wrong with a call, or undefined when it may run: an unknown tool,
   * one the mode does not offer, input that fails the schema or the tool's
   * own rules.
   */
  check(name: string, input: Record<string, unknown>, mode?: AgentMode): string | undefined {
    const tool = this.tools.get(name)
    if (!tool) {
      const names = [...this.tools.keys()]
      return `There is no tool called ${name}.${names.length ? ` Available tools: ${names.join(', ')}.` : ''}`
    }
    if (mode && !modesOf(tool).includes(mode)) return `${name} is not available in ${mode} mode.`
    const problem = validationMessage(input, tool.definition.inputSchema)
    if (problem) return `Invalid input for ${name}: ${problem}.`
    const rule = tool.check?.(input)
    return rule ? `Invalid input for ${name}: ${rule}` : undefined
  }
}

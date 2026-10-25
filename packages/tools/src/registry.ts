/**
 * The tools one session offers. Built-in tools and tools from outside eNCode
 * (MCP servers) register the same way: a definition with its own JSON Schema
 * and an executor. Every call is checked against the schema before it runs,
 * and the error reads as something the model can fix.
 */
import { repairInput, validationMessage, type Repaired } from '@encode/protocol'
import type { ToolDefinition } from '@encode/providers'
import type { AgentMode, Tool } from './types'

/** The tool that loads deferred ones; it has to be registered for any deferral to take effect. */
export const TOOL_SEARCH = 'ToolSearch'

/** What every provider accepts as a tool name. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** Tools that ask to be deferred are sent in full only while their definitions together stay under this many characters. */
export const DEFER_ABOVE_CHARS = 10_000

const ALL_MODES: readonly AgentMode[] = ['code', 'ask', 'plan']
const WRITING_MODES: readonly AgentMode[] = ['code']

export function modesOf(tool: Tool): readonly AgentMode[] {
  return tool.modes ?? (tool.readOnly ? ALL_MODES : WRITING_MODES)
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()
  private deferredNames: ReadonlySet<string> | undefined

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
    this.deferredNames = undefined
    return () => {
      if (this.tools.get(name) === tool) {
        this.tools.delete(name)
        this.deferredNames = undefined
      }
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
   * The tools whose definitions wait for ToolSearch: those that ask for it, once together they are long enough to matter,
   * and the seldom needed built-ins that always wait.
   */
  deferred(): readonly Tool[] {
    const names = this.deferredSet()
    return [...this.tools.values()].filter((tool) => names.has(tool.definition.name))
  }

  isDeferred(name: string): boolean {
    return this.deferredSet().has(name)
  }

  /** What ToolSearch can load: the deferred tools, and the seldom needed ones a model without a cache waits for (ADR 0136). */
  searchable(): readonly Tool[] {
    const names = this.deferredSet()
    return [...this.tools.values()].filter((tool) => names.has(tool.definition.name) || tool.seldom)
  }

  isSearchable(name: string): boolean {
    return this.isDeferred(name) || this.tools.get(name)?.seldom === true
  }

  /**
   * What a request carries: every tool `allowed` names, except the deferred ones that were not loaded yet. An agent that
   * cannot search (ToolSearch is not among its tools) is sent what it may use in full, because it could not ask. `brief`:
   * for a model that needs no guide, each tool's brief in place of its description. `lean`: for a model without a
   * prompt cache, the seldom needed tools wait for ToolSearch too, and its description names them (ADR 0136).
   */
  visibleDefinitions(allowed: readonly string[] | undefined, loaded: ReadonlySet<string>, brief = false, lean = false): ToolDefinition[] {
    const names = this.deferredSet()
    const searches = this.tools.has(TOOL_SEARCH) && (!allowed || allowed.includes(TOOL_SEARCH)) && (names.size > 0 || lean)
    const waits = (tool: Tool) => names.has(tool.definition.name) || (lean && tool.seldom === true)
    const listed = this.list(allowed)
    const held = searches && lean ? listed.filter((tool) => tool.seldom && !names.has(tool.definition.name) && !loaded.has(tool.definition.name)) : []
    return listed
      .filter((tool) => !searches || !waits(tool) || loaded.has(tool.definition.name))
      .map((tool) => {
        const definition = brief && tool.brief ? { ...tool.definition, description: tool.brief } : tool.definition
        if (!held.length || definition.name !== TOOL_SEARCH) return definition
        return { ...definition, description: `${definition.description}\nAlso: ${held.map((each) => each.definition.name).join(', ')}` }
      })
  }

  private deferredSet(): ReadonlySet<string> {
    if (!this.deferredNames) {
      const asking = [...this.tools.values()].filter((tool) => tool.defer)
      const chars = asking.reduce((sum, tool) => sum + JSON.stringify(tool.definition).length, 0)
      const deferred = chars > DEFER_ABOVE_CHARS ? asking : asking.filter((tool) => tool.defer === 'always')
      this.deferredNames = new Set(deferred.map((tool) => tool.definition.name))
    }
    return this.deferredNames
  }

  /**
   * The call's input mended where it can mean one thing only (a number sent as text, `path` for `file_path`), with
   * what was changed (ADR 0089). An input that passes, or a tool that is not known, comes back as it is. A call the
   * tool reads in its own shape first (Tool.reshape) may name another tool to run it (`name`), when `allowed` lets it.
   */
  repair(name: string, input: Record<string, unknown>, allowed?: (name: string) => boolean): Repaired & { name?: string } {
    const tool = this.tools.get(name)
    if (!tool) return { value: input, fixes: [] }
    const schema = tool.definition.inputSchema
    if (!validationMessage(input, schema)) return { value: input, fixes: [] }
    const shaped = tool.reshape?.(input)
    const target = shaped?.tool ? (allowed?.(shaped.tool) === false ? undefined : this.tools.get(shaped.tool)) : tool
    if (shaped && target) {
      const mended = repairInput(shaped.input, target.definition.inputSchema)
      if (!validationMessage(mended.value, target.definition.inputSchema)) {
        return { value: mended.value, fixes: [...shaped.fixes, ...mended.fixes], ...(target !== tool ? { name: target.definition.name } : {}) }
      }
    }
    return repairInput(input, schema)
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

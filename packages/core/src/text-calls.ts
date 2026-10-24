/**
 * Tool calls a model wrote as text (ADR 0089). Some models, served through some providers, put their tool calls in
 * the reply's text in their own markup instead of the API's tool calls: the provider's parser missed them, or the
 * model fell back to the format it was trained on. The turn would then end on a reply that only looks like work.
 *
 * A reply with no tool call of its own is read for the formats models use:
 *   - `<tool_call>{"name": …, "arguments": …}</tool_call>` (Hermes, Qwen);
 *   - `<tool_call>Name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>` (GLM);
 *   - `<function=Name><parameter=k>v</parameter></function>`, wrapped in `<tool_call>` or not (Qwen3 Coder);
 *   - `<invoke name="Name"><parameter name="k">v</parameter></invoke>`, in `<function_calls>` or not;
 *   - DeepSeek's and Kimi's tool-call tokens;
 *   - a reply that is nothing but one JSON object naming a tool and its arguments (in a json fence or not).
 *
 * The markup is taken out of the text, and each call becomes a tool call that goes through every check a call does.
 * A reply that only shows a call (markup inside a code fence, JSON that names no tool of the agent) is
 * left as it is. Values written in markup are text; the tool's schema reads "50" as a number (repair.ts).
 */
import type { AssistantBlock, AssistantMessage, ToolUseBlock } from '@encode/providers'
import { repairJson } from '@encode/providers'

interface Found {
  name: string
  input: Record<string, unknown>
}

/** The calls written in a text, each with the markup it was written in. */
interface Read {
  calls: Found[]
  /** The markup taken out, as written: a model that only repeats what a file or a page said is not calling. */
  written: string[]
  text: string
}

const BAR = String.fromCharCode(0xff5c)
const LOW = String.fromCharCode(0x2581)
/** DeepSeek's tokens: <｜tool▁calls▁begin｜> and the rest, written here from their code points. */
const ds = (name: string) => `<${BAR}${name.split('_').join(LOW)}${BAR}>`
const DS_CALLS = new RegExp(`${escape(ds('tool_calls_begin'))}([\\s\\S]*?)(?:${escape(ds('tool_calls_end'))}|$)`, 'g')
const DS_CALL = new RegExp(`${escape(ds('tool_call_begin'))}([\\s\\S]*?)${escape(ds('tool_call_end'))}`, 'g')
const DS_SEP = ds('tool_sep')
const KIMI_SECTION = /<\|tool_calls_section_begin\|>([\s\S]*?)(?:<\|tool_calls_section_end\|>|$)/g
const KIMI_CALL = /<\|tool_call_begin\|>\s*([\w.\-:]+?)\s*<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/g
const TOOL_CALL = /<tool_call>([\s\S]*?)<\/tool_call>/g
const FUNCTION = /<function=([\w.-]+)>([\s\S]*?)<\/function>/g
const FUNCTION_PARAM = /<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g
const INVOKES = /<function_calls>([\s\S]*?)<\/function_calls>/g
const INVOKE = /<invoke name="([\w.-]+)">([\s\S]*?)<\/invoke>/g
const INVOKE_PARAM = /<parameter name="([\w.-]+)">([\s\S]*?)<\/parameter>/g
const GLM_PAIR = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g
const MARKERS = ['<tool_call>', '<function=', '<invoke name=', '<function_calls>', '<|tool_call', ds('tool_call_begin')]

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Arguments as models send them: an object, or JSON text of one. */
function argumentsOf(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return {}
  if (isRecord(value)) return value
  if (typeof value === 'string') {
    const parsed = repairJson(value)
    return isRecord(parsed) ? parsed : undefined
  }
  return undefined
}

/** `{"name": "Read", "arguments": {…}}` and the shapes like it, including OpenAI's `{"function": {"name", "arguments"}}`. */
function callOf(value: unknown): Found | undefined {
  if (!isRecord(value)) return undefined
  if (isRecord(value.function)) return callOf(value.function)
  const name = [value.name, value.tool, value.tool_name, value.function].find((field): field is string => typeof field === 'string')
  if (!name) return undefined
  const args = argumentsOf(value.arguments ?? value.parameters ?? value.input ?? value.args)
  return args ? { name: name.trim(), input: args } : undefined
}

function pairs(body: string, pattern: RegExp): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  for (const match of body.matchAll(pattern)) input[match[1].trim()] = match[2]
  return input
}

/** One `<tool_call>` body, whatever its inner format. */
function toolCallBody(body: string): Found | undefined {
  const inner = body.trim()
  if (inner.startsWith('{')) return callOf(repairJson(inner))
  const fn = /^<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/.exec(inner)
  if (fn) return { name: fn[1], input: pairs(fn[2], FUNCTION_PARAM) }
  const glm = /^([\w.-]+)\s*([\s\S]*)$/.exec(inner)
  if (glm && (!glm[2].trim() || glm[2].trim().startsWith('<arg_key>'))) return { name: glm[1], input: pairs(glm[2], GLM_PAIR) }
  return undefined
}

/** `function<｜tool▁sep｜>Name\n```json\n{…}\n```` (V3) or `Name<｜tool▁sep｜>{…}` (V3.1). */
function deepSeekCall(body: string): Found | undefined {
  const at = body.indexOf(DS_SEP)
  if (at < 0) return undefined
  const left = body.slice(0, at).trim()
  let right = body.slice(at + DS_SEP.length).trim()
  let name = left
  if (left === 'function') {
    const line = right.indexOf('\n')
    name = (line < 0 ? right : right.slice(0, line)).trim()
    right = line < 0 ? '' : right.slice(line + 1)
  }
  right = right.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '')
  const input = argumentsOf(right.trim() || '{}')
  return name && input ? { name, input } : undefined
}

/** Removes every match of `pattern` from `text`, reading each with `read`; null when one cannot be read. */
function take(text: string, pattern: RegExp, read: (match: RegExpMatchArray) => Found[] | undefined, found: Found[], written: string[]): string | null {
  let failed = false
  const left = text.replace(pattern, (...args) => {
    const match = args.slice(0, -2) as unknown as RegExpMatchArray
    const calls = read(match)
    if (!calls?.length) failed = true
    else {
      found.push(...calls)
      written.push(match[0])
    }
    return ''
  })
  return failed ? null : left
}

/** The calls written in `text`, and the text without them; null when there are none, or one could not be read. */
export function callsInText(text: string, known: (name: string) => boolean): Read | null {
  // Markup inside a code fence is someone showing a call, not making one.
  for (const fence of text.matchAll(/```[\s\S]*?```/g)) if (MARKERS.some((marker) => fence[0].includes(marker))) return null
  const found: Found[] = []
  const written: string[] = []
  let left: string | null = text
  const steps: [RegExp, (match: RegExpMatchArray) => Found[] | undefined][] = [
    [DS_CALLS, (match) => [...match[1].matchAll(DS_CALL)].map((call) => deepSeekCall(call[1])).filter((call): call is Found => !!call)],
    [KIMI_SECTION, (match) => [...match[1].matchAll(KIMI_CALL)].map((call) => ({ name: call[1].replace(/^functions\./, '').replace(/:\d+$/, ''), input: argumentsOf(call[2].trim() || '{}') })).filter((call): call is Found => !!call.input)],
    [
      TOOL_CALL,
      (match) => {
        const call = toolCallBody(match[1])
        return call ? [call] : undefined
      },
    ],
    [INVOKES, (match) => [...match[1].matchAll(INVOKE)].map((call) => ({ name: call[1], input: pairs(call[2], INVOKE_PARAM) }))],
    [INVOKE, (match) => [{ name: match[1], input: pairs(match[2], INVOKE_PARAM) }]],
    [FUNCTION, (match) => [{ name: match[1], input: pairs(match[2], FUNCTION_PARAM) }]],
  ]
  for (const [pattern, read] of steps) {
    if (left === null) return null
    left = take(left, pattern, read, found, written)
  }
  if (left === null) return null
  if (found.length) return { calls: found, written, text: left.replace(/\n{3,}/g, '\n\n').trim() }
  // A reply that is nothing but one call written as JSON, naming a tool this agent has.
  const bare = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1')
  if (!bare.startsWith('{') && !bare.startsWith('[')) return null
  const value = repairJson(bare)
  const calls = (Array.isArray(value) ? value : [value]).map(callOf)
  if (!calls.length || calls.some((call) => !call || !known(call.name))) return null
  return { calls: calls as Found[], written: [bare], text: '' }
}

/**
 * The reply with the calls it wrote as text made into tool calls, or null when it has tool calls of its own or wrote
 * none. `known` says whether a tool is this agent's; markup naming another tool still becomes a call, which is refused
 * with the list of tools, so the model learns the names. `quoted` says whether markup was in what the model read (a
 * tool's result, a message): a call copied from a file or a page is that file's words, not the model's, and the whole
 * reply is left as it is.
 */
export function recoverTextCalls(
  message: AssistantMessage,
  known: (name: string) => boolean,
  makeId: (index: number) => string,
  quoted: (markup: string) => boolean = () => false,
): AssistantMessage | null {
  if (message.content.some((block) => block.type === 'tool-use')) return null
  const content: AssistantBlock[] = []
  const calls: ToolUseBlock[] = []
  for (const block of message.content) {
    if (block.type !== 'text') {
      content.push(block)
      continue
    }
    const read = callsInText(block.text, known)
    if (!read) {
      content.push(block)
      continue
    }
    if (read.written.some(quoted)) return null
    if (read.text) content.push({ ...block, text: read.text })
    for (const call of read.calls) calls.push({ type: 'tool-use', id: makeId(calls.length), name: call.name, input: call.input })
  }
  return calls.length ? { ...message, content: [...content, ...calls] } : null
}

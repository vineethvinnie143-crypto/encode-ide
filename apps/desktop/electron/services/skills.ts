import fs from 'node:fs'
import path from 'node:path'
import { builtinDefinitions, loadAgentDefinitions } from '@encode/core'
import { scanSkills } from '@encode/core/skills'
import type { AgentCreateInput, AgentDefinitionInfo, SkillInfo } from '../../shared/types'

const TEMPLATE = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDescribe when to use this skill and the exact steps to follow.\n`

/** What the read-only built-in agents get (Explore, Plan, Review). */
const READ_ONLY_TOOLS = ['Bash', 'BashOutput', 'Glob', 'Grep', 'CodeMap', 'Read', 'LSP', 'WebFetch', 'WebSearch']
const AGENT_ROLES = new Set(['main', 'explore', 'planner', 'reviewer', 'utility'])
/** What core takes as an agent's name (subagents.ts). */
const AGENT_NAME = /^[A-Za-z][\w-]{0,40}$/

const AGENT_TEMPLATE = (input: AgentCreateInput): string =>
  [
    '---',
    `name: ${input.name}`,
    `description: ${oneLine(input.description)}`,
    ...(input.readOnly ? [`tools: ${READ_ONLY_TOOLS.join(', ')}`] : []),
    ...(input.role ? [`role: ${input.role}`] : []),
    '---',
    '',
    'What this agent does, step by step, and what its report back to the main agent holds.',
    '',
  ].join('\n')

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Skills are markdown files the agent can load on demand with the Skill tool, and agents are markdown files the main
 * agent can start with the Task tool. The agent finds both in the same two places: the user's own folder
 * (~/.encode/skills and ~/.encode/agents, shared with the command line) and the workspace's .encode folder.
 */
export class SkillService {
  /**
   * `userDir`: the user's own folder, ~/.encode. `openPath` shows a folder in the system's file manager, `showItem` a
   * file in its folder, and `trash` moves a file or folder to the bin, where the person can get it back.
   */
  constructor(
    private readonly workspaceRoot: () => string | null,
    private readonly userDir: string,
    private readonly openPath: (dir: string) => Promise<unknown> = async () => undefined,
    private readonly showItem: (file: string) => void = () => undefined,
    private readonly trash: (target: string) => Promise<void> = async (target) => fs.rmSync(target, { recursive: true, force: true }),
  ) {}

  private get userSkills(): string {
    return path.join(this.userDir, 'skills')
  }

  private dirs(): { dir: string; source: SkillInfo['source'] }[] {
    const list: { dir: string; source: SkillInfo['source'] }[] = [{ dir: this.userSkills, source: 'user' }]
    const root = this.workspaceRoot()
    if (root) list.push({ dir: path.join(root, '.encode', 'skills'), source: 'workspace' })
    return list
  }

  /** The skills the agent can load, as its Skill tool lists them: a repository's skills cannot be links, and its own override the user's of the same name. */
  list(): SkillInfo[] {
    return scanSkills(this.dirs()).map(({ name, description, source, file }) => ({ name, description, source, path: file }))
  }

  read(name: string): string {
    const skill = this.list().find((item) => item.name === name)
    if (!skill) throw new Error(`Unknown skill: ${name}`)
    return fs.readFileSync(skill.path, 'utf8')
  }

  create(name: string, description = ''): SkillInfo {
    const safe = name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!safe) throw new Error('Skill name is required')
    const dir = this.userSkills
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${safe}.md`)
    if (!fs.existsSync(file)) fs.writeFileSync(file, TEMPLATE(safe, description || `Use when working on ${safe}.`), 'utf8')
    return { name: safe, description: description || `Use when working on ${safe}.`, source: 'user', path: file }
  }

  async openFolder(): Promise<void> {
    fs.mkdirSync(this.userSkills, { recursive: true })
    await this.openPath(this.userSkills)
  }

  /** Moves one of the user's own skills to the bin: its folder, or its file. A project's skills belong to the project. */
  async remove(name: string): Promise<void> {
    const skill = this.list().find((item) => item.name === name && item.source === 'user')
    if (!skill) throw new Error(`${name} is not one of your skills.`)
    await this.trash(this.ownEntry(skill.path, this.userSkills))
  }

  /** Shows a skill's file in the system's file manager. */
  reveal(name: string): void {
    const skill = this.list().find((item) => item.name === name)
    if (!skill) throw new Error(`Unknown skill: ${name}`)
    this.showItem(skill.path)
  }

  // ------------------------------------------------------------ agents

  private get userAgents(): string {
    return path.join(this.userDir, 'agents')
  }

  /** The agents the main agent can start, as its Task tool sees them: the built-in ones, then the user's, then the project's, which win over the user's. */
  agents(): AgentDefinitionInfo[] {
    const root = this.workspaceRoot()
    const sources = [{ dir: this.userAgents, source: 'user' as const }, ...(root ? [{ dir: path.join(root, '.encode', 'agents'), source: 'workspace' as const }] : [])]
    return [...builtinDefinitions(), ...loadAgentDefinitions(sources)].map((definition) => ({
      name: definition.name,
      description: definition.description,
      source: definition.source,
      ...(definition.role ? { role: definition.role } : {}),
      ...(definition.tools ? { tools: [...definition.tools] } : {}),
      ...(definition.disallowedTools ? { disallowedTools: [...definition.disallowedTools] } : {}),
      ...(definition.maxTurns ? { maxTurns: definition.maxTurns } : {}),
      ...(definition.color ? { color: definition.color } : {}),
      ...(definition.file ? { path: definition.file } : {}),
    }))
  }

  readAgent(name: string): string {
    const agent = this.agents().find((item) => item.name === name && item.path)
    if (!agent?.path) throw new Error(`Unknown agent: ${name}`)
    return fs.readFileSync(agent.path, 'utf8')
  }

  /** A new agent in the user's folder, from what the person chose; an agent of that name is never replaced. */
  createAgent(input: AgentCreateInput): AgentDefinitionInfo {
    const name = input.name.trim()
    const description = oneLine(input.description)
    if (!AGENT_NAME.test(name)) throw new Error('An agent’s name starts with a letter and has only letters, digits, - and _, up to 41 characters.')
    if (!description) throw new Error('Say when the main agent should use it.')
    if (input.role && !AGENT_ROLES.has(input.role)) throw new Error(`Unknown role: ${input.role}`)
    if (this.agents().some((agent) => agent.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already an agent called ${name}.`)
    fs.mkdirSync(this.userAgents, { recursive: true })
    const file = path.join(this.userAgents, `${name}.md`)
    fs.writeFileSync(file, AGENT_TEMPLATE({ ...input, name, description: description.slice(0, 300) }), { encoding: 'utf8', flag: 'wx' })
    const created = this.agents().find((agent) => agent.name === name)
    if (!created) throw new Error(`${name} was written to ${file} but could not be read back.`)
    return created
  }

  async removeAgent(name: string): Promise<void> {
    const agent = this.agents().find((item) => item.name === name && item.source === 'user')
    if (!agent?.path) throw new Error(`${name} is not one of your agents.`)
    await this.trash(this.ownEntry(agent.path, this.userAgents))
  }

  revealAgent(name: string): void {
    const agent = this.agents().find((item) => item.name === name && item.path)
    if (!agent?.path) throw new Error(`Unknown agent: ${name}`)
    this.showItem(agent.path)
  }

  async openAgentsFolder(): Promise<void> {
    fs.mkdirSync(this.userAgents, { recursive: true })
    await this.openPath(this.userAgents)
  }

  /** What to move to the bin for a file found in `dir`: the entry directly inside it (a skill's folder), never anything outside. */
  private ownEntry(file: string, dir: string): string {
    const relative = path.relative(dir, file)
    const [first] = relative.split(path.sep)
    if (!first || first === '..' || path.isAbsolute(relative)) throw new Error(`${file} is not in ${dir}`)
    return path.join(dir, first)
  }
}

/**
 * Skills an earlier build kept in its data folder move to the user's folder,
 * where the agent looks for them. Copies only what is not there yet, and
 * leaves the originals alone.
 */
export function migrateLegacySkills(legacyDir: string, userSkillsDir: string): number {
  let names: string[]
  try {
    names = fs.readdirSync(legacyDir)
  } catch {
    return 0
  }
  let copied = 0
  for (const name of names) {
    const target = path.join(userSkillsDir, name)
    if (fs.existsSync(target)) continue
    try {
      fs.mkdirSync(userSkillsDir, { recursive: true })
      fs.cpSync(path.join(legacyDir, name), target, { recursive: true, errorOnExist: true })
      copied++
    } catch {
      /* leave it where it is */
    }
  }
  return copied
}

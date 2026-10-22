import fs from 'node:fs'
import path from 'node:path'
import { scanSkills } from '@encode/core/skills'
import type { SkillInfo } from '../../shared/types'

const TEMPLATE = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDescribe when to use this skill and the exact steps to follow.\n`

/**
 * Skills are markdown files the agent can load on demand with the Skill tool.
 * The agent finds them in the same two places: the user's own folder
 * (~/.encode/skills, shared with the command line) and the workspace's
 * .encode/skills.
 */
export class SkillService {
  /** `userDir`: the user's own folder, ~/.encode. `openPath` shows a folder in the system's file manager. */
  constructor(
    private readonly workspaceRoot: () => string | null,
    private readonly userDir: string,
    private readonly openPath: (dir: string) => Promise<unknown> = async () => undefined,
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

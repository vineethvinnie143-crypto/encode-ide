import fs from 'node:fs'
import path from 'node:path'
import { app, shell } from 'electron'
import type { SkillInfo } from '../../shared/types'

const TEMPLATE = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDescribe when to use this skill and the exact steps to follow.\n`

/** Skills are markdown files the agent can load on demand with the `skill` tool. */
export class SkillService {
  constructor(private readonly workspaceRoot: () => string | null) {}

  private dirs(): { dir: string; source: SkillInfo['source'] }[] {
    const list: { dir: string; source: SkillInfo['source'] }[] = [
      { dir: path.join(app.getPath('userData'), 'skills'), source: 'user' },
    ]
    const root = this.workspaceRoot()
    if (root) list.push({ dir: path.join(root, '.eNCode', 'skills'), source: 'workspace' })
    return list
  }

  private describe(file: string, fallback: string): string {
    try {
      const text = fs.readFileSync(file, 'utf8')
      const front = /description\s*:\s*(.+)/i.exec(text)
      if (front) return front[1].trim()
      const heading = text.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('---') && !line.startsWith('#'))
      return heading?.trim().slice(0, 120) ?? fallback
    } catch {
      return fallback
    }
  }

  list(): SkillInfo[] {
    const skills: SkillInfo[] = []
    for (const { dir, source } of this.dirs()) {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const file = entry.isDirectory()
          ? path.join(dir, entry.name, 'SKILL.md')
          : entry.name.toLowerCase().endsWith('.md')
            ? path.join(dir, entry.name)
            : ''
        if (!file || !fs.existsSync(file)) continue
        const name = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/i, '')
        skills.push({ name, description: this.describe(file, name), source, path: file })
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  read(name: string): string {
    const skill = this.list().find((item) => item.name === name)
    if (!skill) throw new Error(`Unknown skill: ${name}`)
    return fs.readFileSync(skill.path, 'utf8')
  }

  create(name: string, description = ''): SkillInfo {
    const safe = name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!safe) throw new Error('Skill name is required')
    const dir = path.join(app.getPath('userData'), 'skills')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${safe}.md`)
    if (!fs.existsSync(file)) fs.writeFileSync(file, TEMPLATE(safe, description || `Use when working on ${safe}.`), 'utf8')
    return { name: safe, description: description || `Use when working on ${safe}.`, source: 'user', path: file }
  }

  async openFolder(): Promise<void> {
    const dir = path.join(app.getPath('userData'), 'skills')
    fs.mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
  }
}

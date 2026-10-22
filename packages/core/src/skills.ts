/**
 * Skills: playbooks the user keeps as Markdown files, loaded on demand by the
 * Skill tool. A skill is `<name>/SKILL.md` or `<name>.md` in a skills folder;
 * `description` in its front matter (or its first line of prose) is what the
 * model sees until it loads one.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { SkillSummary, Skills } from '@encode/tools'
import { isFolderSync, readSmallFile, staysInProject } from './safe-files'

/** The most of a skill file that is read. */
const MAX_SKILL_BYTES = 256 * 1024
/** Skills in a repository's folder are read with care: no links, so a skill cannot be a window onto another file. */
const readSkill = (file: string, source: SkillSource['source']): string | null => readSmallFile(file, { maxBytes: MAX_SKILL_BYTES, followLinks: source !== 'workspace' })

export interface SkillSource {
  dir: string
  source: 'user' | 'workspace'
}

export interface SkillEntry extends SkillSummary {
  source: SkillSource['source']
  /** Absolute path of the skill's Markdown file. */
  file: string
}

/** The front matter's fields and the text after it. */
export function parseFrontMatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (field) fields[field[1].toLowerCase()] = field[2].trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return { fields, body: text.slice(match[0].length) }
}

function describe(text: string, fallback: string): string {
  const { fields, body } = parseFrontMatter(text)
  if (fields.description) return fields.description.slice(0, 300)
  const prose = body.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('#'))
  return prose?.trim().slice(0, 160) ?? fallback
}

/** Every skill in the folders, later folders overriding earlier ones that use the same name. */
export function scanSkills(sources: readonly SkillSource[]): SkillEntry[] {
  const found = new Map<string, SkillEntry>()
  for (const { dir, source } of sources) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    // The folder a repository fills must not lead out of it.
    if (source === 'workspace' && !staysInProject(dir)) continue
    for (const entry of entries) {
      // The user's own folder may hold links to skills kept elsewhere; a repository's may not.
      const folder = entry.isDirectory() || (source !== 'workspace' && entry.isSymbolicLink() && isFolderSync(path.join(dir, entry.name)))
      const file = folder ? path.join(dir, entry.name, 'SKILL.md') : entry.name.toLowerCase().endsWith('.md') ? path.join(dir, entry.name) : ''
      if (!file) continue
      const name = folder ? entry.name : entry.name.replace(/\.md$/i, '')
      const text = readSkill(file, source)
      if (text === null) continue
      found.set(name, { name, description: describe(text, name), source, file })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The Skills the Skill tool uses, reading the folders afresh each time so new files show up at once. */
export function createSkills(sources: () => readonly SkillSource[]): Skills & { entries(): SkillEntry[] } {
  const entries = () => scanSkills(sources())
  return {
    entries,
    list: () => entries().map(({ name, description }) => ({ name, description })),
    async load(name) {
      const skill = entries().find((entry) => entry.name === name)
      if (!skill) return undefined
      const text = readSkill(skill.file, skill.source)
      if (text === null) return undefined
      return { name: skill.name, directory: path.dirname(skill.file), body: parseFrontMatter(text).body.trim() }
    },
  }
}

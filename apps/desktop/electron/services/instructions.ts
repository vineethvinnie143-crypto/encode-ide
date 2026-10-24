import fs from 'node:fs'
import path from 'node:path'
import type { InstructionsInfo, InstructionsSaveOutcome, ProjectInstructions } from '../../shared/types'
import { writePrivateFile } from './private-file'

/** Past this many characters the middle of a file is cut when it is sent (core's memory.ts, MAX_FILE_CHARS). */
export const INSTRUCTIONS_SENT_CHARS = 40_000
/** The most the page reads or saves. */
const MAX_BYTES = 256 * 1024
/** The files core reads in a project folder, the first one found (memory.ts). */
const PROJECT_NAMES = ['ENCODE.md', path.join('.encode', 'ENCODE.md'), 'AGENTS.md', 'CLAUDE.md']
const PROJECT_TEMPLATE = '# Instructions for this project\n\nWhat the agent should know here: how to build and test, conventions to follow, things to avoid.\n'

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * The person's own instructions, ~/.encode/ENCODE.md, which the agent reads in every project and the command line
 * shares (Settings > Personalization), and which file a project's own instructions are in.
 */
export class InstructionsService {
  constructor(
    private readonly userDir: string,
    private readonly workspaceRoot: () => string | null,
  ) {}

  private get file(): string {
    return path.join(this.userDir, 'ENCODE.md')
  }

  read(): InstructionsInfo {
    const file = this.file
    let text = ''
    let exists = false
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) throw new Error(`${file} is not a file.`)
      if (stat.size > MAX_BYTES) throw new Error(`${file} is larger than ${MAX_BYTES / 1024} KB; edit it in an editor.`)
      text = fs.readFileSync(file, 'utf8')
      exists = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { path: file, text, exists, sentChars: INSTRUCTIONS_SENT_CHARS }
  }

  /**
   * Saves `text` when the file still holds `base`, what the page read; otherwise answers with the file as it is now,
   * so an edit made elsewhere (another window, the command line, an editor) is never overwritten unseen.
   */
  write(text: string, base: string): InstructionsSaveOutcome {
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error(`Your instructions can be at most ${MAX_BYTES / 1024} KB.`)
    const current = this.read()
    if (current.text !== base) return { ok: false, changed: current }
    if (!current.exists && !text.trim()) return { ok: true, info: current }
    // A file kept with Windows line ends keeps them; a link (to a dotfiles folder) is written through.
    const content = current.text.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text
    fs.mkdirSync(this.userDir, { recursive: true })
    writePrivateFile(current.exists ? fs.realpathSync(this.file) : this.file, content)
    return { ok: true, info: this.read() }
  }

  /** The open folder's own instructions file, by its path in the folder; null when no folder is open. */
  project(): ProjectInstructions | null {
    const root = this.workspaceRoot()
    if (!root) return null
    const file = PROJECT_NAMES.find((name) => isFile(path.join(root, name)))
    return { root, file: file ? file.split(path.sep).join('/') : null }
  }

  /** Makes ENCODE.md in the open folder when it has none of the files, and answers with the file it has. */
  createProject(): string {
    const project = this.project()
    if (!project) throw new Error('Open a folder first.')
    if (project.file) return project.file
    fs.writeFileSync(path.join(project.root, 'ENCODE.md'), PROJECT_TEMPLATE, { encoding: 'utf8', flag: 'wx' })
    return 'ENCODE.md'
  }
}

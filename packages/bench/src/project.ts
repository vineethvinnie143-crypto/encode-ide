/**
 * A task's project on disk: copied fresh for a run, and pictured before and after it, so a run reports which files
 * the agent changed and a check can say that some were left alone.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BenchTask } from './task'

/** Relative path, with `/`, to the file's hash. */
export type Snapshot = Map<string, string>

export interface FileChanges {
  added: string[]
  changed: string[]
  removed: string[]
}

/** More files than a task's project should ever have: what the agent makes past this is not pictured. */
const MAX_FILES = 20_000

/** Copies the task's project to `to`, then gives the folders git would not keep their real names. */
export async function copyProject(task: BenchTask, to: string): Promise<void> {
  await fs.cp(path.join(task.dir, 'project'), to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
  for (const [from, name] of Object.entries(task.rename)) {
    const source = path.join(to, ...from.split('/'))
    const target = path.join(to, ...name.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rename(source, target)
  }
}

/** Folders whose contents are no change of the run's: git's, and what running the code makes on its own (Python's byte code, pytest's cache). */
const NOT_THE_RUNS = new Set(['.git', '__pycache__', '.pytest_cache'])

export async function snapshot(root: string): Promise<Snapshot> {
  const out: Snapshot = new Map()
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.size >= MAX_FILES) return
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!NOT_THE_RUNS.has(entry.name)) await walk(full, relative)
      } else if (entry.isSymbolicLink()) {
        out.set(relative, `link:${await fs.readlink(full).catch(() => '')}`)
      } else if (entry.isFile()) {
        out.set(relative, createHash('sha256').update(await fs.readFile(full)).digest('hex'))
      }
    }
  }
  await walk(root, '')
  return out
}

export function changesBetween(before: Snapshot, after: Snapshot): FileChanges {
  const changes: FileChanges = { added: [], changed: [], removed: [] }
  for (const [file, hash] of after) {
    const was = before.get(file)
    if (was === undefined) changes.added.push(file)
    else if (was !== hash) changes.changed.push(file)
  }
  for (const file of before.keys()) if (!after.has(file)) changes.removed.push(file)
  return changes
}

/** Whether a changed path is the one named, or inside the folder named. */
export const within = (file: string, named: string): boolean => file === named || file.startsWith(`${named}/`)

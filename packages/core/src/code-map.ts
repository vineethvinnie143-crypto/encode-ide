/**
 * The code map of a session (ADR 0090): the index of the folder it works in, shared with the other sessions there,
 * and an index of its own for a worktree it entered. What the agent reads of it (CodeMap, and the map in its first
 * message) holds only files the person's rules let it read.
 */
import path from 'node:path'
import { CodeIndex, renderMap, termsOf, type CodeMapSource, type IndexedFile } from '@encode/tools'
import type { RuleJudge } from './approval'
import { reminder } from './prompt'

/** The map that goes with a session's first message: about a thousand tokens. */
export const FIRST_MAP_CHARS = 3_500
/** How long the first message waits for an index that is still being built. */
export const FIRST_MAP_WAIT_MS = 1_500
/** A project this small is read whole faster than mapped. */
const MIN_FILES = 3

export interface SessionCodeMapOptions {
  root: string
  platform: NodeJS.Platform
  /** The folder's index, shared by its sessions; without it the session keeps its own. */
  shared?: () => CodeIndex | undefined
  rules?: RuleJudge
}

export class SessionCodeMap implements CodeMapSource {
  private readonly own = new Map<string, CodeIndex>()

  constructor(private readonly options: SessionCodeMapOptions) {}

  /** Starts building the folder's index, so that it is ready when the first message is sent. */
  warm(): void {
    if (this.options.root) this.indexFor(this.options.root).warm()
  }

  async files(dir: string, signal?: AbortSignal): Promise<{ files: IndexedFile[]; truncated: boolean }> {
    const index = this.indexFor(dir)
    const files = await index.files(signal)
    return { files: this.readable(index.root, files), truncated: index.truncated }
  }

  changed(file: string): void {
    this.options.shared?.()?.changed(file)
    for (const index of this.own.values()) index.changed(file)
  }

  /** The map of the folder the agent works in, for its first message or after a summary, pulled towards what the person asked. */
  async reminder(requests: readonly string[], dir = this.options.root, signal?: AbortSignal): Promise<string | undefined> {
    if (!dir) return undefined
    const index = this.indexFor(dir)
    if (!(await index.ready(FIRST_MAP_WAIT_MS)) || signal?.aborted) return undefined
    const files = this.readable(dir, index.current())
    if (files.filter((file) => file.definitions.length).length < MIN_FILES) return undefined
    const map = renderMap(files, { terms: termsOf(requests.join('\n')), maxChars: FIRST_MAP_CHARS })
    if (!map.shownDefinitions) return undefined
    const more = map.shownFiles < map.files ? `\n(${map.shownFiles} of ${map.files} files with definitions; CodeMap shows the rest.)` : ''
    return reminder(`Code map (background for you: where things are defined, by file and line, the most used first; CodeMap shows more):\n${map.text}${more}`)
  }

  private indexFor(dir: string): CodeIndex {
    const { root, platform } = this.options
    const insensitive = platform === 'win32' || platform === 'darwin'
    const same = insensitive ? dir.toLowerCase() === root.toLowerCase() : dir === root
    if (same) {
      const shared = this.options.shared?.()
      if (shared) return shared
    }
    const key = insensitive ? dir.toLowerCase() : dir
    let index = this.own.get(key)
    if (!index) {
      index = new CodeIndex({ root: dir, caseInsensitive: insensitive })
      this.own.set(key, index)
    }
    return index
  }

  /** Leaves out what the person's rules forbid reading. */
  private readable(root: string, files: IndexedFile[]): IndexedFile[] {
    const { rules } = this.options
    if (!rules) return files
    return files.filter((file) => rules.evaluate({ type: 'read', paths: [path.join(root, file.path)] })?.decision !== 'deny')
  }
}

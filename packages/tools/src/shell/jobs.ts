/**
 * Background commands: dev servers, watchers, long builds. Each runs in the
 * agent's shell without a timeout until it ends or is killed, keeps the last
 * megabyte of its output, and hands out only what is new on every read.
 */
import path from 'node:path'
import { collapseCarriageReturns, stripAnsi } from '../text'
import type { JobInfo, JobManager, JobStatus } from '../types'
import type { ManagedShell, RunningCommand } from './run'

const KEEP_CHARS = 1_000_000
const MAX_JOBS = 32

interface Job {
  info: JobInfo
  output: string
  /** Characters dropped from the front of `output` so far. */
  dropped: number
  /** Position, in characters ever produced, of the last read. */
  cursor: number
  handle?: RunningCommand
  killed: boolean
}

export interface BackgroundJobs extends JobManager {
  /** The whole retained output, for the UI. */
  output(id: string): string | undefined
  dispose(): Promise<void>
}

export function createJobManager(shell: ManagedShell, options: { onChange?(jobs: JobInfo[]): void } = {}): BackgroundJobs {
  const jobs = new Map<string, Job>()
  let counter = 0
  const changed = () => options.onChange?.(list())

  function list(): JobInfo[] {
    return [...jobs.values()].map((job) => ({ ...job.info }))
  }

  function prune() {
    if (jobs.size <= MAX_JOBS) return
    for (const [id, job] of jobs) {
      if (job.info.status !== 'running') jobs.delete(id)
      if (jobs.size <= MAX_JOBS) return
    }
  }

  return {
    async start(command, startOptions) {
      const id = `bash_${++counter}`
      const cwd = startOptions.cwd ?? shell.state().cwd
      const job: Job = { info: { id, command, cwd, startedAt: Date.now(), status: 'running' }, output: '', dropped: 0, cursor: 0, killed: false }
      jobs.set(id, job)
      prune()
      const append = (text: string) => {
        job.output += collapseCarriageReturns(stripAnsi(text))
        if (job.output.length > KEEP_CHARS) {
          const cut = job.output.length - KEEP_CHARS
          job.output = job.output.slice(cut)
          job.dropped += cut
        }
      }
      try {
        job.handle = await shell.start(command, { cwd: path.resolve(cwd), ...(startOptions.unsandboxed ? { unsandboxed: true } : {}), onOutput: append })
      } catch (error) {
        append(`${error instanceof Error ? error.message : String(error)}\n`)
        job.info.status = 'error'
        changed()
        return { ...job.info }
      }
      changed()
      void job.handle.done.then(({ exitCode }) => {
        const status: JobStatus = job.killed ? 'killed' : exitCode === 0 ? 'done' : 'error'
        job.info.status = status
        if (exitCode !== null) job.info.exitCode = exitCode
        changed()
      })
      return { ...job.info }
    },

    read(id, readOptions = {}) {
      const job = jobs.get(id)
      if (!job) return undefined
      const total = job.dropped + job.output.length
      const from = Math.max(job.cursor, job.dropped) - job.dropped
      let fresh = job.output.slice(from)
      if (job.cursor < job.dropped) fresh = `… [${job.dropped - job.cursor} characters were dropped before this read] …\n${fresh}`
      job.cursor = total
      if (readOptions.filter) {
        const filter = readOptions.filter
        fresh = fresh
          .split('\n')
          .filter((line) => {
            filter.lastIndex = 0
            return filter.test(line)
          })
          .join('\n')
      }
      return { job: { ...job.info }, output: fresh }
    },

    async kill(id) {
      const job = jobs.get(id)
      if (!job || job.info.status !== 'running' || !job.handle) return false
      job.killed = true
      await job.handle.kill()
      return true
    },

    list,

    output: (id) => jobs.get(id)?.output,

    async dispose() {
      await Promise.all(
        [...jobs.values()].filter((job) => job.info.status === 'running' && job.handle).map((job) => {
          job.killed = true
          return job.handle!.kill()
        }),
      )
    },
  }
}

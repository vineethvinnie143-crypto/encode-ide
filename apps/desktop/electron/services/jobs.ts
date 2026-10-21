import { randomUUID } from 'node:crypto'
import type { BackgroundJob } from '../../shared/types'
import type { ShellService } from './shell'

const JOB_TIMEOUT_MS = 30 * 60 * 1000
const MAX_OUTPUT = 60_000

/** Tracks long-running shell commands so the agent and UI can poll them. */
export class JobService {
  private readonly jobs = new Map<string, BackgroundJob>()
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly shell: ShellService,
    private readonly onChange: (jobs: BackgroundJob[]) => void,
  ) {}

  start(command: string, cwd: string, sessionId: string): BackgroundJob {
    const id = randomUUID()
    const job: BackgroundJob = {
      id,
      command,
      cwd,
      sessionId,
      startedAt: Date.now(),
      status: 'running',
      output: '',
    }
    this.jobs.set(id, job)
    const controller = new AbortController()
    this.controllers.set(id, controller)
    this.emit()

    void this.shell
      .capture(command, cwd, JOB_TIMEOUT_MS, controller.signal, (chunk) => {
        job.output = (job.output + chunk).slice(-MAX_OUTPUT)
        this.emit()
      })
      .then((result) => {
        if (result.output.length >= job.output.length) job.output = result.output.slice(-MAX_OUTPUT)
        job.exitCode = result.code
        job.status = result.aborted ? 'killed' : result.timedOut ? 'error' : result.code === 0 ? 'done' : 'error'
        this.controllers.delete(id)
        this.emit()
      })
      .catch(() => {
        job.status = 'error'
        this.controllers.delete(id)
        this.emit()
      })

    return job
  }

  list(): BackgroundJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 30)
  }

  output(id: string): string {
    return this.jobs.get(id)?.output ?? ''
  }

  kill(id: string): void {
    this.controllers.get(id)?.abort()
  }

  private emit(): void {
    this.onChange(this.list())
  }
}

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { bashOutputTool, OUTPUT_WAIT_MS } from './bash'
import { tempWorkspace, testContext, textOf } from './testing'
import type { JobInfo, JobManager, JobStatus, ToolContext } from './types'

interface Read {
  status: JobStatus
  output: string
  exitCode?: number
}

/** Jobs whose reads come from a list (the last one repeats), and that note every wait. */
function scripted(reads: Read[], onWait: (ms: number) => void = () => {}) {
  const waits: number[] = []
  let at = 0
  const jobs: JobManager = {
    start: async () => {
      throw new Error('not used')
    },
    read: (id) => {
      const next = reads[Math.min(at++, reads.length - 1)]
      const job: JobInfo = { id, command: 'build', cwd: '/work', startedAt: 0, status: next.status, ...(next.exitCode !== undefined ? { exitCode: next.exitCode } : {}) }
      return { job, output: next.output }
    },
    wait: async (_id, ms) => {
      waits.push(ms)
      onWait(ms)
    },
    kill: async () => false,
    list: () => [],
  }
  return { jobs, waits, reads: () => at }
}

async function context(jobs: JobManager, overrides: Partial<ToolContext> = {}) {
  return testContext(await tempWorkspace(), { jobs, ...overrides })
}

describe('BashOutput on a command that still runs (ADR 0153)', () => {
  it('waits for output when there is none, shows that it waits, and returns what came', async () => {
    const { jobs, waits } = scripted([{ status: 'running', output: '' }, { status: 'running', output: 'built 3 files\n' }])
    const shown: string[] = []
    const outcome = await bashOutputTool.run({ bash_id: 'bash_1' }, await context(jobs, { progress: (text) => shown.push(text) }))
    assert.equal(textOf(outcome.content), 'Status: running\n\nbuilt 3 files')
    assert.equal(waits.length, 1)
    assert.ok(waits[0] > OUTPUT_WAIT_MS - 5_000 && waits[0] <= OUTPUT_WAIT_MS, `${waits[0]} ms`)
    assert.deepEqual(shown, ['Waiting up to 30 s for bash_1 to print…'])
  })

  it('does not wait when there is output, or the command has ended', async () => {
    const printed = scripted([{ status: 'running', output: 'hello\n' }])
    assert.equal(textOf((await bashOutputTool.run({ bash_id: 'bash_1' }, await context(printed.jobs))).content), 'Status: running\n\nhello')
    const ended = scripted([{ status: 'done', exitCode: 0, output: '' }])
    assert.equal(textOf((await bashOutputTool.run({ bash_id: 'bash_1' }, await context(ended.jobs))).content), 'Status: done, exit code 0\n\n(no new output)')
    assert.deepEqual([...printed.waits, ...ended.waits], [])
  })

  it('goes on waiting through output the filter drops, and says how a command that ended meanwhile ended', async () => {
    const { jobs, waits } = scripted([
      { status: 'running', output: '' },
      { status: 'running', output: '' },
      { status: 'error', exitCode: 1, output: 'FAIL a.test\n' },
    ])
    const outcome = await bashOutputTool.run({ bash_id: 'bash_1', filter: 'FAIL' }, await context(jobs))
    assert.equal(textOf(outcome.content), 'Status: error, exit code 1\n\nFAIL a.test')
    assert.equal(waits.length, 2)
  })

  it('does not wait once the call is stopped', async () => {
    const stopped = new AbortController()
    stopped.abort()
    const { jobs, waits } = scripted([{ status: 'running', output: '' }])
    const outcome = await bashOutputTool.run({ bash_id: 'bash_1' }, await context(jobs, { signal: stopped.signal }))
    assert.equal(textOf(outcome.content), 'Status: running\n\n(no new output)')
    assert.deepEqual(waits, [])
  })

  it('gives up after 30 s with nothing new, having waited no more than that in all', async () => {
    mock.timers.enable({ apis: ['Date'] })
    try {
      const { jobs, waits } = scripted([{ status: 'running', output: '' }], (ms) => mock.timers.tick(ms))
      const outcome = await bashOutputTool.run({ bash_id: 'bash_1' }, await context(jobs))
      assert.equal(textOf(outcome.content), 'Status: running\n\n(no new output)')
      assert.ok(waits.length >= 1)
      assert.equal(waits.reduce((sum, ms) => sum + ms, 0), OUTPUT_WAIT_MS)
    } finally {
      mock.timers.reset()
    }
  })

  it('still says when there is no such command, without waiting', async () => {
    const { jobs } = scripted([])
    const none: JobManager = { ...jobs, read: () => undefined }
    const outcome = await bashOutputTool.run({ bash_id: 'bash_9' }, await context(none))
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /^There is no background command bash_9\./)
  })
})
